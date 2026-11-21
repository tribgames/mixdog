//! The host assembly of a turn ([`RunParts`] over what exists today): the provider from the
//! registry, the tool environment from the file and process services, the policy gate, the
//! per-session tool-result reuse, artifacts, hooks, reactions and tail reminder, the retry decider,
//! and the turn's request options from the session header.
//!
//! What has no provider in the tree yet is a method of [`SessionSeams`], each naming its owner and
//! the exact signature the owner has to supply; nothing is stubbed. `compose-seams.md` carries one
//! row per method.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::compact::blob_reads::BlobReads;
use mixdog_agent::env::{Clock, Compactor, RouteFallback, SkillSelector, TurnGuards};
use mixdog_agent::step_effort::StepEffortJudge;
use mixdog_agent::todo::{TodoGuards, TodoView};
use mixdog_agent::tools::{ToolEnv, ToolSet};
use mixdog_agent::{RunCarry, RunConfig};
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::provider::RequestThread;
use mixdog_core_api::domain::tool::{SurfaceKind, Tool, ToolIo};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::SessionDirectory;
use mixdog_protocol::TurnError;
use mixdog_services::effort_judge::judge::{EffortJudge, EffortJudgeModel};
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::{ConnectorPermissions, ToolPolicy, ToolResolver};
use serde_json::{Value, json};

use super::factory::{AssembleInput, Assembled, GateBuilder, GateContext, RunParts, SkillContext, SkillsBuilder};
use super::hooks::{PostToolDispatch, SessionToolHooks};
use super::reactions::{LoopReactions, ReactionScope, ReactionTargets};
use mixdog_core_ports::ports::gate::GateEnv;
use mixdog_core_ports::ports::gate::SessionGate;
use mixdog_core_run::run_host::artifact::ToolResultArtifacts;
use mixdog_core_run::run_host::failure_log::FailureWriter;
use mixdog_core_run::run_host::failure_log::RunFailureLog;
use mixdog_core_run::run_host::route_fallback::HopHost;
use mixdog_core_run::run_host::route_fallback::RouteHop;

/// The tools of a session's surface.
pub struct SessionTools {
    pub tools: Vec<Arc<dyn Tool>>,
    /// The builtin names typo aliases and suggestions draw from (`ToolSet::with_builtins`).
    pub builtins: Vec<String>,
    /// The session is a delegated agent's: it is sent the agent text of `git` and `task`.
    pub agent: bool,
}

mod session_view;

#[cfg(test)]
mod prefix_guard_tests {
    use mixdog_agent::prefix_guard::{GuardOptions, Snapshot, compare, snapshot};
    use mixdog_core_api::domain::provider::{CacheTier, Content, Message, ModelRequest, Role, ToolDefinition};
    use mixdog_core_session::session::route_session::RouteChange;

    use super::super::route_change::{RouteFacts, RunHostRouteChange};
    use super::*;

    struct Facts;

    #[async_trait]
    impl RouteFacts for Facts {
        fn context_meta(&self, _: &str, _: &str, _: &Value) -> Option<mixdog_core_run::run_host::session_context_meta::ContextMeta> {
            None
        }

        fn cache_opts(&self, _: &str, _: &str, _: Option<&str>, _: &Header) -> Option<Value> {
            None
        }
    }

    impl Clock for Facts {
        fn now_ms(&self) -> i64 {
            1
        }
    }

    async fn apply_route(change: &RunHostRouteChange, header: &mut Header, provider: &str, model: &str) {
        let previous = header.clone();
        let route = json!({ "provider": provider, "model": model }).as_object().unwrap().clone();
        let lookups = change.lookups(header, &route).await;
        header.extend(route.clone());
        let patch = change.route_change(header, &route, &previous, true, &lookups);
        for key in patch.unset {
            header.shift_remove(&key);
        }
        header.extend(patch.set);
    }

    fn request(provider: &str, model: &str) -> ModelRequest {
        ModelRequest {
            model: model.into(),
            messages: vec![
                Message::new(Role::System, Content::Text(format!("Model: {provider}/{model}"))),
                Message::new(Role::User, Content::Text("Continue the conversation.".into())),
                Message::new(Role::Assistant, Content::Text("Earlier answer.".into())),
            ],
            tools: Vec::new(),
            options: Default::default(),
        }
    }

    fn fingerprint(request: &ModelRequest, provider: &str) -> Snapshot {
        snapshot(&request.messages, &request.tools, &request.options.hosted_tools, provider, &request.model)
    }

    /// Only an applied switch starts a new chain, even when two switches return to the original route
    /// before another turn. A held pick and subsequent same-route mutations cannot reset the guard.
    #[tokio::test]
    async fn route_changes_rebaseline_without_allowing_same_route_mutations() {
        let change = RunHostRouteChange::new(Arc::new(Facts), Arc::new(Facts));
        let slot = mixdog_core_session::session::PrefixGuardSlot::default();
        let thread = ThreadId::from("route-guard");
        for (provider, model) in [("anthropic", "new-model"), ("openai", "old-model"), ("openai", "new-model")] {
            for held in [false, true] {
                let mut header = json!({ "id": thread.as_str(), "provider": "anthropic", "model": "old-model", "transcriptEpoch": "same-lineage" })
                    .as_object()
                    .unwrap()
                    .clone();
                let mut before = request("anthropic", "old-model");
                before.messages[0].cache_tier = Some(CacheTier::Tier3);
                before.messages[2].thinking_blocks = Some(json!([{ "type": "thinking", "thinking": "Earlier reasoning.", "signature": "old-signature" }]));
                let old = fingerprint(&before, "anthropic");
                slot.for_header(&header);
                slot.keep(Some(old.clone()));
                if held {
                    header.insert("pendingRoute".into(), json!({ "provider": provider, "model": model }));
                    let running = slot.for_header(&header);
                    let mut mutated = before.clone();
                    mutated.messages[1].content = Content::Text("Rewritten while the pick is held.".into());
                    let options = GuardOptions { provider: "anthropic", model: "old-model", intent: None, mutation_source: None };
                    assert_eq!(compare(running.as_ref(), &fingerprint(&mutated, "anthropic"), &options).unwrap()["classification"], "unexpected");
                    header.shift_remove("pendingRoute");
                }
                // The applied pick, not the displayed pendingRoute, is what assemble reads.
                apply_route(&change, &mut header, provider, model).await;
                let mut next = request(provider, model);
                next.messages[0].cache_tier = Some(CacheTier::Env);
                next.tools.push(ToolDefinition {
                    name: "read".into(),
                    description: "Read a file.".into(),
                    input_schema: json!({ "type": "object" }),
                    defer_loading: false,
                    freeform: None,
                });
                next.messages.push(Message::new(Role::User, Content::Text("Next turn.".into())));
                let next_guard = fingerprint(&next, provider);
                let options = GuardOptions { provider, model, intent: None, mutation_source: None };
                // This is the original failure: route-specific prompt/replay changes against the old chain.
                assert_eq!(compare(Some(&old), &next_guard, &options).unwrap()["classification"], "unexpected");
                assert!(compare(slot.for_header(&header).as_ref(), &next_guard, &options).is_none(), "{provider}/{model}, held={held}");
                // settle_prefix / keep_prefix_guard retain the route that actually sent, including a fallback.
                slot.keep(Some(next_guard));
                apply_route(&change, &mut header, provider, model).await;
                let baseline = slot.for_header(&header);
                assert!(compare(baseline.as_ref(), &fingerprint(&next, provider), &options).is_none());
                next.messages[1].content = Content::Text("An unauthorized prefix rewrite.".into());
                assert_eq!(compare(baseline.as_ref(), &fingerprint(&next, provider), &options).unwrap()["reason"], "message_prefix");
                next.messages.truncate(1);
                assert_eq!(compare(baseline.as_ref(), &fingerprint(&next, provider), &options).unwrap()["reason"], "history_shrink");
            }
        }
    }

