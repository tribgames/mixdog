//! The argument grammar of the source-control calls, as Node's host applied it before it acted on a call
//! (apps/desktop main/remote-methods.ts:396-587 over ipc-validation.ts and git-contract.mjs; the shared copies are
//! shared/scm-input.ts and shared/git-contract.mjs). The phone's page applies the same grammar, but the page runs
//! on the phone: a caller that speaks the protocol without it reaches the core directly, so the core refuses what
//! Node's host refused, with Node's text. Each refusal was a plain `TypeError` there: a message and no code.
//!
//! The request is read raw (the protocol leaves these params `JsonValue`, params.rs): a missing argument is Node's
//! `undefined` and an explicit `null` is `null`, a number goes through `Number(...)`, and the arguments are checked in
//! the order Node's call evaluated them, so the first one that fails is the one whose text answers.

use mixdog_js::js_trim;
use mixdog_js::to_number_of;
use mixdog_js::utf16_len;
use serde_json::Value;
use serde_json::json;

use crate::error::ScmFailure;

fn refused(text: &str) -> ScmFailure {
    ScmFailure::git(text)
}

/// One argument as the request carries it: `None` is a missing one (`undefined`), `Some(Null)` an explicit `null`.
type Arg<'a> = Option<&'a Value>;

/// `requiredString(value, name, maximum)` (ipc-validation.ts:656): a string, trimmed, not empty, at most `maximum` UTF-16 units.
/// The rule is the protocol's, which keys a request by the same value (a sign-in's flow id).
fn required_string<'a>(value: Arg<'a>, name: &str, maximum: usize) -> Result<&'a str, ScmFailure> {
    if !matches!(value, Some(Value::String(_))) {
        return Err(refused(&format!("{name} must be a string.")));
    }
    mixdog_app_protocol::common::required_text(value, maximum).ok_or_else(|| refused(&format!("{name} is invalid.")))
}

/// `value === true`: what Node passed on for a flag (any other value, `null` and a missing one included, is `false`).
fn flag(value: Arg<'_>) -> bool {
    value == Some(&Value::Bool(true))
}

/// `requiredRepositoryCwd` (git-contract.mjs:3): a string, trimmed, not empty and absolute by the platform's rule. The rule is
/// the protocol's, which keys a repository-scoped request by the same value.
pub fn repository_cwd(value: Arg<'_>) -> Result<&str, ScmFailure> {
    mixdog_app_protocol::common::repository_cwd(value).ok_or_else(|| refused("A project directory is required."))
}

/// `path.isAbsolute` on the platform the core runs on.
pub(crate) use mixdog_app_protocol::common::path_is_absolute as is_absolute;

/// `requiredGitPath` (ipc-validation.ts:1942): a path inside the repository, never absolute and never climbing out of it.
fn git_path(value: Arg<'_>) -> Result<&str, ScmFailure> {
    let path = required_string(value, "git path", 4_096)?;
    if is_absolute(path) || path.contains('\0') || path.split(['/', '\\']).any(|part| part == "..") {
        return Err(refused("git path is invalid."));
    }
    Ok(path)
}

/// `requiredGitPaths` (ipc-validation.ts:1915): an array of 1 to 500 paths.
fn git_paths(value: Arg<'_>) -> Result<Vec<Value>, ScmFailure> {
    match value {
        Some(Value::Array(paths)) if (1..=500).contains(&paths.len()) => paths.iter().map(|path| Ok(json!(git_path(Some(path))?))).collect(),
        _ => Err(refused("git paths are invalid.")),
    }
}

/// `requiredGitRequestContextInput` (ipc-validation.ts:1923): an object of up to 500 paths (none is allowed) and an optional
/// base branch, `''` when it is missing or empty (an explicit `null` is a branch that is no string).
fn request_context(value: Arg<'_>) -> Result<Value, ScmFailure> {
    let Some(Value::Object(input)) = value else {
        return Err(refused("git request input is invalid."));
    };
    let paths = match input.get("paths") {
        Some(Value::Array(paths)) if paths.len() <= 500 => paths.iter().map(|path| Ok(json!(git_path(Some(path))?))).collect::<Result<Vec<_>, ScmFailure>>()?,
        _ => return Err(refused("git paths are invalid.")),
    };
    let base = match input.get("base") {
        None => "",
        Some(Value::String(base)) if base.is_empty() => "",
        base => branch_name(base)?,
    };
    Ok(json!({ "paths": paths, "base": base }))
}

