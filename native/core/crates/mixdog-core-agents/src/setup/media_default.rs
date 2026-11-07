//! The `set_media_default` setup action (`setup-tool/extended-actions.mjs`): pins the lane, model
//! and account the media tool uses for a kind that names none. The checks run here, in Node's
//! order and words, against the live lane catalog (`media/listMediaLanes`) and the OAuth account
//! roster; the pin itself is the domain method the Settings UI also calls (`media/setMediaPin`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCall;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::domain_settings::DomainCalls;
use super::domain_settings::refused;
use super::settings::clean;
use super::settings::truthy;

/// `getProviderAccounts(provider)`: the account roster of an OAuth provider (`accounts` holds its
/// rows), refused with the sentence Node threw.
#[async_trait]
pub trait ProviderAccounts: Send + Sync {
    async fn accounts(&self, provider: &str) -> Result<Value, String>;
}

pub struct MediaDefaultSetup {
    domains: Arc<dyn DomainCalls>,
    roster: Arc<dyn ProviderAccounts>,
}

/// `MEDIA_KINDS`.
const KINDS: [&str; 2] = ["image", "video"];

fn failed(message: impl Into<String>) -> PortError {
    PortError::Failed { capability: "setup".into(), message: message.into() }
}

/// `${value}` of a catalog field: an absent one prints as JavaScript prints it.
fn shown(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".to_owned(),
        Some(other) => other.to_string(),
    }
}

fn has_own(args: &Value, key: &str) -> bool {
    args.as_object().is_some_and(|fields| fields.contains_key(key))
}

impl MediaDefaultSetup {
    pub fn new(domains: Arc<dyn DomainCalls>, roster: Arc<dyn ProviderAccounts>) -> Self {
        Self { domains, roster }
    }

    async fn pin(&self, input: Value) -> Result<Value, PortError> {
        self.domains.call("media/setMediaPin", json!({ "input": input })).await.map_err(refused)
    }

    async fn set_default(&self, args: &Value) -> Result<Value, PortError> {
        let kind = args.get("kind").and_then(Value::as_str).filter(|kind| KINDS.contains(kind));
        let Some(kind) = kind else {
            return Err(failed(format!("kind must be one of {}", KINDS.join(", "))));
        };
        let wanted = args.get("lane");
        // A blank lane returns the kind to Auto, as the Settings control does.
        if clean(wanted).is_empty() {
            if has_own(args, "model") || has_own(args, "accountId") {
                return Err(failed("model and accountId need a lane"));
            }
            return Ok(json!({ "kind": kind, "media": self.pin(json!({ "kind": kind, "lane": "" })).await? }));
        }
        let lanes = self.domains.call("media/listMediaLanes", json!({})).await.map_err(refused)?;
        let lane = lanes.as_array().into_iter().flatten().find(|row| row.get("id") == wanted);
        let Some(lane) = lane else {
            return Err(failed(format!("Unknown media lane \"{}\"; list lanes with the media tool", shown(wanted))));
        };
        let id = shown(lane.get("id"));
        if !truthy(lane.get("authenticated")) {
            return Err(failed(format!("{} is not signed in; open providers first", shown(lane.get("label")))));
        }
        let spec = lane.get(kind).filter(|spec| truthy(Some(spec)));
        let Some(spec) = spec else {
            return Err(failed(match lane.get("catalogError").filter(|error| truthy(Some(error))) {
                Some(error) => shown(Some(error)),
                None => format!("{id} offers no {kind} models"),
            }));
        };
        if let Some(model) = args.get("model") {
            let offered = spec.get("models").and_then(Value::as_array).into_iter().flatten().any(|row| row.get("id") == Some(model));
            if !offered {
                return Err(failed(format!("model \"{}\" is not available on {id}/{kind}", shown(Some(model)))));
            }
        }
        if let Some(account) = args.get("accountId") {
            if lane.get("authType") != Some(&Value::String("oauth".into())) {
                return Err(failed(format!("{id} signs in with an API key; it has no accounts")));
            }
            let provider = lane.get("authProvider");
            let roster = self.roster.accounts(provider.and_then(Value::as_str).unwrap_or_default()).await.map_err(failed)?;
            let known = roster.get("accounts").and_then(Value::as_array).into_iter().flatten().any(|row| row.get("id") == Some(account));
            if !known {
                return Err(failed(format!("Unknown {} account \"{}\"; list accounts with status providers", shown(provider), shown(Some(account)))));
            }
        }
        let mut input = Map::new();
        input.insert("kind".into(), json!(kind));
        input.insert("lane".into(), wanted.cloned().unwrap_or(Value::Null));
        if let Some(model) = args.get("model") {
            input.insert("model".into(), model.clone());
        }
        if let Some(account) = args.get("accountId") {
            input.insert("account".into(), account.clone());
        }
        Ok(json!({ "kind": kind, "media": self.pin(Value::Object(input)).await? }))
    }
}

#[async_trait]
impl SetupActions for MediaDefaultSetup {
    fn actions(&self) -> &'static [&'static str] {
        &["set_media_default"]
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        match call.action {
            "set_media_default" => self.set_default(call.args).await,
            other => Err(PortError::Unavailable { capability: format!("setup.{other}"), message: format!("setup {other} is not a media setting") }),
        }
    }
}
