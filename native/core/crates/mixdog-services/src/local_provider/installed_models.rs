//! The model picker's view of the local provider: the installed models, read from the catalog.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::providers::local::Endpoint;
use mixdog_ai::providers::local::Inference;
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

fn unsent(message: String) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    error.message = message;
    error
}

/// The managed runtime as the registered `mixdog-local` provider uses it: the installed models, and the server
/// [`LocalProvider::ensure_server`] starts (or reuses) for a model.
pub struct ManagedRuntime(pub Arc<LocalProvider>);

#[async_trait]
impl InstalledModels for ManagedRuntime {
    async fn installed(&self) -> Result<Vec<Value>, ProviderError> {
        let rows = CatalogInstalledModels(self.0.catalog.clone()).installed().await?;
        self.0.note_installed(&rows);
        Ok(rows)
    }
}

/// One request's slot in the provider's queue with its measurement: dropping it ends the queue operation that holds the slot.
struct Slot {
    inference: super::model_state::Inference,
    _release: tokio::sync::oneshot::Sender<()>,
}

impl Inference for Slot {
    fn progress(&self, kind: &str) {
        self.inference.progress(kind);
    }
    fn finish(&self, input_tokens: Option<u64>, output_tokens: Option<u64>, error: Option<&str>) {
        self.inference.finish(input_tokens.map(|n| n as i64), output_tokens.map(|n| n as i64), error);
    }
}

#[async_trait]
impl LocalRuntime for ManagedRuntime {
    /// `runLocalProviderRequest` + `beginLocalInference`: the request waits its turn in the provider's serial queue, which also
    /// holds idle unload and context changes, and keeps the slot until the returned [`Slot`] is dropped.
    async fn begin(&self, model: &str) -> Result<Box<dyn Inference>, ProviderError> {
        let queued_at = tokio::time::Instant::now();
        let cancel = tokio_util::sync::CancellationToken::new();
        // A caller that stops waiting leaves the queue.
        let leaving = cancel.clone().drop_guard();
        let (turn, mut turns) = tokio::sync::mpsc::unbounded_channel();
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let queue = self.0.queue.clone();
        let refused = turn.clone();
        tokio::spawn(async move {
            let started = queue
                .run(Some(cancel), move |_| async move {
                    let _ = turn.send(Ok(()));
                    // The slot is held until the request lets go of it.
                    let _ = released.await;
                })
                .await;
            if let Err(error) = started {
                let _ = refused.send(Err(error));
            }
        });
        match turns.recv().await {
            Some(Ok(())) => {}
            Some(Err(error)) => return Err(unsent(error.to_string())),
            None => return Err(unsent("aborted".into())),
        }
        leaving.disarm();
        let inference = self.0.catalog.state.begin_inference(model, queued_at);
        Ok(Box::new(Slot { inference, _release: release }))
    }

    fn installed_now(&self) -> Option<Vec<Value>> {
        self.0.installed_rows().borrow().clone()
    }

    async fn ensure_server(&self, model: &str) -> Result<Endpoint, ProviderError> {
        let ready = self.0.ensure_server(model, None).await.map_err(|e| unsent(e.to_string()))?;
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
