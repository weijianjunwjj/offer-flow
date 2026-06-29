use super::database::{app_database_path, open_initialized_database, unix_timestamp};
use super::error::{StorageError, StorageResult};
use super::repository::PROFILE_ID_DEFAULT;
use super::T3_SMOKE_DB_FILE;
use rusqlite::{params, Connection, Transaction};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::AppHandle;

const MIGRATION_TYPE_LOCALSTORAGE_TO_SQLITE: &str = "localstorage_to_sqlite";
const MIGRATION_STATUS_RUNNING: &str = "running";
const MIGRATION_STATUS_SUCCEEDED: &str = "succeeded";
const MIGRATION_STATUS_FAILED: &str = "failed";
const APP_META_MIGRATION_STATUS: &str = "migration_status";
const APP_META_LAST_SUCCESSFUL_MIGRATION_ID: &str = "last_successful_migration_id";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStorageMigrationResult {
    pub db_path: String,
    pub migration_id: String,
    pub status: String,
    pub profile_count: i64,
    pub job_count: i64,
    pub backup_checksum: String,
    pub migration_status: String,
}

pub fn migrate_localstorage_to_sqlite(
    app: &AppHandle,
    migration_payload_json: &str,
) -> StorageResult<LocalStorageMigrationResult> {
    let db_path = app_database_path(app, T3_SMOKE_DB_FILE)?;
    let mut conn = open_initialized_database(&db_path)?;
    migrate_localstorage_payload_with_conn(
        &mut conn,
        &db_path.display().to_string(),
        migration_payload_json,
    )
}

pub fn run_t5_migration_smoke(app: &AppHandle) -> StorageResult<LocalStorageMigrationResult> {
    let now_millis = unix_timestamp()? * 1000;
    let payload = json!({
        "migrationVersion": 1,
        "createdAt": now_millis,
        "source": "localStorageBackup",
        "backupChecksum": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "backupCreatedAt": now_millis - 1000,
        "profile": {
            "key": "offerflow:profile",
            "namespace": "offerflow",
            "data": {
                "resumeText": "T5 smoke resume",
                "projectExperience": "T5 smoke project",
                "targetCity": "Suzhou",
                "targetRole": "Frontend Developer",
                "expectedSalary": "20-25K",
                "acceptOutsourcing": false,
                "acceptOvertime": true,
                "jobSearchFocus": "growth",
                "weaknessNote": ""
            }
        },
        "jobs": [
            {
                "key": "offerflow:job:t5-smoke-job-new",
                "namespace": "offerflow",
                "id": "t5-smoke-job-new",
                "data": smoke_job("t5-smoke-job-new", now_millis, "T5 New Co")
            },
            {
                "key": "offerflow:job:t5-smoke-job-old",
                "namespace": "offerflow",
                "id": "t5-smoke-job-old",
                "data": smoke_job("t5-smoke-job-old", now_millis - 10_000, "T5 Old Co")
            }
        ],
        "counts": {
            "profiles": 1,
            "jobs": 2,
            "backupRawEntries": 3,
            "backupParseErrors": 0,
            "warnings": 0
        },
        "warnings": []
    });

    migrate_localstorage_to_sqlite(
        app,
        &serde_json::to_string(&payload)
            .map_err(|error| StorageError::json_serialize(error.to_string()))?,
    )
}

pub fn migrate_localstorage_payload_with_conn(
    conn: &mut Connection,
    db_path: &str,
    migration_payload_json: &str,
) -> StorageResult<LocalStorageMigrationResult> {
    let payload = parse_payload(migration_payload_json)?;
    let migration = MigrationInput::from_payload(&payload)?;
    let migration_id = migration_id(migration.created_at, &migration.backup_checksum);
    let started_at = unix_timestamp()?;

    match attempt_migration(conn, &migration, &migration_id, started_at) {
        Ok(result) => Ok(LocalStorageMigrationResult {
            db_path: db_path.to_string(),
            migration_id,
            status: MIGRATION_STATUS_SUCCEEDED.to_string(),
            profile_count: result.profile_count,
            job_count: result.job_count,
            backup_checksum: migration.backup_checksum,
            migration_status: "migrated".to_string(),
        }),
        Err(error) => {
            let _ =
                insert_failed_migration_log(conn, &migration_id, &migration, started_at, &error);
            Err(error)
        }
    }
}

