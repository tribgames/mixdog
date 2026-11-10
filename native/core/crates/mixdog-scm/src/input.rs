//! The argument grammar of the source-control calls, as Node's host applied it before it acted on a call
//! (apps/desktop main/remote-methods.ts over ipc-validation.ts and git-contract.mjs; the shared copies are
//! shared/scm-input.ts and shared/git-contract.mjs). The phone's page applies the same grammar, but the page runs
//! on the phone: a caller that speaks the protocol without it reaches the core directly, so the core refuses what
//! Node's host refused, with Node's text. Each refusal was a plain `TypeError` there: a message and no code.

use mixdog_js::js_trim;
use mixdog_js::utf16_len;
use serde_json::Value;

use crate::error::ScmFailure;

fn refused(text: &str) -> ScmFailure {
    ScmFailure::git(text)
}

/// `requiredString(value, name, maximum)`: trimmed, not empty, at most `maximum` UTF-16 units.
fn required_string<'a>(value: &'a str, name: &str, maximum: usize) -> Result<&'a str, ScmFailure> {
    let text = js_trim(value);
    if text.is_empty() || utf16_len(text) > maximum {
        return Err(refused(&format!("{name} is invalid.")));
    }
    Ok(text)
}

/// `path.isAbsolute` on the platform the core runs on (git-contract.mjs `isAbsolutePath`).
fn is_absolute(path: &str) -> bool {
    if cfg!(windows) {
        let bytes = path.as_bytes();
        let separator = |byte: u8| byte == b'/' || byte == b'\\';
        match bytes {
            [first, ..] if separator(*first) => true,
            [letter, b':', third, ..] => letter.is_ascii_alphabetic() && separator(*third),
            _ => false,
        }
    } else {
        path.starts_with('/')
    }
}

/// `requiredGitPath`: a path inside the repository, never absolute and never climbing out of it.
pub fn git_path(value: &str) -> Result<&str, ScmFailure> {
    let path = required_string(value, "git path", 4_096)?;
    if is_absolute(path) || path.contains('\0') || path.split(['/', '\\']).any(|part| part == "..") {
        return Err(refused("git path is invalid."));
    }
    Ok(path)
}

/// `requiredGitPaths`: 1 to 500 paths.
pub fn git_paths(values: &[String]) -> Result<Vec<String>, ScmFailure> {
    if values.is_empty() || values.len() > 500 {
        return Err(refused("git paths are invalid."));
    }
    values.iter().map(|path| git_path(path).map(str::to_owned)).collect()
}

/// `requiredGitRequestContextInput`: up to 500 paths (none is allowed) and an optional base branch.
pub fn request_context(paths: &[String], base: Option<&str>) -> Result<(Vec<String>, String), ScmFailure> {
    if paths.len() > 500 {
        return Err(refused("git paths are invalid."));
    }
    let paths = paths.iter().map(|path| git_path(path).map(str::to_owned)).collect::<Result<_, _>>()?;
    let base = match base {
        None | Some("") => String::new(),
        Some(base) => branch_name(base)?.to_owned(),
    };
    Ok((paths, base))
}

/// `requiredReviewDiffFiles`: up to 512 `{path, untracked}` entries; each entry is given back with its path as Node's host passed it on.
pub fn review_files(values: &[Value]) -> Result<Vec<Value>, ScmFailure> {
    if values.len() > 512 {
        return Err(refused("git review files are invalid."));
    }
    values
        .iter()
        .map(|entry| {
            let Some(object) = entry.as_object() else {
                return Err(refused("git review file is invalid."));
            };
            let Some(path) = object.get("path").and_then(Value::as_str) else {
                return Err(refused("git path must be a string."));
            };
            let untracked = object.get("untracked").and_then(Value::as_bool) == Some(true);
            Ok(serde_json::json!({ "path": git_path(path)?, "untracked": untracked }))
        })
        .collect()
}

/// `requiredGitPatch`: 1 to 4,000,000 UTF-16 units, no NUL; not trimmed.
pub fn git_patch(value: &str) -> Result<&str, ScmFailure> {
    if value.is_empty() || utf16_len(value) > 4_000_000 || value.contains('\0') {
        return Err(refused("git patch is invalid."));
    }
    Ok(value)
}

/// `requiredGitDiscardMode`: absent means `all`.
pub fn discard_mode(value: Option<&str>) -> Result<&'static str, ScmFailure> {
    match value {
        None | Some("all") => Ok("all"),
        Some("worktree") => Ok("worktree"),
        Some(_) => Err(refused("git discard mode is invalid.")),
    }
}

