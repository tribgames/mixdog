//! `github` (T §3.9): repositories, issues, pull requests, Actions runs, releases and
//! notifications through the `gh` CLI, spawned by the `ProcessManager` seam.

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::error::scrub_credentials;
use mixdog_scm::exec::Exec;
use mixdog_scm::exec::ExecSpec;

use crate::code_graph::invalid_args;
use crate::code_graph::spec_from;
use crate::code_graph::text_output;

const SPEC: &str = include_str!("specs/github.json");
const RUN_LIMIT: u64 = 32_000_000;

pub struct GithubTool {
    spec: ToolSpec,
}

impl GithubTool {
    pub fn new() -> Self {
        Self {
            spec: spec_from(SPEC, false),
        }
    }
}

impl Default for GithubTool {
    fn default() -> Self {
        Self::new()
    }
}

struct Req<'a>(&'a JsonValue);

impl Req<'_> {
    fn str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(JsonValue::as_str).filter(|s| !s.is_empty())
    }

    fn need(&self, action: &str, key: &str) -> Result<String, String> {
        self.str(key)
            .map(str::to_owned)
            .ok_or_else(|| format!("github {action}: \"{key}\" is required."))
    }

    fn number(&self, action: &str, key: &str) -> Result<String, String> {
        self.0
            .get(key)
            .and_then(JsonValue::as_u64)
            .map(|n| n.to_string())
            .ok_or_else(|| format!("github {action}: \"{key}\" is required."))
    }

    fn flag(&self, key: &str) -> bool {
        self.0.get(key).and_then(JsonValue::as_bool).unwrap_or(false)
    }

    fn list(&self, key: &str) -> Vec<String> {
        self.0
            .get(key)
            .and_then(JsonValue::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    }
}

fn argv<const N: usize>(parts: [&str; N]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_owned()).collect()
}

