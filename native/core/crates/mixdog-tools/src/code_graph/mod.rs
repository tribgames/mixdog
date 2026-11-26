//! `code_graph` (T §3.7): code structure and relations answered from `mixdog-graph`'s parse. The parse, the graphs and their
//! cache live in the code graph helper ([`engine`], `graph-worker`); the core guards a call's arguments, reads the roots it may
//! federate over, asks the helper's host ([`CodeGraphHost`]) and maps the answer to the tool's result.

mod args;
mod cache;
mod dispatch;
pub mod engine;
mod exports;
mod federation;
#[cfg(test)]
mod federation_tests;
mod graph;
mod hits;
mod modes;
mod outline;
mod output;
mod refs;
mod roots;
mod symbols;
#[cfg(any(test, feature = "test-support"))]
pub mod testing;
#[cfg(test)]
mod tests;
mod util;
mod workspace;

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_graph_host::GraphHost;
use mixdog_graph_host::HostError;
use mixdog_graph_host::Start;
use mixdog_graph_host::wire;
use mixdog_protocol::JsonValue;
use mixdog_rt::CancellationToken;

const SPEC: &str = include_str!("specs/code_graph.json");

pub(crate) fn text_output(text: impl Into<String>) -> ToolOutput {
    ToolOutput { parts: vec![ToolPart::Text(text.into())], ..ToolOutput::default() }
}

pub(crate) fn invalid_args(field: &str, message: impl Into<String>) -> ToolError {
    let message = message.into();
    ToolError::new(ToolErrorCode::InvalidArgs { field: field.to_owned(), reason: message.clone() }, message)
}

/// The `ToolOutput::meta` key holding a result's dependency roots.
pub const DEPENDENCY_ROOTS_META: &str = "dependencyRoots";
/// The `ToolOutput::meta` key saying whether the answer is whole (`false`: a federated section
/// failed or the graph hit its file cap), so the cache must not reuse it.
pub const COMPLETE_META: &str = "complete";

/// The absolute paths a `code_graph` result depends on (Node's `outcome.dependencyRoots`), for
/// the tool-result cache to invalidate when a file under, or an ancestor of, one changes.
/// `None` means the call recorded none (a missing-file answer): such a result is not cached,
/// as in Node (`scoped-cache.mjs`: a `code_graph` entry without roots is dropped).
pub fn dependency_roots(output: &ToolOutput) -> Option<Vec<String>> {
    let roots = output.meta.as_ref()?.get(DEPENDENCY_ROOTS_META)?.as_array()?;
    let roots: Vec<String> = roots.iter().filter_map(JsonValue::as_str).map(str::to_owned).collect();
    (!roots.is_empty()).then_some(roots)
}

#[cfg(test)]
use cache::GraphCache;
pub use cache::is_tmp_name;
pub use federation::TrustedRoots;
pub use workspace::WorkspaceCodeGraph;

/// The code graph helper as the tool asks it: the composition's one [`GraphHost`]; in tests, [`testing::InProcessHost`].
#[async_trait]
pub trait CodeGraphHost: Send + Sync {
    /// One call. Cancelling `cancel`, or dropping the future, withdraws it.
    async fn query(&self, query: wire::Query, cancel: &CancellationToken) -> Result<wire::Answer, HostError>;

    /// Builds the graph of the project `prewarm.cwd` belongs to; `start` says whether it may start a helper.
    async fn prewarm(&self, prewarm: wire::Prewarm, start: Start, cancel: &CancellationToken) -> Result<wire::Warmed, HostError>;
}

#[async_trait]
impl CodeGraphHost for GraphHost {
    async fn query(&self, query: wire::Query, cancel: &CancellationToken) -> Result<wire::Answer, HostError> {
        GraphHost::query(self, query, cancel).await
    }

    async fn prewarm(&self, prewarm: wire::Prewarm, start: Start, cancel: &CancellationToken) -> Result<wire::Warmed, HostError> {
        GraphHost::prewarm(self, prewarm, start, cancel).await
    }
}

/// The write notices of the files the session's own tools wrote (`ReadState`'s invalidation signal), in their order: each path
/// resolved now to the identity the helper keys it by ([`engine::change_identities`]), the unknown location for one that has
/// none. What [`GraphHost::changed`] sends.
pub fn changed_files(paths: &[String]) -> wire::Changed {
    let files = engine::change_identities(paths)
        .into_iter()
        .map(|identity| match identity {
            Some(identity) => wire::FileIdentity::Known { identity },
            None => wire::FileIdentity::Unknown,
        })
        .collect();
    wire::Changed { files }
}

/// The modes the schema offers (`CODE_GRAPH_MODES`) and the file modes among them (`CODE_GRAPH_FILE_MODES`); `prewarm` is the
/// hidden one a call may also name.
const SCHEMA_MODES: [&str; 12] =
    ["overview", "imports", "dependents", "related", "impact", "symbols", "find_symbol", "symbol_search", "search", "references", "callers", "callees"];
const FILE_MODES: [&str; 5] = ["overview", "imports", "dependents", "related", "impact"];

