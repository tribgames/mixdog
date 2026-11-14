//! `glob`, `find` and `grep` over the file service's walk and text-search
//! streams, which run on the maintenance lane (T §3.3).

use std::collections::BTreeSet;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use globset::Glob;
use globset::GlobBuilder;
use globset::GlobSet;
use globset::GlobSetBuilder;
use nucleo_matcher::Config as FuzzyConfig;
use nucleo_matcher::Matcher as FuzzyMatcher;
use nucleo_matcher::Utf32String;
use nucleo_matcher::pattern::AtomKind;
use nucleo_matcher::pattern::CaseMatching;
use nucleo_matcher::pattern::Normalization;
use nucleo_matcher::pattern::Pattern;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::Descent;
use mixdog_core_api::domain::fs::DirEntry;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FsError;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::SearchClass;
use mixdog_core_api::domain::fs::SearchMatch;
use mixdog_core_api::domain::fs::SearchRequest;
use mixdog_core_api::domain::fs::WalkRequest;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;

use super::common::*;
use crate::orch::util::spec_from_def;
use super::read::ReadTool;
use super::read::in_noise_dir;

const GLOB_SPEC: &str = include_str!("specs/glob.json");
const FIND_SPEC: &str = include_str!("specs/find.json");
const GREP_SPEC: &str = include_str!("specs/grep.json");

const GLOB_DEFAULT_LIMIT: usize = 100;
pub(super) const GLOB_ACCUM_CAP: usize = 50_000;
const FIND_DEFAULT_LIMIT: usize = 25;
const FIND_UNLIMITED_CAP: usize = 1_000;
const GREP_DEFAULT_LIMIT: usize = 250;
/// `GREP_CTX_HEAD_LIMIT_MAX`: the match blocks one content-mode page may hold.
const GREP_CONTEXT_LIMIT_MAX: usize = 40;
/// The content matches one path's scan keeps at most.
const CONTENT_MATCH_CAP: usize = 200_000;
/// `PUBLIC_PATH_BATCH_LIMIT`: the scopes one grep `path` array may name.
const GREP_PATH_BATCH_LIMIT: usize = 10;

// ---------------------------------------------------------------------------
// shared walk helpers

/// Node `rootScanIgnoreGlobs`: a scan rooted at a POSIX filesystem root never enters the
/// kernel-virtual trees mounted there (procfs re-enumerates every pid, `/proc/kcore` reads as a
/// huge file). A scan rooted at or inside one of them, or anywhere else, keeps them.
pub(super) fn root_scan_prunes(root: &AbsPath, posix: bool) -> Vec<AbsPath> {
    if !posix || root.as_path().parent().is_some() {
        return Vec::new();
    }
    ["proc", "sys", "dev"].iter().filter_map(|name| AbsPath::new(root.as_path().join(name))).collect()
}

/// What a walk collected: the kept files, `complete` (false when the deadline passed first) and
/// `capped` (a kept file past the cap existed and was dropped).
pub(super) struct Walked {
    pub entries: Vec<DirEntry>,
    pub complete: bool,
    pub capped: bool,
}

/// Pulls a recursive walk of `root` into a list of at most `cap` kept files.
async fn walk_entries(
    ctx: &ToolContext,
    root: &AbsPath,
    respect_ignore: bool,
    keep: impl Fn(&DirEntry) -> bool,
    cap: Option<usize>,
    server: Option<SearchClass>,
) -> Result<Walked, ToolError> {
    walk_entries_pruned(ctx, root, respect_ignore, keep, root_scan_prunes(root, cfg!(not(windows))), cap, server).await
}

pub(super) async fn walk_entries_pruned(
    ctx: &ToolContext,
    root: &AbsPath,
    respect_ignore: bool,
    keep: impl Fn(&DirEntry) -> bool,
    prune: Vec<AbsPath>,
    cap: Option<usize>,
    server: Option<SearchClass>,
) -> Result<Walked, ToolError> {
    let request = WalkRequest { root: root.clone(), recursive: true, include_hidden: true, respect_ignore, require_git: true, include_dirs: false, prune, descent: Default::default(), server };
    walk_kept(ctx, request, keep, cap).await
}

/// Files and directories under `root` (nothing ignored or hidden skipped; the kernel trees of a
/// filesystem root pruned), at most `cap` kept entries.
pub(super) async fn walk_inventory(
    ctx: &ToolContext,
    root: &AbsPath,
    keep: impl Fn(&DirEntry) -> bool,
    cap: usize,
) -> Result<Walked, ToolError> {
    let prune = root_scan_prunes(root, cfg!(not(windows)));
    let request = WalkRequest { root: root.clone(), recursive: true, include_hidden: true, respect_ignore: false, require_git: true, include_dirs: true, prune, descent: Default::default(), server: None };
    walk_kept(ctx, request, keep, Some(cap)).await
}

/// A deep `list`'s inventory (`tryNativeDeepListRows`): files and directories under `root`, nothing ignored, at most `cap`
/// kept, as one `--files --directories` request to the search server, which is a broad search (`isBroadSearchRequest`: its
/// args hold `--files`) and takes its turn on the broad-search gate within the search's budget. It is refused or ends past
/// its budget as a glob's inventory does (`BROAD_REFUSALS`). The walk itself stops at `descent` (`--max-depth`, the
/// noise folders and, unless hidden, dotted folders listed but not entered), so nothing `keep` would drop is read.
pub(super) async fn broad_listing(ctx: &ToolContext, root: &AbsPath, descent: Descent, keep: impl Fn(&DirEntry) -> bool, cap: usize) -> Result<Walked, ToolError> {
    let request = WalkRequest { root: root.clone(), recursive: true, include_hidden: true, respect_ignore: false, require_git: true, include_dirs: true, prune: Vec::new(), descent, server: Some(SearchClass::Bulk) };
    broad_search(ctx, BROAD_REFUSALS[1], |_| walk_kept(ctx, request, keep, Some(cap))).await
}

async fn walk_kept(
    ctx: &ToolContext,
    request: WalkRequest,
    keep: impl Fn(&DirEntry) -> bool,
    cap: Option<usize>,
) -> Result<Walked, ToolError> {
    let include_dirs = request.include_dirs;
    // A walk the search server runs answers what it found at its soft deadline, before the client's hard timeout would refuse the
    // search (`softDeadlineMs`, native-search-client.mjs): the served partial.
    let soft = request.server.map(|_| SearchDeadlines::of(ctx).soft);
    let mut walk = ctx.files.walk(ctx.io.maintenance, request);
    let mut out = Vec::new();
    let mut capped = false;
    let mut refused = None;
    let timer = async move {
        match soft {
            Some(at) => mixdog_rt::time::sleep_until(at).await,
            None => std::future::pending().await,
        }
    };
    let end = pull_until(ctx, walk.as_mut(), timer, |item| {
        match item {
            Ok(entry) => {
                if (include_dirs || entry.kind != EntryKind::Dir) && keep(&entry) {
                    // Exactly `cap` files is a complete list; the next one is what was cut.
                    if cap.is_some_and(|cap| out.len() >= cap) {
                        capped = true;
                        return false;
                    }
                    out.push(entry);
                }
            }
            Err(FsError { kind, .. }) => refused = refused.take().or_else(|| refusal_reason(&kind)),
        }
        true
    })
    .await;
    let complete = match end {
        PullEnd::Cancelled => return Err(cancelled()),
        PullEnd::Deadline | PullEnd::Timer => false,
        PullEnd::Exhausted => true,
    };
    if let Some(reason) = refused {
        return Err(refusal(reason));
    }
    Ok(Walked { entries: out, complete, capped })
}

/// Node's search server refusing a request its full queue cannot take (serve_search/server.rs:370-383), which its client
/// throws (`NATIVE_SEARCH_ERROR`, native-search-client.mjs:869-871) and the tools answer as their failure: grep's and
/// find's `Error: native search queue saturated` (search-grep-tool.mjs:679), glob's group failure
/// `rg failed for <root>: …` (search-glob-tool.mjs:287-298).
const SATURATED: &str = "native search queue saturated";

/// What Node's client throws for a request whose server it ended, twice, for a search that did not stop within the
/// cancel grace (`_teardown` and `processFailure`, native-search-client.mjs:86-100 and :204-226; the watchdog's error,
/// :501-520), which the tools answer as they answer a full queue (recorded: search-cancel-stalled).
const STALLED_PREFIX: &str = "native search server exited (cancellation grace expired; NATIVE_SEARCH_CANCEL_STALLED: ";

/// The reason a search was refused with, as Node's client words it; `None` for any other failure.
fn refusal_reason(kind: &FsErrorKind) -> Option<String> {
    match kind {
        FsErrorKind::Saturated => Some(SATURATED.to_owned()),
        FsErrorKind::CancelStalled { search, grace_ms } => {
            Some(format!("{STALLED_PREFIX}native {search} search did not stop within {grace_ms}ms after cancellation)"))
        }
        _ => None,
    }
}

/// A refused search as the tools answer it: `Error: <reason>`, a failure.
fn refusal(reason: String) -> ToolError {
    let text = format!("Error: {reason}");
    fail(ToolErrorCode::Failed { reason }, text)
}

/// What Node's client throws for a broad search that waited past its budget for its turn (owner-fair-gate.mjs
/// `waitTimeoutError`) and for one that was admitted and then ran past what the wait left (`timeoutError`,
/// native-search-client.mjs:67-77), as the reasons begin; the tools answer both as they answer a full queue
/// ([`broad_search`]).
const BROAD_REFUSALS: [&str; 4] = [
    "broad search I/O admission wait exceeded ",
    "native file inventory search timed out after ",
    "native fuzzy search timed out after ",
    "native content search timed out after ",
];

/// The reason of a refusal ([`refusal`]).
fn refused_with(error: &ToolError) -> Option<&str> {
    match &error.code {
        ToolErrorCode::Failed { reason }
            if reason == SATURATED || reason.starts_with(STALLED_PREFIX) || BROAD_REFUSALS.iter().any(|p| reason.starts_with(p)) =>
        {
            Some(reason)
        }
        _ => None,
    }
}

/// Include/exclude sets for gitignore-style globs (`!` excludes).
fn compile_globs(patterns: &[String]) -> Result<(GlobSet, GlobSet, bool), ToolError> {
    let (mut inc, mut exc) = (GlobSetBuilder::new(), GlobSetBuilder::new());
    let mut any_include = false;
    for raw in patterns {
        let (neg, body) = match raw.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, raw.as_str()),
        };
        let mut p = body.trim().replace('\\', "/");
        // A leading `/` anchors the glob at the walk root, as rg reads it.
        let anchored = p.starts_with('/');
        p = p.trim_start_matches("./").trim_start_matches('/').to_owned();
        if p.ends_with('/') {
            p.push_str("**");
        }
        if !anchored && !p.contains('/') {
            p = format!("**/{p}");
        }
        let glob: Glob = GlobBuilder::new(&p)
            .literal_separator(true)
            .build()
            .map_err(|e| invalid("pattern", "glob", format!("Error: invalid glob {raw:?}: {e}")))?;
        if neg {
            exc.add(glob);
        } else {
            inc.add(glob);
            any_include = true;
        }
    }
    let build = |b: GlobSetBuilder| {
        b.build()
            .map_err(|e| invalid("pattern", "glob", format!("Error: invalid glob set: {e}")))
    };
    Ok((build(inc)?, build(exc)?, any_include))
}

/// The mtime in ms (0 when the file service has none); `None` when the stat failed.
async fn mtime_millis(ctx: &ToolContext, path: &AbsPath) -> Option<u128> {
    let stat = ctx.files.stat(ctx.io.interactive, path.clone()).await.ok()?;
    Some(stat.modified.and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis()))
}

/// Node's `searchIoAdmission` (`tool-workload-gates.mjs`, `search-admission.mjs`): one broad search (a `--files` walk, a fuzzy
/// find, a bulk grep) runs at a time in the process; the others wait their turn behind it, session by session
/// (`createOwnerFairGate`: the turn goes round the sessions that wait, not to the oldest waiter).
static BROAD_SEARCH: std::sync::LazyLock<mixdog_rt::OwnerGate> = std::sync::LazyLock::new(mixdog_rt::OwnerGate::new);