/// The `gh` argument vector of one action, validated; never a shell string.
fn build(action: &str, args: &JsonValue) -> Result<Vec<String>, String> {
    let r = Req(args);
    let mut v: Vec<String> = Vec::new();
    let (group, verb) = action
        .split_once('.')
        .ok_or_else(|| format!("github: unknown action \"{action}\""))?;
    match (group, verb) {
        ("notification", "list") => v.extend(argv(["api", "notifications"])),
        ("notification", "read") => {
            let id = r.number(action, "id")?;
            v.extend(argv(["api", "-X", "PATCH"]));
            v.push(format!("notifications/threads/{id}"));
            return Ok(v);
        }
        ("repo", "list") => {
            v.extend(argv(["repo", "list"]));
            v.extend(r.str("owner").map(str::to_owned));
        }
        ("repo", "view") => {
            v.extend(argv(["repo", "view"]));
            v.extend(r.str("repo").map(str::to_owned));
        }
        ("repo", "create") => {
            v.extend(argv(["repo", "create"]));
            v.push(r.need(action, "repo")?);
            v.push(format!("--{}", r.str("visibility").unwrap_or("private")));
            if let Some(d) = r.str("description") {
                v.extend(["--description".to_owned(), d.to_owned()]);
            }
        }
        ("repo", "clone") => {
            v.extend(argv(["repo", "clone"]));
            v.push(r.need(action, "repo")?);
            v.extend(r.str("destination").map(str::to_owned));
        }
        ("repo", "fork") => {
            v.extend(argv(["repo", "fork"]));
            v.push(r.need(action, "repo")?);
            v.push("--clone=false".to_owned());
            if let Some(o) = r.str("organization") {
                v.extend(["--org".to_owned(), o.to_owned()]);
            }
        }
        ("issue" | "pr", "list") => {
            v.extend([group.to_owned(), "list".to_owned()]);
            if let Some(s) = r.str("state") {
                v.extend(["--state".to_owned(), s.to_owned()]);
            }
        }
        ("issue" | "pr", "view" | "comments") => {
            v.extend([group.to_owned(), "view".to_owned(), r.number(action, "number")?]);
            if verb == "comments" {
                v.push("--comments".to_owned());
            }
        }
        ("issue" | "pr", "close" | "reopen" | "checkout") => {
            v.extend([group.to_owned(), verb.to_owned(), r.number(action, "number")?]);
        }
        ("issue" | "pr", "comment") => {
            v.extend([group.to_owned(), "comment".to_owned(), r.number(action, "number")?]);
            v.extend(["--body".to_owned(), r.need(action, "body")?]);
        }
        ("issue", "create") | ("pr", "create") => {
            v.extend([group.to_owned(), "create".to_owned()]);
            v.extend(["--title".to_owned(), r.need(action, "title")?]);
            v.extend(["--body".to_owned(), r.str("body").unwrap_or("").to_owned()]);
            for l in r.list("labels") {
                v.extend(["--label".to_owned(), l]);
            }
            for a in r.list("assignees") {
                v.extend(["--assignee".to_owned(), a]);
            }
            if group == "pr" {
                for (key, flag) in [("base", "--base"), ("head", "--head")] {
                    if let Some(x) = r.str(key) {
                        v.extend([flag.to_owned(), x.to_owned()]);
                    }
                }
                if r.flag("draft") {
                    v.push("--draft".to_owned());
                }
            }
        }
        ("issue", "edit") => {
            v.extend(["issue".to_owned(), "edit".to_owned(), r.number(action, "number")?]);
            for (key, flag) in [("title", "--title"), ("body", "--body")] {
                if let Some(x) = r.str(key) {
                    v.extend([flag.to_owned(), x.to_owned()]);
                }
            }
            for l in r.list("labels") {
                v.extend(["--add-label".to_owned(), l]);
            }
            for a in r.list("assignees") {
                v.extend(["--add-assignee".to_owned(), a]);
            }
        }
        ("pr", "merge") => {
            v.extend(["pr".to_owned(), "merge".to_owned(), r.number(action, "number")?]);
            v.push(format!("--{}", r.str("method").unwrap_or("merge")));
            v.extend(["--match-head-commit".to_owned(), r.need(action, "sha")?]);
        }
        ("pr", "review") => {
            v.extend(["pr".to_owned(), "review".to_owned(), r.number(action, "number")?]);
            v.push(
                match r.str("event").unwrap_or("COMMENT") {
                    "APPROVE" => "--approve",
                    "REQUEST_CHANGES" => "--request-changes",
                    _ => "--comment",
                }
                .to_owned(),
            );
            v.extend(["--body".to_owned(), r.str("body").unwrap_or("").to_owned()]);
            if let Some(sha) = r.str("sha") {
                v.extend(["--match-head-commit".to_owned(), sha.to_owned()]);
            }
        }
        ("workflow", "list") => v.extend(argv(["workflow", "list"])),
        ("workflow", "run") => {
            v.extend(["workflow".to_owned(), "run".to_owned(), r.need(action, "workflow")?]);
            if let Some(x) = r.str("ref") {
                v.extend(["--ref".to_owned(), x.to_owned()]);
            }
            if let Some(inputs) = r.0.get("inputs").and_then(JsonValue::as_object) {
                for (k, val) in inputs {
                    let text = val.as_str().map(str::to_owned).unwrap_or_else(|| val.to_string());
                    v.extend(["-f".to_owned(), format!("{k}={text}")]);
                }
            }
        }
        ("run", "list") => {
            v.extend(argv(["run", "list"]));
            if let Some(w) = r.str("workflow") {
                v.extend(["--workflow".to_owned(), w.to_owned()]);
            }
        }
        ("run", "view") => v.extend(["run".to_owned(), "view".to_owned(), r.number(action, "id")?]),
        ("run", "logs") => {
            v.extend(["run".to_owned(), "view".to_owned(), r.number(action, "id")?]);
            v.push(if r.flag("failed") { "--log-failed" } else { "--log" }.to_owned());
        }
        ("run", "rerun") => {
            v.extend(["run".to_owned(), "rerun".to_owned(), r.number(action, "id")?]);
            if r.flag("failed") {
                v.push("--failed".to_owned());
            }
        }
        ("run", "cancel") => v.extend(["run".to_owned(), "cancel".to_owned(), r.number(action, "id")?]),
        ("release", "list") => v.extend(argv(["release", "list"])),
        ("release", "view") => {
            v.extend(argv(["release", "view"]));
            v.push(r.need(action, "tag")?);
        }
        ("release", "create" | "edit") => {
            v.extend(["release".to_owned(), verb.to_owned(), r.need(action, "tag")?]);
            for (key, flag) in [("target", "--target"), ("title", "--title"), ("body", "--notes")] {
                if let Some(x) = r.str(key) {
                    v.extend([flag.to_owned(), x.to_owned()]);
                }
            }
            for (key, flag) in [("draft", "--draft"), ("prerelease", "--prerelease")] {
                if r.flag(key) {
                    v.push(flag.to_owned());
                }
            }
        }
        _ => return Err(format!("github: unknown action \"{action}\"")),
    }
    if let Some(repo) = r.str("repo")
        && !matches!((group, verb), ("repo", _) | ("notification", _))
    {
        v.extend(["--repo".to_owned(), repo.to_owned()]);
    }
    let paged = matches!(verb, "list");
    if paged && group != "workflow" {
        let limit = r.0.get("limit").and_then(JsonValue::as_u64).unwrap_or(30);
        v.extend([
            if group == "notification" { "--paginate" } else { "--limit" }.to_owned(),
        ]);
        if group != "notification" {
            v.push(limit.to_string());
        }
    }
    Ok(v)
}