fn attempt_migration(
    conn: &mut Connection,
    migration: &MigrationInput,
    migration_id: &str,
    started_at: i64,
) -> StorageResult<MigrationWriteResult> {
    let tx = conn
        .transaction()
        .map_err(|error| StorageError::write("migration_logs", error.to_string()))?;

    insert_migration_log(
        &tx,
        &MigrationLogInput {
            id: migration_id.to_string(),
            status: MIGRATION_STATUS_RUNNING,
            started_at,
            finished_at: None,
            backup_path: None,
            profile_count_before: migration.profile.as_ref().map(|_| 1).unwrap_or(0),
            job_count_before: migration.jobs.len() as i64,
            profile_count_after: None,
            job_count_after: None,
            checksum_before: Some(migration.backup_checksum.clone()),
            checksum_after: None,
            error_message: None,
            data_json: migration_log_data_json(migration),
        },
    )?;

    let profile_count = if let Some(profile) = &migration.profile {
        upsert_profile_value(&tx, profile, started_at)?;
        1
    } else {
        0
    };

    for job in &migration.jobs {
        upsert_job_value(&tx, job)?;
    }

    validate_migration(&tx, migration, profile_count)?;

    set_app_meta(&tx, APP_META_MIGRATION_STATUS, "migrated", started_at)?;
    set_app_meta(
        &tx,
        APP_META_LAST_SUCCESSFUL_MIGRATION_ID,
        migration_id,
        started_at,
    )?;

    insert_migration_log(
        &tx,
        &MigrationLogInput {
            id: migration_id.to_string(),
            status: MIGRATION_STATUS_SUCCEEDED,
            started_at,
            finished_at: Some(started_at),
            backup_path: None,
            profile_count_before: profile_count,
            job_count_before: migration.jobs.len() as i64,
            profile_count_after: Some(profile_count),
            job_count_after: Some(migration.jobs.len() as i64),
            checksum_before: Some(migration.backup_checksum.clone()),
            checksum_after: Some(migration.backup_checksum.clone()),
            error_message: None,
            data_json: migration_log_data_json(migration),
        },
    )?;

    tx.commit()
        .map_err(|error| StorageError::write("migration_logs", error.to_string()))?;

    Ok(MigrationWriteResult {
        profile_count,
        job_count: migration.jobs.len() as i64,
    })
}

fn parse_payload(payload_json: &str) -> StorageResult<Value> {
    serde_json::from_str(payload_json)
        .map_err(|error| StorageError::json_deserialize(error.to_string()))
}

fn upsert_profile_value(
    tx: &Transaction<'_>,
    profile: &MigratedProfile,
    fallback_updated_at: i64,
) -> StorageResult<()> {
    let updated_at = read_i64(&profile.data, "updatedAt").unwrap_or(fallback_updated_at * 1000);
    let data_json = serde_json::to_string(&profile.data)
        .map_err(|error| StorageError::json_serialize(error.to_string()))?;

    tx.execute(
        "INSERT OR REPLACE INTO profiles (
            id,
            target_city,
            target_role,
            expected_salary,
            updated_at,
            data_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            PROFILE_ID_DEFAULT,
            read_string(&profile.data, "targetCity"),
            read_string(&profile.data, "targetRole"),
            read_string(&profile.data, "expectedSalary"),
            updated_at,
            data_json,
        ],
    )
    .map(|_| ())
    .map_err(|error| StorageError::write("profiles", error.to_string()))
}

fn upsert_job_value(tx: &Transaction<'_>, job: &MigratedJob) -> StorageResult<()> {
    let columns = JobColumns::from_job(job)?;
    let data_json = serde_json::to_string(&sanitize_job_data(&job.data))
        .map_err(|error| StorageError::json_serialize(error.to_string()))?;

    tx.execute(
        "INSERT OR REPLACE INTO jobs (
            id,
            created_at,
            updated_at,
            company,
            role,
            city,
            salary_range,
            communication_status,
            parse_status,
            ai_pasted_at,
            match_score,
            opportunity_score,
            apply_advice,
            risk_level,
            company_size_tier,
            last_greeted_at,
            followup_count,
            last_followup_at,
            high_value_signal,
            data_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            &columns.id,
            columns.created_at,
            columns.updated_at,
            &columns.company,
            &columns.role,
            &columns.city,
            &columns.salary_range,
            &columns.communication_status,
            &columns.parse_status,
            columns.ai_pasted_at,
            &columns.match_score,
            columns.opportunity_score,
            &columns.apply_advice,
            &columns.risk_level,
            &columns.company_size_tier,
            columns.last_greeted_at,
            columns.followup_count,
            columns.last_followup_at,
            columns.high_value_signal,
            data_json,
        ],
    )
    .map(|_| ())
    .map_err(|error| StorageError::write("jobs", error.to_string()))
}

