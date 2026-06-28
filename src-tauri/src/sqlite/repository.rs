use super::error::{StorageError, StorageResult};
use super::models::{JobDocument, ProfileDocument, StoredJob, StoredProfile};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;

pub const PROFILE_ID_DEFAULT: &str = "default";

pub fn set_app_meta(
    conn: &Connection,
    key: &str,
    value: &str,
    updated_at: i64,
) -> StorageResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO app_meta (key, value, updated_at)
         VALUES (?1, ?2, ?3)",
        params![key, value, updated_at],
    )
    .map(|_| ())
    .map_err(|error| StorageError::write("app_meta", error.to_string()))
}

pub fn get_app_meta(conn: &Connection, key: &str) -> StorageResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM app_meta WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| StorageError::query("app_meta", error.to_string()))
}

pub fn upsert_profile(conn: &Connection, profile: &ProfileDocument) -> StorageResult<()> {
    let data_json = to_json_string(profile)?;
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
            &profile.target_city,
            &profile.target_role,
            &profile.expected_salary,
            profile.updated_at,
            data_json,
        ],
    )
    .map(|_| ())
    .map_err(|error| StorageError::write("profiles", error.to_string()))
}

pub fn get_profile(conn: &Connection) -> StorageResult<Option<StoredProfile>> {
    conn.query_row(
        "SELECT id, target_city, target_role, expected_salary, updated_at, data_json
         FROM profiles
         WHERE id = ?1",
        params![PROFILE_ID_DEFAULT],
        profile_from_row,
    )
    .optional()
    .map_err(|error| StorageError::query("profiles", error.to_string()))?
    .map_or(Ok(None), |profile| profile.map(Some))
}

pub fn upsert_job(conn: &Connection, job: &JobDocument) -> StorageResult<()> {
    let data_json = to_json_string(job)?;
    let high_value_signal = if job.high_value_signal { 1_i64 } else { 0_i64 };

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
            &job.id,
            job.created_at,
            job.updated_at,
            &job.company,
            &job.role,
            &job.city,
            &job.salary_range,
            &job.communication_status,
            &job.parse_status,
            job.ai_pasted_at,
            &job.match_score,
            job.opportunity_score,
            &job.apply_advice,
            &job.risk_level,
            &job.company_size_tier,
            job.last_greeted_at,
            job.followup_count,
            job.last_followup_at,
            high_value_signal,
            data_json,
        ],
    )
    .map(|_| ())
    .map_err(|error| StorageError::write("jobs", error.to_string()))
}

pub fn get_job(conn: &Connection, id: &str) -> StorageResult<Option<StoredJob>> {
    conn.query_row(
        "SELECT
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
         FROM jobs
         WHERE id = ?1",
        params![id],
        job_from_row,
    )
    .optional()
    .map_err(|error| StorageError::query("jobs", error.to_string()))?
    .map_or(Ok(None), |job| job.map(Some))
}

pub fn require_job(conn: &Connection, id: &str) -> StorageResult<StoredJob> {
    get_job(conn, id)?.ok_or_else(|| StorageError::not_found("jobs", id))
}

pub fn list_jobs_by_updated_desc(conn: &Connection) -> StorageResult<Vec<StoredJob>> {
    let mut statement = conn
        .prepare(
            "SELECT
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
             FROM jobs
             ORDER BY updated_at DESC",
        )
        .map_err(|error| StorageError::query("jobs", error.to_string()))?;

    let rows = statement
        .query_map([], job_from_row)
        .map_err(|error| StorageError::query("jobs", error.to_string()))?;

    let mut jobs = Vec::new();
    for row in rows {
        jobs.push(row.map_err(|error| StorageError::query("jobs", error.to_string()))??);
    }
    Ok(jobs)
}

pub fn delete_job(conn: &Connection, id: &str) -> StorageResult<bool> {
    conn.execute("DELETE FROM jobs WHERE id = ?1", params![id])
        .map(|deleted| deleted > 0)
        .map_err(|error| StorageError::write("jobs", error.to_string()))
}

fn to_json_string<T: Serialize>(value: &T) -> StorageResult<String> {
    serde_json::to_string(value).map_err(|error| StorageError::json_serialize(error.to_string()))
}

fn parse_data_json(raw: String) -> StorageResult<Value> {
    serde_json::from_str(&raw).map_err(|error| StorageError::json_deserialize(error.to_string()))
}

fn profile_from_row(row: &Row<'_>) -> rusqlite::Result<StorageResult<StoredProfile>> {
    let id = row.get(0)?;
    let target_city = row.get(1)?;
    let target_role = row.get(2)?;
    let expected_salary = row.get(3)?;
    let updated_at = row.get(4)?;
    let data_json = row.get::<_, String>(5)?;
    Ok(parse_data_json(data_json).map(|data_json| StoredProfile {
        id,
        target_city,
        target_role,
        expected_salary,
        updated_at,
        data_json,
    }))
}

fn job_from_row(row: &Row<'_>) -> rusqlite::Result<StorageResult<StoredJob>> {
    let id = row.get(0)?;
    let created_at = row.get(1)?;
    let updated_at = row.get(2)?;
    let company = row.get(3)?;
    let role = row.get(4)?;
    let city = row.get(5)?;
    let salary_range = row.get(6)?;
    let communication_status = row.get(7)?;
    let parse_status = row.get(8)?;
    let ai_pasted_at = row.get(9)?;
    let match_score = row.get(10)?;
    let opportunity_score = row.get(11)?;
    let apply_advice = row.get(12)?;
    let risk_level = row.get(13)?;
    let company_size_tier = row.get(14)?;
    let last_greeted_at = row.get(15)?;
    let followup_count = row.get(16)?;
    let last_followup_at = row.get(17)?;
    let high_value_signal = row.get(18)?;
    let data_json = row.get::<_, String>(19)?;
    Ok(parse_data_json(data_json).map(|data_json| StoredJob {
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
        data_json,
    }))
}
