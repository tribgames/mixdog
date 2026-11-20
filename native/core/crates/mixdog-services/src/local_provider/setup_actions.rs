//! The `setup` tool's local-model actions, as `session-runtime/setup-tool/executor.mjs` runs them
//! over `local-model-api.mjs` and `local-provider-settings.mjs`. Every argument is cleaned and
//! checked the way the executor does before the provider sees it; the receipts carry the
//! provider status (`getToolModuleSettings().localProvider`).
//!
//! The owner trait (`SetupActions`) lives in the config crate, which depends on this one, so the
//! integration wraps [`LocalModelSetupActions::run`] and lists [`LocalModelSetupActions::ACTIONS`].

use std::sync::Arc;

use mixdog_tools::orch::util::PortError;
use serde_json::{Map, Value, json};

use super::hugging_face::HfError;
use super::provider::ProviderError;
use super::request_queue::{DEFAULT_LOCAL_IDLE_TTL_SECONDS, local_idle_ttl_seconds};
use super::service::LocalProviderService;

pub struct LocalModelSetupActions {
    service: Arc<LocalProviderService>,
}

fn invalid(field: &str, reason: impl Into<String>) -> PortError {
    PortError::Invalid { field: field.into(), reason: reason.into() }
}

fn failed(message: impl Into<String>) -> PortError {
    PortError::Failed { capability: "localProvider".into(), message: message.into() }
}

fn provider_error(error: ProviderError) -> PortError {
    match error {
        ProviderError::Invalid(message) => invalid("args", message),
        ProviderError::Failed(message) => failed(message),
    }
}

fn hf_error(error: HfError) -> PortError {
    match error {
        HfError::Invalid(message) => invalid("args", message),
        other => failed(other.to_string()),
    }
}

/// `clean(value)`: `String(value ?? '').trim()`.
fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => mixdog_js::js_trim(s).to_owned(),
        Some(other) => mixdog_js::js_trim(&mixdog_js::value_to_string(other)).to_owned(),
    }
}

fn require_text(args: &Value, field: &str) -> Result<String, PortError> {
    let text = clean(args.get(field));
    if text.is_empty() { Err(invalid(field, format!("{field} is required"))) } else { Ok(text) }
}

fn require_enum(args: &Value, field: &str, allowed: &[&str]) -> Result<String, PortError> {
    let id = clean(args.get(field));
    if allowed.contains(&id.as_str()) { Ok(id) } else { Err(invalid(field, format!("{field} must be one of {}", allowed.join(", ")))) }
}

fn require_boolean(args: &Value, field: &str) -> Result<bool, PortError> {
    args.get(field).and_then(Value::as_bool).ok_or_else(|| invalid(field, format!("{field} (boolean) is required")))
}

/// `{ ...receipt, localProvider }`: a result object extended with the provider status.
fn with_status(mut result: Value, status: Value) -> Value {
    if let Some(object) = result.as_object_mut() {
        object.insert("localProvider".into(), status);
    }
    result
}

impl LocalModelSetupActions {
    pub const ACTIONS: &'static [&'static str] = &[
        "install_local_model",
        "start_local_installation",
        "cancel_local_installation",
        "set_local_idle_ttl",
        "search_local_models",
        "inspect_hf_model",
        "register_hf_model",
        "local_model_details",
        "maintain_local_model",
        "delete_local_model",
    ];

    pub fn new(service: Arc<LocalProviderService>) -> Self {
        Self { service }
    }

    pub async fn run(&self, action: &str, args: &Value) -> Result<Value, PortError> {
        let service = &self.service;
        let provider = &service.provider;
        match action {
            "install_local_model" => {
                let model_id = require_text(args, "modelId")?;
                provider.install_model_and_wait(&model_id).await.map_err(provider_error)?;
                service.settings.catalog_changed().await;
                Ok(service.settings_view().await.map_err(provider_error)?)
            }
            "start_local_installation" => {
                let phase = require_enum(args, "phase", &["runtime", "model"])?;
                let model_id = if phase == "model" {
                    Some(require_text(args, "modelId")?)
                } else {
                    match args.get("modelId") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(s)) => Some(s.clone()),
                        Some(_) => return Err(invalid("modelId", "runtime installation does not accept modelId.")),
                    }
                };
                service.begin_installation(&phase, model_id.as_deref()).map_err(provider_error)?;
                let mut out = Map::new();
                out.insert("background".into(), Value::Bool(true));
                if let Value::Object(status) = service.settings_view().await.map_err(provider_error)? {
                    out.extend(status);
                }
                Ok(Value::Object(out))
            }
            "cancel_local_installation" => {
                let job_id = require_text(args, "jobId")?;
                provider.installs.cancel(&job_id).map_err(|e| failed(e.to_string()))?;
                Ok(service.settings_view().await.map_err(provider_error)?)
            }
            "set_local_idle_ttl" => {
                let value = match args.get("idleTtlSeconds") {
                    None => i64::try_from(DEFAULT_LOCAL_IDLE_TTL_SECONDS).unwrap_or(i64::MAX),
                    Some(v) => v.as_f64().filter(|n| n.fract() == 0.0 && n.abs() <= 9.0e15).map_or(-1, |n| n as i64),
                };
                let seconds = local_idle_ttl_seconds(value).map_err(|e| invalid("idleTtlSeconds", e.to_string()))?;
                service.settings.persist_idle_ttl(seconds).await.map_err(failed)?;
                provider.queue.configure(seconds);
                Ok(service.settings_view().await.map_err(provider_error)?)
            }
            "search_local_models" => {
                let query = require_text(args, "query")?;
                provider.hf.search(Some(&Value::String(query))).await.map_err(hf_error)
            }
            "inspect_hf_model" => {
                let mut options = Map::new();
                options.insert("repository".into(), Value::String(require_text(args, "repository")?));
                for key in ["filename", "contextWindow"] {
                    if let Some(v) = args.get(key) {
                        options.insert(key.into(), v.clone());
                    }
                }
                let memory = provider.hardware().detect(false).await.max_gpu_memory();
                provider.hf.inspect(&Value::Object(options), memory).await.map_err(hf_error)
            }
            "register_hf_model" => {
                let preview_id = require_text(args, "previewId")?;
                let accepted = require_boolean(args, "licenseAccepted")?;
                provider.register_model(&preview_id, accepted).await.map_err(hf_error)
            }
            "local_model_details" => provider.model_details(&require_text(args, "modelId")?).await.map_err(provider_error),
            "maintain_local_model" => {
                let model_id = require_text(args, "modelId")?;
                let operation = require_enum(args, "operation", &["verify", "repair"])?;
                let job = provider.start_maintenance(&model_id, &operation).map_err(provider_error)?;
                Ok(json!({"job": job, "localProvider": service.settings_view().await.map_err(provider_error)?}))
            }
            "delete_local_model" => {
                let token = require_text(args, "confirmationToken")?;
                let result = provider.delete_model(&token).await.map_err(provider_error)?;
                service.settings.catalog_changed().await;
                Ok(with_status(result, service.settings_view().await.map_err(provider_error)?))
            }
            other => Err(PortError::Unavailable { capability: format!("setup.{other}"), message: format!("setup {other} is not a local-model action") }),
        }
    }
}

