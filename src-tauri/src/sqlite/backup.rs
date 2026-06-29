use super::database::{app_database_path, open_initialized_database, unix_timestamp};
use super::error::{StorageError, StorageResult};
use super::T3_SMOKE_DB_FILE;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};

const BACKUP_TYPE_LOCALSTORAGE_JSON: &str = "localstorage_json";
const BACKUP_STATUS_SUCCEEDED: &str = "succeeded";
const BACKUP_STATUS_FAILED: &str = "failed";
const CHECKSUM_ALGORITHM: &str = "sha256-json-null-checksum";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStorageBackupWriteResult {
    pub db_path: String,
    pub backup_path: String,
    pub file_name: String,
    pub checksum: String,
    pub size_bytes: i64,
    pub profile_count: i64,
    pub job_count: i64,
    pub raw_entry_count: i64,
    pub backup_log_id: String,
}

pub fn write_localstorage_backup(
    app: &AppHandle,
    payload_json: &str,
) -> StorageResult<LocalStorageBackupWriteResult> {
    let db_path = app_database_path(app, T3_SMOKE_DB_FILE)?;
    let conn = open_initialized_database(&db_path)?;
    let backups_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| StorageError::database_open(error.to_string()))?
        .join("backups");

    write_localstorage_backup_to_paths(
        &conn,
        &db_path,
        &backups_dir,
        payload_json,
        unix_timestamp()?,
    )
}

pub fn run_t4_backup_smoke(app: &AppHandle) -> StorageResult<LocalStorageBackupWriteResult> {
    let now_millis = unix_timestamp()? * 1000;
    let payload = json!({
        "backupVersion": 1,
        "createdAt": now_millis,
        "source": "localStorage",
        "app": "OfferFlow",
        "namespace": "offerflow+offerpilot",
        "namespaces": ["offerflow", "offerpilot"],
        "profile": {
            "key": "offerflow:profile",
            "namespace": "offerflow",
            "data": {
                "targetCity": "Suzhou",
                "targetRole": "Frontend Developer"
            }
        },
        "profiles": [
            {
                "key": "offerflow:profile",
                "namespace": "offerflow",
                "data": {
                    "targetCity": "Suzhou",
                    "targetRole": "Frontend Developer"
                }
            }
        ],
        "jobs": [
            {
                "key": "offerflow:job:t4-smoke-job",
                "namespace": "offerflow",
                "id": "t4-smoke-job",
                "data": {
                    "id": "t4-smoke-job",
                    "company": "T4 Backup Smoke Co",
                    "role": "Frontend Engineer"
                }
            }
        ],
        "rawEntries": [
            {
                "key": "offerflow:profile",
                "value": "{\"targetCity\":\"Suzhou\",\"targetRole\":\"Frontend Developer\"}"
            },
            {
                "key": "offerflow:job:t4-smoke-job",
                "value": "{\"id\":\"t4-smoke-job\",\"company\":\"T4 Backup Smoke Co\",\"role\":\"Frontend Engineer\"}"
            }
        ],
        "counts": {
            "profiles": 1,
            "jobs": 1,
            "rawEntries": 2,
            "parseErrors": 0
        },
        "warnings": [],
        "checksum": null
    });

    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| StorageError::json_serialize(error.to_string()))?;
    write_localstorage_backup(app, &payload_json)
}

