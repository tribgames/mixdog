//! A validated GitHub request as the one `gh` invocation that serves it.

use serde_json::Value;

use crate::error::ScmFailure;
use crate::gh::contract::GithubRequest;
use crate::gh::contract::github_number;
use crate::gh::contract::github_repository;
use crate::gh::contract::github_text;
use crate::gh::contract::is_repo_free;

/// What is run: arguments, the JSON body fed on stdin (data, never a flag or a file name), and
/// how the answer is read.
#[derive(Clone, Debug, PartialEq)]
pub struct GhCommand {
    pub args: Vec<String>,
    pub input: Option<String>,
    pub json: bool,
    pub list: bool,
    pub collection: Option<&'static str>,
    pub page: u64,
    pub limit: u64,
    /// A write: never retried, and a failure says the remote state is unknown.
    pub mutation: bool,
    /// Set for `gh` subcommands; REST calls carry `--hostname` in their arguments.
    pub hostname: Option<String>,
    /// A dependency probe (Node's cli-run.ts un): the scrubbed child environment, none of the gh variables the API client sets.
    pub plain: bool,
}

impl GhCommand {
    pub fn read(args: Vec<String>, hostname: Option<String>) -> Self {
        Self {
            args,
            input: None,
            json: true,
            list: false,
            collection: None,
            page: 1,
            limit: 30,
            mutation: false,
            hostname,
            plain: false,
        }
    }
}

