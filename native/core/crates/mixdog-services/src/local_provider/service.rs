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
use crate::params;
use mixdog_core_base::support::failed;

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
    CoreError::DomainError { domain: "localProvider".into(), code: Some(code.into()), message: None, detail: None }
}

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

impl From<ProviderError> for CoreError {
    fn from(e: ProviderError) -> Self {
        match e {
            // Node's `TypeError` text is what the window shows; `invalidParams` would drop it.
            ProviderError::Invalid(m) => failed("localProvider", m),
            // The `[local-provider] …` text is what Node's error carries to the caller.
            ProviderError::Failed(message) => CoreError::DomainError {
                domain: "localProvider".into(),
                code: Some("localProviderFailed".into()),
                message: Some(message.into()),
                detail: None,
            },
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

    /// The text of the last installation command that failed, `None` when the last one did not
    /// (`localSettings.status().installationCommandError`); the tool-module settings report it.
    pub fn installation_command_error(&self) -> Option<String> {
        self.command_error.lock().unwrap().clone()
    }

    pub(super) async fn settings_view(&self) -> Result<Value, ProviderError> {
        let mut status = self.provider.status().await?;
        status["installationCommandError"] = json!(self.command_error.lock().unwrap().clone());
        Ok(status)
    }

    /// What Node's settings methods answer after a change: `getToolModuleSettings()`.
    async fn tool_settings_view(&self) -> Result<Value, ProviderError> {
        match self.provider.tool_settings().await {
            Some(settings) => Ok(settings),
            None => self.settings_view().await,
        }
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

    async fn dispatch(&self, method: &str, wire: &Value) -> Result<Value, CoreError> {
        let args = params::object(wire).cloned().unwrap_or_else(|| json!({}));
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
                let id = text(&args, "modelId").filter(|s| !s.is_empty()).ok_or_else(|| failed("localProvider", "Unknown local model."))?;
                let tokens = match args.get("tokens") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(v.as_i64().ok_or_else(|| invalid("params.tokens", "integer or null"))?),
                };
                provider.set_context(id, tokens).await?;
                self.settings.catalog_changed().await;
                Ok(self.tool_settings_view().await?)
            }
            "localProvider/installLocalProviderModel" => {
                let id = text(&args, "modelId").unwrap_or("");
                provider.install_model_and_wait(id).await?;
                self.settings.catalog_changed().await;
                Ok(self.tool_settings_view().await?)
            }
            "localProvider/startLocalProviderInstallation" => {
                let (phase, model) = (text(&args, "phase").unwrap_or(""), text(&args, "modelId"));
                self.begin_installation(phase, model)?;
                Ok(self.tool_settings_view().await?)
            }
            "localProvider/cancelLocalProviderInstallation" => {
                let job = text(&args, "jobId").filter(|s| !mixdog_js::js_trim(s).is_empty()).ok_or_else(|| failed("localProvider", "jobId is required."))?;
                provider.installs.cancel(job).map_err(|e| failed("localProvider", e.to_string()))?;
                Ok(self.tool_settings_view().await?)
            }
            "localProvider/discardLocalProviderInstallation" => {
                let phase = text(&args, "phase").filter(|p| ["runtime", "model", "verify", "repair"].contains(p)).ok_or_else(|| failed("localProvider", "phase must be runtime, model, verify or repair."))?;
                let model = text(&args, "modelId").filter(|m| !mixdog_js::js_trim(m).is_empty());
                if phase != "runtime" && model.is_none() {
                    return Err(failed("localProvider", "modelId is required."));
                }
                provider.discard_installation(phase, if phase == "runtime" { None } else { model }).await?;
                *self.command_error.lock().unwrap() = None;
                Ok(self.tool_settings_view().await?)
            }
            "localProvider/setLocalProviderIdleTtl" => {
                let value = args.get("seconds").and_then(Value::as_i64).ok_or_else(|| failed("localProvider", "idleTtlSeconds must be an integer from 0 (disabled) to 86400."))?;
                let seconds = local_idle_ttl_seconds(value).map_err(|e| failed("localProvider", e.to_string()))?;
                self.settings.persist_idle_ttl(seconds).await.map_err(|_| domain("settingsFailed"))?;
                provider.queue.configure(seconds);
                Ok(self.tool_settings_view().await?)
            }
            _ => Err(invalid("method", "localProvider/*")),
        }
    }
}

