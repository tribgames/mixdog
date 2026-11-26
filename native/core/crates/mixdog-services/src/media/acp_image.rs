//! Seam for ACP-backed image generation lanes (currently `acp-antigravity` via Antigravity's
//! built-in `generate_image` tool over ACP). `mixdog-services` defines this trait without
//! depending on `mixdog-acp`; `mixdog-app-server-daemon` supplies the concrete adapter.

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::catalog::CatalogFailure;
use super::jobs::MediaFailure;

pub const ACP_ANTIGRAVITY_LANE: &str = "acp-antigravity";
pub const ACP_ANTIGRAVITY_MODEL_ID: &str = "antigravity-image";
pub const ACP_ANTIGRAVITY_MODEL_LABEL: &str = "Antigravity Image";

#[derive(Clone, Debug)]
pub struct AcpImageReference {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct AcpImageRequest {
    pub provider: String,
    pub prompt: String,
    pub aspect_ratio: Option<String>,
    pub references: Vec<AcpImageReference>,
}

#[derive(Clone, Debug)]
pub struct AcpImageReply {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub revised_prompt: Option<String>,
    pub usage: Option<Value>,
}

#[async_trait]
pub trait AcpImageBackend: Send + Sync {
    /// File-level credential/readiness check (never spawns an ACP server or starts a check).
    async fn authenticated(&self, provider: &str) -> bool;
    /// Plain-language cause when `authenticated` is false for a reason other than sign-in
    /// (ACP agents turned off, not installed, unsupported, or version too old).
    async fn unavailable_reason(&self, _provider: &str) -> Option<String> {
        None
    }
    /// Returns the image model rows advertised by `provider`.
    async fn catalog_models(&self, provider: &str) -> Result<Vec<Value>, CatalogFailure>;
    /// Runs one isolated image-only ACP turn to generate or edit an image.
    async fn generate(&self, request: AcpImageRequest, cancel: &CancellationToken) -> Result<AcpImageReply, MediaFailure>;
}
