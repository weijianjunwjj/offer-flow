use super::database::{app_database_path, open_initialized_database, unix_timestamp};
use super::error::{StorageError, StorageResult};
use super::repository::PROFILE_ID_DEFAULT;
use super::T3_SMOKE_DB_FILE;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

const MIGRATION_TYPE_LOCALSTORAGE_TO_SQLITE: &str = "localstorage_to_sqlite";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMigrationStatusResult {
    pub migration_status: Option<String>,
    pub last_migration_status: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct T7AdapterSmokeResult {
    pub db_path: String,
    pub profile_target_city: String,
    pub created_job_id: String,
    pub listed_job_ids: Vec<String>,
    pub updated_job_match_score: String,
    pub patch_preserved_ai_raw: bool,
    pub deleted_job_missing: bool,
}

pub fn sqlite_get_profile(app: &AppHandle) -> StorageResult<Option<Value>> {
    let conn = open_app_database(app)?;
    get_profile_value(&conn)
}

pub fn sqlite_save_profile(app: &AppHandle, profile_json: &str) -> StorageResult<Value> {
    let conn = open_app_database(app)?;
    let profile = parse_json_object(profile_json, "profiles")?;
    save_profile_value(&conn, &profile, unix_timestamp()? * 1000)?;
    Ok(profile)
}

pub fn sqlite_clear_profile(app: &AppHandle) -> StorageResult<bool> {
    let conn = open_app_database(app)?;
    clear_profile_value(&conn)
}

pub fn sqlite_create_job(app: &AppHandle, job_json: &str) -> StorageResult<Value> {
    let conn = open_app_database(app)?;
    let job = parse_json_object(job_json, "jobs")?;
    upsert_job_value(&conn, &job)?;
    Ok(job)
}

pub fn sqlite_get_job(app: &AppHandle, id: &str) -> StorageResult<Option<Value>> {
    let conn = open_app_database(app)?;
    get_job_value(&conn, id)
}

pub fn sqlite_list_jobs(app: &AppHandle) -> StorageResult<Vec<Value>> {
    let conn = open_app_database(app)?;
    list_job_values_by_updated_desc(&conn)
}

pub fn sqlite_update_job(app: &AppHandle, job_json: &str) -> StorageResult<Value> {
    let conn = open_app_database(app)?;
    let job = parse_json_object(job_json, "jobs")?;
    upsert_job_value(&conn, &job)?;
    Ok(job)
}

pub fn sqlite_delete_job(app: &AppHandle, id: &str) -> StorageResult<bool> {
    let conn = open_app_database(app)?;
    delete_job_value(&conn, id)
}

pub fn sqlite_get_storage_migration_status(
    app: &AppHandle,
) -> StorageResult<StorageMigrationStatusResult> {
    let conn = open_app_database(app)?;
    Ok(StorageMigrationStatusResult {
        migration_status: get_app_meta_value(&conn, "migration_status")?,
        last_migration_status: get_last_migration_status(&conn)?,
    })
}

pub fn run_t7_adapter_smoke(app: &AppHandle) -> StorageResult<T7AdapterSmokeResult> {
    let now = unix_timestamp()? * 1000;
    let db_path = app_database_path(app, &format!("offerflow-t7-adapter-smoke-{now}.sqlite3"))?;
    let conn = open_initialized_database(&db_path)?;

    let profile = json!({
        "resumeText": "T7 smoke resume",
        "projectExperience": "T7 smoke project",
        "targetCity": "Suzhou",
        "targetRole": "Frontend Developer",
        "expectedSalary": "20-25K",
        "acceptOutsourcing": false,
        "acceptOvertime": true,
        "jobSearchFocus": "growth",
        "weaknessNote": ""
    });
    save_profile_value(&conn, &profile, now)?;
    let stored_profile = get_profile_value(&conn)?
        .ok_or_else(|| StorageError::not_found("profiles", PROFILE_ID_DEFAULT))?;

    let old_job = smoke_job("t7-smoke-job-old", now - 10_000, "T7 Old Co");
    let new_job = smoke_job("t7-smoke-job-new", now, "T7 New Co");
    upsert_job_value(&conn, &old_job)?;
    upsert_job_value(&conn, &new_job)?;

    let created_job = get_job_value(&conn, "t7-smoke-job-new")?
        .ok_or_else(|| StorageError::not_found("jobs", "t7-smoke-job-new"))?;
    let listed_job_ids = list_job_values_by_updated_desc(&conn)?
        .iter()
        .map(|job| read_string(job, "id").unwrap_or_default())
        .collect::<Vec<_>>();

    let mut updated_job = created_job.clone();
    if let Value::Object(map) = &mut updated_job {
        map.insert("matchScore".to_string(), Value::String("91".to_string()));
        map.insert("updatedAt".to_string(), Value::Number((now + 1).into()));
    }
    upsert_job_value(&conn, &updated_job)?;
    let stored_updated_job = get_job_value(&conn, "t7-smoke-job-new")?
        .ok_or_else(|| StorageError::not_found("jobs", "t7-smoke-job-new"))?;

    delete_job_value(&conn, "t7-smoke-job-old")?;
    let deleted_job_missing = get_job_value(&conn, "t7-smoke-job-old")?.is_none();

    Ok(T7AdapterSmokeResult {
        db_path: db_path.display().to_string(),
        profile_target_city: read_string(&stored_profile, "targetCity").unwrap_or_default(),
        created_job_id: read_string(&created_job, "id").unwrap_or_default(),
        listed_job_ids,
        updated_job_match_score: read_string(&stored_updated_job, "matchScore")
            .unwrap_or_default(),
        patch_preserved_ai_raw: read_string(&stored_updated_job, "aiRawResult")
            == read_string(&created_job, "aiRawResult"),
        deleted_job_missing,
    })
}

fn open_app_database(app: &AppHandle) -> StorageResult<Connection> {
    let db_path = app_database_path(app, T3_SMOKE_DB_FILE)?;
    open_initialized_database(&db_path)
}

fn get_app_meta_value(conn: &Connection, key: &str) -> StorageResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM app_meta WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| StorageError::query("app_meta", error.to_string()))
}