    /// Returning to the original route without a send in between must not revive the old baseline.
    #[tokio::test]
    async fn a_round_trip_between_routes_consumes_the_staged_reroot() {
        let change = RunHostRouteChange::new(Arc::new(Facts), Arc::new(Facts));
        let slot = mixdog_core_session::session::PrefixGuardSlot::default();
        let thread = ThreadId::from("route-guard");
        let mut header = json!({
            "id": thread.as_str(), "provider": "anthropic", "model": "old-model", "transcriptEpoch": "same-lineage",
            "cwd": "new-workspace", "bp3EnvSplit": true, "bp3EnvironmentContext": "- Workspace: old",
            "promptEnv": "# Session\nCwd: old-workspace\nModel: Old-Model\n\n- Workspace: old",
            "workspaceReroot": { "rootCwd": "old-workspace", "target": { "environmentContext": "- Workspace: new" } }
        })
        .as_object()
        .unwrap()
        .clone();
        let mut before = request("anthropic", "old-model");
        before.messages[0] = mixdog_core_prompt::prompt::blocks::request_system_messages(&header).pop().unwrap();
        let old = fingerprint(&before, "anthropic");
        slot.for_header(&header);
        slot.keep(Some(old.clone()));
        // No guard lookup or send between A -> B -> A. The first switch consumes the staged re-root;
        // returning to A must not revive A's old baseline.
        apply_route(&change, &mut header, "openai", "new-model").await;
        apply_route(&change, &mut header, "anthropic", "old-model").await;
        assert_eq!(header["bp3EnvironmentContext"], "- Workspace: new");
        assert_ne!(header["transcriptEpoch"], "same-lineage", "an applied switch names a new lineage");
        let mut next = before;
        next.messages[0] = mixdog_core_prompt::prompt::blocks::request_system_messages(&header).pop().unwrap();
        let options = GuardOptions { provider: "anthropic", model: "old-model", intent: None, mutation_source: None };
        let next_guard = fingerprint(&next, "anthropic");
        assert_eq!(compare(Some(&old), &next_guard, &options).unwrap()["reason"], "message_prefix");
        assert!(compare(slot.for_header(&header).as_ref(), &next_guard, &options).is_none());
        slot.keep(Some(next_guard));
        next.messages[1].content = Content::Text("An unauthorized rewrite after the round trip.".into());
        assert_eq!(compare(slot.for_header(&header).as_ref(), &fingerprint(&next, "anthropic"), &options).unwrap()["reason"], "message_prefix");
    }
}

/// The thread a Codex request names. Node's `codexWireSendOpts` fixes the wire window at `<wire id>:0` whatever the
/// compaction count, and `buildRequestSendOptions` sends the turn's start as the stamp its id was minted from.
pub(crate) fn wire_thread(id: ThreadId, turn: Option<mixdog_core_api::ids::TurnId>) -> RequestThread {
    let turn_started_at_ms = turn.as_ref().and_then(|t| mixdog_ai::providers::openai::client_meta::v7_stamp(t.as_str()));
    RequestThread { id, window: 0, turn, turn_started_at_ms }
}

/// `isUuidV7`: the canonical 8-4-4-4-12 form of a version 7, variant `[89ab]` id.
fn is_uuid_v7(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 5
        && parts.iter().zip([8, 4, 4, 4, 12]).all(|(part, len)| part.len() == len && part.bytes().all(|b| b.is_ascii_hexdigit()))
        && parts[2].starts_with(['7'])
        && parts[3].starts_with(['8', '9', 'a', 'b', 'A', 'B'])
}

/// The thread a request of the stored session `header` names: a Codex session sends its stored wire identity
/// (`codexWireSessionId`, `ensureCodexWireSessionId`), which is not the thread's id, as the id of every request of the
/// session, compaction summaries included; any other route names the thread itself. A Codex header with no valid stored
/// identity falls back to the thread id only for requests built outside a turn; `assemble` mints and stores one first.
pub(crate) fn request_identity(thread: &ThreadId, header: &Header, turn: Option<mixdog_core_api::ids::TurnId>) -> RequestThread {
    let stored = text(header, "codexWireSessionId").to_lowercase();
    let wire = (text(header, "provider") == "openai-oauth" && is_uuid_v7(&stored)).then(|| ThreadId::from(stored.as_str()));
    wire_thread(wire.unwrap_or_else(|| thread.clone()), turn)
}

/// The identity fields of a request's options, shared by the turn's assembly and the parity test: Node's
/// `codexSessionId`, thread and cache key are all the stored wire identity (`cache-strategy.mjs:312`).
pub(crate) fn apply_identity(
    options: &mut mixdog_core_api::domain::provider::RequestOptions,
    thread: &ThreadId,
    header: &Header,
    turn: Option<mixdog_core_api::ids::TurnId>,
) {
    let identity = request_identity(thread, header, turn);
    options.session_id = Some(identity.id.to_string());
    options.thread = Some(identity);
    // The spend belongs to the thread, whatever id the provider sees: a Codex request's `session_id` is its wire id, which
    // the ledger and the session's header do not know. An attribution set upstream stays.
    options.usage_session_id.get_or_insert_with(|| thread.as_str().to_owned());
}

/// `...session.providerCacheOpts`, spread last into every send's options (`ask-turn-loop-options.mjs:74-77`): the
/// session's cache policy. Its `cacheStrategy` is what the Anthropic body reads as `model_parameters.cacheStrategy`
/// (a lead session's message breakpoints are `1h`), its `promptCacheScope` the request's cache scope.
pub(crate) fn apply_cache_opts(options: &mut mixdog_core_api::domain::provider::RequestOptions, header: &Header) {
    let Some(opts) = header.get("providerCacheOpts").and_then(Value::as_object) else { return };
    for key in [
        "cacheStrategy",
        "responsesPromptCacheKey",
        "promptCacheKey",
        "providerCacheKey",
        "promptCacheLane",
        "promptCacheLaneShards",
        "openaiCacheLaneShards",
        "promptCacheLaneAuto",
        "openaiCacheLaneAuto",
        "promptCacheLaneMaxParallel",
        "openaiCacheMaxParallel",
        "promptCacheLaneIgnoreAliases",
        "promptCacheLaneSlot",
        "cacheLaneSlot",
        "promptCacheLaneSeed",
    ] {
        if let Some(value) = opts.get(key).filter(|v| key != "cacheStrategy" || v.is_object()) {
            let parameters = options.model_parameters.get_or_insert_with(|| Value::Object(serde_json::Map::new()));
            if let Some(parameters) = parameters.as_object_mut() {
                parameters.insert(key.to_owned(), value.clone());
            }
        }
    }
    if let Some(scope) = opts.get("promptCacheScope").and_then(Value::as_str) {
        options.prompt_cache_scope = Some(scope.to_owned());
    }
}

fn apply_route_options(options: &mut mixdog_core_api::domain::provider::RequestOptions, header: &Header) {
    options.effort = Some(text(header, "effort").to_owned()).filter(|e| !e.is_empty());
    options.fast = header.get("fast").and_then(Value::as_bool) == Some(true);
    options.prompt_cache_key = Some(text(header, "promptCacheKey").to_owned()).filter(|k| !k.is_empty());
    options.model_parameters = header.get("modelParameters").filter(|v| v.is_object()).cloned();
    apply_cache_opts(options, header);
    apply_selected_window(options, header);
    options.wire_pin = wire_pin_of(header.get("wireRoute"));
}

/// `selectedContextWindow: session.selectedContextWindow || session.contextWindow` (`ask-turn-loop-options.mjs:58`): the
/// session's chosen window rides `model_parameters` beside the route's choices, where a provider that picks a variant by
/// window (Cursor's Max mode) reads it. The desktop slider removes `context` from the saved parameters, so the header's own
/// key is the one source; a falsy window is not passed.
fn apply_selected_window(options: &mut mixdog_core_api::domain::provider::RequestOptions, header: &Header) {
    let Some(window) = header.get("selectedContextWindow").filter(|v| v.as_f64().is_some_and(|n| n > 0.0)) else { return };
    let parameters = options.model_parameters.get_or_insert_with(|| Value::Object(serde_json::Map::new()));
    if let Some(parameters) = parameters.as_object_mut() {
        parameters.insert("selectedContextWindow".to_owned(), window.clone());
    }
}

fn text<'a>(header: &'a Header, key: &str) -> &'a str {
    header.get(key).and_then(Value::as_str).map_or("", mixdog_js::js_trim)
}

/// `snapshotProviderRequestTools` at a request boundary: `tools` as the provider is sent them, with the catalog tools the
/// transcript's native tool searches (`native`, [`super::factory::native_searches`]) reference. The turn's boundary and
/// the snapshot both take the request's tools here.
/// The definitions of a live epoch are not re-filtered by availability here (a tool that cannot run now is answered
/// unavailable at dispatch); only the scoped MCP snapshot (`isDeferredToolAvailable`) lists them, as before.
///
/// A tool its owner withdrew is not removed here: the request's tools are the session's stored ones, and a withdrawal only
/// stops the tool being callable (the builder keeps its definition and answers a call unavailable). The definition leaves the
/// stored lists, and so the request, at a cold fold or an explicit surface rebuild (`ToolSurface::repair`), as in Node, so a warm
/// prefix is never rewritten between two sends.
pub(crate) fn boundary_tools(
    header: &Header,
    tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
    native: &[Value],
) -> Vec<mixdog_core_api::domain::provider::ToolDefinition> {
    let provider = text(header, "provider").to_lowercase();
    let referenced = native.iter().flat_map(|record| super::context_world::native_references(Some(record), &provider)).collect();
    super::context_world::snapshot_tools(header, tools, referenced, &provider)
}

/// The session's `wireRoute` as the pin a gateway's send reads; `None` without one.
fn wire_pin_of(route: Option<&Value>) -> Option<mixdog_core_api::domain::provider::WirePin> {
    mixdog_core_api::domain::provider::WirePin::from_route(route?)
}

