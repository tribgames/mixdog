//! The hook bus: runs the configured hook handlers for an event and folds their verdicts (Node
//! `hook-bus/`). The before-tool decision — standard `PreToolUse` handlers first (deny / ask /
//! modify), then the legacy rule file — is what the tool policy's `PreToolHook` asks for.

pub mod after;
pub mod config;
pub mod output;
pub mod rules;
pub mod runners;
pub mod session;

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_js::js_trim;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use self::config::HookConfig;
use self::config::Loaded;
use self::output::Aggregate;
use self::output::HandlerRun;
pub use self::output::MAX_BUFFER_BYTES;
use self::output::handler_timeout;
use self::output::parse_handler_output;
use self::output::run_failure;
use self::rules::Subject;
use self::rules::dedupe_key;
use self::rules::if_condition_passes;
use self::runners::CommandContext;
use self::runners::CommandRunner;
use crate::hook_runner::run_mcp_tool_handler;
use crate::hooks::HookHandler;
use crate::hooks::NO_MATCHER_EVENTS;
use crate::hooks::SUPPORTED_HANDLER_TYPES;
use crate::hooks::match_field;
use crate::hub::McpHub;

/// Receives the hook bus's observer events (`tool:before`, `tool:deny`, `hook:error`, …).
pub trait HookObserver: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// Runs a `prompt` handler: asks a model the handler's prompt about the event payload and
/// answers its text.
#[async_trait]
pub trait PromptRunner: Send + Sync {
    async fn run(&self, prompt: &str, payload: &Value, timeout: Duration, cancel: &CancellationToken) -> Result<String, String>;
}

/// What the before-tool hooks decided.
#[derive(Clone, PartialEq, Debug)]
pub struct Outcome {
    /// `deny`, `ask`, `modify` or `allow`.
    pub action: &'static str,
    pub name: Option<String>,
    pub args: Option<Value>,
    pub reason: Option<String>,
}

/// The fields every hook payload carries besides the call itself (the session's transcript
/// file, permission mode and effort).
#[derive(Clone, PartialEq, Debug, Default)]
pub struct HookCommon {
    pub transcript_path: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<Value>,
}

/// The session transcript a hook is told about (`hookTranscriptPath`): derived on demand, so
/// the bus asks just before a handler runs.
#[async_trait]
pub trait TranscriptExport: Send + Sync {
    /// The payload's `transcript_path` for a session with a non-empty id: the path of its
    /// refreshed transcript file, or `null` for an id that cannot name a session.
    async fn transcript_path(&self, session_id: &str) -> Value;
}

/// A tool call as the hooks see it. `cwd` is the call's effective directory
/// ([`after::effective_tool_cwd`]).
pub struct ToolCall<'a> {
    pub session_id: &'a str,
    pub call_id: &'a str,
    pub name: &'a str,
    pub args: &'a Value,
    pub cwd: &'a Path,
    pub common: &'a HookCommon,
}

/// A session-level event (`PostToolBatch`): no tool, no matcher.
pub struct BatchCall<'a> {
    pub session_id: &'a str,
    pub cwd: &'a Path,
    pub common: &'a HookCommon,
    pub tool_count: usize,
}

/// What an event's handlers decided, for the events whose answer is read field by field.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct Dispatched {
    pub blocked: bool,
    /// A handler answered `continue: false`.
    pub prevent_continuation: bool,
    pub reason: Option<String>,
    pub additional_context: Vec<String>,
    pub updated_input: Option<Value>,
    pub updated_tool_name: Option<String>,
    pub updated_tool_output: Option<Value>,
    pub handlers_run: usize,
}

pub struct HookBus {
    data_dir: PathBuf,
    maintenance: MaintenanceIo,
    commands: CommandRunner,
    hub: Option<Arc<McpHub>>,
    prompt: Option<Arc<dyn PromptRunner>>,
    observer: Option<Arc<dyn HookObserver>>,
    cache: Mutex<Option<Arc<HookConfig>>>,
    /// Bound once by the session service, which owns the transcript (built after the bus).
    transcripts: std::sync::OnceLock<Arc<dyn TranscriptExport>>,
    /// Bound once by the session service: the MCP scope of the session a hook fires for.
    scopes: std::sync::OnceLock<ScopeOf>,
}

