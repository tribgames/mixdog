//! The model picker's view of the local provider: the installed models, read from the catalog.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::providers::local::Endpoint;
use mixdog_ai::providers::local::LocalRuntime;
use mixdog_ai::providers::local::listing::InstalledModels;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError};
use serde_json::Value;

use super::catalog::Catalog;
use super::provider::LocalProvider;

/// `InstalledModels` over [`Catalog::installed_models`]; compose passes it to `LocalListing::new`.
pub struct CatalogInstalledModels(pub Arc<Catalog>);

#[async_trait]
impl InstalledModels for CatalogInstalledModels {
    async fn installed(&self) -> Result<Vec<Value>, ProviderError> {
        self.0.installed_models().await.map_err(|e| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
            error.message = e.to_string();
            error
        })
    }
}

/// The managed runtime as the registered `mixdog-local` provider uses it: the installed models, and the server
/// [`LocalProvider::ensure_server`] starts (or reuses) for a model.
pub struct ManagedRuntime(pub Arc<LocalProvider>);

#[async_trait]
impl InstalledModels for ManagedRuntime {
    async fn installed(&self) -> Result<Vec<Value>, ProviderError> {
        CatalogInstalledModels(self.0.catalog.clone()).installed().await
    }
}

#[async_trait]
impl LocalRuntime for ManagedRuntime {
    async fn ensure_server(&self, model: &str) -> Result<Endpoint, ProviderError> {
        let ready = self.0.ensure_server(model, None).await.map_err(|e| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
            error.message = e.to_string();
            error
        })?;
        let text = |key: &str| ready[key].as_str().unwrap_or_default().to_owned();
        Ok(Endpoint { base_url: text("baseURL"), api_key: text("apiKey") })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_empty_data_dir_lists_no_installed_models() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = super::super::catalog::tests::catalog(dir.path());
        assert!(CatalogInstalledModels(catalog).installed().await.unwrap().is_empty());
    }
}