/// The gate's owner key of a call. Node's is the session id of the loop that ran the tool (`executeTool`'s
/// `callerSessionId`, `runWithToolExecutionOwner`, tool-execution-owner.mjs), which is the thread id here: a sub-agent's
/// run has its own session and so its own thread, never its parent's; the core keys a session by its thread id, so a
/// session's threads are the owners its sessions are in Node. A call with no session is `anonymous`, and the key is trimmed and cut at 240
/// characters (owner-fair-gate.mjs `run`).
fn gate_owner(thread: &str) -> String {
    let owner: String = thread.trim().chars().take(240).collect();
    if owner.is_empty() { "anonymous".to_owned() } else { owner }
}

/// How a broad search came by its turn, and how long its work then ran.
pub(super) struct Turn {
    /// It waited behind another search. Node tells such a search's admission to whichever call was running when the
    /// turn was handed over (`onAdmit` runs in the dispatching call's context), so it is not the search's own to report.
    pub queued: bool,
    pub ran_ms: u64,
}

/// `work`, a broad search whose hard timeout is worded `kind` (`BROAD_REFUSALS`: a file inventory's, a fuzzy search's or a
/// content search's), run in its turn on the process's one broad-search gate, for the session of the call.
/// The search's budget (`SearchDeadlines`, native-search-client.mjs `requestNativeWithRestart`) covers the wait and the
/// work: a turn not had within it is refused (the gate's `waitTimeoutMs` is the budget left at the call, its whole
/// budget here as no setup is spent), and the work has what the wait left, at least 1 ms
/// (`searchRemainingMs`), before the search's hard timeout (`requestNative`). A cancel ends the wait, or the work and
/// its turn with it; the turn is released as the work ends, however it ends.
async fn broad_search<T, W: Future<Output = Result<T, ToolError>>>(ctx: &ToolContext, kind: &str, work: impl FnOnce(u64) -> W) -> Result<T, ToolError> {
    broad_search_turn(ctx, kind, work).await.map(|(out, _)| out)
}

/// As [`broad_search`], with how the turn came and went; `work` is given the budget left, in ms.
pub(super) async fn broad_search_turn<T, W: Future<Output = Result<T, ToolError>>>(
    ctx: &ToolContext,
    kind: &str,
    work: impl FnOnce(u64) -> W,
) -> Result<(T, Turn), ToolError> {
    let budget = SearchDeadlines::of(ctx).hard_ms;
    let queued = mixdog_rt::time::Instant::now();
    let waited = mixdog_rt::Scope::new()
        .cancel(&ctx.cancel)
        .within(Duration::from_millis(budget))
        .run(BROAD_SEARCH.enter(&gate_owner(ctx.thread_id.as_str()), &ctx.cancel))
        .await;
    let turn = match waited {
        mixdog_rt::Scoped::Done(Ok(turn)) => turn,
        mixdog_rt::Scoped::Done(Err(mixdog_rt::GateCancelled)) | mixdog_rt::Scoped::Cancelled => return Err(cancelled()),
        mixdog_rt::Scoped::DeadlineExceeded => {
            return Err(refusal(format!("{}{budget}ms; retry after running work completes", BROAD_REFUSALS[0])));
        }
    };
    let queued_behind_others = turn.queued();
    let admitted = std::time::Instant::now();
    let left = budget.saturating_sub(u64::try_from(queued.elapsed().as_millis()).unwrap_or(u64::MAX)).max(1);
    let ran = mixdog_rt::Scope::new().cancel(&ctx.cancel).within(Duration::from_millis(left)).run(work(left)).await;
    drop(turn);
    let turn = Turn { queued: queued_behind_others, ran_ms: u64::try_from(admitted.elapsed().as_millis()).unwrap_or(u64::MAX) };
    match ran {
        mixdog_rt::Scoped::Done(out) => out.map(|out| (out, turn)),
        mixdog_rt::Scoped::Cancelled => Err(cancelled()),
        mixdog_rt::Scoped::DeadlineExceeded => {
            // The remedy a fuzzy search's timeout names (`timeoutError`).
            let detail = if kind == BROAD_REFUSALS[2] {
                " Fuzzy ranking requires a complete file inventory; narrow the search to a subdirectory via path, or use glob for a wildcard path match."
            } else {
                ""
            };
            Err(refusal(format!("{kind}{left}ms.{detail}")))
        }
    }
}

/// Files under `root` matching any pattern, in walk order, with their mtime (ms; `None` when the
/// stat failed), at most `cap` of them. `complete` is false when the walk hit the deadline,
/// `capped` true when a match past the cap was dropped.
pub(crate) async fn glob_files(
    ctx: &ToolContext,
    root: &AbsPath,
    patterns: &[String],
    include_noise: bool,
    cap: Option<usize>,
) -> Result<(Vec<(AbsPath, Option<u128>)>, bool, bool, Turn), ToolError> {
    let (inc, exc, any_include) = compile_globs(patterns)?;
    let root_path = root.as_path().to_path_buf();
    let rel = |p: &Path| p.strip_prefix(&root_path).map(fwd).unwrap_or_else(|_| fwd(p));
    let ((found, complete, capped), turn) = broad_search_turn(ctx, BROAD_REFUSALS[1], |_| async {
        let walked = walk_entries(ctx, root, !include_noise, |e| {
            if !include_noise && in_noise_dir(e.path.as_path(), &root_path) {
                return false;
            }
            let r = rel(e.path.as_path());
            (!any_include || inc.is_match(&r)) && !exc.is_match(&r)
        }, cap, Some(SearchClass::Bulk))
        .await?;
        let mut out = Vec::with_capacity(walked.entries.len());
        for e in walked.entries {
            if ctx.cancel.is_cancelled() {
                return Err(cancelled());
            }
            let m = mtime_millis(ctx, &e.path).await;
            out.push((e.path, m));
        }
        Ok((out, walked.complete, walked.capped))
    })
    .await?;
    Ok((found, complete, capped, turn))
}

async fn require_dir(ctx: &ToolContext, raw: &str, abs: &AbsPath) -> Result<Option<String>, ToolError> {
    match guarded(ctx, "search", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
        Ok(_) => Ok(None),
        Err(e) if matches!(e.kind, FsErrorKind::NotFound | FsErrorKind::NotADirectory) => {
            let hint = ReadTool::not_found(ctx, raw, abs).await;
            let hint = hint.trim_start_matches("[path absent] ENOENT: no such file or directory, stat ");
            Ok(Some(format!(
                "Error: path does not exist: {} (ENOENT) {hint}",
                fwd(abs.as_path())
            )))
        }
        Err(e) => Err(fs_failure(&e, raw)),
    }
}

/// Node's `isAbsolute` of a glob pattern: on Windows a rooted `/x` counts too.
fn is_absolute_pattern(pattern: &str) -> bool {
    pattern.starts_with('/') || Path::new(pattern).is_absolute()
}

/// path-utils.mjs `canonicalizeGlobSlashes`: rg reads `/` only, so on Windows a glob's `\` is a separator.
fn canonical_glob_slashes(glob: &str) -> String {
    if cfg!(windows) { glob.replace('\\', "/") } else { glob.to_owned() }
}

/// Node `isUncOrSmbPath`: a `\\` or `//` spelling, the device namespaces (`//./`, `//?/`) included.
fn is_unc_or_smb(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//")
}

/// Node's win32 `path.resolve` of a path it reads as a UNC or device root whatever its separators (`/\server/share`,
/// `\/./C:/x`): the `\\server\share\…` it resolves to; `None` for any other path.
fn win32_unc_resolution(raw: &str) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let fwd = raw.replace('\\', "/");
    let root_len = parse_root_len(&fwd);
    if !fwd.starts_with("//") || root_len <= 1 {
        return None;
    }
    let mut rest: Vec<&str> = Vec::new();
    for segment in fwd[root_len..].split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                rest.pop();
            }
            s => rest.push(s),
        }
    }
    let root = format!("{}/", fwd[..root_len].trim_end_matches('/'));
    Some(format!("{root}{}", rest.join("/")).replace('/', "\\"))
}

/// Node `globUncRefusal`: the base path (as given, then resolved) and every absolute pattern, before any walk.
fn glob_unc_refusal(ctx: &ToolContext, raw: &str, patterns: &[String]) -> Option<String> {
    let refuse = |shown: &str| {
        format!(
            "Error: glob refuses UNC/SMB path {}; remote share access is blocked to prevent NTLM credential leaks",
            serde_json::to_string(&super::patch_guard::normalize_output_path(shown)).unwrap_or_default()
        )
    };
    if is_unc_or_smb(raw) {
        return Some(refuse(raw));
    }
    if let Some(resolved) = win32_unc_resolution(raw) {
        return Some(refuse(&resolved));
    }
    if let Ok(resolved) = resolve_path(&ctx.cwd, raw)
        && is_unc_or_smb(&resolved.as_path().to_string_lossy())
    {
        return Some(refuse(&resolved.as_path().to_string_lossy()));
    }
    patterns.iter().find(|p| is_absolute_pattern(p) && is_unc_or_smb(p)).map(|p| refuse(p))
}

/// The byte length of Node's `path.parse(raw).root` (win32 on Windows, posix elsewhere) of a `/`-spelled path:
/// a UNC share keeps its server and share, a device path its namespace, a drive its letter in either case.
pub(super) fn parse_root_len(raw: &str) -> usize {
    let b = raw.as_bytes();
    if !cfg!(windows) {
        return usize::from(b.first() == Some(&b'/'));
    }
    let sep = |i: usize| b.get(i) == Some(&b'/');
    if sep(0) {
        if b.len() == 1 || !sep(1) {
            return 1;
        }
        let mut j = 2;
        let mut last = j;
        while j < b.len() && !sep(j) {
            j += 1;
        }
        if j < b.len() && j != last {
            last = j;
            while j < b.len() && sep(j) {
                j += 1;
            }
            if j < b.len() && j != last {
                last = j;
                while j < b.len() && !sep(j) {
                    j += 1;
                }
                if j == b.len() {
                    return j;
                }
                if j != last {
                    return j + 1;
                }
            }
        }
        return 1;
    }
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return if sep(2) { 3 } else { 2 };
    }
    0
}

const EXPAND_DEADLINE: Duration = Duration::from_millis(1_500);
const EXPAND_CANDIDATE_CAP: usize = 200;

/// Node `segmentMatcher`: one path segment's matcher; `None` for `**` or an unclosed class or brace.
fn segment_matcher(segment: &str) -> Option<regex::Regex> {
    if segment.contains("**") {
        return None;
    }
    let mut source = String::new();
    let mut rest = segment;
    while let Some(ch) = rest.chars().next() {
        rest = &rest[ch.len_utf8()..];
        match ch {
            '*' => source.push_str("[^/]*"),
            '?' => source.push_str("[^/]"),
            '[' => {
                let end = rest.find(']')?;
                let inner: String = rest[..end]
                    .chars()
                    .map(|c| if matches!(c, '\\' | '[' | '&' | '~') { format!("\\{c}") } else { c.to_string() })
                    .collect();
                source.push_str(&format!("[{inner}]"));
                rest = &rest[end + 1..];
            }
            '{' => {
                let end = rest.find('}')?;
                let alternatives: Vec<String> = rest[..end].split(',').map(regex::escape).collect();
                source.push_str(&format!("(?:{})", alternatives.join("|")));
                rest = &rest[end + 1..];
            }
            other => source.push_str(&regex::escape(&other.to_string())),
        }
    }
    let flags = if cfg!(windows) { "(?i)" } else { "" };
    regex::Regex::new(&format!("{flags}^{source}$")).ok()
}

