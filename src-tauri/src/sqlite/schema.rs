use super::error::{StorageError, StorageResult};
use rusqlite::Connection;

pub const SCHEMA_VERSION: &str = "1";

pub fn initialize_schema(conn: &mut Connection) -> StorageResult<()> {
    let tx = conn
        .transaction()
        .map_err(|error| StorageError::schema_init(error.to_string()))?;

    tx.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            target_city TEXT,
            target_role TEXT,
            expected_salary TEXT,
            updated_at INTEGER NOT NULL,
            data_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            company TEXT NOT NULL,
            role TEXT NOT NULL,
            city TEXT,
            salary_range TEXT,
            communication_status TEXT,
            parse_status TEXT,
            ai_pasted_at INTEGER,
            match_score TEXT,
            opportunity_score INTEGER,
            apply_advice TEXT,
            risk_level TEXT,
            company_size_tier TEXT,
            last_greeted_at INTEGER,
            followup_count INTEGER NOT NULL DEFAULT 0,
            last_followup_at INTEGER,
            high_value_signal INTEGER NOT NULL DEFAULT 0,
            data_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_updated_at
            ON jobs (updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_jobs_city
            ON jobs (city);
        CREATE INDEX IF NOT EXISTS idx_jobs_communication_status
            ON jobs (communication_status);
        CREATE INDEX IF NOT EXISTS idx_jobs_opportunity_score
            ON jobs (opportunity_score);

        CREATE TABLE IF NOT EXISTS migration_logs (
            id TEXT PRIMARY KEY,
            migration_type TEXT NOT NULL,
            status TEXT NOT NULL,
            from_version TEXT,
            to_version TEXT,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            backup_path TEXT,
            profile_count_before INTEGER,
            job_count_before INTEGER,
            profile_count_after INTEGER,
            job_count_after INTEGER,
            checksum_before TEXT,
            checksum_after TEXT,
            error_message TEXT,
            data_json TEXT
        );

        CREATE TABLE IF NOT EXISTS backup_logs (
            id TEXT PRIMARY KEY,
            backup_type TEXT NOT NULL,
            status TEXT NOT NULL,
            path TEXT,
            profile_count INTEGER,
            job_count INTEGER,
            size_bytes INTEGER,
            checksum TEXT,
            created_at INTEGER NOT NULL,
            finished_at INTEGER,
            error_message TEXT,
            data_json TEXT
        );

        PRAGMA user_version = 1;
        ",
    )
    .map_err(|error| StorageError::schema_init(error.to_string()))?;

    tx.commit()
        .map_err(|error| StorageError::schema_init(error.to_string()))
}