#[cfg(test)]
mod tests {

    use async_trait::async_trait;

    use super::super::provider::tests::{install_fake_model, provider};
    use super::super::service::LocalProviderSettings;
    use super::*;

    struct Settings;

    #[async_trait]
    impl LocalProviderSettings for Settings {
        async fn persist_idle_ttl(&self, _: u64) -> Result<(), String> {
            Ok(())
        }
        async fn catalog_changed(&self) {}
    }

    fn actions(dir: &std::path::Path) -> (LocalModelSetupActions, Arc<super::super::LocalProvider>) {
        let provider = provider(dir);
        (LocalModelSetupActions::new(Arc::new(LocalProviderService::new(provider.clone(), Arc::new(Settings)))), provider)
    }

    fn reason(error: PortError) -> String {
        match error {
            PortError::Invalid { reason, .. } => reason,
            other => panic!("expected an invalid-argument error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn arguments_are_checked_with_the_executors_wording() {
        let dir = tempfile::tempdir().unwrap();
        let (a, _) = actions(dir.path());
        let err = |action: &'static str, args: Value| {
            let a = &a;
            async move { reason(a.run(action, &args).await.unwrap_err()) }
        };
        assert_eq!(err("local_model_details", json!({"modelId": "  "})).await, "modelId is required");
        assert_eq!(err("search_local_models", json!({})).await, "query is required");
        assert_eq!(err("register_hf_model", json!({"previewId": "x"})).await, "licenseAccepted (boolean) is required");
        assert_eq!(err("maintain_local_model", json!({"modelId": "m", "operation": "execute"})).await, "operation must be one of verify, repair");
        assert_eq!(err("start_local_installation", json!({"phase": "disk"})).await, "phase must be one of runtime, model");
        assert_eq!(err("start_local_installation", json!({"phase": "runtime", "modelId": "m"})).await, "runtime installation does not accept modelId.");
        assert_eq!(err("set_local_idle_ttl", json!({"idleTtlSeconds": 86401})).await, "idleTtlSeconds must be an integer from 0 (disabled) to 86400.");
        assert_eq!(err("set_local_idle_ttl", json!({"idleTtlSeconds": 1.5})).await, "idleTtlSeconds must be an integer from 0 (disabled) to 86400.");
        assert_eq!(err("set_local_idle_ttl", json!({"idleTtlSeconds": null})).await, "idleTtlSeconds must be an integer from 0 (disabled) to 86400.");
    }

    #[tokio::test]
    async fn idle_ttl_and_maintenance_answer_the_provider_status() {
        let dir = tempfile::tempdir().unwrap();
        let (a, provider) = actions(dir.path());
        let status = a.run("set_local_idle_ttl", &json!({"idleTtlSeconds": 30})).await.unwrap();
        assert_eq!(status["idleTtlSeconds"], 30);
        assert!(status.get("installationCommandError").is_some());
        // Omitting the value restores the default, as the Node default parameter does.
        let status = a.run("set_local_idle_ttl", &json!({})).await.unwrap();
        assert_eq!(status["idleTtlSeconds"], 3600);

        let (entry, _) = install_fake_model(&provider, b"weights").await;
        let id = entry["id"].as_str().unwrap();
        let out = a.run("maintain_local_model", &json!({"modelId": format!(" {id} "), "operation": "verify"})).await.unwrap();
        assert!(out["job"].is_object() && out["localProvider"]["installations"].is_array());
        let details = a.run("local_model_details", &json!({"modelId": id})).await.unwrap();
        assert_eq!(details["modelId"], id);
    }

    #[tokio::test]
    async fn a_runtime_installation_receipt_is_background_and_carries_the_status() {
        let dir = tempfile::tempdir().unwrap();
        let (a, _) = actions(dir.path());
        let out = a.run("start_local_installation", &json!({"phase": "runtime"})).await.unwrap();
        assert_eq!(out["background"], true);
        assert!(out["installations"].as_array().is_some_and(|rows| rows.iter().any(|r| r["phase"] == "runtime")));
    }
}
