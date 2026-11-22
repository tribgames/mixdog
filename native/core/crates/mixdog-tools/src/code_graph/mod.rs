//! `code_graph` (T §3.7): code structure and relations answered from `mixdog-graph`'s parse.

mod args;
mod cache;
mod dispatch;
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
#[cfg(test)]
mod tests;
mod util;
mod workspace;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;

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

pub use cache::GraphCache;
pub use cache::is_tmp_name;
pub use federation::TrustedRoots;
pub use workspace::WorkspaceCodeGraph;

/// The modes the schema offers (`CODE_GRAPH_MODES`) and the file modes among them (`CODE_GRAPH_FILE_MODES`); `prewarm` is the
/// hidden one a call may also name.
const SCHEMA_MODES: [&str; 12] =
    ["overview", "imports", "dependents", "related", "impact", "symbols", "find_symbol", "symbol_search", "search", "references", "callers", "callees"];
const FILE_MODES: [&str; 5] = ["overview", "imports", "dependents", "related", "impact"];

pub struct CodeGraphTool {
    spec: ToolSpec,
    trust: std::sync::Arc<dyn TrustedRoots>,
    cache: std::sync::Arc<GraphCache>,
    #[cfg(test)]
    output_budget: Option<usize>,
}

impl CodeGraphTool {
    /// `trust` is where federated calls find the registered and selected project roots; `cache`
    /// is the on-disk graph cache, whose manifest also supplies the cached roots.
    pub fn new(trust: std::sync::Arc<dyn TrustedRoots>, cache: std::sync::Arc<GraphCache>) -> Self {
        Self {
            spec: crate::orch::util::spec_from_def(SPEC, true, &[]),
            trust,
            cache,
            #[cfg(test)]
            output_budget: None,
        }
    }
}

/// The calls made so far: a request's number in its trace row.
static NEXT_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// What the lane job measured of one call.
#[derive(Default)]
struct CallStages {
    lane_wait_ms: u64,
    run_ms: u64,
    prune_ms: u64,
    spent: cache::Timings,
}

/// One call's trace row (`target: "code_graph"`, `event = "call"`).
struct CallRow<'a> {
    request: u64,
    mode: &'a str,
    outcome: &'static str,
    stages: CallStages,
    wrap_ms: u64,
    total_ms: u64,
}

impl CallRow<'_> {
    /// What the graph work does not account for inside the run: the query itself.
    fn query_ms(&self) -> u64 {
        self.stages.run_ms.saturating_sub(self.stages.spent.graph_ms())
    }

    /// What no stage accounts for.
    fn other_ms(&self) -> u64 {
        let stages = &self.stages;
        self.total_ms.saturating_sub(stages.lane_wait_ms + stages.run_ms + stages.prune_ms + self.wrap_ms)
    }

    fn emit(&self) {
        let (stages, graph) = (&self.stages, &self.stages.spent);
        let (query_ms, other_ms) = (self.query_ms(), self.other_ms());
        tracing::info!(
            target: "code_graph",
            event = "call",
            request = self.request,
            mode = self.mode,
            outcome = self.outcome,
            lane_wait_ms = stages.lane_wait_ms,
            root_wait_ms = graph.root_wait_ms,
            inventory_ms = graph.inventory_ms,
            verify_ms = graph.verify_ms,
            resolver_check_ms = graph.resolver_check_ms,
            cache_load_ms = graph.cache_load_ms,
            parse_ms = graph.parse_ms,
            link_ms = graph.link_ms,
            assemble_ms = graph.assemble_ms,
            admission_ms = graph.admission_ms,
            query_ms,
            prune_ms = stages.prune_ms,
            wrap_ms = self.wrap_ms,
            other_ms,
            total_ms = self.total_ms,
            files_reused = graph.reused,
            files_parsed = graph.parsed,
            files_omitted = graph.omitted,
            files_verified = graph.verified,
            retained = ?graph.retained,
            generation = graph.generation,
            "code_graph call"
        );
    }
}

/// The build behind [`CodeGraphTool::prewarm_if_project`]: `true` when `cwd` belongs to a project and its build ran.
async fn warm_project(cache: std::sync::Arc<GraphCache>, cwd: std::path::PathBuf, io: mixdog_rt::MaintenanceIo, cancel: &mixdog_rt::CancellationToken) -> bool {
    let built = mixdog_scm::repo::on_lane(io, cancel, {
        let cache = cache.clone();
        move || {
            let root = roots::find_dir_project_root(&cwd, true)?;
            // Fills the shared graph cache, or finds it valid already; builds nothing the cache cannot keep.
            cache.prewarm(&root);
            Some(root)
        }
    })
    .await;
    cache.schedule_flush(io);
    matches!(built, Ok(Some(_)))
}

/// Why a call produced no answer.
enum Failure {
    /// The dispatcher refused the call (Node throws an `Error` with this message).
    Refused(String),
    /// The lane job did not complete.
    Lane(mixdog_scm::error::ScmFailure),
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
    /// `prewarmCodeGraphIfProject(cwd)`: builds the graph of the project `cwd` belongs to, so the first call finds its files cached.
    /// The root is the implicit walk (`stopAtUserBoundary`: a home or temp folder is never adopted). `true` when a project was
    /// found and its build ran; a failed build is only a cold first call.
    pub async fn prewarm_if_project(&self, cwd: &std::path::Path, io: mixdog_rt::MaintenanceIo, cancel: &mixdog_rt::CancellationToken) -> bool {
        warm_project(self.cache.clone(), cwd.to_path_buf(), io, cancel).await
    }

