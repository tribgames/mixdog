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
    /// The key and the endpoint that must be used with it. An identity lookup does not discover endpoints.
    async fn routed_key(&self, _discover: bool) -> Result<(String, Option<String>), ProviderError> {
        self.key().await.map(|key| (key, None))
    }
    fn opencode_auth(&self) -> Option<&super::compat::login::opencode_go::OpenCodeGoAuth> {
        None
    }
}
