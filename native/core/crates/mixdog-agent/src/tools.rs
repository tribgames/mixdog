//! The tool half of a round: guards that answer a call without running it,
//! the policy and approval wait, concurrent execution, and the ordered commit
//! of results.
//!
//! Calls start together unless a tool's declared scheduling keeps two of them
//! apart (`parallel_safe`, `exclusive_with`); results are committed in the
//! assistant's call order, so the transcript never depends on which call
//! finished first.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use base64::Engine;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::tool::CallOptions;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolNotify;
use mixdog_core_api::domain::tool::ProgressSink;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolGroup;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_rt::Scope;
use mixdog_rt::Scoped;
use mixdog_rt::TaskClass;
use tokio_util::sync::CancellationToken;

use crate::env::GateAsk;
use crate::env::GateCall;
use crate::env::GateDecision;
use crate::env::RunEvent;
use crate::env::Stage;
use crate::env::ToolGate;
use crate::env::TurnGuards;
use crate::limits;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::message::ToolKind;
use crate::message::ToolTiming;
use crate::response::ModelResponse;
use crate::response::tool_call_message;
use crate::run::AgentError;
use crate::run::Run;

/// Consecutive identical-and-failing calls tolerated before the loop refuses
/// to re-execute and steers the model to change approach.
pub const REPEAT_FAIL_LIMIT: u32 = 3;

// ---------------------------------------------------------------------------
// Tool set and environment
// ---------------------------------------------------------------------------

/// The tools of a surface, looked up by canonical name or declared alias. An
/// unknown name is unknown: nothing is fuzzy-matched.
#[derive(Clone)]
pub struct ToolSet {
    tools: Arc<Vec<Arc<dyn Tool>>>,
    index: Arc<HashMap<String, usize>>,
    /// Names typo aliases, case variants and did-you-mean suggestions are
    /// drawn from (the builtin tools; other tools match exactly only).
    builtin: Arc<Vec<String>>,
    /// The set is a delegated agent's: a tool with an agent text (`Tool::agent_spec`) shows that.
    agent: bool,
}

impl ToolSet {
    pub fn new(tools: Vec<Arc<dyn Tool>>) -> Self {
        let builtin = tools.iter().map(|t| t.spec().name.clone()).collect();
        Self::with_builtins(tools, builtin)
    }

    pub fn with_builtins(tools: Vec<Arc<dyn Tool>>, builtin: Vec<String>) -> Self {
        let mut index = HashMap::new();
        for (i, tool) in tools.iter().enumerate() {
            let spec = tool.spec();
            index.insert(spec.name.clone(), i);
            for alias in &spec.aliases {
                index.entry(alias.clone()).or_insert(i);
            }
        }
        Self {
            tools: Arc::new(tools),
            index: Arc::new(index),
            builtin: Arc::new(builtin),
            agent: false,
        }
    }

    /// The set a delegated agent's session is sent (`bindAgentOwner`).
    #[must_use]
    pub fn for_agent(mut self, agent: bool) -> Self {
        self.agent = agent;
        self
    }

    pub fn get(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.index.get(name).map(|i| &self.tools[*i])
    }

    pub fn builtin_names(&self) -> Vec<&str> {
        self.builtin.iter().map(String::as_str).collect()
    }

    /// A typo alias or case variant of a surface tool name, as the canonical
    /// name; the name itself otherwise.
    pub fn canonical(&self, name: &str) -> String {
        crate::text::canonical_name(name, self.builtin.iter().map(String::as_str))
            .unwrap_or(name)
            .to_owned()
    }

    pub(crate) fn read_only(&self, name: &str) -> bool {
        self.get(name)
            .is_some_and(|t| t.spec().annotations.read_only_hint == Some(true))
    }

    /// The definition of `tool` on this set's surface: a delegated agent's own text and schema where
    /// the tool has them (`bindAgentOwner`), the Lead's otherwise. The model is sent it, and a call's
    /// arguments are coerced to it.
    pub(crate) fn spec_of<'a>(&self, tool: &'a Arc<dyn Tool>) -> &'a ToolSpec {
        if self.agent { tool.agent_spec().unwrap_or_else(|| tool.spec()) } else { tool.spec() }
    }

    /// What the model is sent. A `public: false` tool stays in the set (a rewritten call reaches it by
    /// name) but is never listed.
    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .iter()
            .filter(|tool| tool.spec().public)
            .map(|tool| {
                let spec = self.spec_of(tool);
                ToolDefinition {
                    name: spec.name.clone(),
                    description: spec.description.clone(),
                    input_schema: spec.input_schema.clone(),
                    defer_loading: false,
                    freeform: tool.freeform().cloned(),
                }
            })
            .collect()
    }

    /// A read-only result may stand in for an identical call in the same turn
    /// (`isToolCallDedupEligible`): the tool declares `readOnlyHint`, and the
    /// loaders (`load_tool`, `tool_search`) are read-only but must run to report state.
    pub(crate) fn dedup_eligible(&self, name: &str) -> bool {
        !matches!(name, "load_tool" | "tool_search") && self.get(name).is_some_and(|tool| tool.spec().annotations.read_only_hint == Some(true))
    }
}

/// How long a tool call may run, from its spec.
pub type DeadlineFn = Arc<dyn Fn(&ToolSpec) -> Option<Duration> + Send + Sync>;