fn get_last_migration_status(conn: &Connection) -> StorageResult<Option<String>> {
    conn.query_row(
        "SELECT status
         FROM migration_logs
         WHERE migration_type = ?1
         ORDER BY started_at DESC
         LIMIT 1",
        params![MIGRATION_TYPE_LOCALSTORAGE_TO_SQLITE],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| StorageError::query("migration_logs", error.to_string()))
}

fn parse_json_object(raw: &str, entity: &'static str) -> StorageResult<Value> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| StorageError::json_deserialize(error.to_string()))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(StorageError::query(entity, "payload must be a JSON object"))
    }
}

fn save_profile_value(conn: &Connection, profile: &Value, updated_at: i64) -> StorageResult<()> {
    let data_json = serde_json::to_string(profile)
        .map_err(|error| StorageError::json_serialize(error.to_string()))?;

    conn.execute(
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
            read_string(profile, "targetCity"),
            read_string(profile, "targetRole"),
            read_string(profile, "expectedSalary"),
            updated_at,
            data_json,
        ],
    )
    .map(|_| ())
    .map_err(|error| StorageError::write("profiles", error.to_string()))
}

fn get_profile_value(conn: &Connection) -> StorageResult<Option<Value>> {
    conn.query_row(
        "SELECT data_json FROM profiles WHERE id = ?1",
        params![PROFILE_ID_DEFAULT],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| StorageError::query("profiles", error.to_string()))?
    .map(|raw| {
        serde_json::from_str(&raw)
            .map_err(|error| StorageError::json_deserialize(error.to_string()))
    })
    .transpose()
}

fn clear_profile_value(conn: &Connection) -> StorageResult<bool> {
    conn.execute(
        "DELETE FROM profiles WHERE id = ?1",
        params![PROFILE_ID_DEFAULT],
    )
    .map(|deleted| deleted > 0)
    .map_err(|error| StorageError::write("profiles", error.to_string()))
}

