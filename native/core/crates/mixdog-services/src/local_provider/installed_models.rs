//! The model picker's view of the local provider: the installed models, read from the catalog.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::providers::local::listing::InstalledModels;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError};
use serde_json::Value;

use super::catalog::Catalog;

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