/// What every tool call of a run shares.
#[derive(Clone)]
pub struct ToolEnv {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub cwd: AbsPath,
    pub surface: SurfaceKind,
    pub io: ToolIo,
    pub approvals: Arc<dyn ApprovalGate>,
    pub files: Arc<dyn FileService>,
    pub processes: Arc<dyn ProcessManager>,
    pub progress: Arc<dyn ProgressSink>,
    /// The per-call deadline of a tool (read-only I/O), if any.
    pub deadline_of: Option<DeadlineFn>,
    /// A worker turn's own completion hook (`AgentTurn.hooks.notify`, Node `notifyFn`): every
    /// call carries it in its options, and background work the call leaves running reports its
    /// completion through it before falling back to the owner's default delivery.
    pub notify: Option<ToolNotify>,
    /// The turn review the edit tools publish their per-call card diff to (`registerEditToolUiDiff`).
    pub review: Option<Arc<dyn mixdog_core_api::turn_review::TurnReviewApi>>,
}

// ---------------------------------------------------------------------------
// Signatures and the repeat-failure guards
// ---------------------------------------------------------------------------

/// Key-sorted JSON, independent of the map type the build selects.
pub(crate) fn call_signature(name: &str, args: &JsonValue) -> String {
    format!("{name}:{}", mixdog_js::json_stringify_sorted(args))
}

const FAILURE_PATH_KEYS: [&str; 9] = [
    "base_path",
    "cwd",
    "dir",
    "dir_path",
    "directory",
    "file_path",
    "files",
    "path",
    "paths",
];

/// Lexical `normalize`/`resolve` of a path value against `cwd`, lowercased on
/// Windows and with `/` separators, so two spellings of one path agree.
fn normalize_failure_path(value: &str, cwd: &std::path::Path) -> String {
    let has_scheme = value
        .split_once("://")
        .is_some_and(|(scheme, _)| {
            let mut chars = scheme.chars();
            chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        });
    if value.is_empty() || has_scheme {
        return value.to_owned();
    }
    let path = std::path::Path::new(value);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let mut clean = std::path::PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::ParentDir => {
                clean.pop();
            }
            std::path::Component::CurDir => {}
            other => clean.push(other.as_os_str()),
        }
    }
    let mut out = clean.to_string_lossy().into_owned();
    if cfg!(windows) {
        out = out.to_lowercase();
    }
    out.replace('\\', "/")
}

fn canonical_failure(value: &JsonValue, key: &str, cwd: &std::path::Path, out: &mut String) {
    match value {
        JsonValue::String(s) if FAILURE_PATH_KEYS.contains(&key.to_lowercase().as_str()) => {
            out.push_str(&JsonValue::String(normalize_failure_path(s, cwd)).to_string());
        }
        JsonValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical_failure(item, key, cwd, out);
            }
            out.push(']');
        }
        JsonValue::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&JsonValue::String(k.clone()).to_string());
                out.push(':');
                canonical_failure(&map[k], k, cwd, out);
            }
            out.push('}');
        }
        other => out.push_str(&mixdog_js::json_stringify(other)),
    }
}

const MCP_TOOL_PREFIX: &str = "mcp__plugin_mixdog_mixdog__";

/// The repeat-failure signature: the call with path-valued arguments
/// normalized against `cwd`.
pub(crate) fn failure_signature(name: &str, args: &JsonValue, cwd: &std::path::Path) -> String {
    let bare = name.strip_prefix(MCP_TOOL_PREFIX).unwrap_or(name);
    let mut out = format!("{bare}:");
    canonical_failure(args, "", cwd, &mut out);
    out
}

pub(crate) fn arg_shape(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "null".into(),
        JsonValue::Array(items) => format!(
            "array[{}]",
            items.iter().map(arg_shape).collect::<Vec<_>>().join(",")
        ),
        JsonValue::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!("{k}:{}", arg_shape(&map[k])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        JsonValue::Bool(_) => "boolean".into(),
        JsonValue::Number(_) => "number".into(),
        JsonValue::String(_) => "string".into(),
    }
}

/// The cycle length when `signature` would continue a 1..5-call pattern that
/// already repeated `limit` times in `history` (executed failures only);
/// otherwise 0.
fn pattern_would_continue(history: &[String], signature: &str, limit: u32) -> usize {
    let n = history.len();
    let limit = limit as usize;
    if limit == 0 {
        return 0;
    }
    for cycle_len in 1..=5 {
        let required = cycle_len * limit;
        if n < required {
            continue;
        }
        let start = n - required;
        let cycle = &history[start..start + cycle_len];
        if (0..required).all(|i| history[start + i] == cycle[i % cycle_len]) && signature == cycle[0]
        {
            return cycle_len;
        }
    }
    0
}

/// Cross-iteration repeat-failure guards. Distinct from the intra-turn dedup:
/// when the model re-issues an identical normalized call that already failed
/// [`REPEAT_FAIL_LIMIT`] times in a row, stop re-executing — the result will
/// not change and each retry burns a full model round trip. Any success clears
/// the chain.
#[derive(Clone, Default, Debug)]
pub struct RepeatGuards {
    last: Option<(String, u32)>,
    history: Vec<String>,
    shape: Option<(String, u32)>,
    /// A tool batch has recorded an outcome (or the session record carried the keys): Node's
    /// `session._repeat*` fields exist from then on.
    kept: bool,
}

impl RepeatGuards {
    /// The guards a session record carries (`_repeatFailGuard`, `_repeatFailHistory`, `_repeatArgShapeFailGuard`).
    pub fn from_saved(saved: &serde_json::Map<String, serde_json::Value>) -> Self {
        let guard = |key: &str| {
            let value = saved.get(key)?;
            Some((value.get("sig")?.as_str()?.to_owned(), u32::try_from(value.get("count")?.as_u64()?).ok()?))
        };
        let history = saved
            .get("_repeatFailHistory")
            .and_then(serde_json::Value::as_array)
            .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        let kept = ["_repeatFailGuard", "_repeatFailHistory", "_repeatArgShapeFailGuard"].iter().any(|key| saved.contains_key(*key));
        Self { last: guard("_repeatFailGuard"), history, shape: guard("_repeatArgShapeFailGuard"), kept }
    }

