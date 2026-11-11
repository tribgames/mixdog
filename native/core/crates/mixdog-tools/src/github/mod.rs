//! `github` (T §3.9): repositories, issues, pull requests, Actions runs, releases and
//! notifications — the agent's tool over the one GitHub client the desktop uses too
//! (`executeGithubTool`, `src/runtime/github/tool.mjs`): the request is served by
//! [`GhClient::execute`], and the model reads its reduced, capped text ([`reduce`]), with the
//! whole response kept as a raw file of the session.

mod reduce;

#[cfg(test)]
mod k1_replay;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::gh::client::GhClient;
use mixdog_scm::gh::contract;

use crate::code_graph::text_output;
use crate::orch::util::spec_from_def;

const SPEC: &str = include_str!("specs/github.json");
const NO_ARCHIVE: &str = "unavailable (no session archive)";

/// `githubRequestMutates`: whether a `github` request may change something; an unknown action counts as a change.
pub fn github_call_mutates(args: &JsonValue) -> bool {
    args.get("action").and_then(JsonValue::as_str).and_then(contract::definition).is_none_or(|def| def.write)
}

pub struct GithubTool {
    spec: ToolSpec,
    client: Arc<GhClient>,
    /// Where a result's raw file is kept (`<data>/tool-results/<session>/`); `None`: no session archive.
    data_dir: Option<PathBuf>,
}

impl GithubTool {
    pub fn new(client: Arc<GhClient>, data_dir: Option<PathBuf>) -> Self {
        Self { spec: spec_from_def(SPEC, false, &[]), client, data_dir }
    }

    /// `executeGithubTool`: the text the model reads for `args`, or the request's failure.
    async fn text(&self, ctx: &ToolContext, args: &JsonValue) -> Result<String, ScmFailure> {
        let result = reduce::parsed(&self.client.execute(args, ctx.cwd.as_path(), &ctx.cancel).await?);
        let action = args.get("action").and_then(JsonValue::as_str).unwrap_or("");
        let original = result.get("data").cloned().unwrap_or(JsonValue::Null);
        let data = reduce::project_list(action, &original)
            .or_else(|| reduce::project_view(action, &original))
            .unwrap_or_else(|| reduce::reduce(&original, None, None));
        let mut reduced = result.as_object().cloned().unwrap_or_default();
        reduced.insert("data".to_owned(), data.clone());
        if reduced.get("hostname").and_then(JsonValue::as_str) == Some(contract::DEFAULT_HOSTNAME) {
            reduced.shift_remove("hostname");
        }
        let text = reduce::stringify_value(&JsonValue::Object(reduced.clone()));
        // Lists point at raw only when a row or excerpt was cut; they are projected by design. Everything else needs raw
        // whenever the reduction dropped data.
        let lossy = if contract::definition(action).is_some_and(|def| def.list) {
            data.as_array().is_some_and(|rows| reduce::rows_were_cut(rows))
        } else {
            reduce::stringify_value(&data) != reduce::stringify_value(&original)
        };
        if !lossy && reduce::fits(&text) {
            return Ok(text);
        }
        let content = match &original {
            JsonValue::String(text) => reduce::plain_text(text),
            other => mixdog_js::json_stringify_indent_parsed(other, 2),
        };
        let raw = self.archive(ctx, &content).await;
        reduced.insert("raw".to_owned(), JsonValue::String(raw.map_or_else(|| NO_ARCHIVE.to_owned(), |path| mixdog_js::json_parsed_text(&path))));
        let with_raw = reduce::stringify_value(&JsonValue::Object(reduced.clone()));
        Ok(if reduce::fits(&with_raw) { with_raw } else { reduce::cap_result(&reduced, args) })
    }

    /// `persistToolResultArtifactSync` on the `github-raw` channel: the shown path of the stored response, `None` without a
    /// session archive (no data directory, session or call) or when it cannot be written.
    async fn archive(&self, ctx: &ToolContext, content: &str) -> Option<String> {
        let data_dir = self.data_dir.as_deref()?;
        if ctx.thread_id.as_str().is_empty() || ctx.call_id.as_str().is_empty() {
            return None;
        }
        crate::exec::archive::persist(ctx.io.maintenance, &ctx.cancel, data_dir, ctx.thread_id.as_str(), "github-raw", content)
            .await
            .map(|stored| stored.path)
    }
}

#[async_trait]
impl Tool for GithubTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        match self.text(ctx, &args).await {
            Ok(text) => Ok(text_output(text)),
            // `executeGithubTool` answers every failure as `Error: <message>`.
            Err(failure) => {
                let text = format!("Error: {failure}");
                Err(ToolError::new(ToolErrorCode::Failed { reason: text.clone() }, text))
            }
        }
    }
}