fn validate_migration(
    tx: &Transaction<'_>,
    migration: &MigrationInput,
    profile_count: i64,
) -> StorageResult<()> {
    if profile_count > 0 {
        let stored_profile_count = tx
            .query_row(
                "SELECT COUNT(*) FROM profiles WHERE id = ?1",
                params![PROFILE_ID_DEFAULT],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| StorageError::query("profiles", error.to_string()))?;
        if stored_profile_count != 1 {
            return Err(StorageError::query(
                "profiles",
                "profile migration count mismatch",
            ));
        }
    }

    for job in &migration.jobs {
        let expected = JobColumns::from_job(job)?;
        let stored = tx
            .query_row(
                "SELECT id, company, role, updated_at, communication_status, data_json
                 FROM jobs WHERE id = ?1",
                params![&expected.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .map_err(|error| StorageError::query("jobs", error.to_string()))?;

        if stored.0 != expected.id
            || stored.1 != expected.company
            || stored.2 != expected.role
            || stored.3 != expected.updated_at
            || stored.4 != expected.communication_status
        {
            return Err(StorageError::query(
                "jobs",
                format!("job key field mismatch: {}", expected.id),
            ));
        }

        let stored_json: Value = serde_json::from_str(&stored.5)
            .map_err(|error| StorageError::json_deserialize(error.to_string()))?;
        let stored_ai_raw_len = read_string(&stored_json, "aiRawResult")
            .unwrap_or_default()
            .len();
        if stored_ai_raw_len
            != read_string(&job.data, "aiRawResult")
                .unwrap_or_default()
                .len()
        {
            return Err(StorageError::query(
                "jobs",
                format!("job aiRawResult length mismatch: {}", expected.id),
            ));
        }
    }

    Ok(())
}

fn insert_failed_migration_log(
    conn: &Connection,
    migration_id: &str,
    migration: &MigrationInput,
    started_at: i64,
    error: &StorageError,
) -> StorageResult<()> {
    insert_migration_log(
        conn,
        &MigrationLogInput {
            id: migration_id.to_string(),
            status: MIGRATION_STATUS_FAILED,
            started_at,
            finished_at: Some(unix_timestamp()?),
            backup_path: None,
            profile_count_before: migration.profile.as_ref().map(|_| 1).unwrap_or(0),
            job_count_before: migration.jobs.len() as i64,
            profile_count_after: None,
            job_count_after: None,
            checksum_before: Some(migration.backup_checksum.clone()),
            checksum_after: None,
            error_message: Some(error.user_message()),
            data_json: migration_log_data_json(migration),
        },
    )
}

fn insert_migration_log(conn: &Connection, input: &MigrationLogInput) -> StorageResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO migration_logs (
            id,
            migration_type,
            status,
            from_version,
            to_version,
            started_at,
            finished_at,
            backup_path,
            profile_count_before,
            job_count_before,
            profile_count_after,
            job_count_after,
            checksum_before,
            checksum_after,
            error_message,
            data_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            &input.id,
            MIGRATION_TYPE_LOCALSTORAGE_TO_SQLITE,
            input.status,
            "localStorage",
            "sqlite-v1",
            input.started_at,
            input.finished_at,
            &input.backup_path,
            input.profile_count_before,
            input.job_count_before,
            input.profile_count_after,
            input.job_count_after,
            &input.checksum_before,
            &input.checksum_after,
            &input.error_message,
            &input.data_json,
        ],
    )
    .map(|_| ())
    .map_err(|error| StorageError::write("migration_logs", error.to_string()))
}

fn set_app_meta(conn: &Connection, key: &str, value: &str, updated_at: i64) -> StorageResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO app_meta (key, value, updated_at)
         VALUES (?1, ?2, ?3)",
        params![key, value, updated_at],
    )
    .map(|_| ())
    .map_err(|error| StorageError::write("app_meta", error.to_string()))
}

