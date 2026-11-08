//! The scalar settings of the agent config with their getters and setters (`config/…` methods
//! of today's settings API): Mixy's heartbeat, bot reactions, AI session titles, prompt-cache
//! warming, the bot order, the system shell, the developer options, the recap switch and the
//! starter guide. Each setter reads the agent config, edits a copy and saves the difference
//! (`Config::save_agent_config`), so a field another writer changed meanwhile survives.
//!
//! Sources: `settings-system-api.mjs`, `settings-builtin-tools-api.mjs`,
//! `settings-developer-api.mjs`, `settings-profile-api.mjs`, `shared/heartbeat-interval.mjs`,
//! `shared/developer-options.mjs`, `starter-guide-state.mjs`, `config-helpers.mjs`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::Config;
use crate::tool_modules::ToolModulesError;

type Doc = Map<String, Value>;

/// `saveConfigAndAdopt` (config-lifecycle.mjs): the runtime holds the grandfathered config, so both sides of the diff carry `builtins` and the
/// first write seeds it (`seedChanges`) where the stored section lacks it.
pub(crate) async fn save_and_adopt(config: &Config, before: &Doc, after: &Doc) -> Result<(), super::ConfigError> {
    // `after` descends from the adopted config, so it keeps the section `before` was stamped with: a Lead route it adds must not turn a fresh
    // profile into a grandfathered one.
    let before = crate::tool_modules::with_grandfathered_builtins(before);
    let mut after = after.clone();
    if !after.contains_key("builtins") {
        after.insert("builtins".into(), before.get("builtins").cloned().unwrap_or(Value::Null));
    }
    config.save_agent_config(&before, &after, false).await.map(|_| ())
}

/// The live effects Node's setters also had; the owners of the session, the shell and the cache
/// warmer implement them.
#[async_trait]
pub trait SettingsEffects: Send + Sync {
    /// `setConfiguredShell(command)`.
    fn set_configured_shell(&self, command: &str);
    /// `noteCacheWarmingEnabled(enabled)`: off cancels every armed chain.
    fn note_cache_warming_enabled(&self, enabled: bool);
    /// `syncDeveloperOption(id)`: flushes and applies live effects (the provider registry).
    async fn sync_developer_option(&self, id: &str);
}

pub struct NoEffects;

#[async_trait]
impl SettingsEffects for NoEffects {
    fn set_configured_shell(&self, _command: &str) {}
    fn note_cache_warming_enabled(&self, _enabled: bool) {}
    async fn sync_developer_option(&self, _id: &str) {}
}

/// `process.env` as the settings read it (`MIXDOG_SHELL`).
pub type SettingsEnv = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

#[derive(Clone)]
pub struct Settings {
    config: Config,
    effects: Arc<dyn SettingsEffects>,
    env: SettingsEnv,
    /// The data directory holding bots/; empty when the host has none, so no agent is a store bot.
    data_dir: std::path::PathBuf,
}

const HEARTBEAT_INTERVAL_CHOICES: [i64; 4] = [30, 60, 120, 240];
const DEFAULT_HEARTBEAT_INTERVAL_MINUTES: i64 = 60;
const MAX_BOT_ORDER_IDS: usize = 500;
const STARTER_GUIDE_STEPS: [&str; 5] = ["provider", "project", "workflow", "extensions", "remote"];
const OAUTH_RISK_WARNING: &str =
    "Using this provider through OAuth carries a high risk of penalties such as account restrictions.";

fn type_error(message: impl Into<String>) -> ToolModulesError {
    ToolModulesError::InvalidArgument(message.into())
}

fn failed(message: impl Into<String>) -> ToolModulesError {
    ToolModulesError::Failed(message.into())
}

/// `clean(value)`: `String(value ?? '').trim()`.
fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::js_trim(&mixdog_js::value_to_string(value)).to_owned(),
    }
}

impl Settings {
    pub fn new(config: Config, effects: Arc<dyn SettingsEffects>, env: SettingsEnv) -> Self {
        Self { config, effects, env, data_dir: std::path::PathBuf::new() }
    }

    /// The data directory whose bot store holds a store bot's route, which the onboarding status summarizes.
    pub fn with_data_dir(self, data_dir: impl Into<std::path::PathBuf>) -> Self {
        Self { data_dir: data_dir.into(), ..self }
    }

