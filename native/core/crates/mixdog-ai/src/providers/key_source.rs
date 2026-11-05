//! The API key an adapter sends, shared by every family that authenticates
//! with a plain key.

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderError;

/// The key a request carries. `reload` re-reads it after the server rejected
/// the current one.
#[async_trait]
pub trait ApiKeySource: Send + Sync {
    async fn key(&self) -> Result<String, ProviderError>;
    async fn reload(&self) -> Result<String, ProviderError>;
}