/// Node `expandAbsoluteGlob`: the pattern descended segment by segment (one listing per surviving
/// directory, at most 200 candidates, 1.5 s), its matches that are files or directories; `None`
/// when the pattern is not absolute, has no magic, or uses a construct this does not expand.
async fn expand_absolute_glob(ctx: &ToolContext, pattern: &str, limit: usize) -> Option<Vec<String>> {
    let raw = pattern.replace('\\', "/");
    if !is_absolute_pattern(&raw) || !has_glob_magic(&raw) {
        return None;
    }
    let stop = Instant::now() + EXPAND_DEADLINE;
    let root_len = parse_root_len(&raw);
    if root_len == 0 {
        return None;
    }
    let segments: Vec<&str> = raw[root_len..].split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return None;
    }
    let root = if cfg!(windows) { raw[..root_len].replace('/', "\\") } else { raw[..root_len].to_owned() };
    let mut current = vec![resolve_path(&ctx.cwd, &root).ok()?];
    for segment in segments {
        if Instant::now() >= stop {
            return None;
        }
        if !has_glob_magic(segment) {
            current = current.iter().filter_map(|dir| AbsPath::new(dir.as_path().join(segment))).collect();
            continue;
        }
        let matcher = segment_matcher(segment)?;
        let mut next = Vec::new();
        for dir in &current {
            if next.len() >= EXPAND_CANDIDATE_CAP || Instant::now() >= stop {
                break;
            }
            let Ok(entries) = ctx.files.list_dir(ctx.io.interactive, dir.clone()).await else { continue };
            for entry in entries {
                let Some(name) = entry.path.as_path().file_name() else { continue };
                if !matcher.is_match(&name.to_string_lossy()) {
                    continue;
                }
                next.push(entry.path);
                if next.len() >= EXPAND_CANDIDATE_CAP {
                    break;
                }
            }
        }
        current = next;
        if current.is_empty() {
            return Some(Vec::new());
        }
    }
    let mut found = Vec::new();
    for candidate in current {
        if found.len() >= limit || Instant::now() >= stop {
            break;
        }
        if let Ok(stat) = ctx.files.stat(ctx.io.interactive, candidate.clone()).await
            && matches!(stat.kind, EntryKind::File | EntryKind::Dir)
        {
            found.push(fwd(candidate.as_path()));
        }
    }
    Some(found)
}

/// Node `expandAbsoluteGlobs`: every absolute pattern expanded, deduplicated, in order.
async fn expand_absolute_globs(ctx: &ToolContext, patterns: &[String], limit: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for pattern in patterns {
        if out.len() >= limit {
            break;
        }
        for found in expand_absolute_glob(ctx, pattern, limit).await.unwrap_or_default() {
            if !out.contains(&found) {
                out.push(found);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// glob

pub struct GlobTool {
    spec: ToolSpec,
}

impl GlobTool {
    pub fn new() -> Self {
        Self {
            spec: spec_from_def(GLOB_SPEC, true, &[]),
        }
    }
}

impl Default for GlobTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for GlobTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        // arg-guard.mjs (glob): a `path` or `root` that is not a string, an array included, is refused; a null or
        // blank one is absent and the search runs from the cwd.
        let path = super::common::optional_path_arg(&args, "path", |got| format!("Error: glob arg \"path\" must be string (got {got})"))?;
        super::common::optional_path_arg(&args, "root", |got| format!("Error: glob arg \"root\" must be string (got {got})"))?;
        let patterns: Vec<String> = arg_strings(&args, "pattern").iter().map(|p| canonical_glob_slashes(p)).collect();
        let raw = path.unwrap_or(".");
        let natural = arg_str(&args, "sort") == Some("natural");
        let limit = match arg_u64(&args, "limit") {
            Some(0) => usize::MAX,
            Some(n) => n as usize,
            None => GLOB_DEFAULT_LIMIT,
        };
        let offset = arg_u64(&args, "offset").unwrap_or(0) as usize;
        if let Some(text) = glob_unc_refusal(ctx, raw, &patterns) {
            return Err(fail(ToolErrorCode::Failed { reason: text.clone() }, text));
        }
        let root = resolve_path(&ctx.cwd, raw)?;
        // Node `buildGlobPatternGroups`: an absolute pattern is walked from its own static prefix,
        // anchored there; the others from `path`.
        let (absolute, relative): (Vec<String>, Vec<String>) =
            patterns.iter().cloned().partition(|p| is_absolute_pattern(p));
        // Each group with the root Node names it by (`normalizeOutputPath(root)`).
        let mut groups: Vec<(AbsPath, Vec<String>, String)> = Vec::new();
        if !relative.is_empty() || absolute.is_empty() {
            if let Some(missing) = require_dir(ctx, raw, &root).await? {
                return Ok(text_output(missing));
            }
            groups.push((root.clone(), relative, raw.replace('\\', "/")));
        }
        for pattern in &absolute {
            let (base, rest) = extract_glob_base_directory(pattern);
            let (group_root, label) = match base {
                Some(base) => (resolve_path(&ctx.cwd, &base)?, base.replace('\\', "/")),
                None => (root.clone(), raw.replace('\\', "/")),
            };
            let rest = format!("/{rest}");
            match groups.iter_mut().find(|(r, _, _)| *r == group_root) {
                Some((_, rels, _)) if rels.contains(&rest) => {}
                Some((_, rels, _)) => rels.push(rest),
                None => groups.push((group_root, vec![rest], label)),
            }
        }
        // A bounded page is ranked over every match, as Node's windowed top-K pass counts them all;
        // an unbounded listing keeps at most GLOB_ACCUM_CAP matches and says so (Node's full rg listing).
        let cap = (limit == usize::MAX).then_some(GLOB_ACCUM_CAP);
        let include_noise = arg_bool(&args, "include_noise");
        let (mut files, mut complete, mut capped) = (Vec::new(), true, false);
        let mut errors = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let (mut walk_ms, mut admitted_directly, mut queued_behind_others) = (0u64, 0usize, false);
        for (group_root, rels, label) in &groups {
            if let Some(missing) = require_dir(ctx, &fwd(group_root.as_path()), group_root).await? {
                errors.push(missing.trim_start_matches("Error: ").to_owned());
                continue;
            }
            let (found, done, cut, turn) = match glob_files(ctx, group_root, rels, include_noise, cap).await {
                Err(e) if refused_with(&e).is_some() => {
                    errors.push(format!("rg failed for {label}: {}", refused_with(&e).unwrap_or_default()));
                    continue;
                }
                found => found?,
            };
            walk_ms += turn.ran_ms;
            admitted_directly += usize::from(!turn.queued);
            queued_behind_others |= turn.queued;
            complete &= done;
            capped |= cut;
            files.extend(found.into_iter().filter(|f| seen.insert(f.0.clone())));
        }
        if let Some(cap) = cap.filter(|cap| files.len() > *cap) {
            files.truncate(cap);
            capped = true;
        }
        // Node's glob is one `--files` request to the search server: admitted as a broad search, served as a bulk
        // one (`search-admission.mjs`, `native-search-runner.mjs`, `local-search-telemetry.mjs`). The walk here is
        // that request: its handler time the walk's, from its admission on. A search that waited for its turn
        // (`broad_search`) reports no admission of its own: Node's gate tells it to whichever call handed the turn over
        // (`onAdmit` runs where the dispatch was scheduled), so the waiter's telemetry has neither `broad_admissions` nor
        // `broad_admission_wait_ms` (recorded: search-admission-waiter-telemetry).
        let mut local_search = serde_json::Map::new();
        if admitted_directly > 0 || !queued_behind_others {
            local_search.insert("broad_admissions".to_owned(), 1.into());
            local_search.insert("broad_admission_wait_ms".to_owned(), 0.into());
        }
        for (key, value) in [("native_bulk_requests", 1), ("native_bulk_queue_ms", 0), ("native_bulk_handler_ms", walk_ms), ("native_hits", 1), ("native_ms", walk_ms)] {
            local_search.insert(key.to_owned(), value.into());
        }
        let local_search = JsonValue::Object(local_search);
        let text_output = |text: String| {
            let mut output = text_output(text);
            output.meta = Some(serde_json::json!({ LOCAL_SEARCH_META: local_search }));
            output
        };
        // `scanGlobGroups`' `Error: …` answer, a failure as Node's result classifier reads that text.
        if files.is_empty() && !errors.is_empty() {
            let text = format!("Error: {}", errors.join(" | "));
            return Err(fail(ToolErrorCode::Failed { reason: text.clone() }, text));
        }
        if natural {
            files.sort_by(|a, b| a.0.cmp(&b.0));
        } else {
            let key = |p: &AbsPath| {
                let s = fwd(p.as_path());
                if cfg!(windows) { s.to_lowercase() } else { s }
            };
            // Newest first; a file whose stat failed cannot be ordered by time and keeps its walk
            // order after the rest (Node's mtime top-K, `serve_search/mtime.rs`).
            let (mut statted, unstatted): (Vec<_>, Vec<_>) = files.into_iter().partition(|f| f.1.is_some());
            statted.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| key(&a.0).cmp(&key(&b.0))));
            statted.extend(unstatted);
            files = statted;
        }
        let total = files.len();
        // Node's bounded newest-first page is a top-(offset+limit+1) window of the whole set, counted in full, that
        // then passes the same GLOB_ACCUM_CAP fold as every listing (`mergeGlobRuns`).
        if !natural && limit != usize::MAX && offset.saturating_add(limit).saturating_add(1).min(total) > GLOB_ACCUM_CAP {
            files.truncate(GLOB_ACCUM_CAP);
            capped = true;
        }
        let windowed = files.get(offset..).unwrap_or(&[]);
        let page = &windowed[..windowed.len().min(limit)];
        // Node's `relativeSearchResultPath` strips `<cwd>/`; a filesystem root as the cwd already ends in its separator, so
        // no path starts with `<cwd>//` and every one stays absolute.
        let root_cwd = ctx.cwd.as_path().parent().is_none();
        let lines: Vec<String> = page
            .iter()
            .map(|(p, _)| if root_cwd { super::common::fwd(p.as_path()) } else { display_path(p.as_path(), &ctx.cwd) })
            .collect();
        let remaining = total.saturating_sub(offset + page.len());
        let mut text = lines.join("\n");
        if remaining > 0 {
            text.push_str(&format!(
                "\n{}",
                window_marker(
                    "entries",
                    offset as u64 + 1,
                    (offset + page.len()) as u64,
                    Some(total as u64),
                    Some((offset + page.len()) as u64),
                    None
                )
            ));
        }
        if lines.is_empty() {
            let shown_patterns = if patterns.len() == 1 {
                serde_json::to_string(&patterns[0])
            } else {
                serde_json::to_string(&patterns)
            }
            .unwrap_or_default();
            let base_label = fwd(Path::new(raw));
            if total > 0 && offset >= total {
                text = format!("(no entries after offset={offset}; total={total}) pattern={shown_patterns} path={base_label}");
            } else {
                // The walk never follows a directory link; an absolute pattern that found nothing is
                // expanded straight off the filesystem before the miss is declared (Node `directAbsoluteMatches`).
                if errors.is_empty() {
                    let want = if limit == usize::MAX { 50 } else { offset.saturating_add(limit) };
                    let direct = expand_absolute_globs(ctx, &patterns, want).await;
                    let shown: Vec<String> = direct.into_iter().skip(offset).take(limit).collect();
                    if !shown.is_empty() {
                        return Ok(text_output(shown.join("\n")));
                    }
                }
                let base = match ctx.files.stat(ctx.io.interactive, root.clone()).await {
                    Ok(s) if s.kind == EntryKind::Dir => "path exists (dir)",
                    Ok(_) => "path exists (file)",
                    Err(_) => "path does not exist (ENOENT)",
                };
                let empty = if complete { "(no files found)" } else { "(no files found yet)" };
                text = format!("{empty} pattern={shown_patterns} path={base_label}; {base_label}: {base}");
            }
        }
        if !errors.is_empty() {
            text.push_str(&format!("\n... [warning] {}", errors.join(" | ")));
        }
        if capped {
            text.push_str(&format!(
                "\n{}",
                cap_marker(&format!("{GLOB_ACCUM_CAP} matches"), "results incomplete", None, "narrow the pattern or path")
            ));
        }
        if !complete {
            text.push_str("\n[warning] search timed out; partial results shown. Narrow path/pattern for a complete result.");
        }
        Ok(text_output(locator_budget(text, &locator_targets(&args), offset)))
    }
}

/// `_locatorTargets` of glob: the `path` argument's values, or `.`.
fn locator_targets(args: &JsonValue) -> Vec<String> {
    let raw = match &args["path"] {
        JsonValue::Array(values) => values.clone(),
        value => vec![value.clone()],
    };
    let values: Vec<String> = raw
        .iter()
        .map(|v| match v {
            JsonValue::Null => String::new(),
            JsonValue::String(s) => s.trim().to_owned(),
            other => other.to_string().trim().to_owned(),
        })
        .filter(|v| !v.is_empty())
        .collect();
    if values.is_empty() { vec![".".to_owned()] } else { values }
}

