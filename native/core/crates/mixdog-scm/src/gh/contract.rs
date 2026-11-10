//! One allowlist for the desktop, the agent's `github` tool and the mutation classifier:
//! which actions exist, which fields each takes, and the validation of every field. Each refusal is the
//! plain `TypeError` text of Node's `validateGithubRequest` (src/runtime/github/contract.mjs:110-193), in its order.

use serde_json::Map;
use serde_json::Value;

use crate::error::ScmFailure;

pub const DEFAULT_HOSTNAME: &str = "github.com";
const MAX_SAFE: u64 = (1 << 53) - 1;

#[derive(Debug)]
pub struct ActionDef {
    pub name: &'static str,
    pub fields: &'static [&'static str],
    pub list: bool,
    pub write: bool,
    /// The key of the list inside the response object (`workflows`, `workflow_runs`).
    pub collection: Option<&'static str>,
    pub required: &'static [&'static str],
}

macro_rules! action {
    ($name:literal, [$($f:literal),*] $(, $k:ident = $v:expr)* $(,)?) => {
        ActionDef { name: $name, fields: &[$($f),*], $($k: $v,)* ..BASE }
    };
}

const BASE: ActionDef = ActionDef { name: "", fields: &[], list: false, write: false, collection: None, required: &[] };

pub static ACTIONS: &[ActionDef] = &[
    action!("repo.list", ["owner", "page", "limit"], list = true),
    action!("repo.view", []),
    action!("repo.create", ["description", "visibility"], write = true, required = &["repo", "visibility"]),
    action!("repo.clone", ["destination"], write = true, required = &["repo", "destination"]),
    action!("repo.fork", ["organization"], write = true, required = &["repo"]),
    action!("issue.list", ["state", "page", "limit"], list = true),
    action!("issue.view", ["number"], required = &["number"]),
    action!("issue.comments", ["number", "page", "limit"], list = true, required = &["number"]),
    action!("issue.create", ["title", "body", "labels", "assignees"], write = true, required = &["title"]),
    action!("issue.edit", ["number", "title", "body", "labels", "assignees"], write = true, required = &["number"]),
    action!("issue.close", ["number"], write = true, required = &["number"]),
    action!("issue.reopen", ["number"], write = true, required = &["number"]),
    action!("issue.comment", ["number", "body"], write = true, required = &["number", "body"]),
    action!("pr.list", ["state", "page", "limit"], list = true),
    action!("pr.view", ["number"], required = &["number"]),
    action!("pr.create", ["title", "body", "base", "head", "draft"], write = true, required = &["title", "base", "head"]),
    action!("pr.checkout", ["number"], write = true, required = &["number"]),
    action!("pr.merge", ["number", "method", "sha"], write = true, required = &["number", "sha"]),
    action!("pr.review", ["number", "event", "body", "sha"], write = true, required = &["number", "sha", "event"]),
    action!("pr.comment", ["number", "body"], write = true, required = &["number", "body"]),
    action!("pr.comments", ["number", "page", "limit"], list = true, required = &["number"]),
    action!("workflow.list", ["page", "limit"], list = true, collection = Some("workflows")),
    action!("workflow.run", ["workflow", "ref", "inputs"], write = true, required = &["workflow", "ref"]),
    action!("run.list", ["workflow", "page", "limit"], list = true, collection = Some("workflow_runs")),
    action!("run.view", ["id"], required = &["id"]),
    action!("run.logs", ["id", "failed"], required = &["id"]),
    action!("run.rerun", ["id", "failed"], write = true, required = &["id"]),
    action!("run.cancel", ["id"], write = true, required = &["id"]),
    action!("release.list", ["page", "limit"], list = true),
    action!("release.view", ["id"], required = &["id"]),
    action!("release.create", ["tag", "title", "body", "target", "draft", "prerelease"], write = true, required = &["tag", "title"]),
    action!("release.edit", ["id", "title", "body", "draft", "prerelease"], write = true, required = &["id"]),
    action!("notification.list", ["page", "limit", "all"], list = true),
    action!("notification.read", ["id"], write = true, required = &["id"]),
];

pub fn definition(action: &str) -> Option<&'static ActionDef> {
    ACTIONS.iter().find(|def| def.name == action)
}

/// Actions addressed at the account rather than one repository: they neither require `repo`
/// nor resolve it from the current project.
pub fn is_repo_free(action: &str) -> bool {
    action == "repo.list" || action.starts_with("notification.")
}

/// A validated request: the allowlisted definition and its checked fields.
#[derive(Clone, Debug)]
pub struct GithubRequest {
    pub def: &'static ActionDef,
    pub fields: Map<String, Value>,
}