fn migration_log_data_json(migration: &MigrationInput) -> Option<String> {
    Some(
        json!({
            "warningCount": migration.warning_count,
            "backupRawEntries": migration.backup_raw_entries,
            "backupParseErrors": migration.backup_parse_errors
        })
        .to_string(),
    )
}

fn migration_id(created_at: i64, checksum: &str) -> String {
    let suffix = checksum.rsplit(':').next().unwrap_or(checksum);
    format!("localstorage-to-sqlite-{created_at}-{suffix}")
}

fn smoke_job(id: &str, updated_at: i64, company: &str) -> Value {
    json!({
        "id": id,
        "createdAt": updated_at - 1000,
        "updatedAt": updated_at,
        "company": company,
        "role": "Frontend Engineer",
        "city": "Suzhou",
        "salaryRange": "20-25K",
        "jdText": "T5 smoke JD",
        "promptText": "",
        "aiRawResult": "T5 smoke raw AI result",
        "aiPastedAt": updated_at - 500,
        "parseStatus": "parsed",
        "report": {
            "applyAdvice": "ok",
            "riskLevel": "medium"
        },
        "matchScore": "82",
        "communicationStatus": "greeted_unread",
        "companyAssessment": {
            "sizeTier": "medium"
        },
        "opportunityAnalysis": {
            "opportunityScore": 78,
            "applyAdvice": "ok"
        },
        "lastGreetedAt": updated_at - 300,
        "followupCount": 1,
        "lastFollowupAt": updated_at - 100,
        "lastCommunicationNote": "T5 smoke note",
        "highValueSignal": true,
        "strategyOverride": "low_cost_probe",
        "draftMessageText": "T5 smoke draft",
        "strategy": "should_not_persist",
        "nextAction": "should_not_persist",
        "stopLoss": false,
        "scenario": "should_not_persist",
        "companyWarning": "should_not_persist"
    })
}

fn sanitize_job_data(data: &Value) -> Value {
    let mut sanitized = data.clone();
    if let Value::Object(map) = &mut sanitized {
        for key in [
            "strategy",
            "nextAction",
            "stopLoss",
            "scenario",
            "companyWarning",
        ] {
            map.remove(key);
        }
    }
    sanitized
}

fn read_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn read_nested_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_str().map(ToString::to_string)
}

fn read_i64(value: &Value, field: &str) -> Option<i64> {
    value.get(field).and_then(Value::as_i64)
}

fn read_bool(value: &Value, field: &str) -> Option<bool> {
    value.get(field).and_then(Value::as_bool)
}

fn read_nested_i64(value: &Value, path: &[&str]) -> Option<i64> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_i64()
}

#[derive(Debug)]
struct MigrationInput {
    created_at: i64,
    backup_checksum: String,
    profile: Option<MigratedProfile>,
    jobs: Vec<MigratedJob>,
    warning_count: i64,
    backup_raw_entries: i64,
    backup_parse_errors: i64,
}

impl MigrationInput {
    fn from_payload(payload: &Value) -> StorageResult<Self> {
        let backup_checksum = payload
            .get("backupChecksum")
            .and_then(Value::as_str)
            .filter(|checksum| is_sha256_checksum(checksum))
            .ok_or_else(|| StorageError::query("migration", "backup checksum missing"))?
            .to_string();

        let profile = match payload.get("profile") {
            Some(Value::Object(profile)) => Some(MigratedProfile::from_value(profile)?),
            _ => None,
        };

        let jobs = payload
            .get("jobs")
            .and_then(Value::as_array)
            .ok_or_else(|| StorageError::query("migration", "jobs must be an array"))?
            .iter()
            .map(MigratedJob::from_value)
            .collect::<StorageResult<Vec<_>>>()?;

        Ok(Self {
            created_at: payload
                .get("createdAt")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            backup_checksum,
            profile,
            jobs,
            warning_count: payload
                .get("counts")
                .and_then(|counts| counts.get("warnings"))
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            backup_raw_entries: payload
                .get("counts")
                .and_then(|counts| counts.get("backupRawEntries"))
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            backup_parse_errors: payload
                .get("counts")
                .and_then(|counts| counts.get("backupParseErrors"))
                .and_then(Value::as_i64)
                .unwrap_or_default(),
        })
    }
}

#[derive(Debug)]
struct MigratedProfile {
    data: Value,
}

