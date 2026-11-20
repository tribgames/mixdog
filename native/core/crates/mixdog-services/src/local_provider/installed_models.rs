//! The model picker's view of the local provider: the installed models, read from the catalog.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::providers::local::Endpoint;
use mixdog_ai::providers::local::Inference;
use mixdog_ai::providers::local::LocalRuntime;
use mixdog_ai::providers::local::listing::InstalledModels;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

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
        self.0.refresh_installed().await.map_err(unsent)
    }
}

/// One request's slot in the provider's queue with its measurement: dropping it ends the queue operation that holds the slot.
struct Slot {
    inference: super::model_state::Inference,
    cancel: CancellationToken,
    cleanup: Arc<tokio::sync::Semaphore>,
    _release: tokio::sync::oneshot::Sender<()>,
}

impl Inference for Slot {
    fn startup_cancel(&self) -> Option<CancellationToken> {
        Some(self.cancel.clone())
    }

    fn attempt_cleanup(&self) -> Option<Arc<tokio::sync::Semaphore>> {
        Some(self.cleanup.clone())
    }

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
        let cancel = CancellationToken::new();
        // A caller that stops waiting leaves the queue.
        let leaving = cancel.clone().drop_guard();
        let (turn, mut turns) = tokio::sync::mpsc::unbounded_channel();
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let queue = self.0.queue.clone();
        let refused = turn.clone();
        let cleanup = Arc::new(tokio::sync::Semaphore::new(1));
        let worker_cleanup = cleanup.clone();
        tokio::spawn(async move {
            let started = queue
                .run(Some(cancel), move |cancel| async move {
                    if turn.send(Ok(cancel.clone())).is_ok() {
                        tokio::select! {
                            _ = cancel.cancelled() => {},
                            _ = released => {},
                        }
                        // Stop retires an idle retry group immediately, but an active worker
                        // still owns the queue lane until it has dropped its body.
                        let _cleaned = worker_cleanup.acquire().await.expect("the cleanup gate is never closed");
                    }
                })
                .await;
            if let Err(error) = started {
                let _ = refused.send(Err(error));
            }
        });
        let cancel = match turns.recv().await {
            Some(Ok(cancel)) => cancel,
            Some(Err(error)) => return Err(unsent(error.to_string())),
            None => return Err(unsent("aborted".into())),
        };
        leaving.disarm();
        let inference = self.0.catalog.state.begin_inference(model, queued_at);
        Ok(Box::new(Slot { inference, cancel, cleanup, _release: release }))
    }

    fn installed_now(&self) -> Option<Vec<Value>> {
        self.0.installed_rows().borrow().clone()
    }

    async fn ensure_server(&self, model: &str, cancel: Option<CancellationToken>) -> Result<Endpoint, ProviderError> {
        let ready = self.0.ensure_server(model, cancel).await.map_err(|e| unsent(e.to_string()))?;
        let text = |key: &str| ready[key].as_str().unwrap_or_default().to_owned();
        Ok(Endpoint { base_url: text("baseURL"), api_key: text("apiKey") })
    }

    fn supports_tools(&self, model: &str) -> Option<bool> {
        self.0
            .catalog
            .state
            .get(model)
            .pointer("/capabilities/tools")
            .and_then(Value::as_bool)
            .or_else(|| self.0.catalog.model_entry(model)?.get("supportsFunctionCalling")?.as_bool())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn stop_waits_for_cleanup_before_reopening_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        let provider = super::super::provider::tests::provider(dir.path());
        let runtime = ManagedRuntime(provider.clone());
        let slot = runtime.begin("old").await.unwrap();
        let stop_signal = slot.startup_cancel().unwrap();
        let cleanup = slot.attempt_cleanup().unwrap().acquire_owned().await.unwrap();
        let mut stopping = Box::pin(provider.queue.stop());
        tokio::select! {
            biased;
            _ = &mut stopping => panic!("stop completed before attempt cleanup"),
            _ = stop_signal.cancelled() => {},
        }
        tokio::select! {
            biased;
            _ = &mut stopping => panic!("stop completed before attempt cleanup"),
            _ = mixdog_rt::time::sleep(std::time::Duration::from_secs(1)) => {},
        }
        assert_eq!(provider.queue.status()["activeRequests"], 1);
        assert!(matches!(provider.queue.run(None, |_| async {}).await, Err(super::super::request_queue::QueueError::Stopping)));
        drop(cleanup);
        stopping.await;
        assert_eq!(provider.queue.run(None, |_| async { 1 }).await, Ok(1));
        drop(slot);
    }

    #[tokio::test]
    async fn an_empty_data_dir_lists_no_installed_models() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = super::super::catalog::tests::catalog(dir.path());
        assert!(CatalogInstalledModels(catalog).installed().await.unwrap().is_empty());
    }
}
