mod sqlite;

use serde_json::Value;
use sqlite::adapter::{StorageMigrationStatusResult, T7AdapterSmokeResult};
use sqlite::backup::LocalStorageBackupWriteResult;
use sqlite::error::StorageErrorPayload;
use sqlite::migration::LocalStorageMigrationResult;
use sqlite::models::T3RepositorySmokeResult;
use tauri::AppHandle;

#[tauri::command]
fn sqlite_t3_check(app: AppHandle) -> Result<T3RepositorySmokeResult, String> {
    sqlite::run_t3_repository_smoke(&app).map_err(|error| error.payload().message)
}

#[tauri::command]
fn write_localstorage_backup(
    app: AppHandle,
    payload_json: String,
) -> Result<LocalStorageBackupWriteResult, String> {
    sqlite::backup::write_localstorage_backup(&app, &payload_json)
        .map_err(|error| error.payload().message)
}

#[tauri::command]
fn migrate_localstorage_to_sqlite(
    app: AppHandle,
    migration_payload_json: String,
) -> Result<LocalStorageMigrationResult, StorageErrorPayload> {
    sqlite::migration::migrate_localstorage_to_sqlite(&app, &migration_payload_json)
        .map_err(|error| error.payload())
}

#[tauri::command]
fn sqlite_get_profile(app: AppHandle) -> Result<Option<Value>, StorageErrorPayload> {
    sqlite::adapter::sqlite_get_profile(&app).map_err(|error| error.payload())
}

#[tauri::command]
fn sqlite_save_profile(
    app: AppHandle,
    profile_json: String,
) -> Result<Value, StorageErrorPayload> {
    sqlite::adapter::sqlite_save_profile(&app, &profile_json).map_err(|error| error.payload())
}

#[tauri::command]
fn sqlite_clear_profile(app: AppHandle) -> Result<bool, StorageErrorPayload> {
    sqlite::adapter::sqlite_clear_profile(&app).map_err(|error| error.payload())
}

#[tauri::command]
fn sqlite_create_job(app: AppHandle, job_json: String) -> Result<Value, StorageErrorPayload> {
    sqlite::adapter::sqlite_create_job(&app, &job_json).map_err(|error| error.payload())
}

#[tauri::command]
fn sqlite_get_job(app: AppHandle, id: String) -> Result<Option<Value>, StorageErrorPayload> {
    sqlite::adapter::sqlite_get_job(&app, &id).map_err(|error| error.payload())
}

#[tauri::command]
fn sqlite_list_jobs(app: AppHandle) -> Result<Vec<Value>, StorageErrorPayload> {
    sqlite::adapter::sqlite_list_jobs(&app).map_err(|error| error.payload())
}

#[tauri::command]
fn sqlite_update_job(app: AppHandle, job_json: String) -> Result<Value, StorageErrorPayload> {
    sqlite::adapter::sqlite_update_job(&app, &job_json).map_err(|error| error.payload())
}

#[tauri::command]
fn sqlite_delete_job(app: AppHandle, id: String) -> Result<bool, StorageErrorPayload> {
    sqlite::adapter::sqlite_delete_job(&app, &id).map_err(|error| error.payload())
}

#[tauri::command]
fn sqlite_get_storage_migration_status(
    app: AppHandle,
) -> Result<StorageMigrationStatusResult, StorageErrorPayload> {
    sqlite::adapter::sqlite_get_storage_migration_status(&app).map_err(|error| error.payload())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                match sqlite::run_t3_repository_smoke(&app.handle()) {
                    Ok(result) => println!(
                        "[OfferFlow T3 SQLite Repository] db_path={} schema_version={} profile_id={} job_id={} listed_jobs={} remaining_jobs={}",
                        result.db_path,
                        result.schema_version,
                        result.profile_id,
                        result.job_id,
                        result.listed_job_ids.join(","),
                        result.remaining_job_count
                    ),
                    Err(error) => eprintln!(
                        "[OfferFlow T3 SQLite Repository] failed: {} ({})",
                        error.payload().message,
                        error.technical_message()
                    ),
                }

                match sqlite::backup::run_t4_backup_smoke(&app.handle()) {
                    Ok(result) => println!(
                        "[OfferFlow T4 LocalStorage Backup] backup_path={} checksum={} size_bytes={} profile_count={} job_count={} raw_entries={} backup_log_id={}",
                        result.backup_path,
                        result.checksum,
                        result.size_bytes,
                        result.profile_count,
                        result.job_count,
                        result.raw_entry_count,
                        result.backup_log_id
                    ),
                    Err(error) => eprintln!(
                        "[OfferFlow T4 LocalStorage Backup] failed: {} ({})",
                        error.payload().message,
                        error.technical_message()
                    ),
                }

                match sqlite::migration::run_t5_migration_smoke(&app.handle()) {
                    Ok(result) => println!(
                        "[OfferFlow T5 LocalStorage Migration] migration_id={} status={} profile_count={} job_count={} backup_checksum={} migration_status={}",
                        result.migration_id,
                        result.status,
                        result.profile_count,
                        result.job_count,
                        result.backup_checksum,
                        result.migration_status
                    ),
                    Err(error) => eprintln!(
                        "[OfferFlow T5 LocalStorage Migration] failed: {} ({})",
                        error.payload().message,
                        error.technical_message()
                    ),
                }

                match sqlite::adapter::run_t7_adapter_smoke(&app.handle()) {
                    Ok(T7AdapterSmokeResult {
                        db_path,
                        profile_target_city,
                        created_job_id,
                        listed_job_ids,
                        updated_job_match_score,
                        patch_preserved_ai_raw,
                        deleted_job_missing,
                    }) => println!(
                        "[OfferFlow T7 SQLite Adapter] db_path={} profile_target_city={} created_job_id={} listed_jobs={} updated_match_score={} patch_preserved_ai_raw={} deleted_job_missing={}",
                        db_path,
                        profile_target_city,
                        created_job_id,
                        listed_job_ids.join(","),
                        updated_job_match_score,
                        patch_preserved_ai_raw,
                        deleted_job_missing
                    ),
                    Err(error) => eprintln!(
                        "[OfferFlow T7 SQLite Adapter] failed: {} ({})",
                        error.payload().message,
                        error.technical_message()
                    ),
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sqlite_t3_check,
            write_localstorage_backup,
            migrate_localstorage_to_sqlite,
            sqlite_get_profile,
            sqlite_save_profile,
            sqlite_clear_profile,
            sqlite_create_job,
            sqlite_get_job,
            sqlite_list_jobs,
            sqlite_update_job,
            sqlite_delete_job,
            sqlite_get_storage_migration_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