/// Node's locator byte budget (`capLineOrientedToolOutput` with `_locatorBudgetFooter`): the most leading lines that
/// fit in 20 KB together with a footer naming the complete rows they hold and the offset after them.
fn locator_budget(text: String, targets: &[String], offset: usize) -> String {
    if text.len() <= locator_max_bytes() {
        return text;
    }
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let footer = |kept: &[&str]| {
        let (mut target_index, mut visible) = (0usize, 0usize);
        for line in kept {
            if let Some(section) = line.strip_prefix("# glob ").filter(|s| !s.is_empty()) {
                target_index = match targets.iter().position(|t| t == section) {
                    Some(at) => at,
                    None => (target_index + 1).min(targets.len().saturating_sub(1)),
                };
                visible = 0;
                continue;
            }
            if line.is_empty() || ["#", "...", "[", "("].iter().any(|p| line.starts_with(p)) {
                continue;
            }
            visible += 1;
        }
        let target = targets.get(target_index).or(targets.first()).map(String::as_str).unwrap_or("");
        let remaining = targets.len().saturating_sub(target_index + 1);
        let next = if remaining > 0 {
            format!("; {remaining} target(s) not shown, next={}", serde_json::to_string(&targets[target_index + 1]).unwrap_or_default())
        } else {
            String::new()
        };
        cap_marker(
            &format_cap_size(locator_max_bytes()),
            &format!("{visible} complete row(s) shown for path={}{next}", serde_json::to_string(target).unwrap_or_default()),
            Some((offset + visible) as u64),
            "",
        )
    };
    let (mut lo, mut hi, mut best) = (0usize, lines.len(), String::new());
    while lo <= hi {
        let mid = (lo + hi) / 2;
        let kept = &lines[..mid];
        let candidate = format!("{}{}{}", kept.join("\n"), if kept.is_empty() { "" } else { "\n" }, footer(kept));
        if candidate.len() <= locator_max_bytes() {
            best = candidate;
            lo = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            hi = mid - 1;
        }
    }
    if best.is_empty() { byte_prefix(&footer(&[]), locator_max_bytes()).to_owned() } else { best }
}

/// builtin.mjs `_grepShownEntries`: the complete context blocks kept (a header with every line of its range and one
/// more line after it), else every kept row that is not a header, separator, notice or empty.
fn grep_shown_entries(kept: &[&str]) -> usize {
    static HEADER: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^# [^\n\r\u{2028}\u{2029}]+:[0-9]+ \[lines ([0-9]+)-([0-9]+)\]$").expect("a fixed pattern"));
    let mut blocks = 0;
    let mut saw_header = false;
    for (index, line) in kept.iter().enumerate() {
        let Some(header) = HEADER.captures(line) else { continue };
        saw_header = true;
        let (start, end) = (header[1].parse::<f64>().unwrap_or(0.0), header[2].parse::<f64>().unwrap_or(0.0));
        if (index as f64) + end - start + 1.0 < kept.len() as f64 {
            blocks += 1;
        }
    }
    if saw_header {
        return blocks;
    }
    kept.iter()
        .filter(|l| !l.is_empty() && **l != "--" && !["#", "[", "...", "…", "("].iter().any(|p| l.starts_with(p)))
        .count()
}

/// executeBuiltinTool's grep cap (builtin.mjs `_budgetBuiltinOutput` → `capLineOrientedToolOutput` at
/// `GREP_OUTPUT_MAX_BYTES`, footer `_grepBudgetFooter`): the most leading lines that fit with a footer naming the match
/// rows they hold and the offset after them; a pattern or path fan-out (`# grep ` sections) is told to narrow instead.
fn grep_budget(text: String, offset: usize) -> String {
    if text.len() <= grep_max_bytes() {
        return text;
    }
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let footer = |kept: &[&str]| {
        let fanout = kept.iter().any(|l| l.starts_with("# grep "));
        let shown = grep_shown_entries(kept);
        let narrow = if fanout {
            "run one pattern/path per call, or add path/glob/type to cut the match set"
        } else if shown == 0 {
            "one match row exceeds the cap; read that file window or use a tighter pattern"
        } else {
            ""
        };
        let next = (!fanout && shown > 0).then_some((offset + shown) as u64);
        cap_marker(&format_cap_size(grep_max_bytes()), &format!("{shown} match row(s) shown"), next, narrow)
    };
    let (mut lo, mut hi, mut best) = (0usize, lines.len(), String::new());
    while lo <= hi {
        let mid = (lo + hi) / 2;
        let kept = &lines[..mid];
        let candidate = format!("{}{}{}", kept.join("\n"), if kept.is_empty() { "" } else { "\n" }, footer(kept));
        if candidate.len() <= grep_max_bytes() {
            best = candidate;
            lo = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            hi = mid - 1;
        }
    }
    if best.is_empty() { byte_prefix(&footer(&[]), grep_max_bytes()).to_owned() } else { best }
}

// ---------------------------------------------------------------------------
// find

pub struct FindTool {
    spec: ToolSpec,
}

impl FindTool {
    pub fn new() -> Self {
        Self {
            spec: spec_from_def(FIND_SPEC, true, &[]),
        }
    }
}

impl Default for FindTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for FindTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let query = arg_str(&args, "query").unwrap_or("").trim().to_owned();
        if query.is_empty() {
            return Err(invalid("query", "required", "Error: find requires query."));
        }
        // arg-guard.mjs (find): a `path` that is not a string is refused; a null or blank one is the cwd.
        let raw = super::common::optional_path_arg(&args, "path", |got| format!("Error: find arg \"path\" must be a string (got {got})"))?
            .unwrap_or(".");
        let limit = match arg_u64(&args, "limit") {
            Some(0) => FIND_UNLIMITED_CAP,
            Some(n) => n as usize,
            None => FIND_DEFAULT_LIMIT,
        };
        let include_noise = arg_bool(&args, "include_noise");
        let root = resolve_path(&ctx.cwd, raw)?;
        if let Some(missing) = require_dir(ctx, raw, &root).await? {
            return Ok(text_output(missing));
        }
        let root_path = root.as_path().to_path_buf();
        // Every file and folder is scored, as Node's native inventory ranks the whole scope (serve_search/fuzzy.rs
        // `fuzzy_scope`: `directories`, the ignore files honoured in a repository or not unless `include_noise`). A noise
        // folder is listed, nothing in it (`DEFAULT_IGNORE_GLOBS`, `!**/<name>/**`), and the walk does not enter it.
        let bare = if include_noise { Vec::new() } else { noise_bare() };
        let request = WalkRequest {
            root: root.clone(),
            recursive: true,
            include_hidden: true,
            respect_ignore: !include_noise,
            require_git: false,
            include_dirs: true,
            prune: root_scan_prunes(&root, cfg!(not(windows))),
            descent: Descent { max_depth: None, bare, bare_dotted: false },
            server: Some(SearchClass::Fuzzy),
        };
        let Walked { entries, complete, .. } = broad_search(ctx, BROAD_REFUSALS[2], |_| {
            walk_kept(ctx, request, |e| include_noise || !in_noise_dir(e.path.as_path().parent().unwrap_or(root_path.as_path()), &root_path), None)
        })
        .await?;
        // serve_search/fuzzy.rs: every whitespace-separated fragment is a nucleo fuzzy atom (case ignored, Unicode
        // normalised "smart"), all must match one path, the scores add, and the best score comes first, a tie by path.
        let atoms: Vec<Pattern> =
            query.split_whitespace().map(|t| Pattern::new(t, CaseMatching::Ignore, Normalization::Smart, AtomKind::Fuzzy)).collect();
        let mut matcher = FuzzyMatcher::new(FuzzyConfig::DEFAULT.match_paths());
        let mut scored: Vec<(u32, String)> = entries
            .iter()
            .filter_map(|e| {
                let rel = display_under(e.path.as_path(), &root_path);
                let text = Utf32String::from(rel.as_str());
                let mut total = 0u32;
                for atom in &atoms {
                    total = total.saturating_add(atom.score(text.slice(..), &mut matcher)?);
                }
                Some((total, rel))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        let more = scored.len() > limit;
        scored.truncate(limit);
        let mut lines: Vec<String> = scored.into_iter().map(|(_, p)| p).collect();
        if lines.is_empty() {
            lines.push(format!("(no fuzzy match for \"{query}\")"));
        } else if more {
            lines.push(format!("... (top {limit}; additional matches omitted)"));
        }
        if !complete {
            lines.push("... [search timed out; partial results shown]".to_owned());
        }
        let text = lines.join("\n");
        if text.len() > locator_max_bytes() {
            let (kept, dropped) = cap_lines(&text, locator_max_bytes());
            let rows = lines.len().saturating_sub(dropped);
            let marker = cap_marker(
                &format_cap_size(locator_max_bytes()),
                &format!("{rows} match row(s) shown for query={query:?}"),
                None,
                "use a more specific query or add path",
            );
            return Ok(text_output(format!("{kept}\n{marker}")));
        }
        Ok(text_output(text))
    }
}

// ---------------------------------------------------------------------------
// grep

/// Waits until a search's hard deadline: a sleep on the runtime's clock, or a test's timer.
pub type SearchTimer = Arc<dyn Fn(std::time::Instant) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

pub struct GrepTool {
    spec: ToolSpec,
    timer: SearchTimer,
}

impl GrepTool {
    pub fn new() -> Self {
        Self::with_timer(Arc::new(|at| Box::pin(mixdog_rt::time::sleep_until(at.into()))))
    }

    /// A grep whose searches' hard deadlines pass on `timer`.
    pub fn with_timer(timer: SearchTimer) -> Self {
        Self { spec: spec_from_def(GREP_SPEC, true, &[]), timer }
    }
}

impl Default for GrepTool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Content,
    Files,
    Count,
}

#[derive(Clone)]
struct Hit {
    path: AbsPath,
    line: u64,
    text: String,
    /// What the line adds to its file's count ([`SearchMatch::count`]).
    count: u64,
}

/// grep-pattern-fanout.mjs `candidateMatchTexts`: the text after every `:<digits>:` of an output line, each a
/// possible split of `path:line:text`; the whole line when there is none.
fn candidate_match_texts(line: &str) -> Vec<&str> {
    static SPLIT: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r":([0-9]+):").expect("a fixed pattern"));
    let mut out = Vec::new();
    let mut at = 0;
    // `re.lastIndex = hit.index + 1`: overlapping splits are all tried.
    while let Some(hit) = SPLIT.find_at(line, at) {
        out.push(&line[hit.end()..]);
        at = hit.start() + 1;
    }
    if out.is_empty() {
        out.push(line);
    }
    out
}

/// grep-pattern-fanout.mjs `attributeCombinedLines`: each output line goes to every pattern whose JavaScript regex
/// matches its text; a line none matches (the regex dialects differ, or the 500-column clip cut the match off) is
/// residual. `None` when the line's possible splits disagree on a pattern (`ambiguous`).
fn attribute_combined(lines: &[String], regexes: &[mixdog_js::JsRegex]) -> Option<(Vec<Vec<usize>>, Vec<usize>)> {
    let mut by_pattern = vec![Vec::new(); regexes.len()];
    let mut residual = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let texts = candidate_match_texts(line);
        let mut hit_any = false;
        for (i, re) in regexes.iter().enumerate() {
            let matched = re.is_match(texts[0]);
            if texts[1..].iter().any(|t| re.is_match(t) != matched) {
                return None;
            }
            if matched {
                by_pattern[i].push(index);
                hit_any = true;
            }
        }
        if !hit_any {
            residual.push(index);
        }
    }
    Some((by_pattern, residual))
}

/// grep-request.mjs `resolveGrepRequest`: the non-empty patterns in NFC (`normalizeSearchPattern`), each once
/// (`uniqueStrings`), at most the first 10 (`capGrepPatterns`, `GREP_PATTERN_ARRAY_CAP`); past 10 the answer opens with
/// `[capped at 10 of N patterns]` (search-input-helpers.mjs `capPatternList`).
fn pattern_list(requested: &[String]) -> (Vec<String>, String) {
    use unicode_normalization::UnicodeNormalization;
    const CAP: usize = 10;
    let mut list: Vec<String> = Vec::new();
    for p in requested.iter().filter(|p| !p.is_empty()).map(|p| p.nfc().collect::<String>()) {
        if !list.contains(&p) {
            list.push(p);
        }
    }
    let total = list.len();
    if total <= CAP {
        return (list, String::new());
    }
    list.truncate(CAP);
    (list, format!("[capped at {CAP} of {total} patterns]\n"))
}

