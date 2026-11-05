//! The `localProvider/` namespace. Every mutating method answers the provider's status (what the
//! settings dialog polls), with the last installation command error that no paused job explains.
//! Arguments ride in the request's `params` member, named as in the method table.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::Admit;
use mixdog_core_api::{CoreError, CoreRequest, DomainService, Reply};
use serde_json::{Value, json};

use super::provider::{LocalProvider, ProviderError};
use super::request_queue::local_idle_ttl_seconds;

/// Where the provider's persisted settings live (the config layer).
#[async_trait]
pub trait LocalProviderSettings: Send + Sync {
    async fn persist_idle_ttl(&self, seconds: u64) -> Result<(), String>;
    /// The installed-model catalog changed; refresh what the model picker lists.
    async fn catalog_changed(&self);
}

pub struct LocalProviderService {
    pub(super) provider: Arc<LocalProvider>,
    pub(super) settings: Arc<dyn LocalProviderSettings>,
    pub(super) command_error: Arc<Mutex<Option<String>>>,
}

fn domain(code: &str) -> CoreError {
    CoreError::DomainError { domain: "localProvider".into(), code: Some(code.into()), detail: None }
}

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

impl From<ProviderError> for CoreError {
    fn from(e: ProviderError) -> Self {
        match e {
            ProviderError::Invalid(m) => invalid("params", &m),
            ProviderError::Failed(_) => domain("localProviderFailed"),
        }
    }
}

fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

impl LocalProviderService {
    pub fn new(provider: Arc<LocalProvider>, settings: Arc<dyn LocalProviderSettings>) -> Self {
        Self { provider, settings, command_error: Arc::default() }
    }