impl MigratedProfile {
    fn from_value(value: &Map<String, Value>) -> StorageResult<Self> {
        let data = value
            .get("data")
            .cloned()
            .ok_or_else(|| StorageError::query("profiles", "profile data missing"))?;
        Ok(Self { data })
    }
}

#[derive(Debug)]
struct MigratedJob {
    id: String,
    data: Value,
}

impl MigratedJob {
    fn from_value(value: &Value) -> StorageResult<Self> {
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| StorageError::query("jobs", "job id missing"))?
            .to_string();
        let data = value
            .get("data")
            .cloned()
            .ok_or_else(|| StorageError::query("jobs", "job data missing"))?;
        Ok(Self { id, data })
    }
}

struct JobColumns {
    id: String,
    created_at: i64,
    updated_at: i64,
    company: String,
    role: String,
    city: Option<String>,
    salary_range: Option<String>,
    communication_status: Option<String>,
    parse_status: Option<String>,
    ai_pasted_at: Option<i64>,
    match_score: Option<String>,
    opportunity_score: Option<i64>,
    apply_advice: Option<String>,
    risk_level: Option<String>,
    company_size_tier: Option<String>,
    last_greeted_at: Option<i64>,
    followup_count: i64,
    last_followup_at: Option<i64>,
    high_value_signal: i64,
}

impl JobColumns {
    fn from_job(job: &MigratedJob) -> StorageResult<Self> {
        let id = read_string(&job.data, "id").unwrap_or_else(|| job.id.clone());
        if id != job.id {
            return Err(StorageError::query(
                "jobs",
                format!("job id mismatch: {}", job.id),
            ));
        }
        let updated_at = read_i64(&job.data, "updatedAt")
            .ok_or_else(|| StorageError::query("jobs", format!("updatedAt missing: {id}")))?;

        Ok(Self {
            id,
            created_at: read_i64(&job.data, "createdAt").unwrap_or(updated_at),
            updated_at,
            company: read_string(&job.data, "company").unwrap_or_default(),
            role: read_string(&job.data, "role").unwrap_or_default(),
            city: read_string(&job.data, "city"),
            salary_range: read_string(&job.data, "salaryRange"),
            communication_status: read_string(&job.data, "communicationStatus"),
            parse_status: read_string(&job.data, "parseStatus"),
            ai_pasted_at: read_i64(&job.data, "aiPastedAt"),
            match_score: read_string(&job.data, "matchScore"),
            opportunity_score: read_nested_i64(
                &job.data,
                &["opportunityAnalysis", "opportunityScore"],
            ),
            apply_advice: read_nested_string(&job.data, &["report", "applyAdvice"])
                .or_else(|| read_nested_string(&job.data, &["opportunityAnalysis", "applyAdvice"])),
            risk_level: read_nested_string(&job.data, &["report", "riskLevel"])
                .or_else(|| read_nested_string(&job.data, &["opportunityAnalysis", "riskLevel"])),
            company_size_tier: read_nested_string(&job.data, &["companyInput", "sizeTier"])
                .or_else(|| read_nested_string(&job.data, &["companyAssessment", "sizeTier"])),
            last_greeted_at: read_i64(&job.data, "lastGreetedAt"),
            followup_count: read_i64(&job.data, "followupCount").unwrap_or_default(),
            last_followup_at: read_i64(&job.data, "lastFollowupAt"),
            high_value_signal: if read_bool(&job.data, "highValueSignal").unwrap_or(false) {
                1
            } else {
                0
            },
        })
    }
}

struct MigrationLogInput {
    id: String,
    status: &'static str,
    started_at: i64,
    finished_at: Option<i64>,
    backup_path: Option<String>,
    profile_count_before: i64,
    job_count_before: i64,
    profile_count_after: Option<i64>,
    job_count_after: Option<i64>,
    checksum_before: Option<String>,
    checksum_after: Option<String>,
    error_message: Option<String>,
    data_json: Option<String>,
}

struct MigrationWriteResult {
    profile_count: i64,
    job_count: i64,
}