pub struct CodeGraphTool {
    spec: ToolSpec,
    trust: Arc<dyn TrustedRoots>,
    host: Arc<dyn CodeGraphHost>,
}

impl CodeGraphTool {
    /// `trust` is where a call finds the registered and selected project roots it may federate over; `host` answers it (the
    /// helper owns the graph cache, whose manifest also supplies the cached roots).
    pub fn new(trust: Arc<dyn TrustedRoots>, host: Arc<dyn CodeGraphHost>) -> Self {
        Self { spec: crate::orch::util::spec_from_def(SPEC, true, &[]), trust, host }
    }
}

/// The calls made so far: a request's number in its trace row.
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(0);

/// One call's trace row (`target: "code_graph"`, `event = "call"`).
struct CallRow<'a> {
    request: u64,
    mode: &'a str,
    outcome: &'static str,
    /// Where the helper spent the call's time; all zero when it answered none.
    timings: wire::Timings,
    total_ms: u64,
}

impl CallRow<'_> {
    /// The durations that are the graph's own.
    fn graph_ms(&self) -> u64 {
        let t = &self.timings;
        t.root_wait_ms + t.inventory_ms + t.verify_ms + t.resolver_check_ms + t.cache_load_ms + t.parse_ms + t.link_ms + t.assemble_ms + t.admission_ms
    }

    /// What the graph work does not account for inside the run: the query itself.
    fn query_ms(&self) -> u64 {
        self.timings.run_ms.saturating_sub(self.graph_ms())
    }

    /// What no stage accounts for: in the core, the wait for the host and the helper's pipes.
    fn other_ms(&self) -> u64 {
        let t = &self.timings;
        self.total_ms.saturating_sub(t.queue_ms + t.run_ms + t.prune_ms + t.wrap_ms)
    }

    fn emit(&self) {
        let t = &self.timings;
        let (query_ms, other_ms) = (self.query_ms(), self.other_ms());
        tracing::info!(
            target: "code_graph",
            event = "call",
            request = self.request,
            mode = self.mode,
            outcome = self.outcome,
            queue_ms = t.queue_ms,
            root_wait_ms = t.root_wait_ms,
            inventory_ms = t.inventory_ms,
            verify_ms = t.verify_ms,
            resolver_check_ms = t.resolver_check_ms,
            cache_load_ms = t.cache_load_ms,
            parse_ms = t.parse_ms,
            link_ms = t.link_ms,
            assemble_ms = t.assemble_ms,
            admission_ms = t.admission_ms,
            query_ms,
            prune_ms = t.prune_ms,
            wrap_ms = t.wrap_ms,
            other_ms,
            total_ms = self.total_ms,
            files_reused = t.files_reused,
            files_parsed = t.files_parsed,
            files_omitted = t.files_omitted,
            files_verified = t.files_verified,
            retained = ?t.retained,
            generation = t.generation,
            "code_graph call"
        );
    }
}

/// `validateBuiltinArgs('code_graph', args)` (`arg-guard.mjs`): the null drops and list normalisation that come first, then
/// `guardCodeGraph`. The arguments the call runs with, or the refusal text Node answers with.
fn guard_args(args: JsonValue) -> Result<JsonValue, String> {
    let JsonValue::Object(mut a) = args else {
        return Err(if args.is_null() {
            "Error: code_graph requires arguments object (got null)".to_owned()
        } else {
            format!("Error: code_graph arguments must be an object (got {})", crate::exec::describe_type(&args))
        });
    };
    a.retain(|_, v| !v.is_null());
    crate::exec::normalize_string_list_args(&mut a);
    let mode = match a.get("mode") {
        None => return Err("Error: code_graph requires \"mode\"".to_owned()),
        Some(JsonValue::String(mode)) => mixdog_js::js_trim(mode).to_owned(),
        Some(other) => {
            return Err(format!("Error: code_graph arg \"mode\" must be a string (got {})", crate::exec::describe_type(other)));
        }
    };
    if mode != "prewarm" && !SCHEMA_MODES.contains(&mode.as_str()) {
        return Err(format!(
            "Error: code_graph arg \"mode\" must be one of {}|prewarm (got {})",
            SCHEMA_MODES.join("|"),
            serde_json::to_string(&a["mode"]).unwrap_or_default()
        ));
    }
    // A `file` list is anchors of `files`, ahead of the ones `files` names (a `files` that is no list gives way to it).
    if let Some(JsonValue::Array(file)) = a.get("file") {
        let files = match a.get("files") {
            Some(JsonValue::Array(files)) => file.iter().chain(files).cloned().collect(),
            _ => file.clone(),
        };
        a.insert("files".to_owned(), JsonValue::Array(files));
        a.shift_remove("file");
    }
    if FILE_MODES.contains(&mode.as_str()) {
        a.shift_remove("symbol");
        a.shift_remove("symbols");
    }
    Ok(JsonValue::Object(a))
}
impl CodeGraphTool {
    /// `prewarmCodeGraphIfProject(cwd)`: the helper builds the graph of the project `cwd` belongs to, so the first call finds its
    /// files cached. The root is the implicit walk (`stopAtUserBoundary`: a home or temp folder is never adopted). `true` when a
    /// project was found and its build ran; a failed build is only a cold first call. `start` is whether the warm may start a
    /// helper ([`Start::IfRunning`]: the background prewarm warms only one that runs).
    pub async fn prewarm_if_project(&self, cwd: &Path, start: Start, cancel: &CancellationToken) -> Result<bool, HostError> {
        let warmed = self.host.prewarm(wire::Prewarm { cwd: cwd.to_path_buf() }, start, cancel).await?;
        Ok(warmed.built)
    }

