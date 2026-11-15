//! What the terminal client needs of the core that no other method gave it (the audit of
//! `mixdog-session-view/tests/fixtures/core-gaps.json`, ported from the Node session object of the TUI,
//! `src/tui/session/session-api.mjs`, `session-api/controls.mjs`, `notice-surface.mjs`):
//!
//! - `config/getSettingsSnapshot` (`getSettingsSnapshot({ heavy })`, the call's `options`): the one read of the settings picker's rows. It calls the
//!   same protocol reads the picker would fan out to (no second source of any value) and a read that fails is `null` in its
//!   place, as Node's `read()` helper degrades it; `heavy` (default on) adds the MCP, plugin and skill status.
//! - `thread/setProgressHint` (`setProgressHint(text, tone, percent)`): the sticky hint line of the input row; an empty text clears
//!   it. It is the runtime section's `progressHint`, published through the same `Section::ProgressHint` the running tool's hint and
//!   the voice install use.
//! - `thread/rememberPromptHistory` (`rememberPromptHistory(text)`): the draft Esc clears joins the cwd's persisted up-arrow history.
//!   The thread's actor appends it through the prompt writer a submitted prompt goes through ([`remembered_prompt`] is what it keeps).
//! - `thread/restoreOlderTranscript` / `thread/restoreNewerTranscript`: Node paged rows between memory and a spill file. The core
//!   keeps the whole log and a client pages it with `thread/items/list`, so nothing is ever restored here: both answer `false`, the
//!   value Node's call gave when no page was restored.
//!
//! `inspectProjectPath` is not here: `project/read` is that call (the workspace service answers `{ path, exists, directory }` for
//! any path, registered or not); the audit only lacked its name.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::setup::DomainCalls;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::wrong_method;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_js::js_trim;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

pub const GET_SETTINGS_SNAPSHOT: &str = "config/getSettingsSnapshot";
pub const SET_PROGRESS_HINT: &str = "thread/setProgressHint";
pub const REMEMBER_PROMPT_HISTORY: &str = "thread/rememberPromptHistory";
pub const RESTORE_OLDER_TRANSCRIPT: &str = "thread/restoreOlderTranscript";
pub const RESTORE_NEWER_TRANSCRIPT: &str = "thread/restoreNewerTranscript";

const AUTO_CLEAR: &str = "config/getAutoClear";
const COMPACTION: &str = "config/getCompactionSettings";
const RECAP: &str = "config/getRecapSettings";
const SESSION_TITLES: &str = "config/getSessionTitleSettings";
const TOOL_MODULES: &str = "config/getToolModuleSettings";
const CHANNELS: &str = "channel/getChannelSettings";
const SYSTEM_SHELL: &str = "config/getSystemShell";
const OUTPUT_STYLE: &str = "config/getOutputStyle";
const OUTPUT_STYLES: &str = "config/listOutputStyles";
const CHANNEL_WORKER: &str = "channel/getChannelWorkerStatus";
const PROFILE: &str = "config/getProfile";
const UPDATE_SETTINGS: &str = "config/getUpdateSettings";
const MCP: &str = "mcp/mcpStatus";
const PLUGINS: &str = "plugins/pluginsStatus";
const SKILLS: &str = "skills/skillsStatus";
const VOICE_STATUS: &str = "voice/getVoiceStatus";

/// Where the snapshot's values come from: the protocol reads of the other services (the core's domain table as internal calls,
/// the seam the setup status readers use), and the web-search route (a pushed section whose value the workflow config owns).
pub struct SettingsReads {
    domains: Arc<dyn DomainCalls>,
    web_search_route: Box<dyn Fn() -> Result<Value, CoreError> + Send + Sync>,
}

impl SettingsReads {
    pub fn new(domains: Arc<dyn DomainCalls>, web_search_route: impl Fn() -> Result<Value, CoreError> + Send + Sync + 'static) -> Self {
        Self { domains, web_search_route: Box::new(web_search_route) }
    }
}

/// JavaScript's truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The `thread` a call names, when it names one.
fn thread_param(params: &Value) -> Option<&str> {
    params.get("threadId").and_then(Value::as_str).filter(|id| !id.is_empty())
}

/// `getSettingsSnapshot({ heavy = true })`: the argument is the call's `options`; `heavy` is on unless it states it and it is falsy
/// (a default replaces only an absent value, so an explicit `null` turns it off).
fn heavy(params: &Value) -> bool {
    params.get("options").and_then(|options| options.get("heavy")).is_none_or(truthy)
}

/// `getSettingsSnapshot`: every row of the settings picker, each read on its own (a failing one is `null`).
pub async fn settings_snapshot(reads: &SettingsReads, params: &Value) -> Value {
    let scoped = |extra: Value| {
        let mut map = match extra {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        if let Some(thread) = thread_param(params) {
            map.insert("threadId".into(), json!(thread));
        }
        Value::Object(map)
    };
    let read = |method: &'static str, extra: Value| {
        let params = scoped(extra);
        async move { reads.domains.call(method, params).await.unwrap_or(Value::Null) }
    };
    let mut snapshot = Map::new();
    snapshot.insert("autoClear".into(), read(AUTO_CLEAR, json!({})).await);
    snapshot.insert("compaction".into(), read(COMPACTION, json!({})).await);
    snapshot.insert("recap".into(), read(RECAP, json!({})).await);
    snapshot.insert("sessionTitles".into(), read(SESSION_TITLES, json!({})).await);
    snapshot.insert("toolModules".into(), read(TOOL_MODULES, json!({})).await);
    snapshot.insert("channels".into(), read(CHANNELS, json!({ "options": { "includeStatus": false } })).await);
    snapshot.insert("systemShell".into(), read(SYSTEM_SHELL, json!({})).await);
    snapshot.insert("webSearchRoute".into(), (reads.web_search_route)().unwrap_or(Value::Null));
    let style = read(OUTPUT_STYLE, json!({})).await;
    snapshot.insert("outputStyle".into(), if truthy(&style) { style } else { read(OUTPUT_STYLES, json!({})).await });
    snapshot.insert("channelWorker".into(), read(CHANNEL_WORKER, json!({})).await);
    snapshot.insert("profile".into(), read(PROFILE, json!({})).await);
    snapshot.insert("updateSettings".into(), read(UPDATE_SETTINGS, json!({})).await);
    // `voice: { enabled }`: the switch of the managed voice runtime, as the settings row shows it (null when the status cannot be read).
    let voice = read(VOICE_STATUS, json!({})).await;
    snapshot.insert("voice".into(), if voice.is_object() { json!({ "enabled": voice.get("enabled").is_some_and(truthy) }) } else { Value::Null });
    if heavy(params) {
        snapshot.insert("mcp".into(), read(MCP, json!({})).await);
        snapshot.insert("plugins".into(), read(PLUGINS, json!({})).await);
        snapshot.insert("skills".into(), read(SKILLS, json!({})).await);
    }
    Value::Object(snapshot)
}