/// ripgrep's `-e p1 -e p2 …`: one regex, a line kept when any pattern matches it.
fn combined_regex(patterns: &[String]) -> String {
    patterns.iter().map(|p| format!("(?:{p})")).collect::<Vec<_>>().join("|")
}

fn escape_glob(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '{' | '}' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Path prefix for grep results: the search path as given (`./` for the cwd).
fn grep_display_root(raw: &str, root: &AbsPath, cwd: &AbsPath) -> String {
    let given = raw.trim().replace('\\', "/");
    let under_cwd = Path::new(raw.trim()).is_absolute()
        .then(|| root.as_path().strip_prefix(cwd.as_path()).ok().map(fwd))
        .flatten();
    let shown = match under_cwd {
        Some(rel) if rel.is_empty() => ".".to_owned(),
        Some(rel) => rel,
        None => given,
    };
    shown.trim_end_matches('/').trim_start_matches("./").to_owned().replace("", "").pipe_dot()
}

trait PipeDot {
    fn pipe_dot(self) -> String;
}
impl PipeDot for String {
    fn pipe_dot(self) -> String {
        if self.is_empty() { ".".to_owned() } else { self }
    }
}

impl GrepTool {
    async fn run_one_root(
        &self,
        ctx: &ToolContext,
        raw: &str,
        args: &JsonValue,
        pattern: &str,
        globs: &[String],
        mode: Mode,
        bound: Option<usize>,
        class: SearchClass,
        budget_ms: u64,
    ) -> Result<Scanned, ToolError> {
        let abs = resolve_path(&ctx.cwd, raw)?;
        let stat = match guarded(ctx, "grep", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
            Ok(s) => s,
            Err(e) if super::not_found::missing_code(&e.kind).is_some() => {
                let code = super::not_found::missing_code(&e.kind).unwrap_or("ENOENT");
                let error = super::not_found::grep_missing(ctx, &abs, raw, code).await;
                return Ok(Scanned { hits: Vec::new(), complete: true, timed_out: false, scan_errors: 0, error, single_file: false, bad_pattern: false });
            }
            Err(e) => return Err(fs_failure(&e, raw)),
        };
        let include_noise = arg_bool(args, "include_noise");
        let single_file = stat.kind == EntryKind::File;
        let (root, mut include_globs) = if single_file {
            let parent = AbsPath::new(abs.as_path().parent().unwrap_or(abs.as_path()).to_path_buf())
                .unwrap_or_else(|| abs.clone());
            let name = abs.as_path().file_name().map(|n| escape_glob(&n.to_string_lossy()));
            (parent, name.into_iter().collect::<Vec<_>>())
        } else {
            (abs.clone(), Vec::new())
        };
        let mut exclude_globs = Vec::new();
        // grep-request.mjs `resolveGrepScope`: a caller's glob with each Windows `\` a `/` (`canonicalizeGlobSlashes`).
        for g in globs.iter().map(|g| canonical_glob_slashes(g)) {
            match g.strip_prefix('!') {
                Some(neg) => exclude_globs.push(neg.to_owned()),
                None => include_globs.push(g),
            }
        }
        if !include_noise {
            for n in NOISE_DIRS {
                // A noise directory the caller explicitly searches inside stays visible.
                let inside = abs.as_path().components().any(|c| c.as_os_str() == *n);
                if !inside {
                    exclude_globs.push(format!("**/{n}/**"));
                }
            }
        }
        let deadlines = SearchDeadlines::within(ctx, budget_ms);
        let mut stream = ctx.files.search_text(
            ctx.io.maintenance,
            SearchRequest {
                root,
                pattern: pattern.to_owned(),
                regex: true,
                case_sensitive: true,
                include_globs,
                exclude_globs,
                include_hidden: true,
                respect_ignore: !include_noise,
                // grep-request.mjs `multilineMode` (`-U --multiline-dotall`) and `pcre2Mode` (`-P`), and `text` (`--text`).
                multiline: multiline_mode(args, pattern),
                pcre2: UNSUPPORTED_REGEX.is_match(pattern),
                binary_as_text: arg_bool(args, "text"),
                // The scan itself ends at the window (a file list or counts read every match), as Node's server's
                // `collect_until` does; an unlimited listing at the 200,000-match content cap. The sink below takes one
                // hit before it checks a spent bound, so a bound of 0 still reads one.
                limit: (mode == Mode::Content).then(|| bound.map_or(CONTENT_MATCH_CAP, |n| n.max(1))),
                // A file list reads each file to its first match (`--files-with-matches`).
                first_per_file: mode == Mode::Files,
                deadline: Some(deadlines.soft.into_std()),
                class,
            },
        );
        let mut hits = Vec::new();
        let mut errors = 0usize;
        let mut bad_pattern = None;
        let mut timed_out = false;
        let mut refused = None;
        // The stream is read to its end, past the bound: the scan stops itself at its limit, and the deadline it may
        // report after its last match belongs to the answer (Node's server checks it once more after its scan).
        let end = pull_until(ctx, stream.as_mut(), (self.timer)(deadlines.hard.into_std()),|item| {
            match item {
                Ok(SearchMatch { path, line, text, count, .. }) => {
                    if mode == Mode::Content && hits.len() >= CONTENT_MATCH_CAP {
                        return false;
                    }
                    // A file list is one row per file (`--files-with-matches`).
                    if mode == Mode::Files && hits.last().is_some_and(|h: &Hit| h.path == path) {
                        return true;
                    }
                    if !bound.is_some_and(|n| hits.len() >= n.max(1)) {
                        hits.push(Hit { path, line, text, count });
                    }
                }
                Err(FsError { kind: FsErrorKind::TimedOut, path, .. }) => {
                    timed_out = true;
                    // A file the deadline cut is not answered in part.
                    if let Some(cut) = path {
                        hits.retain(|h| h.path != cut);
                    }
                }
                Err(e) => match e.kind {
                    FsErrorKind::InvalidPattern { message } => bad_pattern = Some(message),
                    ref kind @ (FsErrorKind::Saturated | FsErrorKind::CancelStalled { .. }) => refused = refusal_reason(kind),
                    _ => {
                        errors += 1;
                        // A file whose search failed is not answered in part (Node's server drops its printed lines).
                        if let Some(failed) = e.path {
                            hits.retain(|h| h.path != failed);
                        }
                    }
                },
            }
            true
        })
        .await;
        let complete = match end {
            PullEnd::Cancelled => return Err(cancelled()),
            PullEnd::Deadline => false,
            // A file the scan could not read leaves the answer incomplete (serve_search/search.rs `response_window`).
            PullEnd::Exhausted => !timed_out && errors == 0,
            // The search's hard deadline: the server never answered (`requestNative`'s timer, `timeoutError`); the search
            // was stopped as Node's client cancels and then ends its server.
            PullEnd::Timer => {
                let text = format!("Error: native content search timed out after {}ms.", deadlines.hard_ms);
                return Err(fail(ToolErrorCode::Failed { reason: text.clone() }, text));
            }
        };
        if let Some(reason) = refused {
            return Err(refusal(reason));
        }
        // The parser's own text, as Node relays the search server's refusal.
        if let Some(message) = bad_pattern {
            let error = format!("Error: regex parse error: {message}");
            return Ok(Scanned { hits: Vec::new(), complete: true, timed_out: false, scan_errors: 0, error, single_file, bad_pattern: true });
        }
        Ok(Scanned { hits, complete, timed_out, scan_errors: errors, error: String::new(), single_file, bad_pattern: false })
    }
}

/// A combined scan's or a prefilter's failure (its hard deadline included) declines it, as Node's callers catch it
/// (`streamCombinedLines`, `fanoutPrefilterCandidates`, `runCombinedPathFanout`); a cancel ends the call.
fn declined_on_failure<T>(outcome: Result<T, ToolError>) -> Result<Option<T>, ToolError> {
    match outcome {
        Ok(value) => Ok(Some(value)),
        Err(e) if matches!(e.code, ToolErrorCode::Cancelled) => Err(e),
        Err(_) => Ok(None),
    }
}

/// One root's scan: its hits, whether it finished (`complete`) or reached its soft deadline (`timed_out`), the files it
/// could not read (`scan_errors`, the server's `scanErrors`), the error that answers it instead, whether the root is a
/// file, and whether the error is a refused pattern.
struct Scanned {
    hits: Vec<Hit>,
    complete: bool,
    timed_out: bool,
    scan_errors: usize,
    error: String,
    single_file: bool,
    bad_pattern: bool,
}

/// native-search-client.mjs: a search's hard deadline is the caller's timeout, at most `REQUEST_TIMEOUT_MS` (17.5 s),
/// past which the call fails; the server's soft deadline (`softDeadlineMs`) is that less a margin of 7.5 %, between
/// 250 ms and 2 s, past which the server answers what it found, marked timed out.
struct SearchDeadlines {
    soft: mixdog_rt::time::Instant,
    hard: mixdog_rt::time::Instant,
    hard_ms: u64,
}

impl SearchDeadlines {
    fn of(ctx: &ToolContext) -> Self {
        Self::within(ctx, u64::MAX)
    }

    /// The deadlines of a search that has `left_ms` of its budget left: one admitted after a wait (`requestNativeWithRestart`
    /// sets the server's soft deadline from the budget that remains).
    fn within(ctx: &ToolContext, left_ms: u64) -> Self {
        const REQUEST_TIMEOUT_MS: u64 = 17_500;
        // On the runtime's clock, as the sleeps that wait for these deadlines: a test moves it by an explicit advance.
        let now = mixdog_rt::time::Instant::now();
        let caller = ctx.deadline.map(|at| u64::try_from(mixdog_rt::time::Instant::from_std(at).saturating_duration_since(now).as_millis()).unwrap_or(u64::MAX));
        let hard_ms = caller.filter(|ms| *ms > 0).map_or(REQUEST_TIMEOUT_MS, |ms| ms.min(REQUEST_TIMEOUT_MS)).min(left_ms);
        let margin = (hard_ms * 75 / 1000).clamp(250, 2000);
        let ms = std::time::Duration::from_millis;
        Self { soft: now + ms(hard_ms.saturating_sub(margin).max(1)), hard: now + ms(hard_ms), hard_ms }
    }
}

/// grep-output.mjs `grepPartialWarning` for a timed-out scan.
const TIMEOUT_WARNING: &str = "\n[warning] rg timed out; partial results shown. Narrow path/glob/pattern for a complete result.";

/// grep-output.mjs `grepPartialWarning` for an incomplete scan: a timed-out one, else one with files it could not read.
/// Their count reaches it as `rgStderr` only through a windowed stream (native-search-client.mjs:888-892,
/// `runRgWindowedLines`); `runRg`'s answer (an unlimited listing, a file list, counts) carries none
/// (native-search-runner.mjs:39-44). Node keeps the first 300 characters of `rgStderr`, which this count never reaches.
fn partial_warning(timed_out: bool, scan_errors: usize, streamed: bool) -> String {
    if timed_out || scan_errors == 0 {
        return TIMEOUT_WARNING.to_owned();
    }
    if !streamed {
        return "\n[warning] rg exit 2 (partial results)".to_owned();
    }
    format!(
        "\n[warning] rg exit 2 (partial results): {scan_errors} file(s) could not be read (permission or I/O error); matches from those files are missing"
    )
}

#[async_trait]
impl Tool for GrepTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    /// The answer within Node's context budget (`GREP_OUTPUT_MAX_BYTES` characters), then capped as
    /// executeBuiltinTool caps it (builtin.mjs `_budgetBuiltinOutput`: `capLineOrientedToolOutput` at
    /// `GREP_OUTPUT_MAX_BYTES` bytes with `_grepBudgetFooter`).
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let offset = arg_u64(&args, "offset").unwrap_or(0) as usize;
        let text = self.answer(ctx, args, grep_max_bytes()).await?;
        Ok(text_output(grep_budget(text, offset)))
    }
}