    pub fn with_process_env(config: Config, effects: Arc<dyn SettingsEffects>) -> Self {
        Self::new(config, effects, Arc::new(|name| std::env::var(name).ok()))
    }

    async fn save(&self, before: &Doc, after: &Doc) -> Result<(), ToolModulesError> {
        save_and_adopt(&self.config, before, after).await.map_err(ToolModulesError::Config)
    }

    // --- heartbeat ---

    pub fn heartbeat(&self) -> Value {
        let agent = self.config.agent();
        json!({
            "heartbeat": agent.get("heartbeat") == Some(&Value::Bool(true)),
            "intervalMinutes": heartbeat_minutes(agent.get("heartbeatIntervalMinutes")),
        })
    }

    pub async fn set_heartbeat_enabled(&self, enabled: &Value) -> Result<Value, ToolModulesError> {
        let before = self.config.agent();
        let mut after = before.clone();
        after.insert("heartbeat".into(), Value::Bool(enabled == &Value::Bool(true)));
        self.save(&before, &after).await?;
        Ok(self.heartbeat())
    }

    pub async fn set_heartbeat_interval(&self, minutes: &Value) -> Result<Value, ToolModulesError> {
        let choice = minutes
            .as_f64()
            .filter(|m| HEARTBEAT_INTERVAL_CHOICES.iter().any(|c| *c as f64 == *m))
            .ok_or_else(|| {
                let list: Vec<String> = HEARTBEAT_INTERVAL_CHOICES.iter().map(i64::to_string).collect();
                failed(format!("heartbeat interval must be one of {} minutes", list.join(", ")))
            })?;
        let before = self.config.agent();
        let mut after = before.clone();
        after.insert("heartbeatIntervalMinutes".into(), Value::from(choice as i64));
        self.save(&before, &after).await?;
        Ok(self.heartbeat())
    }

    // --- reactions, AI session titles, cache warming ---

    pub fn reactions(&self) -> Value {
        json!({ "reactions": self.config.agent().get("reactions") != Some(&Value::Bool(false)) })
    }

    pub async fn set_reactions_enabled(&self, enabled: &Value) -> Result<Value, ToolModulesError> {
        let before = self.config.agent();
        let mut after = before.clone();
        after.insert("reactions".into(), Value::Bool(enabled == &Value::Bool(true)));
        self.save(&before, &after).await?;
        Ok(self.reactions())
    }

    pub fn session_titles(&self) -> Value {
        json!({ "aiSessionTitles": self.config.agent().get("aiSessionTitles") != Some(&Value::Bool(false)) })
    }

    pub async fn set_ai_session_titles(&self, enabled: &Value) -> Result<Value, ToolModulesError> {
        let before = self.config.agent();
        let mut after = before.clone();
        after.insert("aiSessionTitles".into(), Value::Bool(enabled != &Value::Bool(false)));
        self.save(&before, &after).await?;
        Ok(self.session_titles())
    }

    pub fn cache_warming(&self) -> Value {
        json!({ "enabled": self.config.agent().get("promptCacheWarming") == Some(&Value::Bool(true)) })
    }

    pub async fn set_cache_warming_enabled(&self, enabled: &Value) -> Result<Value, ToolModulesError> {
        let Value::Bool(enabled) = enabled else {
            return Err(type_error("cache warming must be on or off (a boolean)"));
        };
        let before = self.config.agent();
        let mut after = before.clone();
        after.insert("promptCacheWarming".into(), Value::Bool(*enabled));
        self.save(&before, &after).await?;
        self.effects.note_cache_warming_enabled(*enabled);
        Ok(self.cache_warming())
    }

    // --- recap ---

    pub fn recap(&self) -> Value {
        let agent = self.config.agent();
        let off = agent.get("recap").and_then(Value::as_object).is_some_and(|r| r.get("enabled") == Some(&Value::Bool(false)));
        json!({ "enabled": !off })
    }

    // --- bot order ---

    pub fn bot_order(&self) -> Value {
        json!({ "order": normalize_bot_order(self.config.agent().get("botOrder")).unwrap_or_default() })
    }