/// The MCP scope a session holds (its header's `mcpScopeId`), by session id; `None` for an id the
/// session service does not hold.
pub type ScopeOf = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

fn base_payload(event: &str, session_id: &str, cwd: &Path, common: &HookCommon) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("session_id".into(), if session_id.is_empty() { Value::Null } else { json!(session_id) });
    payload.insert("cwd".into(), json!(cwd.to_string_lossy()));
    payload.insert("hook_event_name".into(), json!(event));
    if let Some(path) = &common.transcript_path {
        payload.insert("transcript_path".into(), json!(path));
    }
    if let Some(mode) = &common.permission_mode {
        payload.insert("permission_mode".into(), json!(mode));
    }
    if let Some(effort) = common.effort.as_ref().filter(|e| !e.is_null()) {
        payload.insert("effort".into(), effort.clone());
    }
    payload
}

/// `payload` with `transcript_path` right after `hook_event_name`, where `base_payload` puts it.
fn with_transcript_path(payload: &Value, path: Value) -> Value {
    let mut out = Map::new();
    for (key, value) in payload.as_object().into_iter().flatten().filter(|(key, _)| key.as_str() != "transcript_path") {
        out.insert(key.clone(), value.clone());
        if key.as_str() == "hook_event_name" {
            out.insert("transcript_path".into(), path.clone());
        }
    }
    Value::Object(out)
}

/// `response` is the tool's result (after events only).
fn build_payload(event: &str, input: &ToolCall<'_>, response: Option<&Value>) -> Value {
    let mut payload = base_payload(event, input.session_id, input.cwd, input.common);
    payload.insert("tool_name".into(), json!(input.name));
    payload.insert("tool_input".into(), input.args.clone());
    if !input.call_id.is_empty() {
        payload.insert("tool_use_id".into(), json!(input.call_id));
    }
    if let Some(response) = response.filter(|r| !r.is_null()) {
        payload.insert("tool_response".into(), response.clone());
    }
    Value::Object(payload)
}