pub fn write_localstorage_backup_to_paths(
    conn: &Connection,
    db_path: &Path,
    backups_dir: &Path,
    payload_json: &str,
    unix_seconds: i64,
) -> StorageResult<LocalStorageBackupWriteResult> {
    let payload = parse_payload(payload_json)?;
    let checksum = checksum_for_payload(&payload)?;
    let final_payload = payload_with_checksum(payload, &checksum);
    let final_json = serde_json::to_string_pretty(&final_payload)
        .map_err(|error| StorageError::json_serialize(error.to_string()))?;

    let file_name = backup_file_name(unix_seconds);
    let backup_path = backups_dir.join(&file_name);
    let counts = BackupCounts::from_payload(&final_payload);
    let backup_log_id = backup_log_id(unix_seconds, &checksum);

    if let Err(error) = write_backup_file(backups_dir, &backup_path, final_json.as_bytes()) {
        let _ = insert_backup_log(
            conn,
            &BackupLogInput {
                id: backup_log_id.clone(),
                status: BACKUP_STATUS_FAILED,
                path: Some(backup_path.display().to_string()),
                counts,
                size_bytes: None,
                checksum: Some(checksum.clone()),
                created_at: unix_seconds,
                finished_at: Some(unix_seconds),
                error_message: Some(error.to_string()),
                data_json: backup_log_data_json(&file_name, counts.raw_entries),
            },
        );
        return Err(StorageError::backup_write(error.to_string()));
    }

    let size_bytes = fs::metadata(&backup_path)
        .map(|metadata| metadata.len() as i64)
        .map_err(|error| StorageError::backup_write(error.to_string()))?;

    insert_backup_log(
        conn,
        &BackupLogInput {
            id: backup_log_id.clone(),
            status: BACKUP_STATUS_SUCCEEDED,
            path: Some(backup_path.display().to_string()),
            counts,
            size_bytes: Some(size_bytes),
            checksum: Some(checksum.clone()),
            created_at: unix_seconds,
            finished_at: Some(unix_seconds),
            error_message: None,
            data_json: backup_log_data_json(&file_name, counts.raw_entries),
        },
    )?;

    Ok(LocalStorageBackupWriteResult {
        db_path: db_path.display().to_string(),
        backup_path: backup_path.display().to_string(),
        file_name,
        checksum,
        size_bytes,
        profile_count: counts.profiles,
        job_count: counts.jobs,
        raw_entry_count: counts.raw_entries,
        backup_log_id,
    })
}

fn parse_payload(payload_json: &str) -> StorageResult<Value> {
    serde_json::from_str(payload_json)
        .map_err(|error| StorageError::json_deserialize(error.to_string()))
}

fn write_backup_file(backups_dir: &Path, backup_path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    fs::create_dir_all(backups_dir)?;
    fs::write(backup_path, bytes)
}

fn insert_backup_log(conn: &Connection, input: &BackupLogInput) -> StorageResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO backup_logs (
            id,
            backup_type,
            status,
            path,
            profile_count,
            job_count,
            size_bytes,
            checksum,
            created_at,
            finished_at,
            error_message,
            data_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            &input.id,
            BACKUP_TYPE_LOCALSTORAGE_JSON,
            input.status,
            &input.path,
            input.counts.profiles,
            input.counts.jobs,
            input.size_bytes,
            &input.checksum,
            input.created_at,
            input.finished_at,
            &input.error_message,
            &input.data_json,
        ],
    )
    .map(|_| ())
    .map_err(|error| StorageError::write("backup_logs", error.to_string()))
}

fn payload_with_checksum(mut payload: Value, checksum: &str) -> Value {
    if let Value::Object(map) = &mut payload {
        map.insert("checksum".to_string(), Value::String(checksum.to_string()));
    }
    payload
}