    pub async fn set_bot_order(&self, order: &Value) -> Result<Value, ToolModulesError> {
        let usage = || failed("usage: setBotOrder(an array of agent ids)");
        let list = order.as_array().ok_or_else(usage)?;
        if list.len() > MAX_BOT_ORDER_IDS || list.iter().any(|id| !is_bot_order_id(id)) {
            return Err(usage());
        }
        let ids = normalize_bot_order(Some(order)).unwrap_or_default();
        let before = self.config.agent();
        let mut after = before.clone();
        if ids.is_empty() {
            after.shift_remove("botOrder");
        } else {
            after.insert("botOrder".into(), Value::from(ids));
        }
        self.save(&before, &after).await?;
        Ok(self.bot_order())
    }

    // --- system shell ---

    /// `normalizeSystemShellConfig(config.shell)`.
    pub fn system_shell(&self) -> Value {
        let agent = self.config.agent();
        shell_config(agent.get("shell"), &*self.env)
    }

    /// `setSystemShell(input)`: a string or `{ command }`.
    pub async fn set_system_shell(&self, input: &Value) -> Result<Value, ToolModulesError> {
        let raw = match input {
            Value::String(text) => Some(Value::String(text.clone())),
            Value::Object(map) => map.get("command").cloned(),
            _ => None,
        };
        let command = shell_command(raw.as_ref())?;
        let before = self.config.agent();
        let mut after = before.clone();
        let shell = if command.is_empty() {
            Doc::new()
        } else {
            let mut shell = before.get("shell").and_then(Value::as_object).cloned().unwrap_or_default();
            shell.insert("command".into(), Value::String(command.clone()));
            shell
        };
        after.insert("shell".into(), Value::Object(shell));
        self.save(&before, &after).await?;
        self.effects.set_configured_shell(&command);
        Ok(self.system_shell())
    }

    // --- developer options ---

    pub fn developer(&self) -> Value {
        developer_view(self.config.agent().get("developer"))
    }

    pub async fn set_developer_option(&self, id: &Value, enabled: &Value) -> Result<Value, ToolModulesError> {
        let name = id.as_str().unwrap_or_default();
        let known = DEVELOPER_OPTIONS.iter().any(|(_, option, ..)| *option == name);
        if !known || !id.is_string() {
            return Err(type_error(format!("Unknown developer option \"{}\".", mixdog_js::value_to_string(id))));
        }
        let Value::Bool(enabled) = enabled else {
            return Err(type_error("Developer option value must be a boolean."));
        };
        let before = self.config.agent();
        let mut after = before.clone();
        let mut developer = before.get("developer").and_then(Value::as_object).cloned().unwrap_or_default();
        developer.insert(name.to_owned(), Value::Bool(*enabled));
        after.insert("developer".into(), Value::Object(developer));
        self.save(&before, &after).await?;
        self.effects.sync_developer_option(name).await;
        Ok(self.developer())
    }

    // --- starter guide ---

    /// `saveStarterGuideState(state)`; answers `getOnboardingStatus()` of the config it adopted.
    pub async fn save_starter_guide_state(&self, state: &Value) -> Result<Value, ToolModulesError> {
        let next = required_starter_guide(state)?;
        let before = self.config.agent();
        let mut onboarding = before.get("onboarding").and_then(Value::as_object).cloned().unwrap_or_default();
        let merged = merge_starter_guide(stored_starter_guide(onboarding.get("starterGuide")), next);
        onboarding.insert("starterGuide".into(), merged);
        let mut after = before.clone();
        after.insert("onboarding".into(), Value::Object(onboarding));
        self.save(&before, &after).await?;
        let routes = crate::config::AgentRoutes::new(self.config.clone(), self.data_dir.clone());
        let bots = crate::workflow::onboarding::bot_routes(&routes).await.map_err(ToolModulesError::Config)?;
        crate::workflow::onboarding::adopted_status(&before, &after, &bots).map_err(failed)
    }
}

const PROFILE_TITLE_MAX: usize = 64;