impl GithubRequest {
    pub fn action(&self) -> &'static str {
        self.def.name
    }

    pub fn text(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(Value::as_str)
    }

    pub fn number(&self, key: &str) -> Option<u64> {
        self.fields.get(key).and_then(safe_integer)
    }

    pub fn flag(&self, key: &str) -> Option<bool> {
        self.fields.get(key).and_then(Value::as_bool)
    }

    pub fn hostname(&self) -> &str {
        self.text("hostname").unwrap_or(DEFAULT_HOSTNAME)
    }

    pub fn repo(&self) -> Option<&str> {
        self.text("repo")
    }
}

fn type_error(text: impl Into<String>) -> ScmFailure {
    ScmFailure::git(text)
}

/// A JSON number that is a safe integer (`Number.isSafeInteger`): `1.0` is one, `"1"` is not.
fn safe_integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    // A negative integer is a safe integer too; no caller takes one, so it is no answer here (and `-0` is 0).
    (number.fract() == 0.0 && (0.0..=MAX_SAFE as f64).contains(&number)).then_some(number as u64)
}

/// `githubText`.
pub fn github_text(value: &Value, name: &str, maximum: usize, empty: bool) -> Result<(), ScmFailure> {
    let ok = value.as_str().is_some_and(|text| {
        (empty || !mixdog_js::js_trim(text).is_empty())
            && mixdog_js::utf16_len(text) <= maximum
            && !text.contains('\0')
    });
    if ok {
        Ok(())
    } else {
        Err(type_error(format!("{name} must be {} string of at most {maximum} characters.", if empty { "a" } else { "a non-empty" })))
    }
}

/// `githubNumber`: a safe integer from 1 to `maximum` (Node's default maximum is the largest safe integer).
pub fn github_number(value: &Value, name: &str, maximum: u64) -> Result<u64, ScmFailure> {
    let maximum = maximum.min(MAX_SAFE);
    match safe_integer(value) {
        Some(number) if (1..=maximum).contains(&number) => Ok(number),
        _ => Err(type_error(format!("{name} must be a positive integer no greater than {maximum}."))),
    }
}

pub fn github_repository(value: &str) -> Result<(), ScmFailure> {
    let valid = value.len() <= 250 && {
        let mut parts = value.splitn(2, '/');
        let (owner, name) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let owner_ok = owner
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
            && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        let name_ok = name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
        owner_ok && name_ok && owner != "." && owner != ".." && name != "." && name != ".."
    };
    if valid {
        Ok(())
    } else {
        Err(type_error("repo must be an explicit owner/name, not a URL or command."))
    }
}

fn valid_hostname(value: &str) -> bool {
    if value.is_empty() || value.len() > 253 {
        return false;
    }
    let Some((head, tld)) = value.rsplit_once('.') else {
        return false;
    };
    let alnum_edges = head
        .chars()
        .next()
        .zip(head.chars().last())
        .is_some_and(|(a, b)| a.is_ascii_alphanumeric() && b.is_ascii_alphanumeric());
    alnum_edges
        && head.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && tld.len() >= 2
        && tld.chars().all(|c| c.is_ascii_alphabetic())
}

fn is_name(value: &str, first: impl Fn(char) -> bool, rest: impl Fn(char) -> bool, max: usize) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(&first) && chars.all(rest) && value.len() <= max
}

