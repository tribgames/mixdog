//! The scalar setup actions (`setup-tool/executor.mjs` handlers over `settings-system-api.mjs`,
//! `settings-builtin-tools-api.mjs`, `settings-developer-api.mjs`, `settings-profile-api.mjs` and
//! `quota-resume-store.mjs`): the system shell, the update switch, AI session titles, the
//! quota auto-resume switch, Mixy's heartbeat, bots' reactions, the user profile and the developer
//! options. The setters are the config actor's [`Settings`]; what this adds is the executor's own
//! argument rules and the receipt body each action answers.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_base::quota_resume::QuotaResumeStore;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::Settings;
use mixdog_core_config::config::PROFILE_EXPERIENCE_LEVELS;
use mixdog_core_config::config::PROFILE_LANGUAGES;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCall;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;
use serde_json::json;

use super::from_modules;
use super::require_boolean;

/// `rt.setAutoUpdate(enabled)`: the update service owns what `getUpdateSettings()` answers
/// (the check state), the config actor owns the stored switch.
#[async_trait]
pub trait UpdateSettings: Send + Sync {
    /// Stores `update.auto` and answers `getUpdateSettings()`.
    async fn set_auto_update(&self, enabled: bool) -> Result<Value, PortError>;
}

/// `setQuotaAutoResumeEnabled(enabled)`: the global switch is the config key `quotaAutoResume`; turning it off drops
/// every pending resume.
pub struct QuotaAutoResume {
    config: Config,
    store: Arc<QuotaResumeStore>,
}

impl QuotaAutoResume {
    pub fn new(config: Config, store: Arc<QuotaResumeStore>) -> Self {
        Self { config, store }
    }

    /// Follows the config for the daemon's life: when `quotaAutoResume` turns `false` (by `config/value/write` or any other
    /// writer), every pending resume drops, as [`set`](Self::set) does for the setup action (Node's
    /// `setQuotaAutoResumeEnabled`).
    pub fn follow(&self, cancel: tokio_util::sync::CancellationToken) -> tokio::task::JoinHandle<()> {
        let config = self.config.clone();
        let store = self.store.clone();
        let mut changes = config.changes();
        let enabled = |config: &Config| config.get("quotaAutoResume") != Some(Value::Bool(false));
        let mut on = enabled(&config);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    changed = changes.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                }
                let now = enabled(&config);
                if on && !now {
                    if let Err(error) = store.cancel_all().await {
                        tracing::warn!(?error, "[quota] the pending resumes were not dropped when the switch went off");
                    }
                }
                on = now;
            }
        })
    }

    async fn set(&self, enabled: bool) -> Result<bool, PortError> {
        self.config
            .update(move |doc| {
                doc.insert("quotaAutoResume".into(), Value::Bool(enabled));
                Ok(())
            })
            .await
            .map_err(|error| failed(error.to_string()))?;
        if !enabled {
            self.store.cancel_all().await.map_err(|error| failed(error.to_string()))?;
        }
        Ok(enabled)
    }
}

pub struct SettingsSetup {
    settings: Settings,
    update: Arc<dyn UpdateSettings>,
    quota: QuotaAutoResume,
}

const ACTIONS: &[&str] = &[
    "set_system_shell",
    "set_auto_update",
    "set_ai_session_titles",
    "set_quota_auto_resume",
    "set_heartbeat_enabled",
    "set_heartbeat_interval",
    "set_reactions_enabled",
    "set_profile",
    "set_developer_option",
];

fn failed(message: impl Into<String>) -> PortError {
    PortError::Failed { capability: "setup".into(), message: message.into() }
}

/// `clean(value)`: `String(value ?? '').trim()`.
pub(super) fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::js_trim(&mixdog_js::value_to_string(value)).to_owned(),
    }
}

/// JS truthiness of an argument the tool schema types as a boolean.
pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

impl SettingsSetup {
    pub fn new(settings: Settings, update: Arc<dyn UpdateSettings>, quota: QuotaAutoResume) -> Self {
        Self { settings, update, quota }
    }