/// `PROFILE_LANGUAGES`: id, label, prompt (`null` for the system locale).
pub const PROFILE_LANGUAGES: [(&str, &str, Option<&str>); 21] = [
    ("system", "System (locale)", None),
    ("en", "English", Some("English")),
    ("ko", "한국어", Some("Korean")),
    ("ja", "日本語", Some("Japanese (日本語)")),
    ("zh-Hans", "中文（简体）", Some("Simplified Chinese (简体中文)")),
    ("zh-Hant", "中文（繁體）", Some("Traditional Chinese (繁體中文)")),
    ("es", "Español", Some("Spanish (Español)")),
    ("fr", "Français", Some("French (Français)")),
    ("de", "Deutsch", Some("German (Deutsch)")),
    ("pt", "Português", Some("Portuguese (Português)")),
    ("ru", "Русский", Some("Russian (Русский)")),
    ("it", "Italiano", Some("Italian (Italiano)")),
    ("vi", "Tiếng Việt", Some("Vietnamese (Tiếng Việt)")),
    ("th", "ภาษาไทย", Some("Thai (ภาษาไทย)")),
    ("id", "Bahasa Indonesia", Some("Indonesian (Bahasa Indonesia)")),
    ("hi", "हिन्दी", Some("Hindi (हिन्दी)")),
    ("ar", "العربية", Some("Arabic (العربية)")),
    ("tr", "Türkçe", Some("Turkish (Türkçe)")),
    ("pl", "Polski", Some("Polish (Polski)")),
    ("nl", "Nederlands", Some("Dutch (Nederlands)")),
    ("uk", "Українська", Some("Ukrainian (Українська)")),
];

pub const PROFILE_EXPERIENCE_LEVELS: [(&str, &str); 4] =
    [("beginner", "Beginner"), ("vibe-coder", "Vibe coder"), ("junior", "Junior"), ("expert", "Expert")];

fn language_json((id, label, prompt): &(&str, &str, Option<&str>)) -> Value {
    json!({ "id": id, "label": label, "prompt": prompt })
}

fn level_json((id, label): &(&str, &str)) -> Value {
    json!({ "id": id, "label": label })
}

/// `String(value ?? fallback)` over the first non-null of `values`.
fn first_text(values: &[Option<&Value>], fallback: &str) -> String {
    values
        .iter()
        .flatten()
        .find(|v| !v.is_null())
        .map_or_else(|| fallback.to_owned(), |v| mixdog_js::value_to_string(v))
}

/// `normalizeProfileConfig`: `{ title, language, experienceLevel }`.
pub fn normalize_profile(value: Option<&Value>) -> Doc {
    let raw = value.and_then(Value::as_object);
    let get = |key: &str| raw.and_then(|m| m.get(key));
    let title_text = first_text(&[get("title"), get("name")], "");
    let mut title = String::new();
    let mut units = 0;
    for ch in mixdog_js::js_trim(&title_text).chars() {
        units += ch.len_utf16();
        if units > PROFILE_TITLE_MAX {
            break;
        }
        title.push(ch);
    }
    let requested = first_text(&[get("language"), get("lang")], "system");
    let requested = mixdog_js::js_trim(&requested);
    let language = if PROFILE_LANGUAGES.iter().any(|(id, ..)| *id == requested) { requested } else { "system" };
    // `/[\s_]+/g` → '-': each run of separators becomes one dash.
    let mut joined = String::new();
    let source = mixdog_js::js_trim(&first_text(&[get("experienceLevel")], "")).to_lowercase();
    let mut in_run = false;
    for ch in source.chars() {
        if ch.is_whitespace() || ch == '_' {
            if !in_run {
                joined.push('-');
            }
            in_run = true;
        } else {
            joined.push(ch);
            in_run = false;
        }
    }
    let experience = if PROFILE_EXPERIENCE_LEVELS.iter().any(|(id, _)| *id == joined) { joined } else { String::new() };
    let mut out = Doc::new();
    out.insert("title".into(), Value::String(title));
    out.insert("language".into(), Value::String(language.to_owned()));
    out.insert("experienceLevel".into(), Value::String(experience));
    out
}

impl Settings {
    /// `getProfile`: the normalised profile with its catalog entries and picker lists.
    pub fn profile(&self) -> Value {
        let agent = self.config.agent();
        let profile = normalize_profile(agent.get("profile"));
        let language = profile["language"].as_str().unwrap_or("system");
        let level = profile["experienceLevel"].as_str().unwrap_or("");
        let language_entry = PROFILE_LANGUAGES.iter().find(|(id, ..)| *id == language).unwrap_or(&PROFILE_LANGUAGES[0]);
        let level_entry = PROFILE_EXPERIENCE_LEVELS.iter().find(|(id, _)| *id == level).map(level_json);
        let mut out = profile.clone();
        out.insert("languageEntry".into(), language_json(language_entry));
        out.insert("languages".into(), Value::Array(PROFILE_LANGUAGES.iter().map(language_json).collect()));
        out.insert("experienceLevelEntry".into(), level_entry.unwrap_or(Value::Null));
        out.insert("experienceLevels".into(), Value::Array(PROFILE_EXPERIENCE_LEVELS.iter().map(level_json).collect()));
        Value::Object(out)
    }

