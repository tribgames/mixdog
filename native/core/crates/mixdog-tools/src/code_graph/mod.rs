//! `code_graph` (T §3.7): code structure and relations answered from `mixdog-graph`'s parse.

mod args;
mod dispatch;
mod cache;
mod federation;
mod graph;
mod hits;
mod modes;
#[cfg(test)]
mod node_cases;
mod outline;
mod output;
mod refs;
mod resolve;
mod roots;
#[cfg(test)]
mod routing_tests;
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
    ToolOutput {
        parts: vec![ToolPart::Text(text.into())],
        ..ToolOutput::default()
    }
}

pub(crate) fn invalid_args(field: &str, message: impl Into<String>) -> ToolError {
    let message = message.into();
    ToolError::new(
        ToolErrorCode::InvalidArgs {
            field: field.to_owned(),
            reason: message.clone(),
        },
        message,
    )
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

/// Why a call produced no answer.
enum Failure {
    /// The dispatcher refused the call (Node throws an `Error` with this message).
    Refused(String),
    /// The lane job did not complete.
    Lane(mixdog_scm::error::ScmFailure),
}

pub struct CodeGraphTool {
    spec: ToolSpec,
    trust: std::sync::Arc<dyn TrustedRoots>,
    cache: std::sync::Arc<GraphCache>,
}

impl CodeGraphTool {
    /// `trust` is where federated calls find the registered and selected project roots; `cache`
    /// is the on-disk graph cache, whose manifest also supplies the cached roots.
    pub fn new(trust: std::sync::Arc<dyn TrustedRoots>, cache: std::sync::Arc<GraphCache>) -> Self {
        Self {
            spec: crate::orch::util::spec_from_def(SPEC, true, &[]),
            trust,
            cache,
        }
    }
}

impl CodeGraphTool {
    /// `prewarmCodeGraphIfProject(cwd)`: builds the graph of the project `cwd` belongs to, so the
    /// first `code_graph` call finds its files in the cache instead of parsing them. The root is
    /// the implicit walk (`stopAtUserBoundary`: a home or temp folder is never adopted, so the
    /// whole profile is never warmed in the background). `true` when a project was found and its
    /// build ran; a failed build is only a cold first call, as in Node's best-effort warm.
    pub async fn prewarm_if_project(&self, cwd: &std::path::Path, io: mixdog_rt::MaintenanceIo, cancel: &mixdog_rt::CancellationToken) -> bool {
        let (cwd, cache) = (cwd.to_path_buf(), self.cache.clone());
        let built = mixdog_scm::repo::on_lane(io, cancel, move || {
            let root = roots::find_dir_project_root(&cwd, true)?;
            let _ = graph::Graph::build(&root, &[], &cache);
            Some(root)
        })
        .await;
        self.cache.schedule_flush(io);
        matches!(built, Ok(Some(_)))
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
        let parsed = args::Args::parse(args);
        // Parsing and indexing a project is CPU and disk bound: keep it off the async workers.
        let snapshot = federation::TrustSnapshot::read(&*self.trust).await;
        let cache = self.cache.clone();
        let job_args = parsed.clone();
        let joined = mixdog_scm::repo::on_lane(io, cancel, move || {
            let snapshot = snapshot.with_cached(cache.roots());
            let env = dispatch::Env { trust: &snapshot, cache: &cache, session_cwd: &cwd };
            let answer = dispatch::run(&job_args, &cwd, &env);
            cache.prune_after_call();
            answer
        })
        .await;
        self.cache.schedule_flush(io);
        match joined {
            Ok(Ok(mut answer)) => {
                answer.text = output::wrap(answer.text, &answer.warnings, &parsed);
                Ok(answer)
            }
            Ok(Err(message)) => Err(Failure::Refused(message)),
            Err(failure) => Err(Failure::Lane(failure)),
        }
    }
}

#[async_trait]
impl Tool for CodeGraphTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let cwd = ctx.cwd.as_path().to_path_buf();
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
            Err(Failure::Lane(mixdog_scm::error::ScmFailure::Cancelled)) => {
                Err(ToolError::new(ToolErrorCode::Cancelled, "Error: tool call cancelled"))
            }
            Err(Failure::Lane(e)) => Err(ToolError::new(
                ToolErrorCode::Internal {
                    incident_id: String::new(),
                },
                format!("Error: code_graph failed: {e}"),
            )),
        }
    }
}