impl GrepTool {
    /// One grep call's text, its context renderings fitted to `budget` characters.
    async fn answer(&self, ctx: &ToolContext, args: JsonValue, budget: usize) -> Result<String, ToolError> {
        let patterns = arg_strings(&args, "pattern");
        if patterns.is_empty() || patterns.iter().all(|p| p.is_empty()) {
            return Err(invalid("pattern", "required", "Error: grep requires pattern."));
        }
        // arg-guard.mjs (grep): a null or blank `path`/`root` is absent (the cwd); an array is kept as the scopes and must
        // hold 1-10 non-empty strings; any other non-string is refused.
        let mut args = args;
        for key in ["path", "root"] {
            match args.get(key) {
                Some(JsonValue::Null) => {
                    args.as_object_mut().map(|o| o.shift_remove(key));
                }
                Some(JsonValue::String(s)) if mixdog_js::js_trim(s).is_empty() => {
                    args.as_object_mut().map(|o| o.shift_remove(key));
                }
                Some(JsonValue::Array(items)) => {
                    let non_empty = |v: &JsonValue| v.as_str().is_some_and(|s| !mixdog_js::js_trim(s).is_empty());
                    if items.is_empty() || items.len() > GREP_PATH_BATCH_LIMIT || !items.iter().all(non_empty) {
                        let text = format!(
                            "Error: grep arg \"{key}\" must contain 1-{GREP_PATH_BATCH_LIMIT} non-empty path strings ({} given, max {GREP_PATH_BATCH_LIMIT})",
                            items.len()
                        );
                        return Err(invalid(key, "type", text));
                    }
                }
                Some(other) if !other.is_string() => {
                    let got = super::read_legacy::describe_type(other);
                    return Err(invalid(key, "type", format!("Error: grep arg \"{key}\" must be string or string[] (got {got})")));
                }
                _ => {}
            }
        }
        // search-grep-tool.mjs: two or more distinct paths are independent greps, one `# grep <path>` section each
        // (lib/grep-path-fanout.mjs); one is that path. Each section's context budget is the call's divided by the
        // number of paths, at least 512 (grep-path-fanout.mjs:244 and :293, `Math.max(512, Math.floor(budget / n))`);
        // the assembled text is capped once, by `call`.
        if let Some(JsonValue::Array(items)) = args.get("path") {
            let mut list: Vec<String> = Vec::new();
            for item in items {
                let p = mixdog_js::js_trim(item.as_str().unwrap_or_default()).to_owned();
                if !p.is_empty() && !list.contains(&p) {
                    list.push(p);
                }
            }
            if list.len() > 1 {
                let per_path = (budget / list.len()).max(512);
                if let Some(bodies) = self.combined_paths(ctx, &args, &list, &patterns, per_path).await? {
                    return Ok(fanout_sections(Fanout::Path, &list, &bodies));
                }
                // `runGrepPathFanout`'s fallback: each path an independent grep.
                let mut bodies = Vec::with_capacity(list.len());
                for p in &list {
                    let mut one = args.clone();
                    one["path"] = JsonValue::String(p.clone());
                    bodies.push(match Box::pin(self.answer(ctx, one, per_path)).await {
                        Ok(text) => text,
                        Err(e) if matches!(e.code, ToolErrorCode::Cancelled) => return Err(e),
                        Err(e) => e.message_for_model,
                    });
                }
                return Ok(fanout_sections(Fanout::Path, &list, &bodies));
            }
            if let Some(one) = list.pop() {
                args["path"] = JsonValue::String(one);
            }
        }
        let (patterns, note) = pattern_list(&patterns);
        let mode = mode_of(&args);
        Ok(format!("{note}{}", self.answer_patterns(ctx, &args, &patterns, mode, budget).await?))
    }

    /// One path's answer to its (distinct, capped) patterns.
    async fn answer_patterns(&self, ctx: &ToolContext, args: &JsonValue, patterns: &[String], mode: Mode, budget: usize) -> Result<String, ToolError> {
        let args = args.clone();
        let patterns = patterns.to_vec();
        // Node `runGrepPatternFanout`: several content patterns are independent greps, one section
        // each; a match line or block an earlier pattern showed is not repeated.
        if patterns.len() > 1 && mode == Mode::Content {
            // `perPatternCharBudget` (grep-pattern-fanout.mjs).
            let per_pattern = (budget / patterns.len()).max(512);
            let (bodies, residual, partial) = match self.combined_patterns(ctx, &args, &patterns, per_pattern).await? {
                Some(answer) => answer,
                // `runPerPatternFanout`: each pattern an independent grep.
                None => {
                    if self.no_candidate_files(ctx, &args, &patterns).await? {
                        return Ok(no_matches(true));
                    }
                    let mut bodies = Vec::with_capacity(patterns.len());
                    // A pattern's failure is its section's text (`runPattern`'s catch, grep-pattern-fanout.mjs:336-339).
                    for pattern in &patterns {
                        bodies.push(match self.search(ctx, &args, pattern, mode, true, per_pattern).await {
                            Ok(text) => text,
                            Err(e) if matches!(e.code, ToolErrorCode::Cancelled) => return Err(e),
                            Err(e) => e.message_for_model,
                        });
                    }
                    (bodies, Vec::new(), None)
                }
            };
            let mut seen = std::collections::HashSet::new();
            let bodies: Vec<String> = bodies.iter().map(|body| dedupe_fanout_match_lines(body, &mut seen)).collect();
            let mut text = fanout_sections(Fanout::Pattern, &patterns, &bodies);
            if !residual.is_empty() {
                // `renderCombinedSections`: lines no pattern claimed are shown, at most 40, not dropped.
                text.push_str(&format!("\n\n# grep (unattributed matches)\n{}", residual[..residual.len().min(40)].join("\n")));
            }
            // The combined scan's one warning closes the answer.
            if let Some(warning) = partial {
                text.push_str(&warning);
            }
            return Ok(text);
        }
        let pattern = if patterns.len() == 1 { patterns[0].clone() } else { combined_regex(&patterns) };
        self.search(ctx, &args, &pattern, mode, false, budget).await
    }

    /// One grep of `pattern`, rendered. `fanout`: a section of a several-pattern answer, whose
    /// bare match lines carry their file (Node's combined pass, `disableContentGrouping`).
    async fn search(&self, ctx: &ToolContext, args: &JsonValue, pattern: &str, mode: Mode, fanout: bool, budget: usize) -> Result<String, ToolError> {
        let window = Window::of(args, mode);
        // The native search window (serve_search/search.rs `collect_until`): the scan stops one hit past what the call
        // can show, so the length of a cut stream is unknown.
        let Collected { all, complete, timed_out, scan_errors, errors, single, all_bad } =
            self.collect(ctx, args, pattern, mode, window.stream_bound(mode), SearchClass::Interactive).await?;
        if all.is_empty() && !errors.is_empty() {
            // A pattern the parser refused is a failed call, as Node's caller takes it; a missing path is a miss.
            // In a several-pattern answer it fails only its own section.
            if all_bad && !fanout {
                let text = errors.join("\n");
                return Err(fail(ToolErrorCode::Failed { reason: text.clone() }, text));
            }
            return Ok(errors.join("\n"));
        }
        let shape = Shape { mode, single: single && !fanout, fanout, complete, totals: Totals::Streamed };
        let mut text = render(ctx, &all, &window, shape, pattern, budget).await?;
        for e in errors {
            text.push_str(&format!("\n{e}"));
        }
        if !complete {
            text.push_str(&partial_warning(timed_out, scan_errors, window.stream_bound(mode).is_some()));
        }
        let _ =(BTreeSet::<u8>::new(), ToolPart::Text(String::new()), ToolOutput::default());
        Ok(text)
    }

    /// grep-pattern-fanout.mjs `runCombinedFanout`: one scan carrying every pattern over a folder, its lines attributed
    /// to each pattern they match, when every pattern compiles as a JavaScript regex. It keeps `min(4000, max(400,
    /// (offset + limit + 4) × patterns))` lines (300 per pattern when unlimited); past that, or over a file, a missing
    /// path or a pattern the scan refuses, it declines (`None`). Its sections know their totals.
    async fn combined_patterns(
        &self,
        ctx: &ToolContext,
        args: &JsonValue,
        patterns: &[String],
        budget: usize,
    ) -> Result<Option<(Vec<String>, Vec<String>, Option<String>)>, ToolError> {
        // `new RegExp(p, request.caseInsensitive ? 'i' : '')`, `caseInsensitive` being `args['-i'] === true`.
        let flags = if args.get("-i") == Some(&JsonValue::Bool(true)) { "i" } else { "" };
        let Ok(regexes) = patterns.iter().map(|p| mixdog_js::JsRegex::new(p, flags)).collect::<Result<Vec<_>, _>>() else {
            return Ok(None);
        };
        let window = Window::of(args, Mode::Content);
        // `combinedFanoutEligible`: the automatic context travels as `-B`/`-A` (grep-request.mjs
        // `resolveGrepContextFlags`), which the combined pass declines, as it declines a multi-line search.
        if window.context.is_none() || patterns.iter().any(|p| multiline_mode(args, p)) {
            return Ok(None);
        }
        let per_window = if window.limit == usize::MAX { 300 } else { window.offset.saturating_add(window.limit).saturating_add(4) };
        let cap = per_window.saturating_mul(patterns.len()).clamp(400, 4000);
        // `combinedBulkHint`: sent as a bulk search unless a glob or a type narrows it (grep-pattern-fanout.mjs:249).
        let class = if arg_strings(args, "glob").is_empty() && arg_str(args, "type").is_none() { SearchClass::Bulk } else { SearchClass::Interactive };
        let Some(mut found) = declined_on_failure(self.collect(ctx, args, &combined_regex(patterns), Mode::Content, Some(cap + 1), class).await)? else {
            return Ok(None);
        };
        if !found.errors.is_empty() || found.single {
            return Ok(None);
        }
        // `runCombinedFanout`: a partial scan (its deadline cut it, or a file could not be read) keeps the lines it found
        // (the server's window, at most the cap) and declines only when it found none; one that ran past its cap
        // declines.
        let partial = found.timed_out || found.scan_errors > 0;
        if partial {
            if found.all.is_empty() {
                return Ok(None);
            }
            found.all.truncate(cap);
        } else if !found.complete || found.all.len() > cap {
            return Ok(None);
        }
        // The stream's lines as ripgrep printed them: `path:line:text`, the path with the platform's separator, the text
        // clipped at 500 columns.
        let lines: Vec<String> = found
            .all
            .iter()
            .map(|(label, h)| format!("{}:{}:{}", label.replace('/', std::path::MAIN_SEPARATOR_STR), h.line, h.text))
            .collect();
        let Some((by_pattern, residual)) = attribute_combined(&lines, &regexes) else { return Ok(None) };
        let mut bodies = Vec::with_capacity(patterns.len());
        for (pattern, indices) in patterns.iter().zip(&by_pattern) {
            bodies.push(if indices.is_empty() {
                no_matches(!partial)
            } else {
                let all: Vec<(String, Hit)> = indices.iter().map(|&i| found.all[i].clone()).collect();
                let shape = Shape { mode: Mode::Content, single: false, fanout: true, complete: !partial, totals: Totals::Combined };
                render(ctx, &all, &window, shape, pattern, budget).await?
            });
        }
        let residual = residual.into_iter().map(|i| lines[i].clone()).collect();
        Ok(Some((bodies, residual, partial.then(|| partial_warning(found.timed_out, found.scan_errors, true)))))
    }

    /// grep-pattern-fanout.mjs `fanoutPrefilterCandidates`: before the per-pattern greps, one files-with-matches scan of
    /// every pattern over a folder; when it completes with no file the call is one no-match answer. A file, a missing
    /// path or a scan error leaves the per-pattern greps to answer.
    async fn no_candidate_files(&self, ctx: &ToolContext, args: &JsonValue, patterns: &[String]) -> Result<bool, ToolError> {
        // Sent as a bulk search (grep-pattern-fanout.mjs:76).
        let Some(found) = declined_on_failure(self.collect(ctx, args, &combined_regex(patterns), Mode::Files, Some(1), SearchClass::Bulk).await)? else {
            return Ok(false);
        };
        Ok(found.complete && found.errors.is_empty() && !found.single && found.all.is_empty())
    }