/// A provider no family serves is one that is not there: a custom provider just removed has no entry for the readiness to build
/// (`ensureProviderEnabled` adds only `enabled: true`), and a live Node turn finds `getProvider` empty and says `Provider "<id>" not available`
/// (`ask-turn-execute.mjs:178`). Any other readiness failure escapes as it is.
#[allow(clippy::result_large_err, reason = "Preserve the canonical structured core/provider failure by value without boxing or changing this call contract")]
fn unserved_provider(provider_id: &str, message: String) -> Result<Option<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>>, TurnError> {
    if mixdog_core_run::run_host::route_fallback::is_unserved(provider_id, &message) {
        return Ok(None);
    }
    Err(refuse(message))
}

fn refuse(message: impl Into<String>) -> TurnError {
    TurnError { message: message.into(), data: json!({}), provider_error: None }
}

/// `Provider "<id>" not available` (`ask-turn-execute.mjs:178`).
fn not_available(provider_id: &str) -> TurnError {
    refuse(format!("Provider \"{provider_id}\" not available"))
}

/// `ensureCodexWireSessionId` (`ask-turn-open.mjs:85`): a Codex session with no valid stored wire identity (a fork
/// or a cold heir does not carry the source's, `cold-heir.mjs:70`) mints one and stores it before its first request.
/// `Some` is the session's header as stored afterwards; `None` when the session needed none.
#[allow(clippy::result_large_err, reason = "Preserve the canonical structured core/provider failure by value without boxing or changing this call contract")]
pub(crate) async fn ensure_codex_wire_id(
    directory: &mixdog_core_session::session::SessionDirectory,
    thread: &ThreadId,
    header: &Header,
) -> Result<Option<Arc<Header>>, TurnError> {
    if text(header, "provider") != "openai-oauth" || is_uuid_v7(&text(header, "codexWireSessionId").to_lowercase()) {
        return Ok(None);
    }
    directory
        .update_header(
            thread,
            Box::new(|stored| {
                let mut set = serde_json::Map::new();
                if !is_uuid_v7(&text(stored, "codexWireSessionId").to_lowercase()) {
                    set.insert("codexWireSessionId".into(), json!(uuid::Uuid::now_v7().to_string()));
                }
                mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }
            }),
        )
        .await
        .map_err(|error| refuse(error.to_string()))?;
    Ok(directory.handle(thread).map(|handle| handle.live_header().header()))
}

#[cfg(test)]
mod cwd_tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_session_without_a_working_directory_runs_in_the_daemons_folder() {
        let named = json!({ "cwd": " C:/work " }).as_object().unwrap().clone();
        assert_eq!(cwd_of(&named).unwrap(), Path::new("C:/work"));
        let here = std::env::current_dir().unwrap();
        assert_eq!(cwd_of(&json!({}).as_object().unwrap().clone()).unwrap(), here, "a header without one");
        assert_eq!(cwd_of(&json!({ "cwd": " " }).as_object().unwrap().clone()).unwrap(), here, "an empty one");
    }
}

/// What a non-bridge session's call reaches by name though its request did not carry it: a connected server's
/// tool (`isMcpTool`, `mcp__…`) and a tool of the session's deferred catalog. A natively loaded tool is callable
/// (`deferredCallableTools`) without joining the session's `tools`, and Node runs it from the registry once the
/// call-through guard let it by (`isInternalTool`, `tool-exec/dispatch.mjs`). A name outside the catalog stays unknown.
struct Surfaced {
    registry: Arc<dyn ToolResolver>,
    /// The deferred catalog's names, less what the route sends in no request.
    catalog: Vec<String>,
}

impl ToolResolver for Surfaced {
    fn resolve(&self, scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
        if name.starts_with("mcp__") || self.catalog.iter().any(|known| known == name) { self.registry.resolve(scope, name) } else { None }
    }
}

/// The registry behind a session's tool set (see [`HostRunParts::surface_tools`]), and the catalog tools it cannot run: a name
/// `load_tool` reported unavailable (`ToolSurface::runs`, the same registered set) is answered with that reason when called.
pub(super) fn with_surface_registry(
    set: ToolSet,
    registry: Arc<dyn ToolResolver>,
    scope: Option<String>,
    surface: &mixdog_tools::policy::SessionSurface,
) -> ToolSet {
    let unavailable = surface
        .catalog_tools
        .iter()
        .filter(|name| !name.starts_with("mcp__") && registry.resolve(scope.as_deref(), name).is_none())
        .map(|name| (name.clone(), super::tool_surface::ToolSurface::unavailable_reason(name)))
        .collect();
    let set = set.with_unavailable(unavailable);
    if surface.bridge {
        return set.with_registry(registry, scope);
    }
    let catalog = surface.catalog_tools.iter().filter(|name| !surface.route_excluded.iter().any(|(excluded, _)| excluded == *name)).cloned().collect();
    set.with_registry(Arc::new(Surfaced { registry, catalog }), scope)
}

#[cfg(test)]
mod surfaced_tests {
    use mixdog_core_api::domain::tool::{ToolAnnotations, ToolContext, ToolOutcome, ToolOutput, ToolSpec};

    use super::*;

    struct Stub(ToolSpec);

    #[async_trait]
    impl Tool for Stub {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            Ok(ToolOutput::default())
        }
    }

    struct Pool(Vec<Arc<dyn Tool>>);

    impl ToolResolver for Pool {
        fn resolve(&self, _: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
            self.0.iter().find(|tool| tool.spec().name == name).cloned()
        }
    }

    fn stub(name: &str) -> Arc<dyn Tool> {
        Arc::new(Stub(ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: String::new(),
            input_schema: json!({}),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        }))
    }

    /// A tool `load_tool` made callable on a native session is not in the request's tool set: a call to it by name
    /// runs the registered tool, as a connected server's tool does, and a name the catalog does not hold is unknown.
    #[test]
    fn a_deferred_catalog_tool_called_by_name_runs_the_registered_tool() {
        let registry: Arc<dyn ToolResolver> = Arc::new(Pool(vec![stub("read"), stub("computer"), stub("mcp__alpha__zeta"), stub("uncatalogued")]));
        let set = ToolSet::new(vec![stub("read")]).with_registry(Arc::new(Surfaced { registry, catalog: vec!["read".into(), "computer".into()] }), None);
        assert_eq!(set.resolve("computer").expect("a catalog tool").spec().name, "computer");
        assert_eq!(set.resolve("mcp__alpha__zeta").expect("a server's tool").spec().name, "mcp__alpha__zeta");
        assert!(set.resolve("uncatalogued").is_none());
    }
}

/// A key of the compaction sizing a cold transcript is judged under: the window and the targets, not the readings that
/// move every turn. A disposition decided under another key does not hold.
fn sizing_key(settings: Option<&mixdog_agent::boundary::CompactSettings>) -> u64 {
    let Some(s) = settings else { return 0 };
    let optional = |value: Option<u64>| value.unwrap_or(u64::MAX);
    let words = [
        optional(s.context_window),
        optional(s.explicit_boundary),
        optional(s.auto_limit),
        optional(s.target_tokens),
        optional(s.target_min_tokens),
        s.buffer_tokens,
        s.configured_reserve_tokens,
        s.request_reserve_tokens,
        s.target_ratio.map_or(u64::MAX, f64::to_bits),
        s.buffer_ratio.to_bits(),
        s.token_calibration.to_bits(),
    ];
    // FNV-1a: the key is persisted with a disposition, so it must not depend on the process.
    words.iter().flat_map(|w| w.to_le_bytes()).fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)) | 1
}

/// The facts of the thread a request is built from.
struct RequestSource<'a> {
    thread: &'a ThreadId,
    header: &'a Header,
    surface: &'a mixdog_tools::policy::SessionSurface,
    prior: &'a [Value],
    request: &'a str,
    injected: bool,
    /// Only a real turn has a cancellable first send; previews never judge.
    first_send: Option<&'a tokio_util::sync::CancellationToken>,
    provider_state: Option<mixdog_core_api::domain::provider::ProviderState>,
    /// The turn the request is for, when there is one. (The thread's compaction count is not a request fact: the wire
    /// window is fixed at `<wire id>:0`, [`wire_thread`].)
    turn: Option<mixdog_core_api::ids::TurnId>,
    /// The generation of the history `prior` is, read with it ([`mixdog_ai::cache_tail::Books::generation`]).
    generation: u64,
}

/// The messages of the next main request: the system prompt and the stored rows, with the pre-send
/// transcript repair of the loop's request boundary (a tool call the interrupted turn never answered
/// gets its stub, a stray result is dropped) applied to this local copy only; nothing is persisted.
fn rebuilt_messages(header: &Header, rows: &[Value]) -> Option<Vec<mixdog_agent::message::AgentMessage>> {
    let mut messages = super::factory::system_messages(header);
    for body in rows {
        messages.push(super::message_row::message_of(body).ok()?);
    }
    mixdog_agent::repair::repair_before_send(&mut messages);
    Some(messages)
}