    /// The hidden `prewarm` mode: a warm the call asks for, so it may start the helper; it runs behind the call's answer.
    fn prewarm(&self, session_cwd: &Path, args: &JsonValue) -> String {
        let parsed = args::Args::parse(args);
        let cwd = match &parsed.cwd {
            Some(cwd) => roots::abs_from(session_cwd, cwd),
            None => session_cwd.to_path_buf(),
        };
        let (host, prewarm) = (self.host.clone(), wire::Prewarm { cwd: cwd.clone() });
        tokio::spawn(async move {
            let _ = host.prewarm(prewarm, Start::Demand, &CancellationToken::new()).await;
        });
        let symbols = parsed.symbol_list();
        let overflow = if symbols.len() > 5 { format!(",+{}", symbols.len() - 5) } else { String::new() };
        let detail = if symbols.is_empty() { String::new() } else { format!(" ({}{overflow})", symbols[..symbols.len().min(5)].join(",")) };
        format!("prewarm scheduled: cwd={} symbols={}{detail}", cwd.to_string_lossy(), symbols.len())
    }

    /// `executeCodeGraphTool(name, args, cwd)`, the one path every surface answers through: the agent tool (`Tool::call`) and the
    /// workspace `project/codeGraph` adapter. The registered projects and the selected directories are read for this call; the
    /// helper answers it with warnings, pagination and the output budget applied.
    async fn answer(&self, cwd: PathBuf, args: &JsonValue, cancel: &CancellationToken) -> Result<wire::Answer, HostError> {
        let request = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed) + 1;
        // End to end: from before the roots are read to the answer.
        let started = Instant::now();
        let mode = args::Args::parse(args).mode;
        let query = wire::Query { session_cwd: cwd, args: args.clone(), registered: self.trust.registered().await, selected: self.trust.selected().await };
        let answered = self.host.query(query, cancel).await;
        let (outcome, timings) = match &answered {
            Ok(answer) => ("ok", answer.timings),
            Err(HostError::Refused(_)) => ("refused", wire::Timings::default()),
            // The helper answered nothing: the whole time is what could not be attributed.
            Err(_) => ("failed", wire::Timings::default()),
        };
        CallRow { request, mode: &mode, outcome, timings, total_ms: cache::elapsed_ms(started) }.emit();
        answered
    }
}
/// The row of a public call that never reached the host (an argument refusal, an accepted `prewarm`): every public return
/// path has exactly one, and all of its time is `other`. The background warm a `prewarm` schedules is not a call and has none.
fn emit_unrun_row(mode: &str, outcome: &'static str, started: Instant) {
    let request = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed) + 1;
    CallRow { request, mode, outcome, timings: wire::Timings::default(), total_ms: cache::elapsed_ms(started) }.emit();
}
#[async_trait]
impl Tool for CodeGraphTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let started = Instant::now();
        let named_mode = args.get("mode").and_then(JsonValue::as_str).unwrap_or_default().to_owned();
        let args = match guard_args(args) {
            Ok(args) => args,
            Err(message) => {
                emit_unrun_row(&named_mode, "refused", started);
                return Err(invalid_args("arguments", message));
            }
        };
        let cwd = ctx.cwd.as_path().to_path_buf();
        if mixdog_js::js_trim(args.get("mode").and_then(JsonValue::as_str).unwrap_or_default()) == "prewarm" {
            let text = self.prewarm(&cwd, &args);
            emit_unrun_row("prewarm", "ok", started);
            return Ok(text_output(text));
        }
        match self.answer(cwd, &args, &ctx.cancel).await {
            Ok(answer) => {
                let mut output = text_output(answer.text);
                let complete = answer.complete;
                output.meta = answer.dependency_roots.map(|roots| {
                    let roots: Vec<String> = roots.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                    serde_json::json!({ DEPENDENCY_ROOTS_META: roots, COMPLETE_META: complete })
                });
                Ok(output)
            }
            Err(HostError::Refused(refusal)) => Err(invalid_args("code_graph", refusal.message)),
            Err(HostError::Cancelled) => Err(ToolError::new(ToolErrorCode::Cancelled, "Error: tool call cancelled")),
            Err(error) => Err(ToolError::new(ToolErrorCode::Internal { incident_id: String::new() }, format!("Error: code_graph failed: {error}"))),
        }
    }
}