fn checksum_for_payload(payload: &Value) -> StorageResult<String> {
    let mut payload_for_checksum = payload.clone();
    if let Value::Object(map) = &mut payload_for_checksum {
        map.insert("checksum".to_string(), Value::Null);
    }
    let bytes = serde_json::to_vec(&payload_for_checksum)
        .map_err(|error| StorageError::json_serialize(error.to_string()))?;
    let digest = Sha256::digest(bytes);
    Ok(format!("sha256:{}", hex_lower(&digest)))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn backup_file_name(unix_seconds: i64) -> String {
    format!(
        "offerflow-localstorage-backup-{}.json",
        format_utc_timestamp(unix_seconds)
    )
}

fn backup_log_id(unix_seconds: i64, checksum: &str) -> String {
    let suffix = checksum.rsplit(':').next().unwrap_or(checksum);
    format!("localstorage-json-{unix_seconds}-{suffix}")
}

fn backup_log_data_json(file_name: &str, raw_entry_count: i64) -> Option<String> {
    Some(
        json!({
            "fileName": file_name,
            "rawEntryCount": raw_entry_count,
            "checksumAlgorithm": CHECKSUM_ALGORITHM
        })
        .to_string(),
    )
}

fn format_utc_timestamp(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400);
    let seconds_of_day = unix_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

#[derive(Clone, Copy)]
struct BackupCounts {
    profiles: i64,
    jobs: i64,
    raw_entries: i64,
}

impl BackupCounts {
    fn from_payload(payload: &Value) -> Self {
        Self {
            profiles: read_count(payload, "profiles"),
            jobs: read_count(payload, "jobs"),
            raw_entries: read_count(payload, "rawEntries"),
        }
    }
}

struct BackupLogInput {
    id: String,
    status: &'static str,
    path: Option<String>,
    counts: BackupCounts,
    size_bytes: Option<i64>,
    checksum: Option<String>,
    created_at: i64,
    finished_at: Option<i64>,
    error_message: Option<String>,
    data_json: Option<String>,
}

fn read_count(payload: &Value, field: &str) -> i64 {
    payload
        .get("counts")
        .and_then(|counts| counts.get(field))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite::database::open_initialized_database;
    use rusqlite::OptionalExtension;
    use std::path::PathBuf;

    #[test]
    fn writes_backup_file_and_records_log() {
        let root = unique_temp_dir("writes-backup");
        let db_path = root.join("offerflow-test.sqlite3");
        let backups_dir = root.join("backups");
        let conn = open_initialized_database(&db_path).expect("open test database");
        let payload = test_payload();

        let result = write_localstorage_backup_to_paths(
            &conn,
            &db_path,
            &backups_dir,
            &payload.to_string(),
            1_780_000_000,
        )
        .expect("write backup");

        assert_eq!(
            result.file_name,
            "offerflow-localstorage-backup-20260528-202640.json",
        );
        assert!(PathBuf::from(&result.backup_path).exists());
        assert_eq!(result.profile_count, 1);
        assert_eq!(result.job_count, 1);
        assert_eq!(result.raw_entry_count, 2);
        assert!(result.checksum.starts_with("sha256:"));
        assert_eq!(result.checksum.len(), "sha256:".len() + 64);
        assert!(result.size_bytes > 0);

        let file_value: Value = serde_json::from_str(
            &fs::read_to_string(&result.backup_path).expect("read backup file"),
        )
        .expect("parse backup file");
        assert_eq!(file_value["checksum"], result.checksum);
        assert_eq!(file_value["rawEntries"][0]["key"], "offerflow:profile");

        let stored_status: Option<String> = conn
            .query_row(
                "SELECT status FROM backup_logs WHERE id = ?1",
                params![result.backup_log_id],
                |row| row.get(0),
            )
            .optional()
            .expect("query backup log");
        assert_eq!(stored_status.as_deref(), Some(BACKUP_STATUS_SUCCEEDED));

        let stored_checksum: Option<String> = conn
            .query_row(
                "SELECT checksum FROM backup_logs WHERE id = ?1",
                params![result.backup_log_id],
                |row| row.get(0),
            )
            .optional()
            .expect("query backup log checksum");
        assert_eq!(stored_checksum.as_deref(), Some(result.checksum.as_str()));
        assert!(stored_checksum.as_deref().is_some_and(is_sha256_checksum));
    }

    #[test]
    fn invalid_payload_is_rejected() {
        let root = unique_temp_dir("invalid-payload");
        let db_path = root.join("offerflow-test.sqlite3");
        let backups_dir = root.join("backups");
        let conn = open_initialized_database(&db_path).expect("open test database");

        let result = write_localstorage_backup_to_paths(&conn, &db_path, &backups_dir, "{bad", 1);

        assert!(matches!(result, Err(StorageError::JsonDeserialize { .. })));
    }

    fn test_payload() -> Value {
        json!({
            "backupVersion": 1,
            "createdAt": 1_780_000_000_000_i64,
            "source": "localStorage",
            "app": "OfferFlow",
            "namespace": "offerflow+offerpilot",
            "namespaces": ["offerflow", "offerpilot"],
            "profile": {
                "key": "offerflow:profile",
                "namespace": "offerflow",
                "data": { "targetCity": "Suzhou" }
            },
            "profiles": [
                {
                    "key": "offerflow:profile",
                    "namespace": "offerflow",
                    "data": { "targetCity": "Suzhou" }
                }
            ],
            "jobs": [
                {
                    "key": "offerflow:job:test",
                    "namespace": "offerflow",
                    "id": "test",
                    "data": { "id": "test", "company": "Test Co" }
                }
            ],
            "rawEntries": [
                {
                    "key": "offerflow:profile",
                    "value": "{\"targetCity\":\"Suzhou\"}"
                },
                {
                    "key": "offerflow:job:test",
                    "value": "{\"id\":\"test\",\"company\":\"Test Co\"}"
                }
            ],
            "counts": {
                "profiles": 1,
                "jobs": 1,
                "rawEntries": 2,
                "parseErrors": 0
            },
            "warnings": [],
            "checksum": null
        })
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "offerflow-t4-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ))
    }

    fn is_sha256_checksum(value: &str) -> bool {
        value
            .strip_prefix("sha256:")
            .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
    }
}