fn is_sha256_checksum(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use rusqlite::OptionalExtension;

    #[test]
    fn migrates_profile_and_jobs_and_sets_status() {
        let mut conn = test_connection();
        let payload = test_migration_payload();

        let result =
            migrate_localstorage_payload_with_conn(&mut conn, ":memory:", &payload.to_string())
                .expect("migrate payload");

        assert_eq!(result.status, MIGRATION_STATUS_SUCCEEDED);
        assert_eq!(result.profile_count, 1);
        assert_eq!(result.job_count, 2);
        assert_eq!(result.migration_status, "migrated");

        let profile_city: String = conn
            .query_row(
                "SELECT target_city FROM profiles WHERE id = ?1",
                params![PROFILE_ID_DEFAULT],
                |row| row.get(0),
            )
            .expect("profile city");
        assert_eq!(profile_city, "Suzhou");

        let jobs = conn
            .query_row("SELECT COUNT(*) FROM jobs", [], |row| row.get::<_, i64>(0))
            .expect("job count");
        assert_eq!(jobs, 2);

        let first_job: String = conn
            .query_row(
                "SELECT id FROM jobs ORDER BY updated_at DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("first job");
        assert_eq!(first_job, "job-new");

        let sanitized_json: String = conn
            .query_row(
                "SELECT data_json FROM jobs WHERE id = ?1",
                params!["job-new"],
                |row| row.get(0),
            )
            .expect("job data_json");
        let sanitized: Value = serde_json::from_str(&sanitized_json).expect("parse job json");
        assert!(sanitized.get("aiRawResult").is_some());
        assert!(sanitized.get("lastCommunicationNote").is_some());
        assert!(sanitized.get("strategyOverride").is_some());
        assert!(sanitized.get("draftMessageText").is_some());
        assert!(sanitized.get("strategy").is_none());
        assert!(sanitized.get("nextAction").is_none());
        assert!(sanitized.get("stopLoss").is_none());
        assert!(sanitized.get("scenario").is_none());
        assert!(sanitized.get("companyWarning").is_none());

        let migration_status: String = conn
            .query_row(
                "SELECT value FROM app_meta WHERE key = ?1",
                params![APP_META_MIGRATION_STATUS],
                |row| row.get(0),
            )
            .expect("migration status");
        assert_eq!(migration_status, "migrated");

        let log_status: String = conn
            .query_row(
                "SELECT status FROM migration_logs WHERE id = ?1",
                params![result.migration_id],
                |row| row.get(0),
            )
            .expect("migration log status");
        assert_eq!(log_status, MIGRATION_STATUS_SUCCEEDED);
    }

    #[test]
    fn failed_validation_logs_failed_and_does_not_mark_migrated() {
        let mut conn = test_connection();
        let mut payload = test_migration_payload();
        payload["jobs"][0]["data"]["updatedAt"] = Value::Null;

        let result =
            migrate_localstorage_payload_with_conn(&mut conn, ":memory:", &payload.to_string());

        assert!(result.is_err());
        let migrated: Option<String> = conn
            .query_row(
                "SELECT value FROM app_meta WHERE key = ?1",
                params![APP_META_MIGRATION_STATUS],
                |row| row.get(0),
            )
            .optional()
            .expect("query migration status");
        assert_eq!(migrated, None);

        let failed_count = conn
            .query_row(
                "SELECT COUNT(*) FROM migration_logs WHERE status = ?1",
                params![MIGRATION_STATUS_FAILED],
                |row| row.get::<_, i64>(0),
            )
            .expect("failed migration log count");
        assert_eq!(failed_count, 1);
    }

    fn test_connection() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open memory database");
        super::super::schema::initialize_schema(&mut conn).expect("initialize schema");
        conn
    }

    fn test_migration_payload() -> Value {
        let now = 1_780_000_000_000_i64;
        json!({
            "migrationVersion": 1,
            "createdAt": now,
            "source": "localStorageBackup",
            "backupChecksum": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "backupCreatedAt": now - 1000,
            "profile": {
                "key": "offerflow:profile",
                "namespace": "offerflow",
                "data": {
                    "targetCity": "Suzhou",
                    "targetRole": "Frontend Developer",
                    "expectedSalary": "20-25K"
                }
            },
            "jobs": [
                {
                    "key": "offerflow:job:job-new",
                    "namespace": "offerflow",
                    "id": "job-new",
                    "data": smoke_job("job-new", now, "New Co")
                },
                {
                    "key": "offerflow:job:job-old",
                    "namespace": "offerflow",
                    "id": "job-old",
                    "data": smoke_job("job-old", now - 10_000, "Old Co")
                }
            ],
            "counts": {
                "profiles": 1,
                "jobs": 2,
                "backupRawEntries": 3,
                "backupParseErrors": 0,
                "warnings": 0
            },
            "warnings": []
        })
    }
}