fn failure(error: ScmFailure) -> ToolError {
    match error {
        ScmFailure::Cancelled => ToolError::new(ToolErrorCode::Cancelled, "Error: tool call cancelled"),
        ScmFailure::Unavailable { .. } => ToolError::new(
            ToolErrorCode::Unavailable {
                capability: "gh".to_owned(),
                reason: "the gh CLI is not installed".to_owned(),
            },
            "Error: github: the gh CLI is not installed or not on PATH",
        ),
        other => ToolError::new(
            ToolErrorCode::Io { os_code: None },
            format!("Error: github: {}", scrub_credentials(&other.to_string())),
        ),
    }
}

#[async_trait]
impl Tool for GithubTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let action = args.get("action").and_then(JsonValue::as_str).unwrap_or("");
        let argv = build(action, &args).map_err(|m| invalid_args("action", format!("Error: {m}")))?;
        let mut spec = ExecSpec::new("gh", ctx.cwd.as_path());
        spec.args = argv;
        spec.max_output = RUN_LIMIT;
        spec.env_set.push(("GH_PROMPT_DISABLED".to_owned(), "1".to_owned()));
        spec.env_set.push(("NO_COLOR".to_owned(), "1".to_owned()));
        if let Some(host) = args.get("hostname").and_then(JsonValue::as_str).filter(|h| !h.is_empty()) {
            spec.env_set.push(("GH_HOST".to_owned(), host.to_owned()));
        }
        let output = Exec::new(ctx.processes.clone())
            .run(spec, &ctx.cancel)
            .await
            .map_err(failure)?;
        let stdout = scrub_credentials(&output.stdout_text());
        if output.success() {
            let text = stdout.trim_end();
            return Ok(text_output(if text.is_empty() { "(no output)" } else { text }));
        }
        let detail = scrub_credentials(&output.stderr_text());
        let detail = if detail.trim().is_empty() { stdout } else { detail };
        Err(ToolError::new(
            ToolErrorCode::Io { os_code: output.code },
            format!("Error: github {action} failed: {}", detail.trim()),
        ))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::build;

    #[test]
    fn builds_gh_argv_per_action() {
        let v = build("pr.merge", &json!({"number": 7, "method": "squash", "sha": "abc", "repo": "o/r"})).unwrap();
        assert_eq!(v, ["pr", "merge", "7", "--squash", "--match-head-commit", "abc", "--repo", "o/r"]);
        let v = build("issue.list", &json!({"state": "open", "limit": 5})).unwrap();
        assert_eq!(v, ["issue", "list", "--state", "open", "--limit", "5"]);
        assert!(build("pr.view", &json!({})).unwrap_err().contains("\"number\" is required"));
        assert!(build("nope", &json!({})).is_err());
    }
}
