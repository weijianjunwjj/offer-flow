pub mod backup;
pub mod database;
pub mod error;
pub mod migration;
pub mod models;
pub mod repository;
pub mod schema;

use self::database::{app_database_path, open_initialized_database};
use self::error::{StorageError, StorageResult};
use self::models::{JobDocument, ProfileDocument, T3RepositorySmokeResult};
use self::repository::{
    delete_job, get_app_meta, get_profile, list_jobs_by_updated_desc, require_job, set_app_meta,
    upsert_job, upsert_profile, PROFILE_ID_DEFAULT,
};
use self::schema::SCHEMA_VERSION;
use std::path::Path;
use tauri::AppHandle;

pub const T3_SMOKE_DB_FILE: &str = "offerflow-t3.sqlite3";

pub fn t3_smoke_database_path(app: &AppHandle) -> StorageResult<std::path::PathBuf> {
    app_database_path(app, T3_SMOKE_DB_FILE)
}

pub fn run_t3_repository_smoke_at_path(db_path: &Path) -> StorageResult<T3RepositorySmokeResult> {
    let conn = open_initialized_database(db_path)?;
    let now = database::unix_timestamp()?;

    set_app_meta(&conn, "schema_version", SCHEMA_VERSION, now)?;
    let schema_version = get_app_meta(&conn, "schema_version")?
        .ok_or_else(|| StorageError::not_found("app_meta", "schema_version"))?;

    let profile = ProfileDocument::smoke(now);
    upsert_profile(&conn, &profile)?;
    let stored_profile = get_profile(&conn)?
        .ok_or_else(|| StorageError::not_found("profiles", PROFILE_ID_DEFAULT))?;

    let older_job = JobDocument::smoke("t3-smoke-job-old", now - 20);
    let newer_job = JobDocument::smoke("t3-smoke-job-new", now);
    upsert_job(&conn, &older_job)?;
    upsert_job(&conn, &newer_job)?;

    let stored_newer_job = require_job(&conn, &newer_job.id)?;
    let listed_jobs = list_jobs_by_updated_desc(&conn)?;
    let listed_job_ids = listed_jobs
        .iter()
        .map(|job| job.id.clone())
        .collect::<Vec<_>>();
    let smoke_listed_job_ids = listed_job_ids
        .iter()
        .filter(|id| **id == newer_job.id || **id == older_job.id)
        .cloned()
        .collect::<Vec<_>>();

    if smoke_listed_job_ids != vec![newer_job.id.clone(), older_job.id.clone()] {
        return Err(StorageError::query(
            "jobs",
            "list jobs by updated_at desc returned an unexpected order",
        ));
    }

    let deleted_old_job = delete_job(&conn, &older_job.id)?;
    let deleted_new_job = delete_job(&conn, &newer_job.id)?;
    let deleted_job_missing = matches!(
        require_job(&conn, &older_job.id),
        Err(StorageError::NotFound { .. })
    );
    let remaining_jobs = list_jobs_by_updated_desc(&conn)?;

    Ok(T3RepositorySmokeResult {
        db_path: db_path.display().to_string(),
        schema_version,
        profile_id: stored_profile.id,
        profile_target_city: stored_profile.target_city.unwrap_or_default(),
        job_id: stored_newer_job.id,
        listed_job_ids: smoke_listed_job_ids,
        deleted_old_job,
        deleted_new_job,
        deleted_job_missing,
        remaining_job_count: remaining_jobs.len(),
    })
}

pub fn run_t3_repository_smoke(app: &AppHandle) -> StorageResult<T3RepositorySmokeResult> {
    let db_path = t3_smoke_database_path(app)?;
    run_t3_repository_smoke_at_path(&db_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_connection() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory sqlite");
        schema::initialize_schema(&mut conn).expect("initialize schema");
        conn
    }

    #[test]
    fn schema_version_round_trips() {
        let conn = test_connection();

        set_app_meta(&conn, "schema_version", SCHEMA_VERSION, 1).expect("set schema_version");

        assert_eq!(
            get_app_meta(&conn, "schema_version").expect("get schema_version"),
            Some(SCHEMA_VERSION.to_string()),
        );
    }

    #[test]
    fn profile_upsert_and_get_round_trip() {
        let conn = test_connection();
        let profile = ProfileDocument::smoke(100);

        upsert_profile(&conn, &profile).expect("upsert profile");
        let stored = get_profile(&conn)
            .expect("get profile")
            .expect("profile exists");

        assert_eq!(stored.id, PROFILE_ID_DEFAULT);
        assert_eq!(stored.target_city.as_deref(), Some("Suzhou"));
        assert_eq!(stored.target_role.as_deref(), Some("Frontend Developer"));
        assert_eq!(stored.expected_salary.as_deref(), Some("20-25K"));
        assert_eq!(stored.data_json["targetCity"], "Suzhou");
    }

    #[test]
    fn job_repository_crud_and_ordering() {
        let conn = test_connection();
        let older = JobDocument::smoke("job-old", 10);
        let newer = JobDocument::smoke("job-new", 20);

        upsert_job(&conn, &older).expect("upsert older job");
        upsert_job(&conn, &newer).expect("upsert newer job");

        let stored = require_job(&conn, "job-new").expect("get newer job");
        assert_eq!(stored.company, "T3 Test Co");
        assert_eq!(stored.followup_count, 1);
        assert_eq!(stored.high_value_signal, 1);
        assert_eq!(stored.data_json["id"], "job-new");

        let listed = list_jobs_by_updated_desc(&conn).expect("list jobs");
        assert_eq!(
            listed.iter().map(|job| job.id.as_str()).collect::<Vec<_>>(),
            vec!["job-new", "job-old"],
        );

        assert!(delete_job(&conn, "job-old").expect("delete existing job"));
        assert!(!delete_job(&conn, "missing").expect("delete missing job"));
        assert!(matches!(
            require_job(&conn, "job-old"),
            Err(StorageError::NotFound { .. }),
        ));
    }
}