    /// `setProfile(input)`: patches title, language and/or experience level.
    pub async fn set_profile(&self, input: &Value) -> Result<Value, ToolModulesError> {
        let before = self.config.agent();
        let mut next = normalize_profile(before.get("profile"));
        let own = |key: &str| input.as_object().and_then(|m| m.get(key));
        let has = |key: &str| input.as_object().is_some_and(|m| m.contains_key(key));
        let pick = |keys: [&str; 2], fallback: &str| {
            Value::String(first_text(&[own(keys[0]), own(keys[1])], fallback))
        };
        if has("title") || has("name") {
            next.insert("title".into(), pick(["title", "name"], ""));
        }
        if has("language") || has("lang") {
            next.insert("language".into(), pick(["language", "lang"], "system"));
        }
        if has("experienceLevel") {
            next.insert("experienceLevel".into(), Value::String(first_text(&[own("experienceLevel")], "")));
        }
        let normalized = normalize_profile(Some(&Value::Object(next)));
        let mut after = before.clone();
        after.insert("profile".into(), Value::Object(normalized));
        self.save(&before, &after).await?;
        Ok(self.profile())
    }

    /// `getTheme`: the stored `ui.theme` resolved against the registry (the default for an
    /// absent or unknown value).
    pub fn theme(&self) -> Value {
        let stored = self.config.get("ui.theme");
        Value::String(resolve_theme(stored.as_ref()).0.to_owned())
    }

    /// `setTheme(id, { persist })`: an unknown id falls back to the default; `persist: false`
    /// applies without storing. Answers `{ id, label, description }`.
    pub async fn set_theme(&self, id: &Value, options: &Value) -> Result<Value, ToolModulesError> {
        let (theme_id, label, description) = resolve_theme(Some(id));
        let persist = options.get("persist") != Some(&Value::Bool(false));
        if persist {
            let theme_id = theme_id.to_owned();
            self.config
                .update(move |doc| {
                    let mut ui = doc.get("ui").and_then(Value::as_object).cloned().unwrap_or_default();
                    ui.insert("theme".into(), Value::String(theme_id));
                    doc.insert("ui".into(), Value::Object(ui));
                    Ok(())
                })
                .await
                .map_err(ToolModulesError::Config)?;
        }
        Ok(json!({ "id": theme_id, "label": label, "description": description }))
    }

    /// `setAutoUpdate(enabled)`: only the stored switch; the update-check state of the answer
    /// belongs to the updater.
    pub async fn set_auto_update(&self, enabled: &Value) -> Result<(), ToolModulesError> {
        let before = self.config.agent();
        let mut update = before.get("update").and_then(Value::as_object).cloned().unwrap_or_default();
        update.insert("auto".into(), Value::Bool(enabled == &Value::Bool(true)));
        let mut after = before.clone();
        after.insert("update".into(), Value::Object(update));
        self.save(&before, &after).await
    }
}

/// `THEME_ORDER` of the TUI registry: id, label, description.
const THEMES: [(&str, &str, &str); 14] = [
    ("basic", "Basic", "Amber-gold default dark with a hot orange live state."),
    ("indigo", "Indigo", "Cool blue-indigo brand dark with orange live state."),
    ("warm", "Warm", "Soft sunset coral on neutral charcoal."),
    ("teal", "Teal", "pi-style teal accent with soft body text."),
    ("onedark", "One Dark", "Atom One Dark — blue accent on slate, balanced syntax."),
    ("tokyonight", "Tokyo Night", "Storm variant — soft blue/purple dark with neon markdown."),
    ("kanagawa", "Kanagawa", "Wave variant — muted ink dark with crystal-blue accent."),
    ("catppuccin", "Catppuccin", "Mocha — gentle pastel violet/blue dark."),
    ("dracula", "Dracula", "Classic purple/pink accents with cyan links."),
    ("rosepine", "Rosé Pine", "Muted rose/pine dark with soho elegance."),
    ("nord", "Nord", "Cool arctic blue/teal frost dark."),
    ("gruvbox", "Gruvbox", "Retro warm earthy dark with green/orange accents."),
    ("everforest", "Everforest", "Soft natural green dark, easy on the eyes."),
    ("light", "Light", "GitHub Light high-contrast — solid blue selection, terminal-ready chrome."),
];