fn hf(e: super::hugging_face::HfError) -> CoreError {
    match e {
        super::hugging_face::HfError::Invalid(m) => failed("localProvider", m),
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

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::super::provider::tests::provider;
    use super::*;

    struct Settings(Mutex<Vec<u64>>);

    #[async_trait]
    impl LocalProviderSettings for Settings {
        async fn persist_idle_ttl(&self, seconds: u64) -> Result<(), String> {
            self.0.lock().unwrap().push(seconds);
            Ok(())
        }
        async fn catalog_changed(&self) {}
    }

    async fn call(service: &LocalProviderService, method: &'static str, params: Value) -> Result<Reply, CoreError> {
        let request = CoreRequest { method: Method(method), params, op: None, ctx: mixdog_core_api::CallContext::internal("test") };
        service.call(request).await
    }

    fn text(reply: Result<Reply, CoreError>) -> (Option<String>, String) {
        match reply.err().unwrap() {
            CoreError::DomainError { code, message, .. } => (code.map(|c| c.to_string()), message.map(|m| m.to_string()).unwrap_or_default()),
            other => panic!("{other:?}"),
        }
    }

    /// The request's `params` are the method's arguments (not a nested `params` member), and a
    /// refusal answers Node's message (`install-progress.mjs`, `model-maintenance.mjs`,
    /// `server.mjs`).
    #[tokio::test]
    async fn the_wire_params_reach_the_method() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(Settings(Mutex::default()));
        let service = LocalProviderService::new(provider(dir.path()), settings.clone());

        call(&service, "localProvider/setLocalProviderIdleTtl", json!({"opId": "o", "seconds": 600})).await.unwrap();
        assert_eq!(*settings.0.lock().unwrap(), vec![600]);
        let refusals = [
            ("localProvider/cancelLocalProviderInstallation", json!({"opId": "o", "jobId": "harness-no-such-job"}), "[local-provider] installation job not found; refresh status before cancelling"),
            ("localProvider/discardLocalProviderInstallation", json!({"opId": "o", "phase": "model", "modelId": "harness-no-such-model"}), "[local-provider] unknown model"),
            ("localProvider/startLocalProviderModelMaintenance", json!({"opId": "o", "modelId": "harness-no-such-model", "operation": "verify"}), "[local-provider] unknown model"),
            ("localProvider/setLocalProviderContext", json!({"opId": "o", "modelId": "harness-no-such-model", "tokens": 4096}), "Unknown local model."),
        ];
        for (method, params, want) in refusals {
            assert_eq!(text(call(&service, method, params).await).1, want, "{method}");
        }
    }

    struct Owner;

    #[async_trait]
    impl super::super::provider::ToolSettings for Owner {
        async fn tool_module_settings(&self) -> Value {
            json!({"autoEffortBase": "medium"})
        }
    }

    /// Node's `setLocalProviderIdleTtl` answers `getToolModuleSettings()` (`local-provider-settings.mjs`),
    /// not the provider's status.
    #[tokio::test]
    async fn a_change_answers_the_tool_module_settings() {
        let dir = tempfile::tempdir().unwrap();
        let service = LocalProviderService::new(provider(dir.path()), Arc::new(Settings(Mutex::default())));
        let owner: Arc<dyn super::super::provider::ToolSettings> = Arc::new(Owner);
        service.provider.attach_tool_settings(Arc::downgrade(&owner));
        let answer = match call(&service, "localProvider/setLocalProviderIdleTtl", json!({"opId": "o", "seconds": 600})).await.unwrap() {
            Reply::Value(v) => v,
            _ => panic!("not a value"),
        };
        assert_eq!(answer, json!({"autoEffortBase": "medium"}));
    }
}