/// A JSON object whose keys keep the order they were given in: the body is what `gh` sends.
#[derive(Default)]
struct Body(Vec<(&'static str, Value)>);

impl Body {
    fn with(mut self, key: &'static str, value: impl Into<Value>) -> Self {
        self.0.push((key, value.into()));
        self
    }

    /// The given fields of the request, in the order named, when present.
    fn selected(mut self, request: &GithubRequest, names: &[&'static str]) -> Self {
        for name in names {
            if let Some(value) = request.fields.get(*name) {
                self.0.push((name, value.clone()));
            }
        }
        self
    }

    fn render(&self) -> String {
        let mut out = String::from("{");
        for (index, (key, value)) in self.0.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&serde_json::to_string(key).expect("a key serializes"));
            out.push(':');
            out.push_str(&serde_json::to_string(value).expect("a value serializes"));
        }
        out.push('}');
        out
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

fn required_text(request: &GithubRequest, key: &str) -> Result<String, ScmFailure> {
    let value = request
        .fields
        .get(key)
        .ok_or_else(|| ScmFailure::invalid(key, "present"))?;
    github_text(value, key, if key == "body" { 60_000 } else { 1000 }, false)?;
    Ok(value.as_str().unwrap_or("").to_owned())
}

fn required_number(request: &GithubRequest, key: &str) -> Result<u64, ScmFailure> {
    github_number(request.fields.get(key).unwrap_or(&Value::Null), key, u64::MAX)
}

pub fn build(request: &GithubRequest) -> Result<GhCommand, ScmFailure> {
    let action = request.action();
    let def = request.def;
    let repo = if is_repo_free(action) {
        request.repo().unwrap_or("").to_owned()
    } else {
        let repo = request.repo().unwrap_or("");
        github_repository(repo)?;
        repo.to_owned()
    };
    let root = format!("repos/{repo}");
    let page = request.number("page").unwrap_or(1);
    let limit = request.number("limit").unwrap_or(30);
    let query = format!("per_page={limit}&page={page}");
    let hostname = request.hostname().to_owned();
    let number = || required_number(request, "number");
    let id = || required_number(request, "id");
    let api = |endpoint: String, method: &str, body: Option<Body>| {
        let mut args = vec![
            "api".to_owned(),
            endpoint,
            "--hostname".to_owned(),
            hostname.clone(),
            "--method".to_owned(),
            method.to_owned(),
        ];
        let input = body.map(|body| {
            args.extend(["--input".to_owned(), "-".to_owned()]);
            body.render()
        });
        GhCommand {
            args,
            input,
            json: true,
            list: def.list,
            collection: def.collection,
            page,
            limit,
            mutation: def.write,
            hostname: None,
            plain: false,
        }
    };
    let cli = |args: Vec<String>| GhCommand {
        args,
        input: None,
        json: false,
        list: false,
        collection: None,
        page,
        limit,
        mutation: def.write,
        hostname: Some(hostname.clone()),
        plain: false,
    };
    let state = request.text("state").unwrap_or("open");
    Ok(match action {
        "repo.list" => match request.text("owner") {
            Some(owner) => api(format!("users/{owner}/repos?{query}&sort=updated"), "GET", None),
            None => api(format!("user/repos?{query}&sort=updated"), "GET", None),
        },
        "repo.view" => api(root, "GET", None),
        "repo.create" => {
            let visibility = request
                .text("visibility")
                .ok_or_else(|| ScmFailure::invalid("visibility", "private or public"))?;
            cli(vec![
                "repo".into(),
                "create".into(),
                repo,
                format!("--{visibility}"),
                "--description".into(),
                request.text("description").unwrap_or("").to_owned(),
            ])
        }
        "repo.clone" => cli(vec![
            "repo".into(),
            "clone".into(),
            repo,
            required_text(request, "destination")?,
        ]),
        "repo.fork" => api(
            format!("{root}/forks"),
            "POST",
            Some(Body::default().selected(request, &["organization"])),
        ),
        "issue.list" => api(format!("{root}/issues?{query}&state={state}"), "GET", None),
        "issue.view" => api(format!("{root}/issues/{}", number()?), "GET", None),
        "issue.comments" => api(format!("{root}/issues/{}/comments?{query}", number()?), "GET", None),
        "issue.create" => api(
            format!("{root}/issues"),
            "POST",
            Some(
                Body::default()
                    .selected(request, &["body", "labels", "assignees"])
                    .with("title", required_text(request, "title")?),
            ),
        ),
        "issue.edit" => {
            let body = Body::default().selected(request, &["title", "body", "labels", "assignees"]);
            if body.is_empty() {
                return Err(ScmFailure::invalid("action", "at least one issue field to edit"));
            }
            api(format!("{root}/issues/{}", number()?), "PATCH", Some(body))
        }
        "issue.close" | "issue.reopen" => api(
            format!("{root}/issues/{}", number()?),
            "PATCH",
            Some(Body::default().with("state", if action == "issue.close" { "closed" } else { "open" })),
        ),
        "issue.comment" | "pr.comment" => api(
            format!("{root}/issues/{}/comments", number()?),
            "POST",
            Some(Body::default().with("body", required_text(request, "body")?)),
        ),
        "pr.list" => api(format!("{root}/pulls?{query}&state={state}"), "GET", None),
        "pr.view" => api(format!("{root}/pulls/{}", number()?), "GET", None),
        "pr.comments" => api(format!("{root}/pulls/{}/comments?{query}", number()?), "GET", None),
        "pr.create" => api(
            format!("{root}/pulls"),
            "POST",
            Some(
                Body::default()
                    .with("title", required_text(request, "title")?)
                    .with("base", required_text(request, "base")?)
                    .with("head", required_text(request, "head")?)
                    .selected(request, &["body", "draft"]),
            ),
        ),
        "pr.checkout" => cli(vec![
            "pr".into(),
            "checkout".into(),
            number()?.to_string(),
            "--repo".into(),
            repo,
        ]),
        "pr.merge" => {
            let sha = request
                .text("sha")
                .ok_or_else(|| ScmFailure::invalid("sha", "the pull request's head sha"))?;
            api(
                format!("{root}/pulls/{}/merge", number()?),
                "PUT",
                Some(
                    Body::default()
                        .with("merge_method", request.text("method").unwrap_or("merge"))
                        .with("sha", sha),
                ),
            )
        }
        "pr.review" => {
            let event = request
                .text("event")
                .ok_or_else(|| ScmFailure::invalid("event", "a review event"))?;
            let sha = request
                .text("sha")
                .ok_or_else(|| ScmFailure::invalid("sha", "the pull request's head sha"))?;
            if event != "APPROVE" {
                required_text(request, "body")?;
            }
            api(
                format!("{root}/pulls/{}/reviews", number()?),
                "POST",
                Some(
                    Body::default()
                        .with("event", event)
                        .with("body", request.text("body").unwrap_or(""))
                        .with("commit_id", sha),
                ),
            )
        }
        "workflow.list" => api(format!("{root}/actions/workflows?{query}"), "GET", None),
        "workflow.run" => {
            let workflow = encode_component(&required_text(request, "workflow")?);
            let inputs = request
                .fields
                .get("inputs")
                .cloned()
                .unwrap_or_else(|| Value::Object(Default::default()));
            api(
                format!("{root}/actions/workflows/{workflow}/dispatches"),
                "POST",
                Some(
                    Body::default()
                        .with("ref", required_text(request, "ref")?)
                        .with("inputs", inputs),
                ),
            )
        }
        "run.list" => match request.text("workflow") {
            Some(_) => api(
                format!(
                    "{root}/actions/workflows/{}/runs?{query}",
                    encode_component(&required_text(request, "workflow")?)
                ),
                "GET",
                None,
            ),
            None => api(format!("{root}/actions/runs?{query}"), "GET", None),
        },
        "run.view" => api(format!("{root}/actions/runs/{}", id()?), "GET", None),
        "run.logs" => cli(vec![
            "run".into(),
            "view".into(),
            id()?.to_string(),
            "--repo".into(),
            repo,
            if request.flag("failed") == Some(true) { "--log-failed" } else { "--log" }.into(),
        ]),
        "run.rerun" => {
            let verb = if request.flag("failed") == Some(true) { "rerun-failed-jobs" } else { "rerun" };
            api(format!("{root}/actions/runs/{}/{verb}", id()?), "POST", None)
        }
        "run.cancel" => api(format!("{root}/actions/runs/{}/cancel", id()?), "POST", None),
        "release.list" => api(format!("{root}/releases?{query}"), "GET", None),
        "release.view" => api(format!("{root}/releases/{}", id()?), "GET", None),
        "release.create" => {
            let mut body = Body::default()
                .with("tag_name", required_text(request, "tag")?)
                .with("name", required_text(request, "title")?)
                .selected(request, &["body", "draft", "prerelease"]);
            if let Some(target) = request.text("target").filter(|target| !target.is_empty()) {
                body = body.with("target_commitish", target);
            }
            api(format!("{root}/releases"), "POST", Some(body))
        }
        "release.edit" => {
            let mut body = Body::default().selected(request, &["body", "draft", "prerelease"]);
            if let Some(title) = request.fields.get("title") {
                body = body.with("name", title.clone());
            }
            if body.is_empty() {
                return Err(ScmFailure::invalid("action", "at least one release field to edit"));
            }
            api(format!("{root}/releases/{}", id()?), "PATCH", Some(body))
        }
        "notification.list" => api(
            format!("notifications?{query}&all={}", request.flag("all") == Some(true)),
            "GET",
            None,
        ),
        "notification.read" => api(format!("notifications/threads/{}", id()?), "PATCH", None),
        _ => return Err(ScmFailure::invalid("action", "a supported GitHub action")),
    })
}

/// `encodeURIComponent`: everything but unreserved characters and `!'()*` is escaped.
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::gh::contract::validate;

    fn command(input: Value) -> GhCommand {
        build(&validate(&input).unwrap()).unwrap()
    }

    #[test]
    fn rest_bodies_keep_their_key_order() {
        let merge = command(json!({"action": "pr.merge", "repo": "o/n", "number": 3, "sha": "a".repeat(40)}));
        assert_eq!(merge.input.as_deref(), Some(format!("{{\"merge_method\":\"merge\",\"sha\":\"{}\"}}", "a".repeat(40)).as_str()));
        assert!(merge.mutation);
        let create = command(json!({"action": "issue.create", "repo": "o/n", "title": "t", "body": "b"}));
        assert_eq!(create.input.as_deref(), Some("{\"body\":\"b\",\"title\":\"t\"}"));
    }

    #[test]
    fn list_reads_carry_their_paging() {
        let list = command(json!({"action": "pr.list", "repo": "o/n", "state": "open", "limit": 5}));
        assert_eq!(list.args[1], "repos/o/n/pulls?per_page=5&page=1&state=open");
        assert!(list.list && !list.mutation && list.input.is_none());
    }

    #[test]
    fn workflow_names_are_percent_encoded() {
        let run = command(json!({"action": "workflow.run", "repo": "o/n", "workflow": "a b.yml", "ref": "main"}));
        assert_eq!(run.args[1], "repos/o/n/actions/workflows/a%20b.yml/dispatches");
    }
}