    /// The session record's `_repeat*` fields; empty until a tool batch recorded an outcome.
    pub fn to_saved(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut saved = serde_json::Map::new();
        if !self.kept {
            return saved;
        }
        let guard = |slot: &Option<(String, u32)>| match slot {
            Some((sig, count)) => serde_json::json!({ "sig": sig, "count": count }),
            None => serde_json::Value::Null,
        };
        saved.insert("_repeatFailGuard".into(), guard(&self.last));
        saved.insert("_repeatFailHistory".into(), serde_json::json!(self.history));
        saved.insert("_repeatArgShapeFailGuard".into(), guard(&self.shape));
        saved
    }

    /// Whether a guard could fire once `pending_earlier` calls before this one
    /// finish: a guard needs [`REPEAT_FAIL_LIMIT`] recorded failures.
    pub(crate) fn could_fire(&self, pending_earlier: usize) -> bool {
        let limit = REPEAT_FAIL_LIMIT as usize;
        self.history.len() + pending_earlier >= limit
            || self
                .shape
                .as_ref()
                .is_some_and(|(_, count)| *count as usize + pending_earlier >= limit)
    }

    pub(crate) fn skip(&self, name: &str, sig: &str, shape_sig: &str) -> Option<String> {
        let cycle = pattern_would_continue(&self.history, sig, REPEAT_FAIL_LIMIT);
        let same = self
            .last
            .as_ref()
            .filter(|(last, count)| last == sig && *count >= REPEAT_FAIL_LIMIT);
        if same.is_some() || cycle > 0 {
            let detail = if cycle > 1 {
                format!("A {cycle}-call normalized failure pattern repeated {REPEAT_FAIL_LIMIT} times")
            } else {
                format!(
                    "Identical normalized `{name}` call failed {} times",
                    self.last.as_ref().map_or(REPEAT_FAIL_LIMIT, |(_, c)| *c)
                )
            };
            return Some(format!(
                "[repeat-failure-guard] {detail}; not re-executed. Retry only after its inputs or subject change; otherwise leave it unresolved."
            ));
        }
        self.shape
            .as_ref()
            .filter(|(s, count)| s == shape_sig && *count >= REPEAT_FAIL_LIMIT)
            .map(|(_, count)| {
                format!(
                    "[repeat-argument-shape-guard] Equivalent malformed `{name}` arguments failed validation {count} times; not re-executed. Correct required fields or types before retrying."
                )
            })
    }

    pub(crate) fn record(&mut self, failed: bool, sig: String, shape_sig: String, arg_failure: bool) {
        fn bump(slot: &Option<(String, u32)>, sig: &str) -> (String, u32) {
            match slot {
                Some((s, c)) if s == sig => (s.clone(), c + 1),
                _ => (sig.to_owned(), 1),
            }
        }
        self.kept = true;
        if failed {
            self.last = Some(bump(&self.last, &sig));
            self.history.push(sig);
            if self.history.len() > 25 {
                let excess = self.history.len() - 25;
                self.history.drain(..excess);
            }
        } else {
            self.last = None;
            self.history.clear();
        }
        self.shape = (failed && arg_failure).then(|| bump(&self.shape, &shape_sig));
    }
}

// ---------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------

pub(crate) struct Executed {
    pub(crate) message: AgentMessage,
    pub(crate) failed: bool,
    pub(crate) arg_failure: bool,
    /// The tool reported an ambiguous edit (`Conflict`).
    pub(crate) conflict: bool,
    pub(crate) follow_ups: Vec<AgentMessage>,
    /// Served from the result cache: the id of the call that first delivered
    /// the body.
    pub(crate) cache_hit: Option<String>,
    /// The tool's result minus its `parts` and follow-ups (already in
    /// `message` / `follow_ups`); `None` for a call that did not run a tool.
    pub(crate) output: Option<ToolOutput>,
    /// The executor returned this text rather than throwing (a gate or hook denial): Node's early notice calls such
    /// a settled call a normal result, not an error.
    pub(crate) returned: bool,
}

impl Executed {
    pub(crate) fn error(call_id: &str, text: String) -> Self {
        Self {
            message: AgentMessage::tool_text(call_id, text, ToolKind::Error),
            failed: true,
            arg_failure: false,
            conflict: false,
            follow_ups: Vec::new(),
            cache_hit: None,
            output: None,
            returned: false,
        }
    }

    /// A failure Node's executor returns as text (`return denial`): the call failed for the transcript, but it did
    /// not throw.
    pub(crate) fn returned(call_id: &str, text: String) -> Self {
        Self { returned: true, ..Self::error(call_id, text) }
    }
}

pub(crate) struct CallEnv {
    pub(crate) tools: ToolSet,
    pub(crate) gate: Arc<dyn ToolGate>,
    pub(crate) hooks: Option<Arc<dyn crate::env::ToolHooks>>,
    pub(crate) observer: Arc<dyn crate::env::RunObserver>,
    pub(crate) guards: Arc<dyn TurnGuards>,
    pub(crate) tool_env: ToolEnv,
    pub(crate) cancel: CancellationToken,
    /// The run's clock, for a call's `toolTiming`.
    pub(crate) clock: Arc<dyn crate::env::Clock>,
    /// The session's MCP catalog, refreshed around the call (`prepareToolCall`, `executeTool`).
    pub(crate) mcp: Option<Arc<dyn crate::env::McpCatalog>>,
}