    /// Every root's hits (at most `bound` in all, in scan order), labelled and sorted.
    async fn collect(&self, ctx: &ToolContext, args: &JsonValue, pattern: &str, mode: Mode, bound: Option<usize>, class: SearchClass) -> Result<Collected, ToolError> {
        let mut roots = arg_strings(args, "path");
        if roots.is_empty() {
            roots.push(".".to_owned());
        }
        let globs = arg_strings(args, "glob");
        let mut all: Vec<(String, Hit)> = Vec::new();
        let mut complete = true;
        let mut errors: Vec<String> = Vec::new();
        let mut single = false;
        let mut all_bad = true;
        let mut timed_out = false;
        let mut scan_errors = 0;
        for raw in &roots {
            let left = bound.map(|n| n.saturating_sub(all.len()));
            // A bulk scan (a fan-out's prefilter or combined pass, `bulkHint`) takes its turn on the broad-search gate as
            // Node's client makes it (search-admission.mjs `isBroadSearchRequest`); the others pass it.
            let scanned = if class == SearchClass::Bulk {
                broad_search(ctx, BROAD_REFUSALS[3], |budget| self.run_one_root(ctx, raw, args, pattern, &globs, mode, left, class, budget)).await?
            } else {
                self.run_one_root(ctx, raw, args, pattern, &globs, mode, left, class, u64::MAX).await?
            };
            complete &= scanned.complete;
            timed_out |= scanned.timed_out;
            scan_errors += scanned.scan_errors;
            single = scanned.single_file && roots.len() == 1;
            if !scanned.error.is_empty() {
                all_bad &= scanned.bad_pattern;
                errors.push(scanned.error);
                continue;
            }
            all.extend(label_hits(ctx, raw, scanned.single_file, scanned.hits)?);
        }
        sort_hits(&mut all);
        Ok(Collected { all, complete, timed_out, scan_errors, errors, single, all_bad })
    }

    /// grep-path-fanout.mjs `runCombinedPathFanout`: one scan over every path, attributed back to each path's section,
    /// when the call is one pattern outside `count` mode over existing, non-glob, non-share paths none of which lies in
    /// another and which share one filter set. The scan keeps `min(4000, max(400, (offset + limit + 4) × paths))` hits
    /// (300 per path when unlimited); past that, or when a path cannot be scanned, it declines (`None`) and every path is
    /// searched on its own. Its sections know their totals.
    async fn combined_paths(
        &self,
        ctx: &ToolContext,
        args: &JsonValue,
        list: &[String],
        patterns: &[String],
        budget: usize,
    ) -> Result<Option<Vec<String>>, ToolError> {
        let mode = mode_of(args);
        let single: Vec<&String> = patterns.iter().filter(|p| !p.is_empty()).collect();
        // `combinedPathRequest`: no `multiline: true`, one pattern, no literal `\n`, nothing ripgrep's default engine
        // refuses (arg-guard.mjs `hasUnsupportedRipgrepRegex`).
        let [pattern] = single.as_slice() else { return Ok(None) };
        if mode == Mode::Count || arg_bool(args, "multiline") || pattern.contains("\\n") || UNSUPPORTED_REGEX.is_match(pattern) {
            return Ok(None);
        }
        let window = Window::of(args, mode);
        let globs = arg_strings(args, "glob");
        let include_noise = arg_bool(args, "include_noise");
        // `resolvePathRoots`, then `combinedPathRgArgs`' one-filter-set rule: a path inside a noise directory keeps
        // that directory, and a file operand drops the globs.
        let mut roots = Vec::with_capacity(list.len());
        for raw in list {
            if has_glob_magic(raw) || is_unc_or_smb(raw) {
                return Ok(None);
            }
            let abs = resolve_path(&ctx.cwd, raw)?;
            let Ok(stat) = guarded(ctx, "grep", ctx.files.stat(ctx.io.interactive, abs.clone())).await? else {
                return Ok(None);
            };
            let is_file = stat.kind == EntryKind::File;
            let kept: Vec<&str> = if include_noise {
                Vec::new()
            } else {
                NOISE_DIRS.iter().copied().filter(|n| abs.as_path().components().any(|c| c.as_os_str() == *n)).collect()
            };
            let rules = (kept, if is_file { Vec::new() } else { globs.clone() });
            roots.push((raw, abs, is_file, rules));
        }
        if roots.windows(2).any(|w| w[0].3 != w[1].3) {
            return Ok(None);
        }
        let key = |p: &AbsPath| {
            let s = fwd(p.as_path());
            let s = s.trim_end_matches('/').to_owned();
            if cfg!(windows) { s.to_lowercase() } else { s }
        };
        for (i, a) in roots.iter().enumerate() {
            for b in &roots[i + 1..] {
                let (l, r) = (key(&a.1), key(&b.1));
                if l == r || l.starts_with(&format!("{r}/")) || r.starts_with(&format!("{l}/")) {
                    return Ok(None);
                }
            }
        }
        let per_window = if window.limit == usize::MAX { 300 } else { window.offset.saturating_add(window.limit).saturating_add(4) };
        let cap = per_window.saturating_mul(roots.len()).clamp(400, 4000);
        let mut sections = Vec::with_capacity(roots.len());
        let mut seen = 0usize;
        for (raw, _, _, _) in &roots {
            let scanned = self.run_one_root(ctx, raw, args, pattern, &globs, mode, Some(cap + 1 - seen), SearchClass::Interactive, u64::MAX).await;
            let Some(Scanned { hits, complete, error, single_file: is_file, .. }) = declined_on_failure(scanned)? else {
                return Ok(None);
            };
            // A scan its deadline cut declines too (`runCombinedPathFanout` takes only a complete scan).
            if !complete || !error.is_empty() {
                return Ok(None);
            }
            seen += hits.len();
            if seen > cap {
                return Ok(None);
            }
            let mut labelled = label_hits(ctx, raw, is_file, hits)?;
            sort_hits(&mut labelled);
            sections.push((labelled, is_file));
        }
        let mut bodies = Vec::with_capacity(sections.len());
        for (hits, is_file) in &sections {
            bodies.push(if hits.is_empty() {
                no_matches(true)
            } else {
                let shape = Shape { mode, single: *is_file, fanout: false, complete: true, totals: Totals::Combined };
                render(ctx, hits, &window, shape, pattern, budget).await?
            });
        }
        Ok(Some(bodies))
    }
}

static CONTEXT_HEADER: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"^# ([^\n\r\u{2028}\u{2029}]+):([0-9]+) \[lines ([0-9]+)-([0-9]+)\]$").expect("a fixed pattern"));
static MATCH_PREFIX: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r":([0-9]+):|-([0-9]+)-").expect("a fixed pattern"));

/// Node `splitGrepLinePrefix` of a match line: its path and line number when the first
/// `:N:`/`-N-` marker (past a drive letter) is a match marker.
fn match_line_key(line: &str) -> Option<String> {
    let from = if line.len() >= 2 && line.as_bytes()[0].is_ascii_alphabetic() && line.as_bytes()[1] == b':' { 2 } else { 0 };
    let marker = MATCH_PREFIX.captures(&line[from..])?;
    let end = from + marker.get(0)?.start();
    // Only a `:N:` marker is a match line; `-N-` is a context line.
    let number = marker.get(1)?.as_str().parse::<u64>().ok()?;
    (end > 0).then(|| format!("{}\0{number}", &line[..end]))
}

/// Node `dedupeFanoutMatchLines`: drops a numbered match line or a whole context block (keyed by
/// its header's path and match line) an earlier pattern's section already showed.
fn dedupe_fanout_match_lines(body: &str, seen: &mut std::collections::HashSet<String>) -> String {
    if body.starts_with("Error:") {
        return body.to_owned();
    }
    let lines: Vec<&str> = body.split('\n').collect();
    let mut out = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let header = CONTEXT_HEADER.captures(line).and_then(|c| {
            let n = |k: usize| c.get(k)?.as_str().parse::<u64>().ok();
            let (at, start, end) = (n(2)?, n(3)?, n(4)?);
            (start >= 1 && end >= start && (start..=end).contains(&at)).then(|| (format!("{}\0{at}", &c[1]), end - start + 1))
        });
        if let Some((key, rows)) = header {
            let duplicate = !seen.insert(key);
            if !duplicate {
                out.push(line);
            }
            for _ in 0..rows {
                if i + 1 >= lines.len() {
                    break;
                }
                i += 1;
                if !duplicate {
                    out.push(lines[i]);
                }
            }
            i += 1;
            continue;
        }
        if let Some(key) = match_line_key(line)
            && !seen.insert(key)
        {
            i += 1;
            continue;
        }
        out.push(line);
        i += 1;
    }
    out.join("\n")
}

/// The axis of a grep fan-out (Node `formatGrepFanoutSections`' `dimension`).
#[derive(Clone, Copy, PartialEq)]
enum Fanout {
    Pattern,
    Path,
}

/// Node `formatGrepFanoutSections`: `# grep pattern:"x"` (or `# grep <path>`) sections; the patterns or paths that
/// matched nothing named in one closing `(no matches) patterns=[…]` / `paths=[…]` line (bare when all missed); for
/// patterns, one missing path answered once.
fn fanout_sections(dimension: Fanout, patterns: &[String], bodies: &[String]) -> String {
    const MISSING: &str = "Error: path does not exist:";
    let by_pattern = dimension == Fanout::Pattern;
    if by_pattern && bodies.len() > 1 && bodies[0].starts_with(MISSING) && bodies.iter().all(|b| *b == bodies[0]) {
        return bodies[0].clone();
    }
    let mut parts = Vec::new();
    let (mut missed, mut partial_missed) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < patterns.len() {
        let body = &bodies[i];
        if by_pattern && body.starts_with(MISSING) {
            let mut grouped = vec![patterns[i].clone()];
            while i + 1 < patterns.len() && bodies[i + 1] == *body {
                i += 1;
                grouped.push(patterns[i].clone());
            }
            let label = if grouped.len() > 1 {
                format!("patterns:{}", serde_json::to_string(&grouped).unwrap_or_default())
            } else {
                format!("pattern:{}", serde_json::to_string(&grouped[0]).unwrap_or_default())
            };
            parts.push(format!("# grep {label}\n{body}"));
        } else if *body == no_matches(true) {
            missed.push(patterns[i].clone());
        } else if *body == no_matches(false) {
            partial_missed.push(patterns[i].clone());
        } else if !body.trim().is_empty() {
            let label = if by_pattern { format!("pattern:{}", serde_json::to_string(&patterns[i]).unwrap_or_default()) } else { patterns[i].clone() };
            parts.push(format!("# grep {label}\n{body}"));
        }
        i += 1;
    }
    let plural = if by_pattern { "patterns" } else { "paths" };
    for (items, complete) in [(missed, true), (partial_missed, false)] {
        if items.is_empty() {
            continue;
        }
        let scope = if items.len() == patterns.len() {
            String::new()
        } else {
            format!(" {plural}={}", serde_json::to_string(&items).unwrap_or_default())
        };
        parts.push(format!("{}{scope}", no_matches(complete)));
    }
    parts.join("\n\n")
}

fn paging_notice(shown: usize, total: usize, complete: bool, offset: usize, next: usize) -> String {
    if shown == 0 {
        return if complete {
            format!("[0 of {total} shown; offset:{offset} past end]")
        } else {
            format!("[0 shown, results partial; offset:{offset} beyond streamed window; narrow path/glob/pattern]")
        };
    }
    let count = if complete { format!("{shown} of {total} shown") } else { format!("{shown} shown, more exist") };
    format!("\n[{count}; offset:{next} for the rest]")
}

fn no_matches(complete: bool) -> String {
    format!("(no matches{})", if complete { "" } else { " in partial results" })
}

fn mode_of(args: &JsonValue) -> Mode {
    match arg_str(args, "mode") {
        Some("files") => Mode::Files,
        Some("count") => Mode::Count,
        _ => Mode::Content,
    }
}

/// arg-guard.mjs `hasUnsupportedRipgrepRegex`: a lookaround or a backreference.
static UNSUPPORTED_REGEX: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"\(\?(?:[=!]|<[=!])|\\[1-9]").expect("a fixed pattern"));

/// grep-request.mjs `multilineMode`: `multiline: true`, or a pattern with a `\n` escape (`hasRegexNewlineEscape`: an `n`
/// after an odd run of backslashes; `\\n` is a backslash and an `n` on one line).
fn multiline_mode(args: &JsonValue, pattern: &str) -> bool {
    let bytes = pattern.as_bytes();
    arg_bool(args, "multiline")
        || bytes.iter().enumerate().any(|(at, &b)| b == b'n' && bytes[..at].iter().rev().take_while(|&&c| c == b'\\').count() % 2 == 1)
}