/// `requiredReviewDiffFiles` (ipc-validation.ts:1933): an array of up to 512 entries, each an object (an array is one) with a
/// path; each is given back as `{path, untracked}`, as Node's host passed it on.
fn review_files(value: Arg<'_>) -> Result<Value, ScmFailure> {
    let Some(Value::Array(entries)) = value.filter(|value| value.as_array().is_some_and(|entries| entries.len() <= 512)) else {
        return Err(refused("git review files are invalid."));
    };
    let entries = entries
        .iter()
        .map(|entry| {
            if !(entry.is_object() || entry.is_array()) {
                return Err(refused("git review file is invalid."));
            }
            Ok(json!({ "path": git_path(entry.get("path"))?, "untracked": flag(entry.get("untracked")) }))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(entries))
}

/// `requiredGitPatch` (ipc-validation.ts:1957): a string of 1 to 4,000,000 UTF-16 units, no NUL; not trimmed.
fn git_patch(value: Arg<'_>) -> Result<&str, ScmFailure> {
    match value {
        Some(Value::String(patch)) if !patch.is_empty() && utf16_len(patch) <= 4_000_000 && !patch.contains('\0') => Ok(patch),
        _ => Err(refused("git patch is invalid.")),
    }
}

/// `requiredGitDiscardMode` (ipc-validation.ts:1964): missing means `all`.
fn discard_mode(value: Arg<'_>) -> Result<&'static str, ScmFailure> {
    match value.map(Value::as_str) {
        None | Some(Some("all")) => Ok("all"),
        Some(Some("worktree")) => Ok("worktree"),
        Some(_) => Err(refused("git discard mode is invalid.")),
    }
}

/// `requiredGitBranchName` (ipc-validation.ts:1970): never an option (`-…`), no NUL, one line.
fn branch_name(value: Arg<'_>) -> Result<&str, ScmFailure> {
    let branch = required_string(value, "git branch", 512)?;
    if branch.starts_with('-') || branch.contains(['\0', '\r', '\n']) {
        return Err(refused("git branch is invalid."));
    }
    Ok(branch)
}

/// `requiredGitOptionalMessage` (ipc-validation.ts:1978): missing, `null` or empty is no message; else a string of at most
/// 20,000 UTF-16 units, no NUL, trimmed.
fn optional_message(value: Arg<'_>) -> Result<&str, ScmFailure> {
    match value {
        None | Some(Value::Null) => Ok(""),
        Some(Value::String(message)) if utf16_len(message) <= 20_000 && !message.contains('\0') => Ok(js_trim(message)),
        Some(_) => Err(refused("git message is invalid.")),
    }
}

/// `requiredGitLogQuery` (ipc-validation.ts:1986): missing or `null` is no query; else a string of at most 200 UTF-16 units,
/// no NUL, trimmed.
fn log_query(value: Arg<'_>) -> Result<&str, ScmFailure> {
    match value {
        None | Some(Value::Null) => Ok(""),
        Some(Value::String(query)) if utf16_len(query) <= 200 && !query.contains('\0') => Ok(js_trim(query)),
        Some(_) => Err(refused("git history query is invalid.")),
    }
}

/// `Number(value)`, then `Number.isSafeInteger` and the inclusive range (ipc-validation.ts:1994, :2003); missing or `null` is
/// `default`.
fn whole_number(value: Arg<'_>, default: u32, range: std::ops::RangeInclusive<u32>, text: &str) -> Result<u32, ScmFailure> {
    if matches!(value, None | Some(Value::Null)) {
        return Ok(default);
    }
    let number = to_number_of(value);
    // Every integer in range is a safe integer; `-0` is one too, and is 0.
    if number.fract() != 0.0 || !(f64::from(*range.start())..=f64::from(*range.end())).contains(&number) {
        return Err(refused(text));
    }
    Ok(number as u32)
}

/// `requiredCommitHash` (git-contract.mjs:23): 4 to 64 hexadecimal digits, trimmed; anything but a string is no hash.
fn commit_hash(value: Arg<'_>) -> Result<&str, ScmFailure> {
    let hash = match value {
        Some(Value::String(text)) => js_trim(text),
        _ => "",
    };
    if !(4..=64).contains(&hash.len()) || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(refused("A commit hash is required."));
    }
    Ok(hash)
}

/// `requiredGitRevision` (git-contract.mjs:36): `HEAD`, `:0`, or a commit hash with an optional `^`. The answer is built
/// from the checked hash, as Node builds it (the hash is trimmed again before its `^`).
pub fn revision(value: &str) -> Result<String, ScmFailure> {
    let rev = js_trim(value);
    if rev.is_empty() || utf16_len(rev) > 128 {
        return Err(refused("A git revision is required."));
    }
    if rev == "HEAD" || rev == ":0" {
        return Ok(rev.to_owned());
    }
    let hash = |text: &str| commit_hash(Some(&Value::String(text.to_owned()))).map(str::to_owned);
    Ok(match rev.strip_suffix('^') {
        Some(base) => format!("{}^", hash(base)?),
        None => hash(rev)?,
    })
}

/// `requiredGitResetMode` (git-contract.mjs:29).
fn reset_mode(value: Arg<'_>) -> Result<&str, ScmFailure> {
    match value.and_then(Value::as_str) {
        Some(mode @ ("soft" | "mixed" | "hard")) => Ok(mode),
        _ => Err(refused("Git reset mode is invalid.")),
    }
}

/// `requiredGitIgnoreScope` (git-contract.mjs:9): missing means `file`.
fn ignore_scope(value: Arg<'_>) -> Result<&'static str, ScmFailure> {
    match value.map(Value::as_str) {
        None | Some(Some("file")) => Ok("file"),
        Some(Some("extension")) => Ok("extension"),
        Some(_) => Err(refused("Git ignore scope is invalid.")),
    }
}

/// `requiredReviewSource` (git-contract.mjs:16): missing means `branch`.
fn review_source(value: Arg<'_>) -> Result<&'static str, ScmFailure> {
    match value.map(Value::as_str) {
        None | Some(Some("branch")) => Ok("branch"),
        Some(Some("uncommitted")) => Ok("uncommitted"),
        Some(_) => Err(refused("Git review source is invalid.")),
    }
}

/// What Node's host passed on for one call, after its checks: the arguments of the desktop operation it invoked, in order
/// (`gitLog` is `[cwd, query, offset, limit]`). The core acts on exactly these.
#[derive(Debug, PartialEq)]
pub struct NodeArgs {
    /// The desktop operation Node's host invoked (`gitRevertFile` for the phone's `gitRevert`).
    pub operation: &'static str,
    pub args: Vec<Value>,
}

impl NodeArgs {
    pub fn text(&self, index: usize) -> &str {
        self.args[index].as_str().expect("a checked string")
    }

    pub fn flag(&self, index: usize) -> bool {
        self.args[index] == Value::Bool(true)
    }

    pub fn number(&self, index: usize) -> u32 {
        self.args[index].as_u64().and_then(|number| u32::try_from(number).ok()).expect("a checked whole number")
    }

    pub fn dir(&self) -> std::path::PathBuf {
        std::path::PathBuf::from(self.text(0))
    }

    /// The checked string list at `index`.
    pub fn texts(&self, index: usize) -> Vec<String> {
        self.args[index].as_array().expect("a checked list").iter().map(|item| item.as_str().expect("a checked string").to_owned()).collect()
    }
}

/// The checks of Node's host for the phone's call behind a core request, in the order its call evaluated them; `None` for a
/// method no phone call checks. A repository review (`review/diff/get`, `scope: repo`) is `gitReviewDiffs` when it names
/// `files`, `gitReviewDiff` when it names a `path` or asks for the patch, else `gitReview`.
pub fn node_args(method: &str, params: &Value) -> Option<Result<NodeArgs, ScmFailure>> {
    let arg = |key: &str| params.get(key);
    let input = |key: &str| params.get("input").and_then(|input| input.get(key));
    let cwd = || repository_cwd(arg("cwd")).map(|cwd| json!(cwd));
    let call = |operation: &'static str, args: Result<Vec<Value>, ScmFailure>| args.map(|args| NodeArgs { operation, args });
    Some(match method {
        "git/status" => call("gitStatus", (|| Ok(vec![cwd()?, json!({ "reuseLineStats": flag(arg("reuseLineStats")), "skipLineStats": flag(arg("skipLineStats")) })]))()),
        "git/diff" => call("gitDiff", (|| Ok(vec![cwd()?, json!(git_path(arg("path"))?), json!(flag(arg("staged"))), json!(flag(arg("worktreeOnly"))), json!(flag(arg("untracked")))]))()),
        // The direction is checked before everything else (remote-methods.ts:417-419).
        "git/applyPatch" => call("gitApplyPatch", (|| {
            if !matches!(arg("reverse"), None | Some(Value::Bool(_))) {
                return Err(refused("git patch direction is invalid."));
            }
            Ok(vec![cwd()?, json!(git_path(arg("path"))?), json!(git_patch(arg("patch"))?), json!(flag(arg("reverse")))])
        })()),
        "git/stage" => call("gitStage", (|| Ok(vec![cwd()?, Value::Array(git_paths(arg("paths"))?)]))()),
        "git/unstage" => call("gitUnstage", (|| Ok(vec![cwd()?, Value::Array(git_paths(arg("paths"))?)]))()),
        "git/ignore" => call("gitIgnore", (|| Ok(vec![cwd()?, json!(git_path(arg("path"))?), json!(ignore_scope(arg("scope"))?)]))()),
        "git/commit" => call("gitCommit", (|| Ok(vec![cwd()?, json!(required_string(arg("message"), "commit message", 20_000)?)]))()),
        "git/commitPaths" => call("gitCommitPaths", (|| {
            Ok(vec![cwd()?, json!(required_string(input("message"), "commit message", 20_000)?), Value::Array(git_paths(input("paths"))?)])
        })()),
        "git/amend" => call("gitAmend", (|| Ok(vec![cwd()?, json!(optional_message(arg("message"))?)]))()),
        "git/stash" => call("gitStash", (|| Ok(vec![cwd()?, json!(optional_message(arg("message"))?)]))()),
        "git/revertFile" => call("gitRevertFile", (|| {
            Ok(vec![cwd()?, json!(git_path(arg("path"))?), json!(flag(arg("untracked"))), json!(discard_mode(arg("mode"))?)])
        })()),
        "git/stashApply" => call("gitStashApply", (|| Ok(vec![cwd()?, json!(required_string(arg("ref"), "stash ref", 64)?)]))()),
        "git/stashDrop" => call("gitStashDrop", (|| Ok(vec![cwd()?, json!(required_string(arg("ref"), "stash ref", 64)?)]))()),
        "git/renameBranch" => call("gitRenameBranch", (|| Ok(vec![cwd()?, json!(branch_name(input("branch"))?), json!(branch_name(input("nextBranch"))?)]))()),
        "git/deleteBranch" => call("gitDeleteBranch", (|| Ok(vec![cwd()?, json!(branch_name(input("branch"))?)]))()),
        "git/createTag" => call("gitCreateTag", (|| Ok(vec![cwd()?, json!(required_string(arg("value"), "git tag", 512)?), json!(commit_hash(arg("at"))?)]))()),
        "git/deleteTag" => call("gitDeleteTag", (|| Ok(vec![cwd()?, json!(required_string(arg("value"), "git tag", 512)?)]))()),
        "git/log" => call("gitLog", (|| {
            Ok(vec![
                cwd()?,
                json!(log_query(arg("query"))?),
                json!(whole_number(arg("skip"), 0, 0..=1_000_000, "git history offset is invalid.")?),
                json!(whole_number(arg("limit"), 40, 1..=100, "git history limit is invalid.")?),
            ])
        })()),
        "git/show" => call("gitShow", (|| Ok(vec![cwd()?, json!(commit_hash(arg("hash"))?)]))()),
        "git/showDiff" => call("gitShowDiff", (|| Ok(vec![cwd()?, json!(commit_hash(arg("hash"))?), json!(git_path(arg("path"))?)]))()),
        "git/requestContext" => call("gitRequestContext", (|| Ok(vec![cwd()?, request_context(arg("input"))?]))()),
        "git/showFile" => call("gitShowFile", (|| {
            let dir = cwd()?;
            let rev = match arg("rev") {
                Some(Value::String(rev)) => revision(rev)?,
                _ => return Err(refused("A git revision is required.")),
            };
            Ok(vec![dir, json!(rev), json!(git_path(arg("path"))?)])
        })()),
        "git/resetToCommit" => call("gitResetToCommit", (|| {
            Ok(vec![cwd()?, json!(commit_hash(arg("value"))?), json!(reset_mode(arg("mode"))?), json!(flag(arg("confirmedDirty")))])
        })()),
        "git/revertCommit" => call("gitRevertCommit", (|| Ok(vec![cwd()?, json!(commit_hash(arg("value"))?)]))()),
        "git/cherryPickCommit" => call("gitCherryPickCommit", (|| Ok(vec![cwd()?, json!(commit_hash(arg("value"))?)]))()),
        "git/branches" => call("gitBranches", cwd().map(|cwd| vec![cwd])),
        "git/stashList" => call("gitStashList", cwd().map(|cwd| vec![cwd])),
        "git/undoLastCommit" => call("gitUndoLastCommit", cwd().map(|cwd| vec![cwd])),
        "git/push" => call("gitPush", cwd().map(|cwd| vec![cwd])),
        "git/pull" => call("gitPull", cwd().map(|cwd| vec![cwd])),
        "git/fetch" => call("gitFetch", cwd().map(|cwd| vec![cwd])),
        "git/sync" => call("gitSync", cwd().map(|cwd| vec![cwd])),
        "git/stashPop" => call("gitStashPop", cwd().map(|cwd| vec![cwd])),
        "git/continue" => call("gitContinue", cwd().map(|cwd| vec![cwd])),
        "git/abortOperation" => call("gitAbortOperation", cwd().map(|cwd| vec![cwd])),
        // The value is checked before the key (remote-methods.ts:529-532).
        "git/globalConfig/write" => call("setGitGlobalConfig", (|| {
            let value = match arg("value") {
                Some(Value::String(value)) if utf16_len(value) <= 500 => value,
                _ => return Err(refused("value must be a string of at most 500 characters.")),
            };
            let key = match arg("key").and_then(Value::as_str) {
                Some(key @ ("user.name" | "user.email" | "init.defaultBranch")) => key,
                _ => return Err(refused("key must be user.name, user.email, or init.defaultBranch.")),
            };
            Ok(vec![json!(key), json!(value)])
        })()),
        "review/diff/get" if arg("scope") == Some(&json!("repo")) => {
            if params.get("files").is_some() {
                call("gitReviewDiffs", (|| Ok(vec![cwd()?, review_files(arg("files"))?, json!(review_source(arg("source"))?)]))())
            } else if params.get("path").is_some() || flag(arg("patch")) {
                call("gitReviewDiff", (|| {
                    Ok(vec![cwd()?, json!(git_path(arg("path"))?), json!(flag(arg("untracked"))), json!(review_source(arg("source"))?)])
                })())
            } else {
                call("gitReview", (|| Ok(vec![cwd()?, json!(review_source(arg("source"))?)]))())
            }
        }
        // The request is checked here, before the Git & GitHub gate (remote-methods.ts:567-568, then github-service.ts:21-25).
        "github/request" => call("githubRequest", (|| {
            let dir = cwd()?;
            let input = arg("input").cloned().unwrap_or(Value::Null);
            crate::gh::contract::validate(&input)?;
            Ok(vec![dir, input])
        })()),
        "github/pr/list" => call("ghPrList", cwd().map(|cwd| vec![cwd])),
        "github/pr/defaultBranch" => call("ghPrDefaultBranch", cwd().map(|cwd| vec![cwd])),
        "github/pr/create" => call("ghPrCreate", (|| Ok(vec![cwd()?, arg("value").cloned().unwrap_or(Value::Null)]))()),
        "github/pr/view" => call("ghPrView", (|| Ok(vec![cwd()?, arg("value").cloned().unwrap_or(Value::Null)]))()),
        "github/pr/diff" => call("ghPrDiff", (|| Ok(vec![cwd()?, arg("value").cloned().unwrap_or(Value::Null)]))()),
        "github/pr/checkout" => call("ghPrCheckout", (|| Ok(vec![cwd()?, arg("value").cloned().unwrap_or(Value::Null)]))()),
        "github/pr/merge" => call("ghPrMerge", (|| {
            Ok(vec![cwd()?, arg("value").cloned().unwrap_or(Value::Null), arg("method").cloned().unwrap_or(Value::Null)])
        })()),
        "github/login/status" => call("githubCliLoginStatus", required_string(arg("flowId"), "flowId", 200).map(|id| vec![json!(id)])),
        "github/login/cancel" => call("cancelGithubCliLogin", required_string(arg("flowId"), "flowId", 200).map(|id| vec![json!(id)])),
        "github/login/openBrowser" => call("githubCliLoginOpenBrowser", required_string(arg("flowId"), "flowId", 200).map(|id| vec![json!(id)])),
        _ => return None,
    })
}