fn upsert_job_value(conn: &Connection, job: &Value) -> StorageResult<()> {
    let columns = JobColumns::from_value(job)?;
    let data_json = serde_json::to_string(job)
        .map_err(|error| StorageError::json_serialize(error.to_string()))?;

    conn.execute(
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

fn get_job_value(conn: &Connection, id: &str) -> StorageResult<Option<Value>> {
    conn.query_row(
        "SELECT data_json FROM jobs WHERE id = ?1",
        params![id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| StorageError::query("jobs", error.to_string()))?
    .map(|raw| {
        serde_json::from_str(&raw)
            .map_err(|error| StorageError::json_deserialize(error.to_string()))
    })
    .transpose()
}

fn list_job_values_by_updated_desc(conn: &Connection) -> StorageResult<Vec<Value>> {
    let mut statement = conn
        .prepare("SELECT data_json FROM jobs ORDER BY updated_at DESC")
        .map_err(|error| StorageError::query("jobs", error.to_string()))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| StorageError::query("jobs", error.to_string()))?;

    let mut jobs = Vec::new();
    for row in rows {
        let raw = row.map_err(|error| StorageError::query("jobs", error.to_string()))?;
        match serde_json::from_str::<Value>(&raw) {
            Ok(job) => jobs.push(job),
            Err(error) => eprintln!("[OfferFlow] skipped corrupted SQLite job: {error}"),
        }
    }
    Ok(jobs)
}

fn delete_job_value(conn: &Connection, id: &str) -> StorageResult<bool> {
    conn.execute("DELETE FROM jobs WHERE id = ?1", params![id])
        .map(|deleted| deleted > 0)
        .map_err(|error| StorageError::write("jobs", error.to_string()))
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
        "jdText": "T7 smoke JD",
        "promptText": "",
        "aiRawResult": "T7 smoke raw AI result",
        "aiPastedAt": updated_at - 500,
        "parseStatus": "parsed",
        "report": null,
        "matchScore": "82",
        "companyInput": {
            "sizeTier": "medium",
            "staffRange": "",
            "companyType": "",
            "financingStage": "",
            "commuteTime": "",
            "commuteWay": "",
            "companyNote": "",
            "opportunityNote": ""
        },
        "companyAssessment": null,
        "opportunityAnalysis": {
            "opportunityScore": 78,
            "applyAdvice": "ok",
            "riskLevel": "medium"
        },
        "communicationStatus": "greeted_unread",
        "followupCount": 1,
        "highValueSignal": true
    })
}

fn read_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn read_i64(value: &Value, field: &str) -> Option<i64> {
    value.get(field).and_then(Value::as_i64)
}

fn read_bool(value: &Value, field: &str) -> Option<bool> {
    value.get(field).and_then(Value::as_bool)
}

fn read_nested_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_str().map(ToString::to_string)
}

fn read_nested_i64(value: &Value, path: &[&str]) -> Option<i64> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_i64()
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
    fn from_value(job: &Value) -> StorageResult<Self> {
        let id = read_string(job, "id")
            .ok_or_else(|| StorageError::query("jobs", "job id missing"))?;
        let updated_at = read_i64(job, "updatedAt")
            .ok_or_else(|| StorageError::query("jobs", format!("updatedAt missing: {id}")))?;

        Ok(Self {
            id,
            created_at: read_i64(job, "createdAt").unwrap_or(updated_at),
            updated_at,
            company: read_string(job, "company").unwrap_or_default(),
            role: read_string(job, "role").unwrap_or_default(),
            city: read_string(job, "city"),
            salary_range: read_string(job, "salaryRange"),
            communication_status: read_string(job, "communicationStatus"),
            parse_status: read_string(job, "parseStatus"),
            ai_pasted_at: read_i64(job, "aiPastedAt"),
            match_score: read_string(job, "matchScore"),
            opportunity_score: read_nested_i64(job, &["opportunityAnalysis", "opportunityScore"]),
            apply_advice: read_nested_string(job, &["report", "applyAdvice"])
                .or_else(|| read_nested_string(job, &["opportunityAnalysis", "applyAdvice"])),
            risk_level: read_nested_string(job, &["report", "riskLevel"])
                .or_else(|| read_nested_string(job, &["opportunityAnalysis", "riskLevel"])),
            company_size_tier: read_nested_string(job, &["companyInput", "sizeTier"])
                .or_else(|| read_nested_string(job, &["companyAssessment", "sizeTier"])),
            last_greeted_at: read_i64(job, "lastGreetedAt"),
            followup_count: read_i64(job, "followupCount").unwrap_or_default(),
            last_followup_at: read_i64(job, "lastFollowupAt"),
            high_value_signal: if read_bool(job, "highValueSignal").unwrap_or(false) {
                1
            } else {
                0
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_columns_are_derived_from_data_json() {
        let job = smoke_job("adapter-test-job", 100, "Adapter Co");
        let columns = JobColumns::from_value(&job).expect("derive columns");

        assert_eq!(columns.id, "adapter-test-job");
        assert_eq!(columns.company, "Adapter Co");
        assert_eq!(columns.updated_at, 100);
        assert_eq!(columns.communication_status.as_deref(), Some("greeted_unread"));
        assert_eq!(columns.opportunity_score, Some(78));
        assert_eq!(columns.company_size_tier.as_deref(), Some("medium"));
        assert_eq!(columns.high_value_signal, 1);
    }
}