/// `resolveThemeId`: `String(id || '').trim()`, the alias `basicIndigo`, else the default.
fn resolve_theme(id: Option<&Value>) -> (&'static str, &'static str, &'static str) {
    let falsy = match id {
        None | Some(Value::Null | Value::Bool(false)) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        _ => false,
    };
    let text = if falsy { String::new() } else { mixdog_js::value_to_string(id.unwrap_or(&Value::Null)) };
    let key = mixdog_js::js_trim(&text);
    let key = if key == "basicIndigo" { "indigo" } else { key };
    THEMES.iter().find(|(id, ..)| *id == key).copied().unwrap_or(THEMES[0])
}

fn heartbeat_minutes(value: Option<&Value>) -> i64 {
    value
        .and_then(Value::as_f64)
        .filter(|m| HEARTBEAT_INTERVAL_CHOICES.iter().any(|c| *c as f64 == *m))
        .map_or(DEFAULT_HEARTBEAT_INTERVAL_MINUTES, |m| m as i64)
}

fn is_bot_order_id(id: &Value) -> bool {
    id.as_str().is_some_and(|s| {
        let trimmed = mixdog_js::js_trim(s);
        !trimmed.is_empty() && mixdog_js::utf16_len(trimmed) <= 128
    })
}

/// `normalizeBotOrder`: trimmed, de-duplicated ids, at most 500; anything else is no order.
fn normalize_bot_order(value: Option<&Value>) -> Option<Vec<String>> {
    let list = value?.as_array()?;
    let mut ids: Vec<String> = Vec::new();
    for id in list.iter().filter(|id| is_bot_order_id(id)) {
        let id = mixdog_js::js_trim(id.as_str().unwrap_or_default()).to_owned();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.truncate(MAX_BOT_ORDER_IDS);
    Some(ids)
}

/// `normalizeSystemShellConfig`.
fn shell_config(value: Option<&Value>, env: &(dyn Fn(&str) -> Option<String> + Send + Sync)) -> Value {
    let command = clean(value.and_then(Value::as_object).and_then(|m| m.get("command")));
    let env_command = env("MIXDOG_SHELL").map(|v| mixdog_js::js_trim(&v).to_owned()).unwrap_or_default();
    let source = if !command.is_empty() {
        "config"
    } else if !env_command.is_empty() {
        "env"
    } else {
        "auto"
    };
    let effective = if !command.is_empty() { command.clone() } else { env_command };
    json!({ "command": command, "effective": effective, "source": source })
}

/// `normalizeSystemShellCommand`: `auto` and quotes are dropped; on Windows only PowerShell.
fn shell_command(value: Option<&Value>) -> Result<String, ToolModulesError> {
    let text = clean(value);
    let text = if text.eq_ignore_ascii_case("auto") { String::new() } else { text };
    let chars: Vec<char> = text.chars().collect();
    let unquoted = if chars.len() >= 3
        && matches!(chars[0], '\'' | '"')
        && matches!(chars[chars.len() - 1], '\'' | '"')
    {
        chars[1..chars.len() - 1].iter().collect::<String>()
    } else {
        text
    };
    let command = mixdog_js::js_trim(&unquoted).to_owned();
    if command.is_empty() {
        return Ok(command);
    }
    if cfg!(windows) {
        let stem = command.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
        let stem = stem.strip_suffix(".exe").unwrap_or(&stem);
        if stem != "powershell" && stem != "pwsh" {
            return Err(failed("system shell command must be powershell.exe or pwsh on Windows"));
        }
    }
    Ok(command)
}

/// The developer registry (`DEVELOPER_SECTIONS`): section id, option id, then the option's
/// label, description, warning and provider.
type DeveloperOption = (&'static str, &'static str, &'static str, &'static str, Option<&'static str>, Option<&'static str>);
const DEVELOPER_OPTIONS: [DeveloperOption; 5] = [
    ("approvals", "allowAllActions", "Allow all actions",
     "Skips the approval cards for every action except payments and permanent deletes.",
     Some("Turning this on lets agents act without asking you first, except for payments and permanent deletes. Use it only if you accept that risk."), None),
    ("providers", "antigravityOAuth", "Gemini (Antigravity)", "Show Antigravity (Gemini) OAuth in Providers and the model picker.", Some(OAUTH_RISK_WARNING), Some("antigravity-oauth")),
    ("providers", "cursorOAuth", "Cursor", "Show Cursor OAuth in Providers and the model picker.", Some(OAUTH_RISK_WARNING), Some("cursor-oauth")),
    ("providers", "devinOAuth", "Devin", "Show Devin OAuth in Providers and the model picker.", Some(OAUTH_RISK_WARNING), Some("devin-oauth")),
    ("providers", "mimoOAuth", "MiMo", "Show Xiaomi MiMo OAuth in Providers and the model picker.", Some(OAUTH_RISK_WARNING), Some("mimo-oauth")),
];

/// `developerSettingsView(stored)`.
fn developer_view(stored: Option<&Value>) -> Value {
    let values: Doc = stored
        .and_then(Value::as_object)
        .map(|m| m.iter().filter(|(_, v)| v.is_boolean()).map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let section = |id: &str, label: &str, description: Option<&str>| {
        let options: Vec<Value> = DEVELOPER_OPTIONS
            .iter()
            .filter(|(section, ..)| *section == id)
            .map(|(_, option, label, description, warning, provider)| {
                let mut out = Map::new();
                out.insert("id".into(), json!(option));
                out.insert("label".into(), json!(label));
                out.insert("description".into(), json!(description));
                if let Some(warning) = warning {
                    out.insert("warning".into(), json!(warning));
                }
                if let Some(provider) = provider {
                    out.insert("provider".into(), json!(provider));
                }
                out.insert("enabled".into(), Value::Bool(values.get(*option) == Some(&Value::Bool(true))));
                Value::Object(out)
            })
            .collect();
        let mut out = Map::new();
        out.insert("id".into(), json!(id));
        out.insert("label".into(), json!(label));
        if let Some(description) = description {
            out.insert("description".into(), json!(description));
        }
        out.insert("options".into(), Value::Array(options));
        Value::Object(out)
    };
    json!({ "sections": [section("approvals", "Approvals", None), section("providers", "Providers", Some(OAUTH_RISK_WARNING))] })
}

fn stored_starter_guide(value: Option<&Value>) -> Option<(bool, bool, Vec<&'static str>)> {
    let map = value?.as_object()?;
    let visited: Vec<&Value> = map.get("visited").and_then(Value::as_array).map(|v| v.iter().collect()).unwrap_or_default();
    Some((
        map.get("closed") == Some(&Value::Bool(true)),
        map.get("welcomed") == Some(&Value::Bool(true)),
        STARTER_GUIDE_STEPS.into_iter().filter(|step| visited.iter().any(|v| v.as_str() == Some(step))).collect(),
    ))
}

type Guide = (bool, bool, Vec<&'static str>);

/// `requiredStarterGuideState`: read strictly, nothing off-schema is coerced.
fn required_starter_guide(value: &Value) -> Result<Guide, ToolModulesError> {
    let map = value.as_object().ok_or_else(|| type_error("starter guide state must be an object."))?;
    if let Some(key) = map.keys().find(|key| !matches!(key.as_str(), "closed" | "welcomed" | "visited")) {
        return Err(type_error(format!("starter guide state has an unknown field: {key}.")));
    }
    if !matches!(map.get("closed"), Some(Value::Bool(_))) || !matches!(map.get("welcomed"), Some(Value::Bool(_))) {
        return Err(type_error("starter guide closed and welcomed must be booleans."));
    }
    let known = |v: &Value| v.as_str().is_some_and(|s| STARTER_GUIDE_STEPS.contains(&s));
    match map.get("visited").and_then(Value::as_array) {
        Some(list) if list.len() <= STARTER_GUIDE_STEPS.len() * 2 && list.iter().all(known) => {}
        _ => return Err(type_error("starter guide visited must list known steps.")),
    }
    Ok(stored_starter_guide(Some(value)).expect("an object"))
}

/// `mergeStarterGuide`: every field only moves forward.
fn merge_starter_guide(stored: Option<Guide>, next: Guide) -> Value {
    let (closed, welcomed, visited) = stored.unwrap_or((false, false, Vec::new()));
    let merged: Vec<&str> = STARTER_GUIDE_STEPS
        .into_iter()
        .filter(|step| visited.contains(step) || next.2.contains(step))
        .collect();
    json!({ "closed": closed || next.0, "welcomed": welcomed || next.1, "visited": merged })
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;
