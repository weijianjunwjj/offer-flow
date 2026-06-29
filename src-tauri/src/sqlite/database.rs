use super::error::{StorageError, StorageResult};
use super::schema::initialize_schema;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub fn app_database_path(app: &AppHandle, file_name: &str) -> StorageResult<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| StorageError::database_open(error.to_string()))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|error| StorageError::database_open(error.to_string()))?;

    Ok(app_data_dir.join(file_name))
}

pub fn open_initialized_database(path: &Path) -> StorageResult<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| StorageError::database_open(error.to_string()))?;
    }

    let mut conn =
        Connection::open(path).map_err(|error| StorageError::database_open(error.to_string()))?;
    initialize_schema(&mut conn)?;
    Ok(conn)
}

pub fn unix_timestamp() -> StorageResult<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|error| StorageError::write("app_meta", error.to_string()))
}
