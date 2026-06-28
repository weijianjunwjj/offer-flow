use serde::Serialize;
use std::fmt;

pub type StorageResult<T> = Result<T, StorageError>;

#[derive(Debug)]
pub enum StorageError {
    DatabaseOpen {
        message: String,
    },
    SchemaInit {
        message: String,
    },
    JsonSerialize {
        message: String,
    },
    JsonDeserialize {
        message: String,
    },
    Write {
        entity: &'static str,
        message: String,
    },
    Query {
        entity: &'static str,
        message: String,
    },
    NotFound {
        entity: &'static str,
        id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageErrorPayload {
    pub code: &'static str,
    pub message: String,
}

impl StorageError {
    pub fn database_open(message: impl Into<String>) -> Self {
        Self::DatabaseOpen {
            message: message.into(),
        }
    }

    pub fn schema_init(message: impl Into<String>) -> Self {
        Self::SchemaInit {
            message: message.into(),
        }
    }

    pub fn json_serialize(message: impl Into<String>) -> Self {
        Self::JsonSerialize {
            message: message.into(),
        }
    }

    pub fn json_deserialize(message: impl Into<String>) -> Self {
        Self::JsonDeserialize {
            message: message.into(),
        }
    }

    pub fn write(entity: &'static str, message: impl Into<String>) -> Self {
        Self::Write {
            entity,
            message: message.into(),
        }
    }

    pub fn query(entity: &'static str, message: impl Into<String>) -> Self {
        Self::Query {
            entity,
            message: message.into(),
        }
    }

    pub fn not_found(entity: &'static str, id: impl Into<String>) -> Self {
        Self::NotFound {
            entity,
            id: id.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::DatabaseOpen { .. } => "database_open_failed",
            Self::SchemaInit { .. } => "schema_init_failed",
            Self::JsonSerialize { .. } => "json_serialize_failed",
            Self::JsonDeserialize { .. } => "json_deserialize_failed",
            Self::Write { .. } => "write_failed",
            Self::Query { .. } => "query_failed",
            Self::NotFound { .. } => "not_found",
        }
    }

    pub fn user_message(&self) -> String {
        match self {
            Self::DatabaseOpen { .. } => "SQLite database could not be opened.".to_string(),
            Self::SchemaInit { .. } => "SQLite schema could not be initialized.".to_string(),
            Self::JsonSerialize { .. } => "Record could not be serialized to JSON.".to_string(),
            Self::JsonDeserialize { .. } => "Record JSON could not be read back.".to_string(),
            Self::Write { entity, .. } => format!("SQLite write failed for {entity}."),
            Self::Query { entity, .. } => format!("SQLite query failed for {entity}."),
            Self::NotFound { entity, id } => {
                format!("SQLite record not found in {entity}: {id}")
            }
        }
    }

    pub fn technical_message(&self) -> String {
        match self {
            Self::DatabaseOpen { message }
            | Self::SchemaInit { message }
            | Self::JsonSerialize { message }
            | Self::JsonDeserialize { message } => message.clone(),
            Self::Write { entity, message } | Self::Query { entity, message } => {
                format!("{entity}: {message}")
            }
            Self::NotFound { entity, id } => format!("{entity}: {id}"),
        }
    }

    pub fn payload(&self) -> StorageErrorPayload {
        StorageErrorPayload {
            code: self.code(),
            message: self.user_message(),
        }
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.user_message())
    }
}

impl std::error::Error for StorageError {}