impl HookBus {
    pub fn new(
        data_dir: PathBuf,
        maintenance: MaintenanceIo,
        processes: Arc<dyn ProcessManager>,
        hub: Option<Arc<McpHub>>,
        prompt: Option<Arc<dyn PromptRunner>>,
        observer: Option<Arc<dyn HookObserver>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            data_dir,
            maintenance,
            commands: CommandRunner::new(processes),
            hub,
            prompt,
            observer,
            cache: Mutex::new(None),
            transcripts: std::sync::OnceLock::new(),
            scopes: std::sync::OnceLock::new(),
        })
    }

    /// Makes every payload carry the transcript path `export` gives. Err: already bound.
    pub fn bind_transcripts(&self, export: Arc<dyn TranscriptExport>) -> Result<(), Arc<dyn TranscriptExport>> {
        self.transcripts.set(export)
    }

    /// Makes an `mcp_tool` handler find its tool among the servers of the scope the hook's session
    /// holds (`scopeId: rt.mcpScopeId`, `boot/infrastructure.mjs:97`). Err: already bound.
    pub fn bind_scopes(&self, scope_of: ScopeOf) -> Result<(), ScopeOf> {
        self.scopes.set(scope_of)
    }

    fn emit(&self, event: &str, payload: Value) {
        if let Some(observer) = &self.observer {
            observer.emit(event, payload);
        }
    }

    async fn load(&self, cwd: &Path) -> Result<Loaded, String> {
        let previous = self.cache.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let (data_dir, cwd) = (self.data_dir.clone(), cwd.to_path_buf());
        let env_file = std::env::var_os("MIXDOG_HOOKS_FILE").map(PathBuf::from);
        let job = self
            .maintenance
            .submit(&CancellationToken::new(), move |lane| {
                config::load_config(lane, &data_dir, &cwd, env_file.as_deref(), previous)
            })
            .map_err(|_| "the hooks configuration could not be read: the maintenance lane is full".to_owned())?;
        let loaded = job.await.map_err(|e| format!("the hooks configuration could not be read: {e:?}"))?;
        if loaded.fresh {
            for (file, problem) in &loaded.config.errors {
                self.emit("hook:error", json!({"error": format!("failed to parse hooks file {}: {problem}", file.display())}));
            }
        }
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&loaded.config));
        Ok(loaded)
    }

    fn select_handlers<'a>(&self, config: &'a HookConfig, event: &str, payload: &Value) -> Vec<&'a HookHandler> {
        if config.disabled || !config.standard {
            return Vec::new();
        }
        let Some(groups) = config.events.get(event) else { return Vec::new() };
        let field = match_field(event, payload);
        let mut seen = std::collections::HashSet::new();
        let mut handlers = Vec::new();
        for group in groups {
            if NO_MATCHER_EVENTS.contains(&event) || group.matcher.fires(field.unwrap_or_default()) {
                for handler in &group.handlers {
                    if seen.insert(dedupe_key(handler)) {
                        handlers.push(handler);
                    }
                }
            }
        }
        handlers
    }

    /// Runs one handler: the `if` condition, the supported-type check, the trust gate for
    /// project hooks, then the runner of its type. `None`: nothing ran.
    async fn run_one(&self, handler: &HookHandler, event: &str, payload: &Value, loaded: &Loaded) -> Option<HandlerRun> {
        let tool_name = payload.get("tool_name").and_then(Value::as_str).unwrap_or_default();
        let error_name = if tool_name.is_empty() { event } else { tool_name };
        let tool_input = payload.get("tool_input").unwrap_or(&Value::Null);
        if !if_condition_passes(handler.raw.get("if"), event, tool_name, tool_input) {
            return None;
        }
        let kind = js_trim(handler.raw.get("type").and_then(Value::as_str).unwrap_or_default());
        if !SUPPORTED_HANDLER_TYPES.contains(&kind) {
            let shown = if kind.is_empty() { "(missing)" } else { kind };
            self.emit("hook:error", json!({"name": error_name, "error": format!("unsupported hook type: {shown}")}));
            return None;
        }
        // Executable and network handlers from an untrusted project's hooks file are an RCE and
        // exfiltration vector without a user-level trust opt-in.
        if handler.untrusted && matches!(kind, "command" | "http" | "mcp_tool") {
            self.emit(
                "hook:error",
                json!({"name": error_name, "error": format!("blocked {kind} hook from untrusted project (add project to trustedProjects to enable)")}),
            );
            return None;
        }
        let text = |key: &str| handler.raw.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
        // Dropping this future (the call was cancelled) cancels whatever the handler started.
        let cancel = CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        match kind {
            "command" => {
                text("command")?;
                let cwd = Path::new(payload.get("cwd").and_then(Value::as_str).unwrap_or_default());
                let plugin_data = handler.plugin_data.clone().unwrap_or_else(|| self.data_dir.clone());
                let ctx = CommandContext { project_dir: cwd, project_exists: loaded.project_exists, plugin_data_dir: &plugin_data, payload, event };
                Some(self.commands.run(handler, &ctx).await)
            }
            "http" => {
                text("url")?;
                Some(runners::run_http(handler, payload, event).await)
            }
            "mcp_tool" => match &self.hub {
                Some(hub) => {
                    // The hook runs in its session's runtime (`scopeId: rt.mcpScopeId`, `boot/infrastructure.mjs:98`);
                    // one that names no session runs in the daemon's own runtime, whose scope is the hub's.
                    let session = payload.get("session_id").and_then(Value::as_str).filter(|id| !id.is_empty());
                    let scope = match session {
                        Some(id) => self.scopes.get().and_then(|scope_of| scope_of(id)),
                        None => Some(hub.runtime_scope().to_owned()),
                    };
                    Some(run_mcp_tool_handler(hub, scope.as_deref(), handler, payload.clone(), event, &cancel).await)
                }
                None => {
                    self.emit("hook:error", json!({"name": error_name, "error": "handler type mcp_tool not configured"}));
                    None
                }
            },
            _ => match &self.prompt {
                Some(runner) => Some(run_prompt(runner.as_ref(), handler, payload, event, &cancel).await),
                None => {
                    self.emit("hook:error", json!({"name": error_name, "error": "handler type prompt not configured"}));
                    None
                }
            },
        }
    }

    /// Runs the standard handlers of `event` in order and folds their verdicts. Once a denial
    /// lands on an event that can be denied, the remaining handlers do not run.
    async fn run_event(&self, event: &str, payload: &Value, loaded: &Loaded) -> Aggregate {
        let handlers = self.select_handlers(&loaded.config, event, payload);
        let session_id = payload.get("session_id").and_then(Value::as_str).filter(|id| !id.is_empty());
        let exported = match (handlers.is_empty(), session_id, self.transcripts.get()) {
            (false, Some(id), Some(export)) => Some(with_transcript_path(payload, export.transcript_path(id).await)),
            _ => None,
        };
        let payload = exported.as_ref().unwrap_or(payload);
        let mut agg = Aggregate { handlers_run: handlers.len(), ..Aggregate::default() };
        let short_circuit = output::EXIT2_BLOCK_EVENTS.contains(&event) || output::TOP_LEVEL_DECISION_EVENTS.contains(&event);
        let error_name = payload.get("tool_name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or(event);
        for handler in handlers {
            let Some(run) = self.run_one(handler, event, payload, loaded).await else { continue };
            let kind = rules::shell_count_for(handler);
            let what = ["command", "url"]
                .iter()
                .find_map(|k| handler.raw.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()))
                .or_else(|| handler.raw.get("type").and_then(Value::as_str))
                .unwrap_or_default();
            if let Some(failure) = run_failure(&run, &kind, what) {
                self.emit("hook:error", json!({"name": error_name, "error": failure}));
                if event == "PreToolUse" {
                    agg.fail_closed(&failure);
                    return agg;
                }
                continue;
            }
            agg.fold(parse_handler_output(&run, event));
            if agg.blocked && short_circuit {
                break;
            }
        }
        agg
    }

    /// Runs every handler of `event` for `payload` and reports what they decided. A
    /// configuration that cannot be read is reported and decides nothing.
    async fn dispatch(&self, event: &str, payload: Value, cwd: &Path) -> Dispatched {
        self.emit(event, payload.clone());
        let loaded = match self.load(cwd).await {
            Ok(loaded) => loaded,
            Err(message) => {
                self.emit("hook:error", json!({"name": event, "error": message}));
                return Dispatched::default();
            }
        };
        let agg = self.run_event(event, &payload, &loaded).await;
        Dispatched {
            blocked: agg.blocked,
            prevent_continuation: agg.prevent_continuation,
            reason: agg.reason.filter(|r| !r.is_empty()),
            additional_context: agg.additional_context,
            updated_input: agg.updated_input,
            updated_tool_name: agg.updated_tool_name,
            updated_tool_output: agg.updated_tool_output,
            handlers_run: agg.handlers_run,
        }
    }

    /// `PostToolUse`: `result` is the model-visible result of the call. What the hooks decided: a
    /// replacement result (`updated_tool_output`, a legacy text envelope arrives as its text), the
    /// `additional_context` and, for a block, the `reason` for the model (the tool already ran and
    /// is not undone; owner-approved difference from Node, which drops them). Best-effort: a hook
    /// problem never changes the result.
    pub async fn post_tool(&self, call: &ToolCall<'_>, result: &Value) -> Dispatched {
        let payload = build_payload("PostToolUse", call, Some(result));
        let mut dispatched = self.dispatch("PostToolUse", payload, call.cwd).await;
        dispatched.updated_tool_output = dispatched.updated_tool_output.map(after::normalize_updated_tool_output);
        dispatched
    }

    /// `PostToolUseFailure`: the call failed; `error` is the text the model sees. Nothing it
    /// decides changes the outcome.
    pub async fn post_failure(&self, call: &ToolCall<'_>, error: &str) {
        let payload = build_payload("PostToolUseFailure", call, Some(&json!(error)));
        self.dispatch("PostToolUseFailure", payload, call.cwd).await;
    }

    /// `PostToolBatch`, after a batch's results are all recorded and before the next model
    /// call. Returns the note to add as a user message (meta `hook`) when a hook blocks
    /// continuation. A batch with no calls fires nothing.
    pub async fn post_batch(&self, batch: &BatchCall<'_>) -> Option<String> {
        let dispatched = self.post_batch_dispatched(batch).await?;
        if dispatched.blocked { after::batch_reminder(dispatched.reason.as_deref()) } else { None }
    }

    /// `PostToolBatch` as the loop reads it: what the handlers decided, for the loop to word the
    /// note itself. A batch with no calls fires nothing.
    pub async fn post_batch_dispatched(&self, batch: &BatchCall<'_>) -> Option<Dispatched> {
        if batch.tool_count == 0 {
            return None;
        }
        let payload = Value::Object(base_payload("PostToolBatch", batch.session_id, batch.cwd, batch.common));
        Some(self.dispatch("PostToolBatch", payload, batch.cwd).await)
    }

    /// `SubagentStart` / `SubagentStop` (`onSubagentEvent`): a worker session began or finished.
    /// `agent_type` is the worker's agent id (`null` for none); `session_id` is the worker's own
    /// session. Best-effort: what the handlers decide changes nothing.
    pub async fn subagent(&self, stop: bool, session_id: &str, agent_type: Option<&str>, cwd: &Path, common: &HookCommon) {
        let event = if stop { "SubagentStop" } else { "SubagentStart" };
        let mut payload = base_payload(event, session_id, cwd, common);
        payload.insert("agent_type".into(), agent_type.filter(|a| !a.is_empty()).map_or(Value::Null, |a| json!(a)));
        self.dispatch(event, Value::Object(payload), cwd).await;
    }

    /// `PreCompact` / `PostCompact` (the session's `preCompactHook` / `postCompactHook`):
    /// `trigger` is what started the compaction (`manual`, `auto_clear`, `auto`; an empty one is
    /// `auto`) and the event's matcher field. Best-effort: nothing the handlers decide changes
    /// the compaction.
    pub async fn compact(&self, post: bool, session_id: &str, trigger: &str, cwd: &Path, common: &HookCommon) {
        let event = if post { "PostCompact" } else { "PreCompact" };
        let mut payload = base_payload(event, session_id, cwd, common);
        payload.insert("trigger".into(), json!(if trigger.is_empty() { "auto" } else { trigger }));
        self.dispatch(event, Value::Object(payload), cwd).await;
    }

    /// `CwdChanged` (`cwd-apply.mjs` `applyResolvedCwd`, only when the folder really changed): the
    /// session's `cwd` is its new one. No matcher field. The caller does not wait for it (Node's
    /// `void hooks.dispatch(..)`); what the handlers decide changes nothing.
    pub async fn cwd_changed(&self, session_id: &str, cwd: &Path, common: &HookCommon) {
        let payload = base_payload("CwdChanged", session_id, cwd, common);
        self.dispatch("CwdChanged", Value::Object(payload), cwd).await;
    }

    /// `SessionStart` (`session-start-hook.mjs` `dispatchSessionStart`, after a runtime built its
    /// session): `source` is `startup`, `resume` or `clear` ([`crate::hooks::session_start_source`])
    /// and the event's matcher field, `model` the route's model. Returns the context the handlers
    /// add (`additionalContext`), which the caller puts before the first user turn. Best-effort:
    /// nothing else the handlers decide changes the creation.
    pub async fn session_start(&self, session_id: &str, source: &str, model: Option<&str>, cwd: &Path, common: &HookCommon) -> Vec<String> {
        let mut payload = base_payload("SessionStart", session_id, cwd, common);
        payload.insert("source".into(), json!(source));
        // `model: rt.route.model`: a route with no model serializes no key.
        if let Some(model) = model {
            payload.insert("model".into(), json!(model));
        }
        self.dispatch("SessionStart", Value::Object(payload), cwd).await.additional_context
    }

    /// `UserPromptSubmit` (`turn-prepare.mjs` `dispatchPromptSubmit`, after the turn's user row and
    /// before the model is asked): `prompt` is the turn's prompt as submitted (text or content
    /// parts). No matcher field. The caller reads `blocked` / `reason` (the turn is refused) and
    /// `additional_context` (it rides the turn as its context).
    pub async fn user_prompt_submit(&self, session_id: &str, prompt: &Value, cwd: &Path, common: &HookCommon) -> Dispatched {
        let mut payload = base_payload("UserPromptSubmit", session_id, cwd, common);
        payload.insert("prompt".into(), prompt.clone());
        self.dispatch("UserPromptSubmit", Value::Object(payload), cwd).await
    }

    /// `Stop`, fired by the agent loop when the model ends its turn (Node fires it at settle, after
    /// the final answer is written, and reads nothing; owner-approved difference, B-5). No matcher
    /// field. `stop_hook_active` is `true` on every continuation a Stop block already made in this
    /// turn. The caller reads `blocked` / `reason`: a block with a reason continues the turn, unless a
    /// handler answered `continue: false` (`prevent_continuation`), which ends it.
    pub async fn stop(&self, session_id: &str, cwd: &Path, common: &HookCommon, stop_hook_active: bool) -> Dispatched {
        let mut payload = base_payload("Stop", session_id, cwd, common);
        payload.insert("stop_hook_active".into(), json!(stop_hook_active));
        self.dispatch("Stop", Value::Object(payload), cwd).await
    }

    /// `StopFailure` (`turn-settle.mjs` `reportTurnError`): the turn ended with an error;
    /// `error_type` is its class ([`crate::hooks::stop_failure_type`]) and the event's matcher
    /// field. The caller does not wait for it (Node's `void hooks.dispatch(..)`).
    pub async fn stop_failure(&self, session_id: &str, error_type: &str, cwd: &Path, common: &HookCommon) {
        let mut payload = base_payload("StopFailure", session_id, cwd, common);
        payload.insert("error_type".into(), json!(error_type));
        self.dispatch("StopFailure", Value::Object(payload), cwd).await;
    }

    /// `SessionEnd` (`teardown/session-close.mjs` `dispatchSessionEnd`, when a runtime closes with
    /// a session): `reason` is `clear`, `exit` or `other` ([`crate::hooks::session_end_reason`])
    /// and the event's matcher field. What the handlers decide changes nothing.
    pub async fn session_end(&self, session_id: &str, reason: &str, cwd: &Path, common: &HookCommon) {
        let mut payload = base_payload("SessionEnd", session_id, cwd, common);
        payload.insert("reason".into(), json!(reason));
        self.dispatch("SessionEnd", Value::Object(payload), cwd).await;
    }

    fn identity(input: &ToolCall<'_>) -> Map<String, Value> {
        let mut identity = Map::new();
        identity.insert("sessionId".into(), if input.session_id.is_empty() { Value::Null } else { json!(input.session_id) });
        identity.insert("name".into(), json!(if input.name.is_empty() { "tool" } else { input.name }));
        identity
    }

    fn emit_tool(&self, input: &ToolCall<'_>, event: &str, reason: Option<&str>) {
        let mut payload = Self::identity(input);
        payload.insert("reason".into(), reason.map_or(Value::Null, |r| json!(r)));
        self.emit(event, Value::Object(payload));
    }

    fn standard_decision(&self, agg: &Aggregate, input: &ToolCall<'_>) -> Option<Outcome> {
        if agg.blocked {
            self.emit_tool(input, "tool:deny", agg.reason.as_deref());
            return Some(Outcome { action: "deny", name: None, args: None, reason: agg.reason.clone() });
        }
        if !(agg.ask || agg.updated_input.is_some() || agg.updated_tool_name.is_some()) {
            return None;
        }
        let (action, reason) = if agg.ask { ("ask", agg.ask_reason.clone()) } else { ("modify", agg.reason.clone()) };
        self.emit_tool(input, &format!("tool:{action}"), reason.as_deref());
        Some(Outcome { action, name: agg.updated_tool_name.clone(), args: agg.updated_input.clone(), reason })
    }

    fn legacy_decision(&self, config: &HookConfig, input: &ToolCall<'_>) -> Option<Outcome> {
        let rules = if config.legacy_rules.is_empty() { &config.fallback_rules } else { &config.legacy_rules };
        let cwd = input.cwd.to_string_lossy();
        let subject = Subject { name: input.name, args: input.args, cwd: &cwd };
        let rule = rules.iter().find(|rule| rules::rule_matches(rule, &subject))?;
        let decision = rules::decision_from_rule(rule, &subject);
        if matches!(decision.action, "deny" | "modify" | "ask") {
            self.emit_tool(input, &format!("tool:{}", decision.action), decision.reason.as_deref());
        }
        Some(Outcome { action: decision.action, name: decision.name, args: decision.args, reason: decision.reason })
    }

    /// The before-tool decision, or `None` when no hook has an opinion.
    pub async fn before_tool(&self, input: &ToolCall<'_>) -> Option<Outcome> {
        let mut event = Self::identity(input);
        event.insert("callId".into(), if input.call_id.is_empty() { Value::Null } else { json!(input.call_id) });
        event.insert("args".into(), input.args.clone());
        self.emit("tool:before", Value::Object(event));
        let loaded = match self.load(input.cwd).await {
            Ok(loaded) => loaded,
            Err(message) => return Some(self.policy_check_failed(input, &message)),
        };
        if loaded.config.disabled {
            return None;
        }
        let payload = build_payload("PreToolUse", input, None);
        let agg = self.run_event("PreToolUse", &payload, &loaded).await;
        self.standard_decision(&agg, input).or_else(|| self.legacy_decision(&loaded.config, input))
    }

    fn policy_check_failed(&self, input: &ToolCall<'_>, message: &str) -> Outcome {
        self.emit("hook:error", json!({"name": if input.name.is_empty() { "tool" } else { input.name }, "error": message}));
        let reason = format!("PreToolUse policy check failed: {message}");
        self.emit_tool(input, "tool:deny", Some(&reason));
        Outcome { action: "deny", name: None, args: None, reason: Some(reason) }
    }
}

