//! The seam where blob references in a request's params are expanded before the method is dispatched.
//!
//! A payload above the inbound frame bound (`limits.maxInboundFrameBytes`) travels as a `blob/put` upload and the request
//! names it with `{"$blobRef": digest, "as": "text" | "base64"}` where the string would be. The server does not know how a
//! blob store is read: the composition installs a [`ParamRefs`] once (`BlobParamRefs` of `mixdog-core-domains`), and until
//! it does, [`expand`] leaves every request as it came.

use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_rt::CancellationToken;
use serde_json::Value;

/// Replaces the blob references of one request's params by the blobs they name.
#[async_trait]
pub trait ParamRefs: Send + Sync {
    /// Rewrites `params` of `method` in place. A reference at a place the method does not list, a blob that is not in the
    /// store, one that is not UTF-8 where text was asked, or an expansion above the limit, is refused with the error the
    /// caller answers with.
    async fn expand(&self, method: &str, params: &mut Value, cancel: &CancellationToken) -> Result<(), CoreError>;
}

static INSTALLED: OnceLock<Arc<dyn ParamRefs>> = OnceLock::new();

/// Installs the expander of the process; the second call is refused and hands its argument back.
pub fn install(refs: Arc<dyn ParamRefs>) -> Result<(), Arc<dyn ParamRefs>> {
    INSTALLED.set(refs)
}

/// Expands the blob references of `params`; nothing happens while no expander is installed.
pub async fn expand(method: &str, params: &mut Value, cancel: &CancellationToken) -> Result<(), CoreError> {
    match INSTALLED.get() {
        Some(refs) => refs.expand(method, params, cancel).await,
        None => Ok(()),
    }
}