#[cfg(test)]
mod rebuilt_tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_dangling_tool_call_is_answered_with_the_missing_stub_in_the_rebuilt_request() {
        let header = json!({}).as_object().unwrap().clone();
        let rows = vec![
            json!({ "role": "user", "content": "go" }),
            json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "c1", "name": "list", "arguments": {} }] }),
        ];
        let messages = rebuilt_messages(&header, &rows).unwrap();
        let tail = &messages[messages.len() - 1];
        assert_eq!(tail.tool_call_id(), Some("c1"));
        assert_eq!(tail.text(), "[Older tool result unavailable after context compaction]");
        assert_eq!(messages.len() - mixdog_core_prompt::prompt::blocks::request_system_messages(&header).len(), 3, "user, assistant, stub; no tail reminder");
        // A complete transcript is untouched.
        let whole = vec![rows[0].clone(), rows[1].clone(), json!({ "role": "tool", "toolCallId": "c1", "content": { "content": "ok" } })];
        assert_eq!(rebuilt_messages(&header, &whole).unwrap().last().unwrap().text(), "ok");
    }
}

#[cfg(test)]
mod identity_tests {
    use serde_json::json;

    use super::*;

    fn stored(thread: &str, provider: &str, wire: serde_json::Value) -> (ThreadId, Header) {
        let header = json!({ "provider": provider, "codexWireSessionId": wire }).as_object().unwrap().clone();
        // Through the store's own text, as a resumed session's header comes back.
        let header: Header = serde_json::from_str(&serde_json::to_string(&header).unwrap()).unwrap();
        (ThreadId::from(thread), header)
    }

    fn request_of(thread: &ThreadId, header: &Header) -> mixdog_core_api::domain::provider::RequestOptions {
        let mut options = mixdog_core_api::domain::provider::RequestOptions::default();
        apply_identity(&mut options, thread, header, None);
        options
    }

    #[test]
    fn a_resumed_session_sends_its_stored_identity_in_every_request_field() {
        let (thread, header) = stored("thread_a", "openai-oauth", json!("0190F0A0-1C2D-7E3F-8A4B-5C6D7E8F9A0D"));
        let options = request_of(&thread, &header);
        let wire = "0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d";
        assert_eq!(options.session_id.as_deref(), Some(wire));
        assert_eq!(options.thread.as_ref().unwrap().id.as_str(), wire);
        // Resumed again from the same stored header: the same identity.
        assert_eq!(request_of(&thread, &header).session_id, options.session_id);
    }

    /// What creation recorded is what the request carries: a worker's message tail (`5m` under a ten-minute idle window), and a one-shot maintenance role
    /// (the memory cycle's `cycle1-agent`) no message tail at all, on the shared prompt-cache scope.
    #[test]
    fn a_created_agent_sessions_request_carries_the_cache_policy_its_creation_recorded() {
        let options_of = |agent: &str| {
            let mut header = Header::new();
            for (key, value) in [("provider", "anthropic-oauth"), ("agent", agent), ("owner", "agent")] {
                header.insert(key.into(), json!(value));
            }
            crate::run_host::session_cache_opts::stamp_cache_opts_with_env(&mut header, &json!({ "enabled": true, "idleMs": 600_000 }), "");
            let mut options = mixdog_core_api::domain::provider::RequestOptions::default();
            apply_cache_opts(&mut options, &header);
            options
        };
        let worker = options_of("worker");
        assert_eq!(worker.model_parameters.unwrap()["cacheStrategy"]["messages"], "5m");
        let cycle = options_of("cycle1-agent");
        assert_eq!(cycle.model_parameters.unwrap()["cacheStrategy"]["messages"], "none");
        assert_eq!(cycle.prompt_cache_scope.as_deref(), Some("shared"));
    }

    /// The session's chosen window reaches the request through the route-options assembly, beside the saved parameters, even
    /// when the slider removed `context` from them; a falsy window is not passed.
    #[test]
    fn the_sessions_selected_window_reaches_the_requests_model_parameters() {
        let options_of = |header: serde_json::Value| {
            let header: Header = header.as_object().unwrap().clone();
            let mut options = mixdog_core_api::domain::provider::RequestOptions::default();
            apply_route_options(&mut options, &header);
            options.model_parameters
        };
        let sent = options_of(json!({ "provider": "cursor-api", "modelParameters": { "effort": "high" }, "selectedContextWindow": 1_000_000 })).unwrap();
        assert_eq!((sent["selectedContextWindow"].clone(), sent["effort"].clone()), (json!(1_000_000), json!("high")));
        assert_eq!(options_of(json!({ "provider": "cursor-api", "selectedContextWindow": 272_000 })).unwrap()["selectedContextWindow"], json!(272_000));
        assert!(options_of(json!({ "provider": "cursor-api", "selectedContextWindow": null })).is_none());
        assert!(options_of(json!({ "provider": "cursor-api", "selectedContextWindow": 0 })).is_none());
    }

    #[test]
    fn a_sub_agent_session_sends_its_own_stored_identity_not_its_parents() {
        let (parent, parent_header) = stored("thread_parent", "openai-oauth", json!("0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d"));
        let (child, child_header) = stored("thread_child", "openai-oauth", json!("0190f0a1-2222-7333-9444-555566667777"));
        assert_eq!(request_of(&parent, &parent_header).session_id.as_deref(), Some("0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d"));
        assert_eq!(request_of(&child, &child_header).session_id.as_deref(), Some("0190f0a1-2222-7333-9444-555566667777"));
    }

    #[test]
    fn another_route_or_an_invalid_stored_identity_names_the_thread_itself() {
        let (thread, other) = stored("thread_b", "anthropic-oauth", json!("0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d"));
        assert_eq!(request_of(&thread, &other).session_id.as_deref(), Some("thread_b"));
        let (thread, bad) = stored("thread_c", "openai-oauth", json!("not-a-uuid"));
        assert_eq!(request_of(&thread, &bad).session_id.as_deref(), Some("thread_c"));
    }
}

#[cfg(test)]
mod unserved_provider_tests {
    use super::*;

    #[test]
    fn a_removed_custom_provider_is_not_available_and_another_failure_escapes() {
        let gone = "[provider] Failed to init \"custom-x\": unknown enabled provider: custom-x".to_owned();
        assert!(unserved_provider("custom-x", gone.clone()).unwrap().is_none());
        // Another provider's failure, and another reason, keep their own text.
        assert_eq!(unserved_provider("custom-y", gone).err().unwrap().message, "[provider] Failed to init \"custom-x\": unknown enabled provider: custom-x");
        assert_eq!(
            unserved_provider("anthropic", "[provider] Failed to init \"anthropic\": not signed in".into()).err().unwrap().message,
            "[provider] Failed to init \"anthropic\": not signed in"
        );
    }
}

