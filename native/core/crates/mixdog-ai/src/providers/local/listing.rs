//! `mixdog-local` model listing: the models installed on this machine. The
//! managed runtime owns what is installed (weights on disk, registered
//! models, context settings); the listing asks it and lists every row it
//! returns. It needs no running server and no network.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ProviderError;
use serde_json::Value;

use crate::providers::listing_row;

/// The installed models in the shape the model picker lists them
/// (`installedLocalProviderModels`).
#[async_trait]
pub trait InstalledModels: Send + Sync {
    async fn installed(&self) -> Result<Vec<Value>, ProviderError>;
}

pub struct LocalListing {
    installed: Arc<dyn InstalledModels>,
}

impl LocalListing {
    pub fn new(installed: Arc<dyn InstalledModels>) -> Self {
        Self { installed }
    }
}

#[async_trait]
impl ModelListing for LocalListing {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        let rows = self.installed.installed().await?;
        Ok(rows
            .into_iter()
            .filter_map(|row| match row {
                Value::Object(row) => Some(listing_row::record(row)),
                _ => None,
            })
            .collect())
    }
}