/// Reads a `prompt` handler: a model's verdict is JSON (`ok: false` denies) or plain text.
async fn run_prompt(runner: &dyn PromptRunner, handler: &HookHandler, payload: &Value, event: &str, cancel: &CancellationToken) -> HandlerRun {
    let timeout = handler_timeout(&handler.raw, event);
    let prompt = handler.raw.get("prompt").and_then(Value::as_str).unwrap_or_default();
    if prompt.is_empty() {
        return HandlerRun::failed("prompt handler missing prompt", false);
    }
    let call = mixdog_rt::time::timeout(timeout, runner.run(prompt, payload, timeout, cancel)).await;
    let text = match call {
        Err(_) => {
            cancel.cancel();
            return HandlerRun::failed(format!("prompt hook timed out: {event}"), true);
        }
        Ok(Err(message)) => {
            let timed_out = message.to_lowercase().contains("timed out");
            return HandlerRun::failed(message, timed_out);
        }
        Ok(Ok(text)) => text,
    };
    let raw = js_trim(&text);
    let deny = |reason: String| HandlerRun { exit_code: 2, stderr: reason, ..HandlerRun::default() };
    let allow = HandlerRun::default();
    match serde_json::from_str::<Value>(raw) {
        Ok(verdict) if verdict.is_object() || verdict.is_array() => {
            if verdict.get("ok") == Some(&Value::Bool(false)) {
                let reason = verdict.get("reason").and_then(Value::as_str).filter(|r| !r.is_empty()).map(str::to_owned);
                return deny(reason.unwrap_or_else(|| format!("blocked by {event} prompt hook")));
            }
            allow
        }
        _ => {
            let lowered = raw.to_lowercase();
            if raw.is_empty() || ["yes", "true", "allow", "ok"].contains(&lowered.as_str()) {
                allow
            } else if ["no", "false", "deny", "block"].contains(&lowered.as_str()) {
                deny(raw.to_owned())
            } else {
                allow
            }
        }
    }
}
