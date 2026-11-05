//! One error type for the memory services. `Rejected` carries the exact
//! user-facing sentence a tool call shows; every other variant is an
//! infrastructure failure whose text is for logs.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum MemoryError {
    /// A request the caller must change. The text is shown to the model verbatim.
    #[error("{0}")]
    Rejected(String),
    #[error("postgres: {0}")]
    Pg(#[from] tokio_postgres::Error),
    #[error("postgres pool: {0}")]
    Pool(String),
    #[error("postgres runtime: {0}")]
    Runtime(String),
    #[error("embedding: {0}")]
    Embedding(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("cancelled")]
    Cancelled,
}

impl MemoryError {
    pub fn rejected(text: impl Into<String>) -> Self {
        Self::Rejected(text.into())
    }

    /// The sentence a tool call reports for this failure.
    pub fn message(&self) -> String {
        match self {
            Self::Rejected(text) => text.clone(),
            other => other.to_string(),
        }
    }
}

impl From<deadpool_postgres::PoolError> for MemoryError {
    fn from(error: deadpool_postgres::PoolError) -> Self {
        Self::Pool(error.to_string())
    }
}

pub type Result<T, E = MemoryError> = std::result::Result<T, E>;