    /// `set_profile`: `profile` is a non-empty object whose language and level, when given, are
    /// ids of the pickers; the answer is the stored profile's three fields.
    async fn set_profile(&self, args: &Value) -> Result<Value, PortError> {
        let profile = args.get("profile").filter(|profile| match profile {
            Value::Object(fields) => !fields.is_empty(),
            Value::Array(items) => !items.is_empty(),
            _ => false,
        });
        let Some(profile) = profile else {
            return Err(failed("profile with title, language, or experienceLevel is required"));
        };
        let language_ids: Vec<&str> = PROFILE_LANGUAGES.iter().map(|(id, ..)| *id).collect();
        let level_ids: Vec<&str> = std::iter::once("").chain(PROFILE_EXPERIENCE_LEVELS.iter().map(|(id, _)| *id)).collect();
        for (field, ids) in [("language", &language_ids), ("experienceLevel", &level_ids)] {
            let Some(value) = profile.get(field) else { continue };
            if !value.as_str().is_some_and(|text| ids.contains(&text)) {
                let list: Vec<String> = ids.iter().map(|id| json!(id).to_string()).collect();
                return Err(failed(format!("profile.{field} must be one of {}", list.join(", "))));
            }
        }
        let stored = self.settings.set_profile(profile).await.map_err(from_modules)?;
        let text = |field: &str, fallback: &str| match stored.get(field) {
            Some(Value::String(text)) if !text.is_empty() => json!(text),
            _ => json!(fallback),
        };
        Ok(json!({
            "title": text("title", ""),
            "language": text("language", "system"),
            "experienceLevel": text("experienceLevel", ""),
        }))
    }

    /// `set_developer_option`: the option must exist; an agent never turns approvals off, and an
    /// option with a warning needs the person's explicit acceptance.
    async fn set_developer_option(&self, args: &Value) -> Result<Value, PortError> {
        let name = args.get("name").map(mixdog_js::value_to_string).unwrap_or_else(|| "undefined".into());
        let view = self.settings.developer();
        let option = view["sections"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|section| section["options"].as_array().into_iter().flatten())
            .find(|option| args.get("name").is_some_and(|wanted| &option["id"] == wanted))
            .cloned();
        let Some(option) = option else {
            return Err(failed(format!("Unknown developer option \"{name}\"; read status developer")));
        };
        let label = option["label"].as_str().unwrap_or_default();
        let enabled = truthy(args.get("enabled"));
        if enabled && option["id"] == "allowAllActions" {
            return Err(failed(format!(
                "\"{label}\" cannot be turned on by an agent; only the person can turn it on in Settings → Developer options."
            )));
        }
        if enabled && truthy(option.get("warning")) && !truthy(args.get("riskAccepted")) {
            return Err(failed(format!(
                "Enabling {label} requires riskAccepted:true after the user explicitly accepts: {}",
                option["warning"].as_str().unwrap_or_default()
            )));
        }
        let developer = self
            .settings
            .set_developer_option(&option["id"], args.get("enabled").unwrap_or(&Value::Null))
            .await
            .map_err(from_modules)?;
        Ok(json!({ "developer": developer }))
    }
}

#[async_trait]
impl SetupActions for SettingsSetup {
    fn actions(&self) -> &'static [&'static str] {
        ACTIONS
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        let args = call.args;
        let enabled = || require_boolean(args, "enabled");
        match call.action {
            "set_system_shell" => self
                .settings
                .set_system_shell(&json!({ "command": clean(args.get("command")) }))
                .await
                .map_err(from_modules),
            "set_auto_update" => self.update.set_auto_update(enabled()?).await,
            "set_ai_session_titles" => self
                .settings
                .set_ai_session_titles(&Value::Bool(enabled()?))
                .await
                .map_err(from_modules),
            "set_quota_auto_resume" => Ok(json!({ "quotaAutoResume": self.quota.set(enabled()?).await? })),
            "set_heartbeat_enabled" => self
                .settings
                .set_heartbeat_enabled(&Value::Bool(enabled()?))
                .await
                .map_err(from_modules),
            "set_heartbeat_interval" => self
                .settings
                .set_heartbeat_interval(args.get("minutes").unwrap_or(&Value::Null))
                .await
                .map_err(from_modules),
            "set_reactions_enabled" => self
                .settings
                .set_reactions_enabled(&Value::Bool(enabled()?))
                .await
                .map_err(from_modules),
            "set_profile" => self.set_profile(args).await,
            "set_developer_option" => self.set_developer_option(args).await,
            other => Err(PortError::Unavailable {
                capability: format!("setup.{other}"),
                message: format!("setup {other} is not a scalar setting"),
            }),
        }
    }
}