/// `String(value ?? '')`: a text as the notice surface reads it. A list or an object has no text the client ever sends.
fn string_of(value: &Value, what: &str) -> Result<String, CoreError> {
    match value {
        Value::Null => Ok(String::new()),
        Value::String(text) => Ok(text.clone()),
        Value::Number(number) => Ok(number.to_string()),
        Value::Bool(flag) => Ok(flag.to_string()),
        Value::Array(_) | Value::Object(_) => Err(invalid(what, "a text")),
    }
}

/// `Number(value)` of a JSON value; `NaN` for what is no number.
fn number_of(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => {
            let text = js_trim(text);
            if text.is_empty() { 0.0 } else { text.parse::<f64>().unwrap_or(f64::NAN) }
        }
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}

/// `setProgressHint(text, tone = 'info', percent)`: the hint to show, `None` to clear it. The text is trimmed and an empty one
/// clears; the tone is the caller's (`info` when none is named); a percent that is a finite number is rounded and held in 0..=100.
pub fn progress_hint(params: &Value) -> Result<Option<Value>, CoreError> {
    let text = string_of(params.get("text").unwrap_or(&Value::Null), "text")?;
    let text = js_trim(&text);
    if text.is_empty() {
        return Ok(None);
    }
    let tone = params.get("tone").cloned().unwrap_or_else(|| json!("info"));
    let mut hint = Map::new();
    hint.insert("text".into(), json!(text));
    hint.insert("tone".into(), tone);
    // A percent that was not sent is `undefined`, whose `Number` is `NaN`; one sent as `null` is `0`.
    let percent = params.get("percent").map_or(f64::NAN, number_of);
    if percent.is_finite() {
        // `Math.round` rounds a half up.
        let rounded = (percent + 0.5).floor().clamp(0.0, 100.0);
        hint.insert("percent".into(), json!(rounded as u8));
    }
    Ok(Some(Value::Object(hint)))
}

/// `rememberPromptHistory(value)`: the text the persisted history takes, `None` when there is none (`String(value || '').trim()`
/// empty).
pub fn remembered_prompt(params: &Value) -> Result<Option<String>, CoreError> {
    let value = params.get("text").unwrap_or(&Value::Null);
    let text = if truthy(value) { string_of(value, "text")? } else { String::new() };
    let text = js_trim(&text);
    Ok((!text.is_empty()).then(|| text.to_owned()))
}

/// The methods of [`TuiClientService`], in the order the service lists them.
const METHODS: &[&str] = &[GET_SETTINGS_SNAPSHOT, SET_PROGRESS_HINT, RESTORE_OLDER_TRANSCRIPT, RESTORE_NEWER_TRANSCRIPT];

/// The terminal client's own methods served by a domain, as `TurnActionsService` serves the other session actions that need no
/// actor state. `thread/rememberPromptHistory` is the thread actor's (it owns the prompt writer).
pub struct TuiClientService {
    reads: SettingsReads,
    threads: Arc<dyn ThreadState>,
}

impl TuiClientService {
    pub fn new(reads: SettingsReads, threads: Arc<dyn ThreadState>) -> Arc<Self> {
        Arc::new(Self { reads, threads })
    }

    /// The thread a call acts on.
    fn thread(params: &Value) -> Result<ThreadId, CoreError> {
        thread_param(params).map(ThreadId::from).ok_or_else(|| invalid("threadId", "the thread to act on"))
    }

    async fn set_progress_hint(&self, params: &Value) -> Result<Value, CoreError> {
        let thread = Self::thread(params)?;
        let hint = progress_hint(params)?;
        match self.threads.publish(&thread, Section::ProgressHint(hint)).await {
            Ok(()) => Ok(Value::Null),
            Err(PortError::NotFound { .. }) => Err(CoreError::ThreadNotFound { thread_id: thread }),
            Err(error) => Err(failed("session", format!("{error:?}"))),
        }
    }
}

#[async_trait]
impl DomainService for TuiClientService {
    fn methods(&self) -> &'static [&'static str] {
        METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            GET_SETTINGS_SNAPSHOT => Ok(Reply::Value(settings_snapshot(&self.reads, &req.params).await)),
            SET_PROGRESS_HINT => self.set_progress_hint(&req.params).await.map(Reply::Value),
            RESTORE_OLDER_TRANSCRIPT | RESTORE_NEWER_TRANSCRIPT => {
                Self::thread(&req.params)?;
                Ok(Reply::Value(Value::Bool(false)))
            }
            other => Err(wrong_method("the terminal client", other)),
        }
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