/// Checks `input` against the allowlist; the result carries exactly the fields given.
pub fn validate(input: &Value) -> Result<GithubRequest, ScmFailure> {
    let unsupported = || type_error("A supported GitHub action is required.");
    let object = input.as_object().ok_or_else(unsupported)?;
    // `Object.hasOwn(GITHUB_ACTIONS, input.action ?? '')` and every later `GITHUB_ACTIONS[action]` read the action as a property
    // key, `String(action)`: a list holding one action's name is that action until its first use as a string below.
    let def = object.get("action").map(mixdog_js::value_to_string).as_deref().and_then(definition).ok_or_else(unsupported)?;
    if object.keys().any(|key| !matches!(key.as_str(), "action" | "repo" | "hostname") && !def.fields.contains(&key.as_str())) {
        return Err(type_error(format!("Unsupported field for GitHub {}.", def.name)));
    }
    for key in def.required {
        if matches!(object.get(*key), None | Some(Value::Null)) || object.get(*key).and_then(Value::as_str) == Some("") {
            return Err(type_error(format!("{key} is required for {}.", def.name)));
        }
    }
    if let Some(value) = object.get("destination") {
        github_text(value, "destination", 1000, false)?;
    }
    if let Some(repo) = object.get("repo") {
        // Anything but a string is no repository (an empty name fails the same rule).
        github_repository(repo.as_str().unwrap_or(""))?;
    }
    if let Some(host) = object.get("hostname") {
        if !host.as_str().is_some_and(valid_hostname) {
            return Err(type_error("hostname must be a GitHub or GitHub Enterprise DNS name."));
        }
    }
    for key in ["number", "id", "page", "limit"] {
        if let Some(value) = object.get(key) {
            github_number(value, key, if key == "limit" { 100 } else { MAX_SAFE })?;
        }
    }
    for key in ["draft", "prerelease", "failed", "all"] {
        if object.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err(type_error(format!("{key} must be boolean.")));
        }
    }
    for key in ["body", "description", "title"] {
        if let Some(value) = object.get(key) {
            github_text(value, key, if key == "body" { 60_000 } else { 1000 }, key != "title")?;
        }
    }
    let event = object.get("event").and_then(Value::as_str);
    // `(out.action === 'pr.review' && …) || out.action.endsWith('.comment')`: an action that is no string reaches the call of
    // `endsWith`, which it lacks; V8's TypeError is the text Node's host answered.
    if !object.get("action").is_some_and(Value::is_string) {
        return Err(type_error("out.action.endsWith is not a function"));
    }
    if (def.name == "pr.review" && event != Some("APPROVE")) || def.name.ends_with(".comment") {
        github_text(object.get("body").unwrap_or(&Value::Null), "body", 60_000, false)?;
    }
    for key in ["labels", "assignees"] {
        if let Some(value) = object.get(key) {
            let Some(items) = value.as_array().filter(|items| items.len() <= 50) else {
                return Err(type_error(format!("{key} must be an array with at most 50 entries.")));
            };
            for item in items {
                github_text(item, key, 100, false)?;
            }
        }
    }
    if let Some(state) = object.get("state") {
        if !matches!(state.as_str(), Some("open" | "closed" | "all")) {
            return Err(type_error("Invalid state."));
        }
    }
    if let Some(visibility) = object.get("visibility") {
        if !matches!(visibility.as_str(), Some("private" | "public")) {
            return Err(type_error("Invalid visibility."));
        }
    }
    if let Some(method) = object.get("method") {
        if !matches!(method.as_str(), Some("merge" | "squash" | "rebase")) {
            return Err(type_error("Invalid merge method."));
        }
    }
    if let Some(event) = object.get("event") {
        if !matches!(event.as_str(), Some("COMMENT" | "APPROVE" | "REQUEST_CHANGES")) {
            return Err(type_error("Invalid review event."));
        }
    }
    if let Some(sha) = object.get("sha") {
        // `/^[a-f0-9]{40}$/i.test(sha)` reads the value as a string.
        let sha = mixdog_js::value_to_string(sha);
        if !(sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())) {
            return Err(type_error("sha must be a full commit hash."));
        }
    }
    for key in ["owner", "organization"] {
        if let Some(value) = object.get(key) {
            let ok = value.as_str().is_some_and(|name| {
                is_name(name, |c| c.is_ascii_alphanumeric(), |c| c.is_ascii_alphanumeric() || c == '-', 100)
            });
            if !ok {
                return Err(type_error(format!("Invalid {key}.")));
            }
        }
    }
    for key in ["base", "head", "ref", "tag", "target", "workflow"] {
        if let Some(value) = object.get(key) {
            github_text(value, key, 512, false)?;
            let text = value.as_str().unwrap_or("");
            if text.starts_with('-') || text.contains(['\r', '\n']) {
                return Err(type_error(format!("Invalid {key}.")));
            }
        }
    }
    if let Some(inputs) = object.get("inputs") {
        let Some(map) = inputs.as_object().filter(|map| map.len() <= 25) else {
            return Err(type_error("inputs must contain at most 25 named values."));
        };
        for (key, value) in map {
            let name_ok = is_name(
                key,
                |c| c.is_ascii_alphabetic() || c == '_',
                |c| c.is_ascii_alphanumeric() || c == '_' || c == '-',
                100,
            );
            if !name_ok {
                return Err(type_error("Invalid workflow input name."));
            }
            github_text(value, "workflow input", 10_000, true)?;
        }
    }
    Ok(GithubRequest {
        def,
        fields: object.clone(),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn unknown_actions_and_fields_are_refused() {
        assert!(validate(&json!({"action": "bogus.action"})).is_err());
        assert!(validate(&json!({"action": "pr.list", "repo": "o/n", "nope": 1})).is_err());
        assert!(validate(&json!({"action": "pr.view", "repo": "o/n"})).is_err());
        assert!(validate(&json!({"action": "pr.view", "repo": "o/n", "number": 1})).is_ok());
    }

    #[test]
    fn repositories_must_be_owner_slash_name() {
        assert!(github_repository("owner/name").is_ok());
        assert!(github_repository("https://github.com/o/n").is_err());
        assert!(github_repository("o/..").is_err());
    }

    #[test]
    fn merge_requires_a_full_head_sha() {
        let ok = json!({"action": "pr.merge", "repo": "o/n", "number": 3, "sha": "a".repeat(40)});
        assert!(validate(&ok).is_ok());
        let short = json!({"action": "pr.merge", "repo": "o/n", "number": 3, "sha": "abc"});
        assert!(validate(&short).is_err());
    }
}