/// `RunConfig` fields that come from the route, the settings and the agent definition.
pub struct RunSettings {
    pub hidden_agent: bool,
    pub agent_mode: bool,
    pub limits: Option<mixdog_agent::limits::TurnLimits>,
    pub compact: Option<mixdog_agent::boundary::CompactSettings>,
    pub escalated_max_output_tokens: Option<u32>,
    pub read_body_required: bool,
    pub vision: Option<Arc<dyn mixdog_agent::env::ModelVision>>,
    pub effort: Option<mixdog_agent::effort::EffortWiring>,
    pub step_auto_effort: Option<mixdog_agent::step_effort::StepAutoEffort>,
    pub text_only: Option<mixdog_agent::text_only::TextOnlyInput>,
    pub attachments: Option<Arc<dyn mixdog_agent::attachments::AttachmentText>>,
    pub file_text: Option<Arc<dyn mixdog_agent::text_only::MediaText>>,
    pub model_max_output_tokens: Option<u32>,
    /// The user's auto-clear setting, read at each provider attempt's admission (`None`: on). Off, a cold transcript is
    /// sent unchanged without compaction.
    pub auto_clear: Option<mixdog_ai::cache_tail::Setting>,
}
/// The run's own parts a compactor reads its transcript through: the same values the run commits
/// and archives with, so a pass sees exactly the rows the session stored.
pub struct CompactorInput {
    /// `RunSettings.compact` (`auto` is not read; see `FreshCompactor::for_session`).
    pub settings: mixdog_agent::boundary::CompactSettings,
    /// The run's stored bodies (`FreshParts.rows`).
    pub rows: Arc<mixdog_core_session::session::StoredRows>,
    /// Where a dropped execution is archived (`FreshParts.archive`).
    pub archive: Arc<dyn mixdog_agent::offload::ArtifactStore>,
    pub blobs: Arc<dyn BlobReads>,
}
/// What a turn needs and no crate supplies yet. Every method is a seam with its owner.
#[async_trait]
pub trait SessionSeams: Send + Sync + 'static {
    /// The surface's tools: the built-ins its tool spec names and the connected MCP servers' tools
    /// (`McpHub::tools`), filtered by the surface. Owner: WP-TOOLS-ORCH (built-in registry),
    /// WP-MCP (merge).
    /// Async: whether skills are listed comes from a current collection; its failure is the error.
    async fn tools(&self, thread: &ThreadId, header: &Header, surface: &mixdog_tools::policy::SessionSurface) -> Result<SessionTools, String>;
    /// `getHiddenAgent(agent)`. Owner: WP-CONFIG (agent store).
    fn hidden_agent(&self, agent: Option<&str>) -> bool;
    /// `getHiddenAgent(agent).stallCap.idleSeconds`: an internal agent's own idle budget.
    fn stall_cap_idle_seconds(&self, _agent: Option<&str>) -> Option<i64> {
        None
    }
    /// `readAgentFirstResponseTimeoutMs(agent)`: the agent definition's own first-response
    /// deadline (0 turns it off); `None` when it sets none.
    async fn first_response_timeout_ms(&self, _agent: &str) -> Option<i64> {
        None
    }
    /// The todo list, goal and background work as the turn guards read them. Owner:
    /// WP-SESSION-PORTS (`TodoStore`, `GoalPort`) over `run_host::guards::HostTodoView`.
    fn todo_view(&self, thread: &ThreadId, header: &Header) -> Arc<dyn TodoView>;
    /// PostToolUse / PostToolUseFailure / PostToolBatch dispatch. Owner: WP-MCP (hook bus).
    fn post_tool_dispatch(&self) -> Arc<dyn PostToolDispatch>;
    /// The compaction pipeline for this session's route (`run_host::compactors::SessionCompactors`
    /// over `FreshCompactor::for_session`). `input` is the run's: the settings it compacts by and
    /// the stored rows, archive and blobs its transcript is read through.
    async fn compactor(&self, thread: &ThreadId, header: &Header, prior: &[Value], input: CompactorInput) -> Option<Arc<dyn Compactor>>;
    /// What the route hop reads and writes (`HopHost`). Owner: WP-AI-SVC (registry, wires) with
    /// WP-SESSION (the header write).
    fn hop_host(&self, thread: &ThreadId, header: &Header) -> Option<Arc<dyn HopHost>>;
    /// Explicit skill selection for typed steering, over the turn's trusted selection text (`AgentTurn.skill_selection`,
    /// `prepareExplicitSkills` `selection`). Owner: WP-MCP (skills domain).
    fn skill_parts(&self) -> Option<SkillParts>;
    /// The route's, settings' and agent's `RunConfig` fields. Owner: WP-AGENT (limits, compaction
    /// settings, effort wiring, text-only), WP-CONFIG (settings).
    fn run_settings(&self, thread: &ThreadId, header: &Header) -> RunSettings;
    /// The tail reminder's language and role. Owner: WP-RUN-HOST (`rules_lead::build_lead_language`
    /// over the system locale) with WP-CONFIG for the role.
    fn tail_context(&self, header: &Header) -> mixdog_agent::tail_rules::TailContext;
    /// What the turn's route says about its efforts, for the step judge's ladder
    /// (`effortOptionsFor(provider, autoEffortModel(..))`, and a custom route's row, protocol and
    /// base URL). The host picks the ladder and builds the judge over its `EffortJudgeModel`.
    /// Owner: WP-AI-SVC (catalog rows, registry, custom config). `None`: the route has no facts.
    async fn step_ladder_facts(
        &self,
        thread: &ThreadId,
        header: &Header,
        auto: &mixdog_agent::step_effort::StepAutoEffort,
    ) -> Option<super::step_judge::StepLadderFacts>;
    /// Tool-result image compaction. Owner: WP-AGENT (ImageCompactor has no implementation).
    fn image_compactor(&self) -> Option<Arc<dyn mixdog_agent::offload::ImageCompactor>>;
    /// The install's plugin root (`rules/`, `output-styles/`): `mixdog_store::paths::Paths::plugin_root`.
    fn plugin_root(&self) -> PathBuf;
    /// `readSection('agent').instructionFiles`, the stored setting. Owner: WP-CONFIG.
    fn stored_instruction_files(&self) -> Option<Value>;
    /// The data directory of the install (artifacts and attachments live under it):
    /// `mixdog_store::paths::Paths::data_dir`.
    fn data_dir(&self) -> PathBuf;
}
/// What a request of a thread is made of, the same for the turn that sends it and for the rebuild a
/// side question forks: the route's provider, the surface's tools, the merged settings and the request
/// options the header gives.
struct RequestParts {
    provider: Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>,
    cwd: PathBuf,
    tool_set: ToolSet,
    settings: RunSettings,
    options: mixdog_core_api::domain::provider::RequestOptions,
}
impl HostRunParts {
    /// The tools a run calls: the surface's own and the registry behind them, the whole registry on a bridge
    /// session, its connected servers' tools and its deferred catalog on any other. A deferred tool is not in the request, but a call
    /// to it (through `call_tool`, or by its name) runs it, as Node's executor dispatches by registry
    /// (`tool-exec/dispatch.mjs`); `dispatchMcp` runs a tool a connected server of the session's scope holds
    /// whatever the session's exposure (`isRegisteredMcpTool`).
    fn surface_tools(&self, set: ToolSet, header: &Header, surface: &mixdog_tools::policy::SessionSurface) -> ToolSet {
        let scope = super::session_tools::header_scope(header).map(str::to_owned);
        with_surface_registry(set, self.services.resolver.clone(), scope, surface)
    }