/// A root's hits under the names grep shows: a file's path from the cwd, a folder's hits under the folder as given.
fn label_hits(ctx: &ToolContext, raw: &str, is_file: bool, hits: Vec<Hit>) -> Result<Vec<(String, Hit)>, ToolError> {
    let abs = resolve_path(&ctx.cwd, raw)?;
    let prefix = grep_display_root(raw, &abs, &ctx.cwd);
    Ok(hits
        .into_iter()
        .map(|h| {
            let label = if is_file {
                display_path(h.path.as_path(), &ctx.cwd)
            } else {
                format!("{prefix}/{}", display_under(h.path.as_path(), abs.as_path()))
            };
            (label, h)
        })
        .collect())
}

/// One grep's hits over its roots: whether the scan finished, the roots' errors (`all_bad`: every one a refused
/// pattern), and whether the one root is a file.
struct Collected {
    all: Vec<(String, Hit)>,
    complete: bool,
    /// A root's scan reached its soft deadline.
    timed_out: bool,
    /// Files the roots' scans could not read.
    scan_errors: usize,
    errors: Vec<String>,
    single: bool,
    all_bad: bool,
}

fn sort_hits(all: &mut Vec<(String, Hit)>) {
    all.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.line.cmp(&b.1.line)));
    all.dedup_by(|a, b| a.0 == b.0 && a.1.line == b.1.line);
}

/// One call's page: `limit` (`usize::MAX` for none) and `offset` count matches, files or count rows; `context` is the
/// explicit radius (none is the automatic window, 0 bare match lines).
struct Window {
    limit: usize,
    offset: usize,
    context: Option<u64>,
}

impl Window {
    fn of(args: &JsonValue, mode: Mode) -> Self {
        let limit = match arg_u64(args, "limit") {
            Some(0) => usize::MAX,
            // arg-guard.mjs `clampGrepContextHeadLimit`: in content mode the limit counts match blocks, at most 40.
            Some(n) if mode == Mode::Content => (n as usize).min(GREP_CONTEXT_LIMIT_MAX),
            Some(n) => n as usize,
            None => GREP_DEFAULT_LIMIT,
        };
        let offset = arg_u64(args, "offset").unwrap_or(0) as usize;
        // `GREP_CONTEXT_MAX`.
        let context = arg_u64(args, "context").map(|c| c.min(200));
        Self { limit, offset, context }
    }

    /// search-grep-tool.mjs:431 `anchorCap`: the matches the adaptive renderer is fed, `min(4000, max(200, offset +
    /// limit + 4))`, 4000 when unlimited.
    fn anchor_cap(&self) -> usize {
        if self.limit == usize::MAX {
            return 4000;
        }
        self.offset.saturating_add(self.limit).saturating_add(4).clamp(200, 4000)
    }

    /// What one path's scan keeps (the native server's `collect_until`, `limit + offset + 1`): the anchor stream past
    /// its cap, a limited bare listing past its page (`runRgWindowedLines`); an unlimited listing, a file list and
    /// counts read every hit (`runRg`).
    fn stream_bound(&self, mode: Mode) -> Option<usize> {
        match mode {
            Mode::Content if self.context != Some(0) => Some(self.anchor_cap() + 1),
            Mode::Content if self.limit != usize::MAX => Some(self.offset.saturating_add(self.limit).saturating_add(1)),
            _ => None,
        }
    }
}

/// Whether a section's hits are a stream one path's scan cut at its window (the single-path grep), or every hit of a
/// combined scan that finished inside its cap (`runCombinedPathFanout`, whose bodies pass `totalKnown: true`).
#[derive(Clone, Copy, PartialEq)]
enum Totals {
    Streamed,
    Combined,
}

#[derive(Clone, Copy)]
struct Shape {
    mode: Mode,
    /// A file operand's bare lines carry no path (`filenameOmitted`).
    single: bool,
    /// A section of a several-pattern answer: bare lines keep their path, ungrouped.
    fanout: bool,
    /// The scan finished (no deadline).
    complete: bool,
    totals: Totals,
}

async fn render(
    ctx: &ToolContext,
    all: &[(String, Hit)],
    window: &Window,
    shape: Shape,
    pattern: &str,
    budget: usize,
) -> Result<String, ToolError> {
    Ok(match shape.mode {
        Mode::Files => files_body(ctx, all, window, shape).await,
        Mode::Count => count_body(all, window, shape.complete),
        Mode::Content if window.context != Some(0) => adaptive_body(ctx, all, window, shape, pattern, budget).await?,
        Mode::Content => bare_body(all, window, shape),
    })
}

/// `runAdaptiveContextGrep`: the anchors after the stream's cap, whose total is known only when the stream ended inside
/// it; a cut stream says so after the rendering.
async fn adaptive_body(
    ctx: &ToolContext,
    all: &[(String, Hit)],
    window: &Window,
    shape: Shape,
    pattern: &str,
    budget: usize,
) -> Result<String, ToolError> {
    let cap = match shape.totals {
        Totals::Streamed => window.anchor_cap(),
        Totals::Combined => usize::MAX,
    };
    let known = shape.complete && all.len() <= cap;
    let anchors = &all[..all.len().min(cap)];
    let matches = anchors
        .iter()
        .map(|(label, h)| super::grep_context::Match { label, path: &h.path, line: h.line, text: h.text.clone() })
        .collect();
    let text = super::grep_context::expand(ctx, matches, pattern, window.offset, window.limit, known, window.context.unwrap_or(0), budget).await?;
    let mut out = if text.is_empty() { no_matches(known) } else { text };
    if shape.complete && !known {
        out.push_str(&format!(
            "\n[warning] anchor output capped at {cap} matches; results partial — narrow path/glob/pattern for the full match set."
        ));
    }
    Ok(out)
}

/// `formatGrepOutput`'s page: the rows after `offset`, at most `limit`, with the paging line when rows remain or the
/// total is unknown (`total` is `offset` plus the rows after it).
fn page_rows(rows: &[String], window: &Window, known: bool) -> (Vec<String>, String) {
    let after = rows.get(window.offset..).unwrap_or(&[]);
    let page = after[..after.len().min(window.limit)].to_vec();
    let remaining = after.len() - page.len();
    let notice = if remaining > 0 || !known {
        paging_notice(page.len(), window.offset + after.len(), known, window.offset, window.offset + page.len())
    } else {
        String::new()
    };
    (page, notice)
}

/// Bare match lines (`context: 0`): a streamed listing with a limit stopped one match past its page, so it knows its
/// total only when it ended inside the page.
fn bare_body(all: &[(String, Hit)], window: &Window, shape: Shape) -> String {
    let after = all.get(window.offset..).unwrap_or(&[]);
    let known = shape.complete
        && (shape.totals == Totals::Combined || window.limit == usize::MAX || after.len() <= window.limit);
    let page = &after[..after.len().min(window.limit)];
    let mut out = if shape.fanout {
        page.iter().map(|(label, h)| format!("{label}:{}:{}", h.line, h.text)).collect::<Vec<_>>().join("\n")
    } else {
        bare_content(page, shape.single)
    };
    if after.len() > page.len() || !known {
        out.push_str(&paging_notice(page.len(), window.offset + after.len(), known, window.offset, window.offset + page.len()));
    }
    empty_page(out, known, shape.totals)
}

/// An empty page is a no-match answer on its own (`grepEmptyBody`); a combined scan's section body stays empty
/// (`combinedPathBody` / `combinedPatternBody` return `formatGrepOutput`'s text as it is), so the section is left out.
fn empty_page(out: String, known: bool, totals: Totals) -> String {
    if out.is_empty() && totals == Totals::Streamed { no_matches(known) } else { out }
}

/// A file list: one row per file; on its own, newest first with the path breaking ties and files whose stat failed
/// last in path order (`orderFileListLines`); in a combined scan, in scan order. A file whose count comes to 0 is not
/// listed: grep-printer's summary printer (`PathWithMatch`) writes a path only when its first match counts (see
/// [`count_body`]).
async fn files_body(ctx: &ToolContext, all: &[(String, Hit)], window: &Window, shape: Shape) -> String {
    let mut files: Vec<(&str, &AbsPath, u64)> = Vec::new();
    for (label, h) in all {
        match files.last_mut() {
            Some(f) if f.0 == label.as_str() => f.2 += h.count,
            _ => files.push((label, &h.path, h.count)),
        }
    }
    files.retain(|f| f.2 > 0);
    let code_units = |a: &str, b: &str| a.encode_utf16().cmp(b.encode_utf16());
    let rows: Vec<String> = if shape.totals == Totals::Streamed && files.len() > 1 {
        let mut statted = Vec::new();
        let mut unstatted = Vec::new();
        for (label, path, _) in files {
            match mtime_millis(ctx, path).await {
                Some(ms) => statted.push((label, ms)),
                None => unstatted.push(label),
            }
        }
        statted.sort_by(|a, b| b.1.cmp(&a.1).then(code_units(a.0, b.0)));
        unstatted.sort_by(|a, b| code_units(a, b));
        statted.into_iter().map(|(l, _)| l.to_owned()).chain(unstatted.into_iter().map(str::to_owned)).collect()
    } else {
        files.into_iter().map(|(l, _, _)| l.to_owned()).collect()
    };
    let (page, notice) = page_rows(&rows, window, shape.complete);
    empty_page(format!("{}{notice}", page.join("\n")), shape.complete, shape.totals)
}

/// `path:count` rows in path order (code units), each file's count its lines' ([`Hit::count`]), the summary counting
/// the rows shown (`grepCountSummary`); with no row the summary alone. A file whose count comes to 0 has no row, as
/// grep-printer's summary printer leaves it out (serve_search/matching.rs `exclude_zero(true)`): a multi-line match
/// whose recount, at most 128 bytes past it, finds nothing.
fn count_body(all: &[(String, Hit)], window: &Window, complete: bool) -> String {
    let mut rows: Vec<(String, u64)> = Vec::new();
    for (label, h) in all {
        match rows.last_mut() {
            Some((l, n)) if l == label => *n += h.count,
            _ => rows.push((label.clone(), h.count)),
        }
    }
    rows.retain(|(_, n)| *n > 0);
    rows.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let rows: Vec<String> = rows.into_iter().map(|(p, n)| format!("{p}:{n}")).collect();
    let (page, notice) = page_rows(&rows, window, complete);
    let total: usize = page.iter().filter_map(|r| r.rsplit(':').next()?.parse::<usize>().ok()).sum();
    let files = page.len();
    format!(
        "{}{notice}\n[total {total} match{} across {files} file{}]",
        page.join("\n"),
        if total == 1 { "" } else { "es" },
        if files == 1 { "" } else { "s" }
    )
}

fn bare_content(page: &[(String, Hit)], single: bool) -> String {
    if single {
        return page.iter().map(|(_, h)| format!("{}:{}", h.line, h.text)).collect::<Vec<_>>().join("\n");
    }
    let mut groups: Vec<(&str, Vec<&Hit>)> = Vec::new();
    for (label, h) in page {
        match groups.last_mut() {
            Some((l, v)) if *l == label.as_str() => v.push(h),
            _ => groups.push((label.as_str(), vec![h])),
        }
    }
    let mut out = Vec::new();
    for (label, hits) in groups {
        out.push(if hits.len() == 1 { label.to_owned() } else { format!("{label} ({} hits)", hits.len()) });
        for h in hits {
            out.push(format!("  {}: {}", h.line, h.text));
        }
    }
    out.join("\n")
}

#[allow(dead_code)]
fn _unused(_: ToolError, _: ToolErrorCode) {}

#[cfg(test)]
mod count_rows {
    use super::*;

    /// A file whose lines count 0 in all (multi-line matches whose recount found nothing) has no row, as grep-printer's
    /// summary printer leaves it out (`exclude_zero(true)`); the summary counts the rows shown.
    #[test]
    fn a_file_counting_zero_has_no_row() {
        let path = AbsPath::new(if cfg!(windows) { "C:\\a" } else { "/a" }).expect("an absolute path");
        let hit = |count| Hit { path: path.clone(), line: 1, text: String::new(), count };
        let all = vec![("./a.ts".to_owned(), hit(2)), ("./a.ts".to_owned(), hit(0)), ("./b.ts".to_owned(), hit(0))];
        let window = Window { limit: usize::MAX, offset: 0, context: None };
        assert_eq!(count_body(&all, &window, true), "./a.ts:2\n[total 2 matches across 1 file]");
    }
}