/// `requiredGitBranchName`: never an option (`-…`), no NUL, one line.
pub fn branch_name(value: &str) -> Result<&str, ScmFailure> {
    let branch = required_string(value, "git branch", 512)?;
    if branch.starts_with('-') || branch.contains(['\0', '\r', '\n']) {
        return Err(refused("git branch is invalid."));
    }
    Ok(branch)
}

/// `requiredGitOptionalMessage`: absent or empty is no message; else at most 20,000 UTF-16 units, no NUL, trimmed.
pub fn optional_message(value: Option<&str>) -> Result<&str, ScmFailure> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok("");
    };
    if utf16_len(value) > 20_000 || value.contains('\0') {
        return Err(refused("git message is invalid."));
    }
    Ok(js_trim(value))
}

/// `requiredString(message, 'commit message', 20_000)`.
pub fn commit_message(value: &str) -> Result<&str, ScmFailure> {
    required_string(value, "commit message", 20_000)
}

/// `requiredString(ref, 'stash ref', 64)`.
pub fn stash_ref(value: &str) -> Result<&str, ScmFailure> {
    required_string(value, "stash ref", 64)
}

/// `requiredString(tag, 'git tag', 512)`.
pub fn tag_name(value: &str) -> Result<&str, ScmFailure> {
    required_string(value, "git tag", 512)
}

/// `requiredGitLogQuery`: absent is no query; else at most 200 UTF-16 units, no NUL, trimmed.
pub fn log_query(value: Option<&str>) -> Result<&str, ScmFailure> {
    let Some(value) = value else {
        return Ok("");
    };
    if utf16_len(value) > 200 || value.contains('\0') {
        return Err(refused("git history query is invalid."));
    }
    Ok(js_trim(value))
}

/// `requiredGitLogOffset`: absent is 0; else 0 to 1,000,000.
pub fn log_offset(value: Option<u32>) -> Result<u32, ScmFailure> {
    match value {
        None => Ok(0),
        Some(offset) if offset <= 1_000_000 => Ok(offset),
        Some(_) => Err(refused("git history offset is invalid.")),
    }
}

/// `requiredGitLogLimit`: absent is 40; else 1 to 100.
pub fn log_limit(value: Option<u32>) -> Result<u32, ScmFailure> {
    match value {
        None => Ok(40),
        Some(limit) if (1..=100).contains(&limit) => Ok(limit),
        Some(_) => Err(refused("git history limit is invalid.")),
    }
}

/// `requiredCommitHash` (git-contract.mjs): 4 to 64 hexadecimal digits, trimmed.
pub fn commit_hash(value: &str) -> Result<&str, ScmFailure> {
    let hash = js_trim(value);
    if !(4..=64).contains(&hash.len()) || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(refused("A commit hash is required."));
    }
    Ok(hash)
}

/// `requiredGitRevision`: `HEAD`, `:0`, or a commit hash with an optional `^`.
pub fn revision(value: &str) -> Result<&str, ScmFailure> {
    let rev = js_trim(value);
    if rev.is_empty() || utf16_len(rev) > 128 {
        return Err(refused("A git revision is required."));
    }
    if rev == "HEAD" || rev == ":0" {
        return Ok(rev);
    }
    commit_hash(rev.strip_suffix('^').unwrap_or(rev))?;
    Ok(rev)
}

/// `requiredGitResetMode`.
pub fn reset_mode(value: &str) -> Result<&str, ScmFailure> {
    match value {
        "soft" | "mixed" | "hard" => Ok(value),
        _ => Err(refused("Git reset mode is invalid.")),
    }
}

/// `requiredGitIgnoreScope`: absent means `file`.
pub fn ignore_scope(value: Option<&str>) -> Result<&'static str, ScmFailure> {
    match value {
        None | Some("file") => Ok("file"),
        Some("extension") => Ok("extension"),
        Some(_) => Err(refused("Git ignore scope is invalid.")),
    }
}

/// `requiredReviewSource`: absent means `branch`.
pub fn review_source(value: Option<&str>) -> Result<&'static str, ScmFailure> {
    match value {
        None | Some("branch") => Ok("branch"),
        Some("uncommitted") => Ok("uncommitted"),
        Some(_) => Err(refused("Git review source is invalid.")),
    }
}

/// `setGitGlobalConfig`'s value: any string of at most 500 UTF-16 units (empty unsets the key).
pub fn global_config_value(value: &str) -> Result<&str, ScmFailure> {
    if utf16_len(value) > 500 {
        return Err(refused("value must be a string of at most 500 characters."));
    }
    Ok(value)
}