    /// The route's provider, readied; `Ok(None)` when it is not available. `Err` is a readiness failure, which says
    /// nothing about the provider's availability.
    #[allow(
        clippy::result_large_err,
        reason = "Preserve the canonical structured core/provider failure by value without boxing or changing this call contract"
    )]
    async fn ready_provider(
        &self,
        thread: &ThreadId,
        header: &Header,
    ) -> Result<Option<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>>, TurnError> {
        let s = &self.services;
        let seams = &s.seams;
        let provider_id = text(header, "provider");
        let host = seams.hop_host(thread, header);
        if host.as_ref().is_some_and(|host| mixdog_ai::service::admin_route::provider_switched_off(&host.config(), provider_id)) {
            return Ok(None);
        }
        Ok(match s.registry.get(provider_id).await {
            Some(provider) => Some(provider),
            None => match host {
                Some(host) => host.provider(provider_id).await.or_else(|message| unserved_provider(provider_id, message))?,
                None => None,
            },
        })
    }

    #[allow(
        clippy::result_large_err,
        reason = "Preserve the canonical structured core/provider failure by value without boxing or changing this call contract"
    )]
    async fn request_parts(
        &self,
        source: RequestSource<'_>,
        provider: Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>,
    ) -> Result<RequestParts, TurnError> {
        let s = &self.services;
        let seams = &s.seams;
        let (thread, header) = (source.thread, source.header);
        let cwd = cwd_of(header)?;
        let SessionTools { tools, builtins, agent, .. } = seams.tools(thread, header, source.surface).await.map_err(refuse)?;
        let tool_set = ToolSet::with_builtins(tools, builtins).for_agent(agent);
        let tool_set = self.surface_tools(tool_set, header, source.surface);
        let effort = match (&s.settings.first_auto_effort, source.first_send) {
            (Some(auto), Some(cancel)) => auto.first_request_effort(thread.as_str(), header, source.prior, source.request, source.injected, cancel).await,
            _ => None,
        };
        let settings = super::settings::merge_settings(
            seams.run_settings(thread, header),
            &s.settings,
            &super::settings::TurnFacts {
                thread,
                header,
                provider: &provider,
                prior: source.prior,
                request: source.request,
                injected: source.injected,
                tools: &tool_set.definitions(),
                now_ms: s.clock.now_ms(),
            },
            effort,
        );
        let mut options = mixdog_core_api::domain::provider::RequestOptions::default();
        apply_identity(&mut options, thread, header, source.turn);
        apply_route_options(&mut options, header);
        if let Some(effort) = effort {
            options.effort = Some(effort.to_owned());
        }
        options.model_max_output_tokens = settings.model_max_output_tokens;
        options.provider_state = source.provider_state;
        let directory = s.directory.upgrade().ok_or_else(|| refuse("the session directory is gone"))?;
        options.tail_gate = Some(directory.deps().cache_tail.gate(
            thread.as_str(),
            header.get("cacheTailBook"),
            mixdog_ai::cache_tail::GateSettings {
                clock: {
                    let clock = s.clock.clone();
                    Arc::new(move || clock.now_ms())
                },
                auto_clear: settings.auto_clear.clone().unwrap_or_else(|| Arc::new(|| true)),
                sizing: sizing_key(settings.compact.as_ref()),
                // Nothing of this session was sent before: no stored rows ahead of this request and no recorded send.
                fresh: source.prior.is_empty() && header.get("lastProviderSendAt").is_none(),
                // A send time that is not positive records no send (Node: `!(lastSendAt > 0)`).
                last_send_at: header.get("lastProviderSendAt").and_then(Value::as_f64).map(|at| at as i64).filter(|at| *at > 0),
            },
        ));
        // The generation of the history `source` loaded, read with its rows: the run moves it on only for its own rewrite (or
        // a reload of the stored history), so an attempt built after a rewrite it did not make is refused, never re-stamped.
        options.tail_generation = Some(source.generation);
        Ok(RequestParts { provider, cwd, tool_set, settings, options })
    }

    fn route_hop(&self, thread: &ThreadId, header: &Header, turn: &mixdog_core_api::ids::TurnId) -> Option<Arc<RouteHop>> {
        let s = &self.services;
        let host = s.seams.hop_host(thread, header)?;
        let (seams, thread, turn) = (s.seams.clone(), thread.clone(), turn.clone());
        let (ceilings, clock, directory) = (s.settings.ceilings.clone(), s.clock.clone(), s.directory.clone());
        Some(Arc::new(RouteHop::new(host).with_request_for_route(move |header| {
            let mut options = mixdog_core_api::domain::provider::RequestOptions::default();
            apply_identity(&mut options, &thread, header, Some(turn.clone()));
            apply_route_options(&mut options, header);
            let ceiling = ceilings.ceilings(text(header, "provider"), text(header, "model"), header);
            options.model_max_output_tokens = ceiling.model_max;
            let run = seams.run_settings(&thread, header);
            let auto_clear = run.auto_clear.clone().unwrap_or_else(|| Arc::new(|| true));
            let (session, book, clock) = (thread.clone(), header.get("cacheTailBook").cloned(), clock.clone());
            let tail_gate = directory.upgrade().map(|directory| -> mixdog_agent::env::TailGateFor {
                Arc::new(move |compact: Option<&mixdog_agent::boundary::CompactSettings>| {
                    let clock = clock.clone();
                    directory.deps().cache_tail.gate(
                        session.as_str(),
                        book.as_ref(),
                        mixdog_ai::cache_tail::GateSettings {
                            clock: Arc::new(move || clock.now_ms()),
                            auto_clear: auto_clear.clone(),
                            sizing: sizing_key(compact),
                            fresh: false,
                            last_send_at: None,
                        },
                    )
                })
            });
            mixdog_agent::env::RouteSwitchRequest {
                options,
                compact: run.compact,
                header: header.clone(),
                escalated_max_output_tokens: ceiling.escalated,
                tail_gate,
            }
        })))
    }

    /// The step judge exists only when auto effort is on for the turn and the shared model has a calibration made for steps.
    async fn step_judge(
        &self,
        thread: &ThreadId,
        header: &Header,
        provider_id: &str,
        requested: Option<mixdog_agent::step_effort::StepAutoEffort>,
    ) -> (Option<mixdog_agent::step_effort::StepAutoEffort>, Option<Arc<dyn StepEffortJudge>>) {
        let s = &self.services;
        let step_auto_effort = match (requested, &s.effort_judge) {
            (Some(auto), Some(model)) if model.supports_steps().await => Some(auto),
            _ => None,
        };
        let step_judge = match &step_auto_effort {
            Some(auto) => match s.seams.step_ladder_facts(thread, header, auto).await {
                Some(facts) => super::step_judge::ladder_for(provider_id, auto, facts)
                    .zip(s.effort_judge.clone())
                    .map(|(ladder, model)| Arc::new(EffortJudge::new(model, ladder)) as Arc<dyn StepEffortJudge>),
                None => None,
            },
            None => None,
        };
        (step_auto_effort, step_judge)
    }

    /// The gate is built by the factory from the run's observer and token, which exist only after assembly.
    fn gate_builder(
        &self,
        directory: &SessionDirectory,
        input: &AssembleInput<'_>,
        cwd: &Path,
        observer: &super::tool_exclusions::ObserverSlot,
    ) -> GateBuilder {
        let s = &self.services;
        let thread = input.thread;
        let (policy, connectors, resolver) = (s.policy.clone(), s.connectors.clone(), s.resolver.clone());
        let grants = directory.grants(thread);
        let session = Arc::new(SessionGate::new(thread.clone(), directory.live_header(thread), input.surface_rx.clone(), s.gate_env.clone()));
        let (thread, cwd) = (thread.clone(), cwd.to_path_buf());
        let observer = observer.clone();
        let approvals = s.approvals.clone();
        Box::new(move |context: GateContext| {
            let _ = observer.set(context.observer.clone());
            Arc::new(mixdog_agent::env::PolicyGate::new(mixdog_agent::env::PolicyGateParts {
                policy,
                connectors,
                session,
                tools: resolver,
                grants,
                approvals: approvals.gate_for(&thread, context.approvals),
                observer: context.observer,
                guards: context.guards,
                thread_id: thread,
                cwd,
                cancel: context.cancel,
            }))
        })
    }

    /// `nextMainRequest`: the request the thread's next turn would send, assembled by the same parts
    /// and the same wire function as the turn's, without the turn's side effects. `None` for a thread
    /// that has no conversation yet, runs for an agent, or whose provider is not available.
    pub async fn next_request(
        &self,
        thread: &ThreadId,
        header: &Header,
        surface: &mixdog_tools::policy::SessionSurface,
        (prior, generation): (Vec<(mixdog_core_api::ids::ItemId, Value)>, u64),
    ) -> Option<(Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, mixdog_core_api::domain::provider::ModelRequest)> {
        self.rebuild_request(thread, header, surface, (prior, generation), None).await.map(|(provider, request, _)| (provider, request))
    }

    /// [`Self::next_request`] as `nextMainRequest` returns it (`side-question.mjs:64-99`): the tools taken through
    /// `snapshotProviderRequestTools` (the request boundary's [`boundary_tools`]), and `user_message` appended to the
    /// transcript. `None` where `nextMainRequest` is null.
    pub async fn snapshot_request(
        &self,
        thread: &ThreadId,
        header: &Header,
        surface: &mixdog_tools::policy::SessionSurface,
        loaded: (Vec<(mixdog_core_api::ids::ItemId, Value)>, u64),
        user_message: Option<&str>,
    ) -> Option<(Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, mixdog_core_api::domain::provider::ModelRequest)> {
        let (provider, mut request, native) = self.rebuild_request(thread, header, surface, loaded, user_message).await?;
        request.tools = boundary_tools(header, std::mem::take(&mut request.tools), &native);
        Some((provider, request))
    }

    async fn rebuild_request(
        &self,
        thread: &ThreadId,
        header: &Header,
        surface: &mixdog_tools::policy::SessionSurface,
        (prior, generation): (Vec<(mixdog_core_api::ids::ItemId, Value)>, u64),
        user_message: Option<&str>,
    ) -> Option<(Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, mixdog_core_api::domain::provider::ModelRequest, Vec<Value>)> {
        if super::compaction_world::is_agent_owner(header) {
            return None;
        }
        let rows: Vec<Value> = prior.iter().map(|(_, body)| body.clone()).collect();
        if !mixdog_core_session::session::route_session::has_user_conversation(&rows) {
            return None;
        }
        let provider_state = header.get("providerState").and_then(|state| serde_json::from_value(state.clone()).ok());
        let source =
            RequestSource { thread, header, surface, prior: &rows, request: "", injected: false, first_send: None, provider_state, turn: None, generation };
        let provider = self.ready_provider(thread, header).await.ok().flatten()?;
        let parts = self.request_parts(source, provider).await.ok()?;
        let mut messages = rebuilt_messages(header, &rows)?;
        messages.extend(user_message.map(mixdog_agent::message::AgentMessage::user));
        let mut options = parts.options;
        options.iteration = 1;
        let (request, _) = mixdog_agent::assemble_request(
            text(header, "model"),
            options,
            mixdog_agent::project::project_for_wire(&messages),
            None,
            parts.tool_set.definitions(),
        );
        Some((parts.provider, request, super::factory::native_searches(&messages)))
    }

    /// The source of the tail reminder the session's sends carry (`withTailReminder`): what the
    /// turn's own assembly gives the loop, and what a cache warm adds to the request it replays.
    pub fn tail_reminder(&self, header: &Header) -> Arc<dyn mixdog_agent::env::TailReminder> {
        super::tail::session_tail_reminder(self.services.seams.tail_context(header))
    }
}

