mod sqlite;

use sqlite::models::T3RepositorySmokeResult;
use tauri::AppHandle;

#[tauri::command]
fn sqlite_t3_check(app: AppHandle) -> Result<T3RepositorySmokeResult, String> {
    sqlite::run_t3_repository_smoke(&app).map_err(|error| error.payload().message)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .setup(|app| {
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sqlite_t3_check])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