    fn prewarm(&self, session_cwd: &std::path::Path, args: &JsonValue, ctx: &ToolContext) -> String {
        let parsed = args::Args::parse(args);
        let cwd = match &parsed.cwd {
            Some(cwd) => roots::abs_from(session_cwd, cwd),
            None => session_cwd.to_path_buf(),
        };
        let (cache, warm_cwd, io) = (self.cache.clone(), cwd.clone(), ctx.io.maintenance);
        tokio::spawn(async move {
            warm_project(cache, warm_cwd, io, &mixdog_rt::CancellationToken::new()).await;
        });
        let symbols = parsed.symbol_list();
        let overflow = if symbols.len() > 5 { format!(",+{}", symbols.len() - 5) } else { String::new() };
        let detail = if symbols.is_empty() { String::new() } else { format!(" ({}{overflow})", symbols[..symbols.len().min(5)].join(",")) };
        format!("prewarm scheduled: cwd={} symbols={}{detail}", cwd.to_string_lossy(), symbols.len())
    }

    /// `executeCodeGraphTool(name, args, cwd)`, the one path every surface answers through: the
    /// agent tool (`Tool::call`) and the workspace `project/codeGraph` adapter.
    async fn answer(
        &self,
        cwd: std::path::PathBuf,
        args: &JsonValue,
        io: mixdog_rt::MaintenanceIo,
        cancel: &mixdog_rt::CancellationToken,
    ) -> Result<dispatch::Answer, Failure> {
        let request = NEXT_REQUEST.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        // End to end: from before the lane is asked for to after the answer is wrapped.
        let started = std::time::Instant::now();
        let parsed = args::Args::parse(args);
        // Parsing and indexing a project is CPU and disk bound: keep it off the async workers.
        let snapshot = federation::TrustSnapshot::read(&*self.trust).await;
        let cache = self.cache.clone();
        let job_args = parsed.clone();
        let submitted = std::time::Instant::now();
        let joined = mixdog_scm::repo::on_lane(io, cancel, move || {
            let lane_wait_ms = cache::elapsed_ms(submitted);
            let snapshot = snapshot.with_cached(cache.roots());
            let env = dispatch::Env { trust: &snapshot, cache: &cache, session_cwd: &cwd };
            // This lane thread's timings are this call's: none are left from another call that ran on it.
            let _ = cache::take_timings();
            let running = std::time::Instant::now();
            let answer = dispatch::run(&job_args, &cwd, &env);
            let run_ms = cache::elapsed_ms(running);
            let spent = cache::take_timings();
            let pruning = std::time::Instant::now();
            cache.prune_after_call();
            (answer, CallStages { lane_wait_ms, run_ms, prune_ms: cache::elapsed_ms(pruning), spent })
        })
        .await;
        self.cache.schedule_flush(io);
        let mode = parsed.mode.clone();
        match joined {
            Ok((answer, stages)) => {
                let wrapping = std::time::Instant::now();
                let outcome = answer.map(|mut answer| {
                    #[cfg(test)]
                    let budget = self.output_budget.unwrap_or_else(output::max_bytes);
                    #[cfg(not(test))]
                    let budget = output::max_bytes();
                    let (text, uncapped) = output::wrap_with_status(answer.text, &answer.warnings, &parsed, budget);
                    answer.text = text;
                    answer.complete &= uncapped;
                    answer
                });
                let wrap_ms = cache::elapsed_ms(wrapping);
                CallRow {
                    request,
                    mode: &mode,
                    outcome: if outcome.is_ok() { "ok" } else { "refused" },
                    stages,
                    wrap_ms,
                    total_ms: cache::elapsed_ms(started),
                }
                .emit();
                outcome.map_err(Failure::Refused)
            }
            Err(failure) => {
                // The lane never ran the call: the row says so, with the whole time as what could not be attributed.
                CallRow { request, mode: &mode, outcome: "lane_failed", stages: CallStages::default(), wrap_ms: 0, total_ms: cache::elapsed_ms(started) }
                    .emit();
                Err(Failure::Lane(failure))
            }
        }
    }
}
/// The row of a public call that never reached the lane (an argument refusal, an accepted `prewarm`): every public return
/// path has exactly one, and all of its time is `other`. The background warm a `prewarm` schedules is not a call and has none.
fn emit_unrun_row(mode: &str, outcome: &'static str, started: std::time::Instant) {
    let request = NEXT_REQUEST.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    CallRow { request, mode, outcome, stages: CallStages::default(), wrap_ms: 0, total_ms: cache::elapsed_ms(started) }.emit();
}
#[async_trait]
impl Tool for CodeGraphTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let started = std::time::Instant::now();
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
            let text = self.prewarm(&cwd, &args, ctx);
            emit_unrun_row("prewarm", "ok", started);
            return Ok(text_output(text));
        }
        match self.answer(cwd, &args, ctx.io.maintenance, &ctx.cancel).await {
            Ok(answer) => {
                let mut output = text_output(answer.text);
                let complete = answer.complete;
                output.meta = answer.dependency_roots.map(|roots| {
                    let roots: Vec<String> = roots.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                    serde_json::json!({ DEPENDENCY_ROOTS_META: roots, COMPLETE_META: complete })
                });
                Ok(output)
            }
            Err(Failure::Refused(message)) => Err(invalid_args("code_graph", message)),
            Err(Failure::Lane(mixdog_scm::error::ScmFailure::Cancelled)) => Err(ToolError::new(ToolErrorCode::Cancelled, "Error: tool call cancelled")),
            Err(Failure::Lane(e)) => Err(ToolError::new(ToolErrorCode::Internal { incident_id: String::new() }, format!("Error: code_graph failed: {e}"))),
        }
    }
}