/// What the explicit skill selector is made of, besides the run's own gate, environment and token.
#[derive(Clone)]
pub struct SkillParts {
    /// The skill names available for a cwd (`SkillCatalog`).
    pub names: Arc<dyn mixdog_mcp::skill_select::SkillNames>,
    /// The session's `Skill` tool.
    pub tool: Arc<dyn Tool>,
    /// What a loaded skill delivers now (`currentSkillDelivery`), for the skill-update notices.
    pub deliveries: Option<Arc<dyn super::mcp_seams::SkillDeliveries>>,
}
/// The services the assembly composes.
pub struct HostServices {
    pub registry: Arc<ProviderRegistry>,
    pub clock: Arc<dyn Clock>,
    pub files: Arc<dyn FileService>,
    pub processes: Arc<dyn ProcessManager>,
    pub io: ToolIo,
    pub policy: Arc<ToolPolicy>,
    pub connectors: Arc<dyn ConnectorPermissions>,
    pub resolver: Arc<dyn ToolResolver>,
    pub gate_env: Arc<dyn GateEnv>,
    /// Where a run's approval asks go (held for its owner, or the session's own card).
    pub approvals: Arc<dyn super::run_approvals::RunApprovals>,
    pub blobs: Arc<dyn BlobReads>,
    /// The process-wide react targets: the same value the react tool (`ports::reactions::SessionReactions`)
    /// records into.
    pub reaction_targets: Arc<ReactionTargets>,
    /// The live runs' result caches, so a workspace change can clear a session's (`clearReadDedupSession`).
    pub reuses: Arc<super::result_reuse::LiveReuses>,
    /// The session directory: each session's live header, grants and thread window. Boot builds it with
    /// `Arc::new_cyclic` since the directory owns the run factory that owns these services.
    pub directory: std::sync::Weak<mixdog_core_session::session::SessionDirectory>,
    /// The shared effort-judge model, present when the install has the ONNX Runtime library; each run's judge is
    /// built over it with the run's ladder.
    pub effort_judge: Option<Arc<EffortJudgeModel>>,
    /// The side-question store the loop's sends record into (the one compaction.requests reads).
    pub side: super::side_requests::SideRequests,
    pub seams: Arc<dyn SessionSeams>,
    /// The sources of the settings the config does not hold.
    pub settings: super::settings::SettingsSources,
    /// Runs the git and shell-tools probes of a composition (one per daemon process).
    pub probes: Arc<super::prewarm::StartupProbes>,
    /// The process-wide probe cache (`prompt::probes`).
    pub observed: Arc<mixdog_core_prompt::prompt::probes::StartupObservations>,
    /// The runtime's shell control, which the progress watchdog's stop reaps a turn's shells
    /// through; `None` reaps nothing.
    pub shells: Option<Arc<mixdog_tools::exec::ShellControl>>,
    /// The tools the provider left out of a session's requests (`recordProviderToolExclusion`).
    pub exclusions: Arc<mixdog_core_session::session::SessionToolExclusions>,
    /// The settings reconcile every turn starts with; bound once the surface host exists.
    pub turn_settings: Arc<super::turn_settings::LateTurnSettings>,
}
pub struct HostRunParts {
    services: HostServices,
}
impl HostRunParts {
    pub fn new(services: HostServices) -> Self {
        Self { services }
    }
}
impl HostRunParts {
    /// Composes a session's prompt under the token of the turn it runs in: the probes it asks for are settled first,
    /// its sources are read on the io-interactive lane and it is assembled on the cpu-interactive lane (see
    /// [super::prewarm::compose]).
    #[allow(
        clippy::result_large_err,
        reason = "Preserve the canonical structured core/provider failure by value without boxing or changing this call contract"
    )]
    pub async fn compose_prompt<R: Send + 'static>(&self, job: super::prewarm::ComposeJob<R>) -> Result<R, TurnError> {
        let seams = &self.services.seams;
        let facts = Arc::new(super::prewarm::PromptFacts::from_process(seams.plugin_root(), seams.data_dir(), seams.stored_instruction_files()));
        let cancel = mixdog_agent::compact::blob_reads::turn_cancel();
        super::prewarm::compose(&self.services.io, &self.services.probes, &self.services.observed, facts, &cancel, job).await.map_err(refuse)
    }
}
#[allow(clippy::result_large_err, reason = "Preserve the canonical structured core/provider failure by value without boxing or changing this call contract")]
fn cwd_of(header: &Header) -> Result<PathBuf, TurnError> {
    let cwd = text(header, "cwd");
    if !cwd.is_empty() {
        return Ok(Path::new(cwd).to_path_buf());
    }
    std::env::current_dir().map_err(|_| refuse("the session has no working directory"))
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured core/provider failure by value without boxing or changing this call contract")]
async fn pin_wire_route(
    directory: &SessionDirectory,
    input: &AssembleInput<'_>,
    header: &Header,
    provider: &dyn mixdog_core_api::domain::provider::ProviderAdapter,
    options: &mut mixdog_core_api::domain::provider::RequestOptions,
) -> Result<(), TurnError> {
    let (thread, provider_id, model) = (input.thread, text(header, "provider"), text(header, "model"));
    let current = header.get("wireRoute");
    let answered = input.prior.iter().any(|row| row.get("role").and_then(Value::as_str) == Some("assistant"));
    let Some(pin) = mixdog_core_run::run_host::hop_host::resolve_pin(provider, current, provider_id, model, current.is_none() && answered).await else {
        return Ok(());
    };
    let live = directory.live_header(thread).header();
    if text(&live, "provider") != provider_id || text(&live, "model") != model {
        return Ok(());
    }
    options.wire_pin = wire_pin_of(Some(&pin));
    let mut set = serde_json::Map::new();
    set.insert("wireRoute".into(), pin);
    input
        .port
        .save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() })
        .await
        .map_err(|_| refuse("the pinned wire route could not be saved"))?;
    Ok(())
}

#[async_trait]
impl RunParts for HostRunParts {
    async fn reconcile_turn(&self, thread: &ThreadId, admitted: Header, conversation: bool) -> Result<Header, TurnError> {
        use super::turn_settings::TurnSettings;
        self.services.turn_settings.reconcile_admitted(thread, conversation, admitted.get("pendingRoute")).await.map_err(refuse)
    }

    async fn refresh_mcp(&self, thread: &ThreadId) -> Result<(), TurnError> {
        use super::turn_settings::TurnSettings;
        self.services.turn_settings.refresh_mcp(thread).await.map_err(refuse)
    }

    async fn current_agents(&self, thread: &ThreadId, header: &Header) -> Result<Option<Vec<super::turn_reminders::AgentEntry>>, TurnError> {
        use super::turn_settings::TurnSettings;
        self.services.turn_settings.current_agents(thread, header).await.map_err(refuse)
    }

    async fn orchestration_instructions(&self, mode: &str) -> Result<String, TurnError> {
        use super::turn_settings::TurnSettings;
        self.services.turn_settings.orchestration_instructions(mode).await.map_err(refuse)
    }

    async fn request_tools(&self, thread: &ThreadId, surface: &mixdog_tools::policy::SessionSurface) -> Result<Option<ToolSet>, TurnError> {
        let directory = self.services.directory.upgrade().ok_or_else(|| refuse("the session directory is closed"))?;
        let header = directory.live_header(thread).header();
        let SessionTools { tools, builtins, agent, .. } = self.services.seams.tools(thread, &header, surface).await.map_err(refuse)?;
        let tool_set = ToolSet::with_builtins(tools, builtins).for_agent(agent);
        Ok(Some(self.surface_tools(tool_set, &header, surface)))
    }

    async fn migrate_exposure(&self, thread: &ThreadId, rows: Vec<Value>) -> Result<Option<Vec<mixdog_agent::message::AgentMessage>>, TurnError> {
        use super::turn_settings::TurnSettings;
        let migrated = self.services.turn_settings.migrate_exposure(thread, &rows).await.map_err(refuse)?;
        Ok(migrated.map(|header| super::factory::system_messages(&header)))
    }

    async fn request_snapshot(
        &self,
        thread: &ThreadId,
        tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
        native: Vec<Value>,
    ) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, TurnError> {
        let directory = self.services.directory.upgrade().ok_or_else(|| refuse("the session directory is closed"))?;
        let header = directory.live_header(thread).header();
        Ok(boundary_tools(&header, tools, &native))
    }

    fn stall_cap_idle_seconds(&self, agent: Option<&str>) -> Option<i64> {
        self.services.seams.stall_cap_idle_seconds(agent)
    }

    fn reap_turn_shells(&self, thread: &ThreadId, since_ms: i64) {
        if let Some(shells) = &self.services.shells {
            shells.reap_since(&mixdog_protocol::ThreadId::from(thread.as_str()), since_ms.max(0) as u64);
        }
    }

    fn reset_turn_shells(&self, thread: &ThreadId) {
        if let Some(shells) = &self.services.shells {
            shells.reset_reaped(&mixdog_protocol::ThreadId::from(thread.as_str()));
        }
    }

    async fn first_response_timeout_ms(&self, agent: &str) -> Option<i64> {
        self.services.seams.first_response_timeout_ms(agent).await
    }