    /// Push, not poll: ticks whenever [`LocalProvider::status`] may have changed.
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.provider.subscribe()
    }

    pub(super) async fn settings_view(&self) -> Result<Value, ProviderError> {
        let mut status = self.provider.status().await?;
        status["installationCommandError"] = json!(self.command_error.lock().unwrap().clone());
        Ok(status)
    }

    /// `startLocalProviderInstallation`: starts the job and tracks it in the background; a failure
    /// that no paused job explains becomes the installation command error.
    pub(super) fn begin_installation(&self, phase: &str, model: Option<&str>) -> Result<(), ProviderError> {
        *self.command_error.lock().unwrap() = None;
        let (_, done) = self.provider.start_installation(phase, model)?;
        // Explicit pauses are represented by the shared installation job.
        let (this, phase, model) = (self.provider.clone(), phase.to_owned(), model.map(str::to_owned));
        let (error_slot, settings) = (self.command_error.clone(), self.settings.clone());
        tokio::spawn(async move {
            match super::installations::wait(done).await {
                Ok(_) => settings.catalog_changed().await,
                Err(message) => {
                    // A status that cannot be read cannot show a pause, so the failure is recorded.
                    let paused = this.status().await.is_ok_and(|status| {
                        status["installations"].as_array().into_iter().flatten().any(|e| {
                            e["phase"] == phase.as_str() && (phase == "runtime" || e["modelId"].as_str() == model.as_deref()) && e["state"] == "paused"
                        })
                    });
                    if !paused {
                        *error_slot.lock().unwrap() = Some(message);
                    }
                }
            }
        });
        Ok(())
    }

    async fn dispatch(&self, method: &str, request: &Value) -> Result<Value, CoreError> {
        let args = request.get("params").filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({}));
        let provider = &self.provider;
        match method {
            "localProvider/searchLocalProviderModels" => Ok(provider.hf.search(args.get("query")).await.map_err(hf)?),
            "localProvider/inspectHuggingFaceModel" => {
                let options = args.get("options").cloned().unwrap_or_else(|| json!({}));
                let memory = provider.hardware().detect(false).await.max_gpu_memory();
                Ok(provider.hf.inspect(&options, memory).await.map_err(hf)?)
            }
            "localProvider/registerHuggingFaceModel" => {
                let id = text(&args, "previewId").unwrap_or("");
                let result = provider.register_model(id, args.get("licenseAccepted") == Some(&Value::Bool(true))).await.map_err(hf)?;
                self.settings.catalog_changed().await;
                Ok(result)
            }
            "localProvider/getLocalProviderModelDetails" => Ok(provider.model_details(text(&args, "modelId").unwrap_or("")).await?),
            "localProvider/startLocalProviderModelMaintenance" => {
                let job = provider.start_maintenance(text(&args, "modelId").unwrap_or(""), text(&args, "operation").unwrap_or(""))?;
                Ok(json!({"job": job, "localProvider": self.settings_view().await?}))
            }
            "localProvider/deleteLocalProviderModel" => {
                let mut result = provider.delete_model(text(&args, "confirmationToken").unwrap_or("")).await?;
                self.settings.catalog_changed().await;
                result["localProvider"] = self.settings_view().await?;
                Ok(result)
            }
            "localProvider/setLocalProviderContext" => {
                let id = text(&args, "modelId").filter(|s| !s.is_empty()).ok_or_else(|| invalid("params.modelId", "string"))?;
                let tokens = match args.get("tokens") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(v.as_i64().ok_or_else(|| invalid("params.tokens", "integer or null"))?),
                };
                provider.set_context(id, tokens).await?;
                self.settings.catalog_changed().await;
                Ok(self.settings_view().await?)
            }
            "localProvider/installLocalProviderModel" => {
                let id = text(&args, "modelId").unwrap_or("");
                provider.install_model_and_wait(id).await?;
                self.settings.catalog_changed().await;
                Ok(self.settings_view().await?)
            }
            "localProvider/startLocalProviderInstallation" => {
                let (phase, model) = (text(&args, "phase").unwrap_or(""), text(&args, "modelId"));
                self.begin_installation(phase, model)?;
                Ok(self.settings_view().await?)
            }
            "localProvider/cancelLocalProviderInstallation" => {
                let job = text(&args, "jobId").filter(|s| !mixdog_js::js_trim(s).is_empty()).ok_or_else(|| invalid("params.jobId", "string"))?;
                provider.installs.cancel(job).map_err(|_| domain("jobNotFound"))?;
                Ok(self.settings_view().await?)
            }
            "localProvider/discardLocalProviderInstallation" => {
                let phase = text(&args, "phase").filter(|p| ["runtime", "model", "verify", "repair"].contains(p)).ok_or_else(|| invalid("params.phase", "runtime | model | verify | repair"))?;
                let model = text(&args, "modelId").filter(|m| !mixdog_js::js_trim(m).is_empty());
                if phase != "runtime" && model.is_none() {
                    return Err(invalid("params.modelId", "string"));
                }
                provider.discard_installation(phase, if phase == "runtime" { None } else { model }).await?;
                *self.command_error.lock().unwrap() = None;
                Ok(self.settings_view().await?)
            }
            "localProvider/setLocalProviderIdleTtl" => {
                let value = args.get("seconds").and_then(Value::as_i64).ok_or_else(|| invalid("params.seconds", "integer"))?;
                let seconds = local_idle_ttl_seconds(value).map_err(|_| invalid("params.seconds", "integer from 0 (disabled) to 86400"))?;
                self.settings.persist_idle_ttl(seconds).await.map_err(|_| domain("settingsFailed"))?;
                provider.queue.configure(seconds);
                Ok(self.settings_view().await?)
            }
            _ => Err(invalid("method", "localProvider/*")),
        }
    }
}

fn hf(e: super::hugging_face::HfError) -> CoreError {
    match e {
        super::hugging_face::HfError::Invalid(m) => invalid("params", &m),
        _ => domain("huggingFaceFailed"),
    }
}

#[async_trait]
impl DomainService for LocalProviderService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.dispatch(req.method.as_str(), &req.params).await?))
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "localProvider/searchLocalProviderModels",
            "localProvider/inspectHuggingFaceModel",
            "localProvider/registerHuggingFaceModel",
            "localProvider/getLocalProviderModelDetails",
            "localProvider/startLocalProviderModelMaintenance",
            "localProvider/deleteLocalProviderModel",
            "localProvider/setLocalProviderContext",
            "localProvider/installLocalProviderModel",
            "localProvider/startLocalProviderInstallation",
            "localProvider/cancelLocalProviderInstallation",
            "localProvider/discardLocalProviderInstallation",
            "localProvider/setLocalProviderIdleTtl",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
