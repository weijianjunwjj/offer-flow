use rusqlite::{params, Connection};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SqliteSpikeResult {
    db_path: String,
    schema_version: String,
}

fn run_sqlite_spike(app: &AppHandle) -> Result<SqliteSpikeResult, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("failed to create app data dir: {error}"))?;

    let db_path = app_data_dir.join("offerflow-spike.sqlite3");
    let conn = Connection::open(&db_path)
        .map_err(|error| format!("failed to open sqlite database: {error}"))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|error| format!("failed to create app_meta: {error}"))?;

    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("failed to read system time: {error}"))?
        .as_secs() as i64;

    conn.execute(
        "INSERT OR REPLACE INTO app_meta (key, value, updated_at)
         VALUES (?1, ?2, ?3)",
        params!["schema_version", "1", updated_at],
    )
    .map_err(|error| format!("failed to write schema_version: {error}"))?;

    let schema_version = conn
        .query_row(
            "SELECT value FROM app_meta WHERE key = ?1",
            params!["schema_version"],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("failed to read schema_version: {error}"))?;

    Ok(SqliteSpikeResult {
        db_path: db_path.display().to_string(),
        schema_version,
    })
}

#[tauri::command]
fn sqlite_spike_check(app: AppHandle) -> Result<SqliteSpikeResult, String> {
    run_sqlite_spike(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .setup(|app| {
            match run_sqlite_spike(&app.handle()) {
                Ok(result) => println!(
                    "[OfferFlow T1 SQLite Spike] db_path={} schema_version={}",
                    result.db_path, result.schema_version
                ),
                Err(error) => eprintln!("[OfferFlow T1 SQLite Spike] failed: {error}"),
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sqlite_spike_check])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