fn render_output(parts: Vec<ToolPart>) -> Content {
    let mut text_only = true;
    let mut rendered: Vec<ContentPart> = Vec::new();
    for part in parts {
        match part {
            ToolPart::Text(text) => rendered.push(ContentPart::Text(text, None)),
            ToolPart::Json(value) => rendered.push(ContentPart::Text(value.to_string(), None)),
            ToolPart::Image { mime, data } => {
                text_only = false;
                let source = match data {
                    ImageData::Bytes(bytes) => ImageSource::Base64 {
                        data: base64::engine::general_purpose::STANDARD.encode(bytes),
                        mime_type: mime,
                    },
                    ImageData::Blob(digest) => ImageSource::FileId(digest.as_str().to_owned()),
                };
                rendered.push(ContentPart::Image(source));
            }
        }
    }
    if text_only {
        let joined = rendered
            .into_iter()
            .filter_map(|part| match part {
                ContentPart::Text(text, _) => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        Content::Text(joined)
    } else {
        Content::Parts(rendered)
    }
}

fn denial_for_unapproved(name: &str, detail: &str) -> String {
    let detail = detail.trim_end_matches(|c: char| c == '.' || mixdog_js::is_js_space(c));
    format!(
        "Error: tool \"{name}\" was not approved: {detail}. Do not retry it or reach the same result another way; report it."
    )
}

/// Policy, approval wait, then the tool task. Awaiting the approval is a
/// cancel-safe wait: the run's token ends it from outside.
pub(crate) async fn execute_call(call: ToolCall, env: Arc<CallEnv>) -> Executed {
    let executed = execute_gated(&call, &env).await;
    // PostToolUseFailure: a tool that resolved to a failure fires the hook;
    // it never breaks the loop.
    if executed.failed
        && let Some(hooks) = &env.hooks
    {
        hooked(
            &env.cancel,
            hooks.after_failure(
                &GateCall::new(call.name.clone(), call.arguments.clone()),
                &executed.message.text(),
            ),
        )
        .await;
    }
    executed
}

/// The gate, the approval wait and the final surface judgement of one call: the call to
/// dispatch, or the model-visible refusal.
async fn authorize(
    call_id: &str,
    name: &str,
    arguments: &JsonValue,
    gate: &dyn ToolGate,
    approvals: &dyn ApprovalGate,
    observer: &dyn crate::env::RunObserver,
    guards: &dyn TurnGuards,
) -> Result<GateCall, String> {
    let mut target = GateCall::new(name, arguments.clone());
    match gate.check_call(call_id, &target).await {
        GateDecision::Allow => {}
        GateDecision::Rewrite(rewritten) => target = rewritten,
        GateDecision::Deny(text) => return Err(text),
        GateDecision::Ask(ask) => {
            let GateAsk {
                reason,
                ask,
                call: rewritten,
            } = *ask;
            if let Some(rewritten) = rewritten {
                target = rewritten;
            }
            observer.event(RunEvent::Stage(Stage::ApprovalWait { waiting: true }));
            let resolution = approvals.request(ask).await;
            observer.event(RunEvent::Stage(Stage::ApprovalWait { waiting: false }));
            match resolution {
                ApprovalResolution::Decided { decision, .. } if decision.approved => {
                    target = gate.apply_approval(&target, &decision);
                }
                other => {
                    // A person (or the hold for one) said no: never a policy
                    // hook to work around, and the turn may now wait on them.
                    guards.note_user_wait();
                    let given = match &other {
                        ApprovalResolution::Decided { decision, .. } => decision.reason.clone(),
                        _ => None,
                    };
                    let detail = given
                        .map(|r| mixdog_js::js_trim(&r).to_owned())
                        .filter(|r| !r.is_empty())
                        .unwrap_or_else(|| {
                            let reason = mixdog_js::js_trim(&reason);
                            if reason.is_empty() {
                                "not approved".to_owned()
                            } else {
                                reason.to_owned()
                            }
                        });
                    return Err(denial_for_unapproved(name, &detail));
                }
            }
        }
    }
    // Node: the final call (after hooks and approval) gets the built-in web_fetch transport
    // routing, then the surface judges it again under its schema name.
    crate::web_route::route_web_fetch(&mut target);
    match gate.pre_dispatch_deny(&target) {
        Some(text) => Err(text),
        None => Ok(target),
    }
}

/// What a tool that dispatches another tool (`call_tool`) runs the target through: the same
/// gate, hooks, observer and guards a direct call of that target would meet.
pub struct Pipeline {
    pub gate: Arc<dyn ToolGate>,
    pub hooks: Option<Arc<dyn crate::env::ToolHooks>>,
    pub observer: Arc<dyn crate::env::RunObserver>,
    pub guards: Arc<dyn TurnGuards>,
    /// The calling thread's MCP catalog, refreshed once a nested MCP call has passed its gate.
    pub mcp: Option<Arc<dyn crate::env::McpCatalog>>,
}

/// One call made from inside a running tool, through the ordinary pipeline: the gate and
/// approval wait, `web_fetch` routing, the surface judgement, argument coercion, the tool itself
/// with the caller's context (its cancel, deadline, approvals and lane tokens) and PostToolUse /
/// PostToolUseFailure. A refusal is the error whose model text is the refusal.
pub async fn run_nested(
    pipeline: &Pipeline,
    tools: &dyn mixdog_tools::policy::ToolResolver,
    scope: Option<&str>,
    ctx: &ToolContext,
    name: &str,
    arguments: JsonValue,
) -> ToolOutcome {
    let refused = |text: String| ToolError::new(ToolErrorCode::DeniedByPolicy { rule: "pipeline".to_owned() }, text);
    let target = authorize(
        ctx.call_id.as_str(),
        name,
        &arguments,
        pipeline.gate.as_ref(),
        ctx.approvals.as_ref(),
        pipeline.observer.as_ref(),
        pipeline.guards.as_ref(),
    )
    .await
    .map_err(refused)?;
    // A `call_tool` is projected onto its target, which Node runs as a direct call (`tool-exec.mjs:114`).
    if target.name.starts_with("mcp__")
        && let Some(mcp) = &pipeline.mcp
    {
        mcp.refresh().await;
    }
    let Some(tool) = tools.resolve(scope, &target.name) else {
        return Err(refused(crate::text::unknown_tool_message(&target.name, &[])));
    };
    // A nested call from a delegated agent is judged against the agent's definition, as its own calls are.
    let spec = if ctx.surface == mixdog_core_api::domain::tool::SurfaceKind::Agent { tool.agent_spec().unwrap_or_else(|| tool.spec()) } else { tool.spec() };
    let nested = ToolContext {
        call_id: ctx.call_id.clone(),
        thread_id: ctx.thread_id.clone(),
        turn_id: ctx.turn_id.clone(),
        tool: spec.name.clone(),
        cwd: ctx.cwd.clone(),
        surface: ctx.surface,
        cancel: ctx.cancel.child_token(),
        deadline: ctx.deadline,
        progress: Arc::clone(&ctx.progress),
        io: ctx.io,
        approvals: Arc::clone(&ctx.approvals),
        files: Arc::clone(&ctx.files),
        processes: Arc::clone(&ctx.processes),
        options: ctx.options.clone(),
        review: ctx.review.clone(),
    };
    let mut args = target.args.clone();
    crate::coerce::coerce_args_to_schema(&mut args, &spec.input_schema);
    let hook_call = GateCall { name: target.name.clone(), args: args.clone(), schema_name: target.schema_name.clone() };
    let timeout = ctx.deadline.map(|d| d.saturating_duration_since(Instant::now()));
    let mut running = Box::pin(tool.call(&nested, args));
    let waited = Scope::new()
        .cancel(&ctx.cancel)
        .deadline(nested.deadline)
        .run_with_grace(&mut running, TOOL_GRACE, || nested.cancel.cancel())
        .await;
    let outcome = match waited {
        Scoped::Done(outcome) => outcome,
        ended => Err(ended_error(&spec.name, &ended, timeout)),
    };
    match outcome {
        Ok(mut output) => {
            if let (Some(hooks), Content::Text(visible)) = (&pipeline.hooks, render_output(output.parts.clone()))
                && let Some(Some(updated)) = hooked(&ctx.cancel, hooks.after_tool(&hook_call, &visible)).await
            {
                output.parts = vec![ToolPart::Text(updated)];
            }
            Ok(output)
        }
        Err(error) => {
            if let Some(hooks) = &pipeline.hooks {
                hooked(&ctx.cancel, hooks.after_failure(&hook_call, &error.message_for_model)).await;
            }
            Err(error)
        }
    }
}

/// How long an ended call keeps to hand back its partial output after its own signal fired
/// (Node `READ_ONLY_IO_PARTIAL_GRACE_MS`, `tool-exec/read-only-deadline.mjs`).
const TOOL_GRACE: Duration = Duration::from_millis(1_500);

/// A hook runs even once the run is cancelled, as in Node (best effort): a PostToolUseFailure
/// hook is how an aborted call is reported. A hook still running `TOOL_GRACE` after the cancel is dropped.
async fn hooked<T>(cancel: &CancellationToken, hook: impl Future<Output = T>) -> Option<T> {
    let mut hook = Box::pin(hook);
    Scope::new().cancel(cancel).run_with_grace(&mut hook, TOOL_GRACE, || {}).await.done()
}

/// The failure of a call that gave nothing back after the dispatcher ended the wait: its run was
/// cancelled, or the tool's deadline passed (Node `runReadOnlyIoWithDeadline`'s timeout text).
fn ended_error<T>(name: &str, ended: &Scoped<T>, timeout: Option<Duration>) -> ToolError {
    match (ended, timeout) {
        (Scoped::DeadlineExceeded, timeout) => ToolError::new(
            ToolErrorCode::DeadlineExceeded { partial: false },
            format!(
                "Error: read-only I/O tool \"{name}\" timed out after {}ms with no partial output; narrow the scope (path, glob, more specific pattern, smaller limit) and retry.",
                timeout.map_or(0, |t| t.as_millis())
            ),
        ),
        _ => ToolError::new(ToolErrorCode::Cancelled, "Error: tool call cancelled"),
    }
}

/// Aborts the spawned tool task when the dispatcher stops waiting for it, whether it ended the
/// wait (cancel, deadline) or was itself dropped by the batch.
struct AbortOnDrop(tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn execute_gated(call: &ToolCall, env: &Arc<CallEnv>) -> Executed {
    let dispatch_started_at = env.clock.now_ms();
    let call = call.clone();
    let name = call.name.clone();
    // `prepareToolCall` (`tool-exec/call-prep.mjs:70`): every call starts from the live registry.
    // The preparation is under the run's cancellation like the tool task: a call nobody waits for any more (an
    // eager run the batch left to finish) must not hold the run's environment through a gate or a catalog that never
    // answers once the turn is cancelled.
    let cancelled = || Executed::error(&call.id, ended_error::<()>(&name, &Scoped::Cancelled, None).message_for_model);
    if let Some(mcp) = &env.mcp
        && hooked(&env.cancel, mcp.refresh()).await.is_none()
    {
        return cancelled();
    }
    let Some(authorized) = hooked(
        &env.cancel,
        authorize(
            &call.id,
            &name,
            &call.arguments,
            env.gate.as_ref(),
            env.tool_env.approvals.as_ref(),
            env.observer.as_ref(),
            env.guards.as_ref(),
        ),
    )
    .await
    else {
        return cancelled();
    };
    let target = match authorized {
        Ok(target) => target,
        Err(text) => return Executed::returned(&call.id, text),
    };
    // `tool-exec.mjs:114`: an MCP call, once its hooks, approval and denial are behind it (the wait for an
    // approval can outlast a server's connect), is judged against the registry as it stands now.
    if target.name.starts_with("mcp__")
        && let Some(mcp) = &env.mcp
        && hooked(&env.cancel, mcp.refresh()).await.is_none()
    {
        return cancelled();
    }
    let Some(tool) = env.tools.get(&target.name).cloned() else {
        let names = env.tools.builtin_names();
        return Executed::returned(&call.id, crate::text::unknown_tool_message(&target.name, &names));
    };
    let spec = env.tools.spec_of(&tool);
    let timeout = env.tool_env.deadline_of.as_ref().and_then(|f| f(spec));
    let ctx = ToolContext {
        call_id: ToolCallId::from(call.id.as_str()),
        thread_id: env.tool_env.thread_id.clone(),
        turn_id: env.tool_env.turn_id.clone(),
        tool: spec.name.clone(),
        cwd: env.tool_env.cwd.clone(),
        surface: env.tool_env.surface,
        // Tool tokens are children of the run's token.
        cancel: env.cancel.child_token(),
        deadline: timeout.map(|d| Instant::now() + d),
        progress: Arc::clone(&env.tool_env.progress),
        io: env.tool_env.io,
        approvals: Arc::clone(&env.tool_env.approvals),
        files: Arc::clone(&env.tool_env.files),
        processes: Arc::clone(&env.tool_env.processes),
        options: CallOptions { notify: env.tool_env.notify.clone(), ..CallOptions::default() },
        review: env.tool_env.review.clone(),
    };
    // Node: arguments are coerced to the declared schema before the tool sees
    // them (a model that hands an object argument as its JSON text).
    let mut args = target.args;
    crate::coerce::coerce_args_to_schema(&mut args, &spec.input_schema);
    let target_args_for_hook = args.clone();
    let (tool_cancel, deadline) = (ctx.cancel.clone(), ctx.deadline);
    let execution_started_at = env.clock.now_ms();
    let mut handle = mixdog_rt::spawn("agent.tool", TaskClass::Work, async move {
        tool.call(&ctx, args).await
    });
    let _abort = AbortOnDrop(handle.abort_handle());
    // Node: the run's abort (or the tool's deadline) fires the tool's own signal first; the
    // tool then has `TOOL_GRACE` to hand back what it collected, and only after that is it dropped.
    let waited = Scope::new()
        .cancel(&env.cancel)
        .deadline(deadline)
        .run_with_grace(&mut handle, TOOL_GRACE, || tool_cancel.cancel())
        .await;
    let execution_completed_at = env.clock.now_ms();
    let timing = |postprocess_started_at: i64| ToolTiming {
        dispatch_started_at,
        execution_started_at,
        execution_completed_at,
        postprocess_started_at,
        result_completed_at: env.clock.now_ms(),
    };
    let outcome: ToolOutcome = match waited {
        Scoped::Done(Ok(outcome)) => outcome,
        Scoped::Done(Err(_)) => Err(ToolError::new(
            ToolErrorCode::Internal {
                incident_id: "tool-task".to_owned(),
            },
            "Error: tool task failed",
        )),
        ended => Err(ended_error(&name, &ended, timeout)),
    };
    match outcome {
        Ok(mut output) => {
            let parts = std::mem::take(&mut output.parts);
            let follow_up_messages = std::mem::take(&mut output.follow_up_messages);
            let postprocess_started_at = env.clock.now_ms();
            let mut content = render_output(parts);
            // PostToolUse may override the model-visible text, never the
            // follow-up message channel.
            if let (Some(hooks), Content::Text(visible)) = (&env.hooks, &content)
                && let Some(Some(updated)) = hooked(
                    &env.cancel,
                    hooks.after_tool(
                        &GateCall {
                            name: target.name.clone(),
                            args: target_args_for_hook,
                            schema_name: target.schema_name.clone(),
                        },
                        visible,
                    ),
                )
                .await
            {
                content = Content::Text(updated);
            }
            let mut message = AgentMessage::tool_result(&call.id, content, ToolKind::Normal);
            message.tool_timing = Some(timing(postprocess_started_at));
            message.ui_diff = output.meta.as_ref().and_then(|m| m.get("uiDiff")).and_then(|d| d.as_str()).map(str::to_owned);
            Executed {
                message,
                failed: false,
                arg_failure: false,
                conflict: false,
                follow_ups: follow_up_messages
                    .into_iter()
                    .map(|m| AgentMessage::sourced(Source::Skill, m.text))
                    .collect(),
                cache_hit: None,
                output: Some(output),
                returned: false,
            }
        }
        Err(error) => {
            let mut executed = Executed::error(&call.id, error.message_for_model);
            executed.message.tool_timing = Some(timing(execution_completed_at));
            executed.arg_failure = matches!(error.code, ToolErrorCode::InvalidArgs { .. });
            executed.conflict = matches!(error.code, ToolErrorCode::Conflict { .. });
            executed
        }
    }
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

/// Calls whose identical read-only twin appeared earlier in the same turn:
/// index → first call id. A non-eligible call between them breaks the run.
pub(crate) fn intra_turn_duplicates(calls: &[ToolCall], tools: &ToolSet) -> HashMap<usize, String> {
    let mut first_by_sig: HashMap<String, String> = HashMap::new();
    let mut duplicates = HashMap::new();
    for (i, call) in calls.iter().enumerate() {
        if call.id.is_empty() {
            continue;
        }
        if !tools.dedup_eligible(&call.name) {
            first_by_sig.clear();
            continue;
        }
        let sig = call_signature(&call.name, &call.arguments);
        match first_by_sig.get(&sig) {
            None => {
                first_by_sig.insert(sig, call.id.clone());
            }
            Some(first) => {
                duplicates.insert(i, first.clone());
            }
        }
    }
    duplicates
}

pub(crate) fn conflicts(a: &ToolSpec, b: &ToolSpec) -> bool {
    !a.parallel_safe
        || !b.parallel_safe
        || a.exclusive_with
            .iter()
            .any(|group: &ToolGroup| b.exclusive_with.contains(group))
}

pub(crate) type CallFuture = Pin<Box<dyn Future<Output = (usize, Executed)> + Send>>;

impl Run {
    pub(crate) async fn run_tool_phase(&mut self, response: ModelResponse) -> Result<(), AgentError> {
        let calls = response.tool_calls.clone();
        self.no_tool.note_tool_call_turn();
        // A capped turn: calls past its cap are answered unrun, and a batch
        // after it was told to reply ends it.
        let allowed = limits::calls_allowed(
            self.turn_limits(),
            self.turn_limit_noticed,
            self.tool_calls_total,
            self.env.clock.now_ms(),
        );
        let overrun = self.turn_limit_noticed;
        self.tool_calls_total += calls.len() as u64;
        // Mid-turn assistant text (a preamble before a tool call) is surfaced
        // for providers that return it only in the final response.
        if !mixdog_js::js_trim(&response.content).is_empty() {
            self.emit(RunEvent::AssistantText {
                text: response.content.clone(),
                committed: false,
            });
        }
        self.emit(RunEvent::ToolCalls {
            iteration: self.iterations,
            calls: calls.clone(),
        });
        let mut assistant = tool_call_message(&response);
        assistant.turn_reminder = self.last_reminder.clone();
        let ticket = self.push(assistant).await?;
        // The tools start only once the assistant item that carries their
        // calls is on disk.
        self.until_durable(ticket).await?;
        let results_from = self.messages.len();
        self.process_tool_batch(&calls, allowed).await?;
        // A turn recovered from a stream cut that dropped an in-flight tool
        // call carries a notice for the model, delivered after its results.
        if let Some(notice) = response.recovery_notice {
            self.push(notice).await?;
        }
        self.settle_turn_limits(overrun).await?;
        self.last_batch_later = calls
            .iter()
            .any(|call| is_sleep_like(&call.name));
        self.tool_batch_just_completed = true;
        self.note_tool_batch_completed(&calls, results_from).await?;
        self.mark_step_effort(&calls, results_from);
        Ok(())
    }

}

/// `isSleepLikeToolCall` (`session/loop/tool-phase.mjs:18`): a sleep tool (any server or namespace
/// prefix) grants the drain after its batch the `later` priority. A constant of the loop.
pub(crate) fn is_sleep_like(name: &str) -> bool {
    let name = name.to_lowercase();
    name == "sleep" || name.ends_with("/sleep") || name.ends_with(".sleep")
}
#[cfg(test)]
mod tests {
    #[test]
    fn a_sleep_tool_with_any_prefix_grants_the_later_flush() {
        for name in ["sleep", "Sleep", "srv/sleep", "ns.SLEEP"] {
            assert!(super::is_sleep_like(name), "{name}");
        }
        for name in ["sleeper", "asleep", "sleep_now", "bash"] {
            assert!(!super::is_sleep_like(name), "{name}");
        }
    }

    use super::*;

    /// Never answers on its own; signals when it starts and when it is dropped. With `honours`
    /// it returns partial output once its token fires, otherwise it ignores the token.
    struct Stuck {
        honours: bool,
        spec: ToolSpec,
        started: Arc<tokio::sync::Notify>,
        dropped: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    }

    struct Plain {
        spec: ToolSpec,
        agent: Option<ToolSpec>,
    }

    #[async_trait::async_trait]
    impl Tool for Plain {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        fn agent_spec(&self) -> Option<&ToolSpec> {
            self.agent.as_ref()
        }
        async fn call(&self, _: &ToolContext, _: JsonValue) -> ToolOutcome {
            Ok(ToolOutput::default())
        }
    }

    fn plain(name: &str, description: &str, public: bool, agent: Option<&str>) -> Arc<dyn Tool> {
        let spec = ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public,
            aliases: Vec::new(),
            description: description.into(),
            input_schema: serde_json::json!({"type": "object"}),
            annotations: Default::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        let agent = agent.map(|text| ToolSpec { description: text.into(), ..spec.clone() });
        Arc::new(Plain { spec, agent })
    }

    /// A `public: false` tool is in the set (a rewritten call finds it by name) but never in what the
    /// model is sent; a delegated agent is sent a tool's agent text.
    #[test]
    fn definitions_leave_out_unlisted_tools_and_follow_the_agent_text() {
        let set = ToolSet::new(vec![plain("web_fetch", "fetch", true, None), plain("local_fetch", "loopback", false, None), plain("task", "lead text", true, Some("agent text"))]);
        let sent = |set: &ToolSet| set.definitions().into_iter().map(|d| (d.name, d.description)).collect::<Vec<_>>();
        assert!(set.get("local_fetch").is_some());
        assert_eq!(sent(&set), [("web_fetch".to_owned(), "fetch".to_owned()), ("task".to_owned(), "lead text".to_owned())]);
        assert_eq!(sent(&set.clone().for_agent(true)), [("web_fetch".to_owned(), "fetch".to_owned()), ("task".to_owned(), "agent text".to_owned())]);
    }

    /// A delegated agent's call is coerced to and timed by the agent's definition (Node's `git` and
    /// `task` differ for it in schema and text), the Lead's by the Lead's.
    #[test]
    fn a_call_is_judged_by_the_definition_of_its_surface() {
        let task = plain("task", "lead text", true, Some("agent text"));
        let set = ToolSet::new(vec![task.clone()]);
        assert_eq!(set.spec_of(&task).description, "lead text");
        assert_eq!(set.clone().for_agent(true).spec_of(&task).description, "agent text");
        let git = plain("git", "same", true, None);
        assert_eq!(set.for_agent(true).spec_of(&git).description, "same");
    }

    struct NoClock;
    impl crate::env::Clock for NoClock {
        fn now_ms(&self) -> i64 {
            0
        }
    }

    struct OnDrop(Option<tokio::sync::oneshot::Sender<()>>);
    impl Drop for OnDrop {
        fn drop(&mut self) {
            if let Some(tx) = self.0.take() {
                let _ = tx.send(());
            }
        }
    }

    #[async_trait::async_trait]
    impl Tool for Stuck {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        async fn call(&self, ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
            let _guard = OnDrop(self.dropped.lock().unwrap().take());
            self.started.notify_one();
            if self.honours {
                ctx.cancel.cancelled().await;
                return Ok(ToolOutput { parts: vec![ToolPart::Text("partial".into())], ..ToolOutput::default() });
            }
            std::future::pending().await
        }
    }

    fn stuck_env(
        deadline: Option<Duration>,
        honours: bool,
    ) -> (Arc<CallEnv>, Arc<tokio::sync::Notify>, tokio::sync::oneshot::Receiver<()>) {
        use mixdog_core_api::domain::mock::{MockApprovalGate, MockFileService, MockProcessManager, MockProgress};
        let started = Arc::new(tokio::sync::Notify::new());
        let (tx, dropped) = tokio::sync::oneshot::channel();
        let tool = Arc::new(Stuck {
            honours,
            spec: ToolSpec {
                name: "stuck".into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: "stuck".into(),
                input_schema: serde_json::json!({"type": "object"}),
                annotations: Default::default(),
                parallel_safe: true,
                exclusive_with: Vec::new(),
            },
            started: started.clone(),
            dropped: std::sync::Mutex::new(Some(tx)),
        });
        let tokens = mixdog_rt::testing::tokens();
        let env = CallEnv {
            tools: ToolSet::new(vec![tool]),
            gate: Arc::new(crate::env::AllowAll),
            hooks: None,
            observer: Arc::new(crate::env::NullObserver),
            guards: Arc::new(crate::env::NoGuards),
            mcp: None,
            clock: Arc::new(NoClock),
            tool_env: ToolEnv {
                thread_id: ThreadId::from("t"),
                turn_id: TurnId::from("r"),
                cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo {
                    interactive: tokens.interactive_io,
                    durability: tokens.durability_io,
                    maintenance: tokens.maintenance_io,
                },
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: Arc::new(MockProgress::default()),
                deadline_of: deadline.map(|d| Arc::new(move |_: &ToolSpec| Some(d)) as DeadlineFn),
                notify: None,
                review: None,
            },
            cancel: CancellationToken::new(),
        };
        (Arc::new(env), started, dropped)
    }

    fn stuck_call() -> ToolCall {
        ToolCall { id: "c1".into(), name: "stuck".into(), arguments: serde_json::json!({}), native_type: None }
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancelled_run_releases_a_tool_that_ignores_its_token_after_the_grace() {
        let (env, started, dropped) = stuck_env(None, false);
        let cancel = env.cancel.clone();
        let call = tokio::spawn(execute_call(stuck_call(), env));
        started.notified().await;
        cancel.cancel();
        let executed = call.await.unwrap();
        assert!(executed.failed);
        assert_eq!(executed.message.text(), "Error: tool call cancelled");
        dropped.await.expect("the tool task was aborted, not left running");
    }

    #[tokio::test(start_paused = true)]
    async fn a_tool_that_answers_its_signal_inside_the_grace_keeps_its_partial_output() {
        let (env, started, _dropped) = stuck_env(None, true);
        let cancel = env.cancel.clone();
        let call = tokio::spawn(execute_call(stuck_call(), env));
        started.notified().await;
        cancel.cancel();
        let executed = call.await.unwrap();
        assert!(!executed.failed);
        assert_eq!(executed.message.text(), "partial");
    }

    #[tokio::test(start_paused = true)]
    async fn a_tool_that_outlives_its_deadline_is_released_and_aborted() {
        let (env, _started, dropped) = stuck_env(Some(Duration::ZERO), false);
        let executed = execute_call(stuck_call(), env).await;
        assert!(executed.failed);
        assert_eq!(
            executed.message.text(),
            "Error: read-only I/O tool \"stuck\" timed out after 0ms with no partial output; narrow the scope (path, glob, more specific pattern, smaller limit) and retry."
        );
        // The task may not have started before the deadline fired; either way it ends.
        let _ = dropped.await;
    }

    #[test]
    fn repeat_failure_cycles_are_detected() {
        let h = |items: &[&str]| items.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(pattern_would_continue(&h(&["a", "a", "a"]), "a", 3), 1);
        assert_eq!(pattern_would_continue(&h(&["a", "a"]), "a", 3), 0);
        let cycle = h(&["a", "b", "a", "b", "a", "b"]);
        assert_eq!(pattern_would_continue(&cycle, "a", 3), 2);
        assert_eq!(pattern_would_continue(&cycle, "b", 3), 0);
    }

    #[test]
    fn a_success_clears_the_failure_chain() {
        let mut guards = RepeatGuards::default();
        for _ in 0..3 {
            guards.record(true, "read:{}".into(), "read:{}".into(), false);
        }
        assert!(guards.skip("read", "read:{}", "read:{}").is_some());
        guards.record(false, "grep:{}".into(), "grep:{}".into(), false);
        assert!(guards.skip("read", "read:{}", "read:{}").is_none());
    }

    #[test]
    fn signatures_ignore_key_order() {
        let a = serde_json::json!({"b": 1, "a": [1, {"y": 2, "x": 3}]});
        let b = serde_json::json!({"a": [1, {"x": 3, "y": 2}], "b": 1});
        assert_eq!(call_signature("t", &a), call_signature("t", &b));
        assert_eq!(arg_shape(&a), "{a:array[number,{x:number,y:number}],b:number}");
    }
}