    async fn record_applied_skills(&self, thread: &ThreadId, item: &mixdog_core_api::ids::ItemId, names: &[String]) -> Result<(), TurnError> {
        let directory = self.services.directory.upgrade().ok_or_else(|| refuse("the session directory is closed"))?;
        mixdog_core_session::session::thread_switches::record_applied_skills(&directory, thread, item, names).await.map_err(|error| refuse(error.to_string()))
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let s = &self.services;
        let seams = &s.seams;
        let (thread, header) = (input.thread, input.header);
        let directory = s.directory.upgrade().ok_or_else(|| refuse("the session directory is closed"))?;
        // `ensureCodexWireSessionId` (`ask-turn-open.mjs:85`): a Codex session with no valid stored wire identity (a fork
        // or a cold heir does not carry the source's, `cold-heir.mjs:70`) mints one and stores it before its first request.
        let ensured = ensure_codex_wire_id(&directory, thread, header).await?;
        let header = ensured.as_deref().unwrap_or(header);
        let route = self.route_hop(thread, header, input.turn);
        let live;
        let (header, provider) = match self.ready_provider(thread, header).await? {
            Some(provider) => (header, provider),
            None => {
                let refusal = not_available(text(header, "provider"));
                let Some(route) = &route else { return Err(refusal) };
                let Some(provider) = route.unavailable(&refusal.message).await.map_err(refuse)? else { return Err(refusal) };
                let landed = directory.live_header(thread).header();
                live = ensure_codex_wire_id(&directory, thread, &landed).await?.unwrap_or(landed);
                (&*live, provider)
            }
        };
        let provider_id = text(header, "provider");
        let RequestParts { provider, cwd, tool_set, settings, mut options } = self
            .request_parts(
                RequestSource {
                    thread,
                    header,
                    surface: &input.surface,
                    prior: input.prior,
                    request: input.request,
                    injected: input.injected,
                    first_send: Some(input.cancel),
                    provider_state: input.port.provider_state().await,
                    turn: Some(input.turn.clone()),
                    generation: input.generation,
                },
                provider,
            )
            .await?;
        let agent = header.get("agent").and_then(Value::as_str).filter(|a| !a.is_empty());
        let hidden = seams.hidden_agent(agent) || settings.hidden_agent;
        pin_wire_route(&directory, &input, header, &*provider, &mut options).await?;
        let tool_env = ToolEnv {
            thread_id: thread.clone(),
            turn_id: input.turn.clone(),
            cwd: AbsPath::new(cwd.clone()).ok_or_else(|| refuse("the working directory is not absolute"))?,
            surface: if super::compaction_world::is_agent_owner(header) { SurfaceKind::Agent } else { SurfaceKind::Lead },
            io: s.io,
            approvals: s.approvals.gate_for(thread, Arc::new(input.port.clone())),
            files: s.files.clone(),
            processes: s.processes.clone(),
            progress: input.progress.clone(),
            // `executeToolOwned` runs every call through `runReadOnlyIoWithDeadline` (`tool-exec.mjs:130`).
            deadline_of: Some(mixdog_agent::tools::read_only_io_deadline()),
            notify: input.notify.clone(),
            review: None,
        };
        // `beginTodoTurn(session, { genuine: !turnPromptSource?.source })` over the cycle state the record carries.
        let todo_guards = Arc::new(TodoGuards::new(seams.todo_view(thread, header), hidden).with_saved(header.get("todoCheck")));
        todo_guards.start_turn(!input.injected).await;
        let guards: Arc<dyn TurnGuards> = todo_guards;
        let observer: super::tool_exclusions::ObserverSlot = Arc::default();

        let mut config = RunConfig::new(thread.clone(), input.turn.clone(), text(header, "model"));
        // `send-phase.mjs:117`: the adapters report the tools they leave out of a request here.
        let mut options = options;
        options.on_tool_excluded = Some(super::tool_exclusions::sink(s.exclusions.clone(), thread.clone(), observer.clone(), s.directory.clone()));
        // Each provider attempt of the loop, whatever provider a route hop moved it to, begins a new set;
        // a side question's attempts do not (Node's `send-phase` is the loop's).
        config.request_begin = Some(super::tool_exclusions::request_begin(s.exclusions.clone(), thread.clone(), s.directory.clone()));
        config.options = options;
        // `prepareToolCall` rereads the session's folder for each call: a Project switch the turn makes moves the calls after it.
        config.live_cwd = {
            let live = directory.live_header(thread);
            Some(Arc::new(move || live.header().get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()).and_then(AbsPath::new)))
        };
        config.hidden_agent = hidden;
        config.agent_mode = settings.agent_mode;
        config.limits = settings.limits;
        let compact_settings = settings.compact.clone();
        config.compact = settings.compact;
        config.escalated_max_output_tokens = settings.escalated_max_output_tokens;
        config.read_body_required = settings.read_body_required;
        config.vision = settings.vision;
        config.effort = settings.effort;
        let (step_auto_effort, step_judge) = self.step_judge(thread, header, provider_id, settings.step_auto_effort).await;
        config.step_auto_effort = step_auto_effort;
        config.text_only = settings.text_only;
        config.attachments = settings.attachments;
        config.file_text = settings.file_text;
        // The image choices of this session, read afresh for every request (a choice made after a refusal applies to the next send).
        let (overlay_dir, overlay_thread) = (seams.data_dir(), thread.as_str().to_owned());
        config.image_overlay = Some(Arc::new(move || {
            mixdog_core_session::session::image_overlay_store::load(&overlay_dir, &overlay_thread).map_err(|error| format!("{error:?}"))
        }));
        // `loop-state.mjs`: a compaction between turns parked a one-shot intent; the turn's first send takes it and the record
        // drops it.
        if let Some(intent) = header.get("pendingCacheBreakIntent").and_then(Value::as_str) {
            config.cache_break_intent = Some(intent.to_owned());
            let change = mixdog_store::schema::record::HeaderChange { set: serde_json::Map::new(), unset: vec!["pendingCacheBreakIntent".into()] };
            input.port.save_header(change).await.map_err(|_| refuse("the session's pending cache break could not be taken"))?;
        }

        let gate = self.gate_builder(&directory, &input, &cwd, &observer);
        config.slot = input.slot;
        let session_id = thread.as_str();
        // The reaction facts are read off the stored bodies the run holds, as Node reads `meta`.
        let rows = Arc::new(mixdog_core_session::session::StoredRows::new());
        let artifacts: Arc<dyn mixdog_agent::offload::ArtifactStore> = Arc::new(ToolResultArtifacts::new(s.io, &seams.data_dir(), session_id));
        // No settings, no compaction policy: Node has no compactor for the session.
        let compactor = match compact_settings {
            Some(settings) => {
                seams
                    .compactor(thread, header, input.prior, CompactorInput { settings, rows: rows.clone(), archive: artifacts.clone(), blobs: s.blobs.clone() })
                    .await
            }
            None => None,
        };
        let side = s.side.tap(super::side_requests::RunSide {
            thread: thread.clone(),
            provider_name: provider_id.to_owned(),
            provider: provider.clone(),
            agent_owner: super::compaction_world::is_agent_owner(header),
        });
        Ok(Assembled {
            rows: rows.clone(),
            provider,
            tools: tool_set,
            tool_env,
            gate,
            worktree: cwd.to_string_lossy().into_owned(),
            config,
            clock: s.clock.clone(),
            decider: Arc::new(StandardRetryDecider),
            guards,
            compactor,
            route: route.map(|route| route as Arc<dyn RouteFallback>),
            skills: seams.skill_parts().map(|parts| {
                let selection = input.skill_selection.clone();
                Box::new(move |run: SkillContext| {
                    Arc::new(
                        super::mcp_seams::ExplicitSkillSelector::new(parts.names, parts.tool, run.gate, run.env, run.cancel)
                            .with_selection(selection)
                            .with_deliveries(parts.deliveries),
                    ) as Arc<dyn SkillSelector>
                }) as SkillsBuilder
            }),
            hooks: Some(Arc::new(
                SessionToolHooks::new(session_id, &cwd, seams.post_tool_dispatch(), input.unattended || hidden).worker(super::hooks::worker_agent(header)),
            )),
            // The session's own cache: the one its earlier turns filled (Node's `_bySession`), not one per run.
            reuse: Some(s.reuses.run(s.io, session_id, s.clock.clone())),
            reactions: Some(Arc::new(LoopReactions::new(
                session_id,
                s.reaction_targets.clone(),
                rows,
                mixdog_protocol::text_class::is_internal_transcript_display_text,
            ))),
            reaction_scope: Some(ReactionScope::new(s.reaction_targets.clone(), session_id)),
            tail: Some(self.tail_reminder(header)),
            side: Some(side),
            step_judge,
            artifacts: Some(artifacts),
            images: seams.image_compactor(),
            failures: Some(Arc::new(RunFailureLog::new(
                FailureWriter::for_data_dir(&seams.data_dir(), s.io, s.clock.clone()),
                session_id,
                // `agent: batch.sessionRef?.agent || null` (finalize.mjs:236): the session's own agent, the Lead's "lead" included.
                agent,
                &cwd.to_string_lossy(),
            ))),
            blobs: s.blobs.clone(),
            carry: RunCarry::from_saved(header),
        })
    }
}
