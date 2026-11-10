//! The Pull Requests pane over `gh`: the default queries, one PR in detail, create / checkout /
//! merge / diff. gh owns auth; no token ever touches this process.

use std::path::Path;
use std::sync::Arc;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::engine::Scm;
use crate::error::ScmFailure;

const LIST_FIELDS: &str =
    "number,title,author,headRefName,baseRefName,isDraft,state,url,updatedAt,reviewDecision,statusCheckRollup";
const DETAIL_FIELDS: &str = "number,title,author,headRefName,baseRefName,isDraft,state,url,updatedAt,reviewDecision,statusCheckRollup,body,additions,deletions,changedFiles,files,mergeable,mergeStateStatus,createdAt,labels,comments,reviews,reviewRequests";

/// The default PR tree categories; "Local Pull Request Branches" is assembled renderer-side
/// from "All Open".
const CATEGORIES: [(&str, &str, &str, &str); 4] = [
    ("copilot", "Copilot on My Behalf", "is:open author:copilot assignee:@me", "25"),
    ("review-requested", "Waiting For My Review", "is:open review-requested:@me", "25"),
    ("created", "Created By Me", "is:open author:@me", "25"),
    ("all", "All Open", "is:open", "50"),
];

fn text(record: &Value, key: &str) -> String {
    match record.get(key) {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn count(record: &Value, key: &str) -> i64 {
    record.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn summarize_checks(rollup: Option<&Value>) -> Value {
    let (mut total, mut passing, mut failing, mut pending) = (0, 0, 0, 0);
    for item in rollup.and_then(Value::as_array).into_iter().flatten() {
        if !item.is_object() {
            continue;
        }
        let verdict = item
            .get("conclusion")
            .filter(|value| !value.is_null())
            .or_else(|| item.get("state"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_uppercase();
        total += 1;
        if ["SUCCESS", "NEUTRAL", "SKIPPED"].contains(&verdict.as_str()) {
            passing += 1;
        } else if ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE"].contains(&verdict.as_str()) {
            failing += 1;
        } else {
            pending += 1;
        }
    }
    json!({ "total": total, "passing": passing, "failing": failing, "pending": pending })
}

fn to_entry(record: &Value) -> Map<String, Value> {
    let author = record
        .get("author")
        .and_then(|author| author.get("login"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let Value::Object(entry) = json!({
        "number": count(record, "number"),
        "title": text(record, "title"),
        "author": author,
        "headRefName": text(record, "headRefName"),
        "baseRefName": text(record, "baseRefName"),
        "isDraft": record.get("isDraft") == Some(&Value::Bool(true)),
        "state": text(record, "state"),
        "url": text(record, "url"),
        "updatedAt": text(record, "updatedAt"),
        "reviewDecision": text(record, "reviewDecision"),
        "checks": summarize_checks(record.get("statusCheckRollup")),
    }) else {
        unreachable!("an object literal")
    };
    entry
}

/// `requiredPrNumber` (`gh-cli.ts`): `Number(value)` must be an integer from 1 to 10 000 000, so `'12'` is 12.
pub(crate) fn required_number(value: &Value) -> Result<u64, ScmFailure> {
    let number = mixdog_js::try_to_number(value).map_err(|error| ScmFailure::git(error.to_string()))?;
    if number.is_finite() && number.fract() == 0.0 && (1.0..=10_000_000.0).contains(&number) {
        return Ok(number as u64);
    }
    Err(ScmFailure::git("A pull request number is required."))
}

/// The arguments of `gh pr merge` (`ghPrMerge`, gh-cli.ts): the method is `String(method ?? 'merge')`, checked before the number
/// and used as that string, so a list holding one method's name is that method.
pub(crate) fn merge_args(value: &Value, method: &Value) -> Result<Vec<String>, ScmFailure> {
    let chosen = match method {
        Value::Null => "merge".to_owned(),
        other => mixdog_js::try_value_to_string(other).map_err(|error| ScmFailure::git(error.to_string()))?,
    };
    if !["merge", "squash", "rebase"].contains(&chosen.as_str()) {
        return Err(ScmFailure::git("A valid merge method is required."));
    }
    Ok(vec!["pr".into(), "merge".into(), required_number(value)?.to_string(), format!("--{chosen}")])
}

/// `requiredCreateText`: the same words as Node's `TypeError`s.
fn create_text(value: Option<&Value>, name: &str, maximum: usize) -> Result<String, ScmFailure> {
    let Some(Value::String(raw)) = value else {
        return Err(ScmFailure::git(format!("{name} must be a string.")));
    };
    let trimmed = mixdog_js::js_trim(raw);
    if trimmed.is_empty() || trimmed.encode_utf16().count() > maximum {
        return Err(ScmFailure::git(format!("{name} is invalid.")));
    }
    Ok(trimmed.to_owned())
}

/// The arguments of `gh pr create` for a pull request input, which allows no other field.
pub fn create_args(value: &Value) -> Result<Vec<String>, ScmFailure> {
    let input = value
        .as_object()
        .ok_or_else(|| ScmFailure::git("Pull request input is required."))?;
    if input
        .keys()
        .any(|key| !["base", "head", "title", "body", "draft"].contains(&key.as_str()))
    {
        return Err(ScmFailure::git("Pull request input contains an unsupported field."));
    }
    let base = create_text(input.get("base"), "base branch", 512)?;
    let head = create_text(input.get("head"), "head branch", 512)?;
    let title = create_text(input.get("title"), "pull request title", 1024)?;
    let body = match input.get("body") {
        None => String::new(),
        Some(Value::String(body)) => body.clone(),
        Some(_) => return Err(ScmFailure::git("pull request body must be a string.")),
    };
    let draft = match input.get("draft") {
        None => false,
        Some(Value::Bool(draft)) => *draft,
        Some(_) => return Err(ScmFailure::git("pull request draft must be a boolean.")),
    };
    if body.encode_utf16().count() > 100_000 {
        return Err(ScmFailure::git("pull request body is invalid."));
    }
    if base.to_lowercase() == head.to_lowercase() {
        return Err(ScmFailure::git("Base branch must differ from the head branch."));
    }
    let mut args: Vec<String> = ["pr", "create", "--base", &base, "--head", &head, "--title", &title, "--body", &body]
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect();
    if draft {
        args.push("--draft".into());
    }
    Ok(args)
}

fn login_of(value: Option<&Value>) -> String {
    value
        .and_then(|value| value.get("login").or_else(|| value.get("name")))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn timeline(record: &Value) -> Vec<Value> {
    let mut items: Vec<(String, Value)> = Vec::new();
    for comment in record.get("comments").and_then(Value::as_array).into_iter().flatten() {
        let body = text(comment, "body").trim().to_owned();
        if body.is_empty() {
            continue;
        }
        let created = text(comment, "createdAt");
        items.push((
            created.clone(),
            json!({ "kind": "comment", "author": login_of(comment.get("author")), "body": body, "state": "", "createdAt": created }),
        ));
    }
    for review in record.get("reviews").and_then(Value::as_array).into_iter().flatten() {
        let state = text(review, "state");
        let body = text(review, "body").trim().to_owned();
        // Bodiless COMMENTED reviews are inline-thread carriers: noise here.
        if body.is_empty() && state == "COMMENTED" {
            continue;
        }
        let created = match review.get("submittedAt").filter(|v| !v.is_null()) {
            Some(_) => text(review, "submittedAt"),
            None => text(review, "createdAt"),
        };
        items.push((
            created.clone(),
            json!({ "kind": "review", "author": login_of(review.get("author")), "body": body, "state": state, "createdAt": created }),
        ));
    }
    // ISO timestamps order as text.
    items.sort_by(|left, right| left.0.cmp(&right.0));
    items.into_iter().map(|(_, item)| item).collect()
}

fn reviewers(record: &Value) -> Vec<Value> {
    let mut by_login: Vec<(String, String)> = Vec::new();
    let mut set = |login: String, state: String| match by_login.iter_mut().find(|(known, _)| *known == login) {
        Some(row) => row.1 = state,
        None => by_login.push((login, state)),
    };
    for review in record.get("reviews").and_then(Value::as_array).into_iter().flatten() {
        let login = login_of(review.get("author"));
        let state = text(review, "state");
        if !login.is_empty() && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].contains(&state.as_str()) {
            // Later reviews win: APPROVED after CHANGES_REQUESTED supersedes.
            set(login, state);
        }
    }
    for request in record.get("reviewRequests").and_then(Value::as_array).into_iter().flatten() {
        let login = login_of(Some(request));
        if !login.is_empty() {
            set(login, "PENDING".into());
        }
    }
    by_login
        .into_iter()
        .map(|(login, state)| json!({ "login": login, "state": state }))
        .collect()
}

fn parse(raw: &str) -> Result<Value, ScmFailure> {
    serde_json::from_str(raw).map_err(|_| ScmFailure::Command {
        domain: crate::error::GITHUB_DOMAIN,
        text: "GitHub returned an unreadable response.".into(),
    })
}

impl Scm {
    async fn gh_pane(
        &self,
        cwd: &Path,
        cancel: &CancellationToken,
        args: &[&str],
    ) -> Result<String, ScmFailure> {
        let mutation = args.first() == Some(&"pr") && matches!(args.get(1), Some(&"create" | &"checkout" | &"merge"));
        self.github.run_args(cwd, cancel, args, mutation).await
    }

    pub async fn gh_pr_default_branch(&self, cwd: &Path, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let raw = self
            .gh_pane(cwd, cancel, &["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])
            .await?;
        Ok(Value::String(create_text(Some(&Value::String(raw)), "default branch", 512)?))
    }

    pub async fn gh_pr_create(&self, cwd: &Path, cancel: &CancellationToken, value: &Value) -> Result<Value, ScmFailure> {
        let args = create_args(value)?;
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = self.gh_pane(cwd, cancel, &refs).await?;
        let number = output
            .find("/pull/")
            .map(|at| output[at + 6..].chars().take_while(char::is_ascii_digit).collect::<String>())
            .filter(|digits| !digits.is_empty());
        let mut view = vec!["pr", "view"];
        if let Some(number) = &number {
            view.push(number);
        }
        view.extend(["--json", LIST_FIELDS]);
        let record = parse(&self.gh_pane(cwd, cancel, &view).await?)?;
        Ok(Value::Object(to_entry(&record)))
    }

    pub async fn gh_pr_list(&self, cwd: &Path, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let lists = futures::future::join_all(CATEGORIES.iter().map(|(key, label, search, limit)| async move {
            let raw = match self
                .gh_pane(cwd, cancel, &["pr", "list", "--search", search, "--limit", limit, "--json", LIST_FIELDS])
                .await
            {
                Ok(raw) => raw,
                // GitHub Enterprise instances and repositories without Copilot can reject the
                // built-in Copilot query; that optional category reads as empty.
                Err(_) if *key == "copilot" => String::new(),
                Err(error) => return Err(error),
            };
            let parsed = if raw.trim().is_empty() { json!([]) } else { parse(&raw)? };
            let prs: Vec<Value> = parsed
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item.is_object())
                .map(|item| Value::Object(to_entry(item)))
                .collect();
            Ok(json!({ "key": key, "label": label, "prs": prs }))
        }))
        .await;
        Ok(Value::Array(lists.into_iter().collect::<Result<Vec<_>, _>>()?))
    }

    pub async fn gh_pr_view(&self, cwd: &Path, cancel: &CancellationToken, value: &Value) -> Result<Value, ScmFailure> {
        let number = required_number(value)?.to_string();
        let record = parse(&self.gh_pane(cwd, cancel, &["pr", "view", &number, "--json", DETAIL_FIELDS]).await?)?;
        let mut detail = to_entry(&record);
        let files: Vec<Value> = record
            .get("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|file| json!({ "path": text(file, "path"), "additions": count(file, "additions"), "deletions": count(file, "deletions") }))
            .filter(|file| file["path"] != "")
            .collect();
        let labels: Vec<Value> = record
            .get("labels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|label| text(label, "name"))
            .filter(|name| !name.is_empty())
            .map(Value::String)
            .collect();
        for (key, value) in [
            ("body", json!(text(&record, "body"))),
            ("additions", json!(count(&record, "additions"))),
            ("deletions", json!(count(&record, "deletions"))),
            ("changedFiles", json!(count(&record, "changedFiles"))),
            ("files", Value::Array(files)),
            ("mergeable", json!(text(&record, "mergeable"))),
            ("mergeStateStatus", json!(text(&record, "mergeStateStatus"))),
            ("createdAt", json!(text(&record, "createdAt"))),
            ("labels", Value::Array(labels)),
            ("timeline", Value::Array(timeline(&record))),
            ("reviewers", Value::Array(reviewers(&record))),
        ] {
            detail.insert(key.into(), value);
        }
        Ok(Value::Object(detail))
    }

    pub async fn gh_pr_checkout(self: &Arc<Self>, cwd: &Path, cancel: &CancellationToken, value: &Value) -> Result<Value, ScmFailure> {
        let number = required_number(value)?.to_string();
        // A checkout rewrites the work tree: it takes the work tree's write lock.
        let repo = self.open(cwd, cancel).await?;
        let _scope = repo.write_scope().await?;
        Ok(Value::String(self.gh_pane(cwd, cancel, &["pr", "checkout", &number]).await?))
    }

    pub async fn gh_pr_merge(
        &self,
        cwd: &Path,
        cancel: &CancellationToken,
        value: &Value,
        method: &Value,
    ) -> Result<Value, ScmFailure> {
        let args = merge_args(value, method)?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        Ok(Value::String(self.gh_pane(cwd, cancel, &args).await?))
    }

    pub async fn gh_pr_diff(&self, cwd: &Path, cancel: &CancellationToken, value: &Value) -> Result<Value, ScmFailure> {
        let number = required_number(value)?.to_string();
        Ok(Value::String(self.gh_pane(cwd, cancel, &["pr", "diff", &number]).await?))
    }

    /// The pull request of the current branch, or none.
    pub async fn current_pull_request(&self, cwd: &Path, cancel: &CancellationToken) -> Value {
        let fields = "number,title,url,state,baseRefName";
        let Ok(raw) = self.gh_pane(cwd, cancel, &["pr", "view", "--json", fields]).await else {
            return Value::Null;
        };
        let Ok(record) = parse(&raw) else {
            return Value::Null;
        };
        json!({
            "number": count(&record, "number"),
            "title": text(&record, "title"),
            "url": text(&record, "url"),
            "state": text(&record, "state"),
            "baseRefName": text(&record, "baseRefName"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_args_allow_only_the_known_fields() {
        let args = create_args(&json!({"base": "main", "head": "topic", "title": "T", "body": "B", "draft": true})).unwrap();
        assert_eq!(
            args,
            ["pr", "create", "--base", "main", "--head", "topic", "--title", "T", "--body", "B", "--draft"]
        );
        assert!(create_args(&json!({"base": "main", "head": "MAIN", "title": "T"})).is_err());
        assert!(create_args(&json!({"base": "a", "head": "b", "title": "T", "extra": 1})).is_err());
    }

    #[test]
    fn check_rollup_counts_each_verdict_once() {
        let checks = summarize_checks(Some(&json!([
            {"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}, {"state": "PENDING"}, {"conclusion": null, "state": "SUCCESS"}
        ])));
        assert_eq!(checks, json!({"total": 4, "passing": 2, "failing": 1, "pending": 1}));
    }

    #[test]
    fn a_later_review_supersedes_an_earlier_one() {
        let record = json!({"reviews": [
            {"author": {"login": "a"}, "state": "CHANGES_REQUESTED"},
            {"author": {"login": "a"}, "state": "APPROVED"}
        ], "reviewRequests": [{"login": "b"}]});
        assert_eq!(reviewers(&record), vec![json!({"login": "a", "state": "APPROVED"}), json!({"login": "b", "state": "PENDING"})]);
    }
}
