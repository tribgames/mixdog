//! `code_graph` (T §3.7): code structure and relations answered from `mixdog-graph`'s parse.

mod args;
mod dispatch;
mod federation;
mod graph;
mod hits;
mod modes;
mod outline;
mod refs;
mod resolve;
mod roots;
#[cfg(test)]
mod tests;
mod util;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;

const SPEC: &str = include_str!("specs/code_graph.json");

/// A [`ToolSpec`] from an embedded `builtin-tools` entry (shared with `git` and `github`).
pub(crate) fn spec_from(raw: &str, parallel_safe: bool) -> ToolSpec {
    let entry: JsonValue = serde_json::from_str(raw).expect("embedded tool spec is valid JSON");
    let ann = &entry["annotations"];
    let flag = |key: &str| ann.get(key).and_then(JsonValue::as_bool);
    ToolSpec {
        name: entry["name"].as_str().expect("spec name").to_owned(),
        aliases: Vec::new(),
        description: entry["description"].as_str().unwrap_or_default().to_owned(),
        input_schema: entry["schema"].clone(),
        annotations: ToolAnnotations {
            title: ann.get("title").and_then(JsonValue::as_str).map(str::to_owned),
            read_only_hint: flag("readOnlyHint"),
            destructive_hint: flag("destructiveHint"),
            idempotent_hint: flag("idempotentHint"),
            open_world_hint: flag("openWorldHint"),
            compressible: flag("compressible"),
            compressible_lossless: flag("compressibleLossless"),
            agent_hidden: false,
        },
        parallel_safe,
        exclusive_with: Vec::new(),
    }
}

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

pub use federation::TrustedRoots;

pub struct CodeGraphTool {
    spec: ToolSpec,
    trust: Option<std::sync::Arc<dyn TrustedRoots>>,
}

impl CodeGraphTool {
    pub fn new() -> Self {
        Self {
            spec: spec_from(SPEC, true),
            trust: None,
        }
    }

    /// Where federated calls find registered, selected and cached project roots.
    pub fn with_trusted_roots(mut self, trust: std::sync::Arc<dyn TrustedRoots>) -> Self {
        self.trust = Some(trust);
        self
    }
}

impl Default for CodeGraphTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for CodeGraphTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let parsed = args::Args::parse(&args);
        let cwd = ctx.cwd.as_path().to_path_buf();
        // Parsing and indexing a project is CPU and disk bound: keep it off the async workers.
        let trust = self.trust.clone();
        let joined = mixdog_scm::repo::on_lane(ctx.io.maintenance, &ctx.cancel, move || {
            let env = dispatch::Env { trust: trust.as_deref(), session_cwd: &cwd };
            dispatch::run(&parsed, &cwd, &env)
        })
        .await;
        match joined {
            Ok(Ok(answer)) => {
                let mut output = text_output(answer.text);
                let complete = answer.complete;
                output.meta = answer.dependency_roots.map(|roots| {
                    let roots: Vec<String> = roots.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                    serde_json::json!({ DEPENDENCY_ROOTS_META: roots, COMPLETE_META: complete })
                });
                Ok(output)
            }
            Ok(Err(message)) => Err(invalid_args("code_graph", message)),
            Err(mixdog_scm::error::ScmFailure::Cancelled) => {
                Err(ToolError::new(ToolErrorCode::Cancelled, "Error: tool call cancelled"))
            }
            Err(e) => Err(ToolError::new(
                ToolErrorCode::Internal {
                    incident_id: String::new(),
                },
                format!("Error: code_graph failed: {e}"),
            )),
        }
    }
}
