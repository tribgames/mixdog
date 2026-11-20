//! `glob`, `find` and `grep` over the file service's walk and text-search
//! streams, which run on the maintenance lane (T §3.3).

use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashSet};
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use globset::Glob;
use globset::GlobBuilder;
use globset::GlobMatcher;
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
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use nucleo_matcher::Config as FuzzyConfig;
use nucleo_matcher::Matcher as FuzzyMatcher;
use nucleo_matcher::Utf32String;
use nucleo_matcher::pattern::AtomKind;
use nucleo_matcher::pattern::CaseMatching;
use nucleo_matcher::pattern::Normalization;
use nucleo_matcher::pattern::Pattern;

use super::common::*;
use super::grep_context::SourceCache;

type GrepIo<'a> = (&'a ToolContext, &'a mut SourceCache);
use super::read::ReadTool;
use super::read::in_noise_dir;
use crate::orch::util::spec_from_def;

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

/// Broad-search refusal prefixes: admission expiry names the wait; expiry after admission names the remaining
/// budget, which also covers producer waiting. The tools answer both as they answer a full queue ([`broad_search`]).
const BROAD_REFUSALS: [&str; 4] =
    ["broad search not started: ", "native file inventory search exceeded its ", "native fuzzy search exceeded its ", "native content search exceeded its "];

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

/// path-utils.mjs `normalizeCompactSurfaceArgs` and `promoteSharedSearchAliases`: the legacy spellings the compact
/// surface still receives. `head_limit` is the `limit` (and wins over it); with `path_aliases` a missing `path` is the
/// first present `root`/`directory`/`dir`.
fn promote_legacy_args(mut args: JsonValue, path_aliases: bool) -> JsonValue {
    let Some(map) = args.as_object_mut() else { return args };
    if let Some(head) = map.shift_remove("head_limit").filter(|v| !v.is_null()) {
        map.insert("limit".to_owned(), head);
    }
    // arg-guard.mjs `coerceIntegerString`: a numeric string (`-?\d+(\.\d+)?`, integral) is its number.
    for key in ["limit", "offset"] {
        let coerced = map.get(key).and_then(JsonValue::as_str).and_then(|s| {
            let t = mixdog_js::js_trim(s);
            let unsigned = t.strip_prefix('-').unwrap_or(t);
            let (whole, fraction) = unsigned.split_once('.').map_or((unsigned, None), |(w, f)| (w, Some(f)));
            let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
            let number = (digits(whole) && fraction.is_none_or(digits)).then(|| t.parse::<f64>().ok()).flatten()?;
            (number.is_finite() && number.fract() == 0.0).then_some(number as i64)
        });
        if let Some(number) = coerced {
            map.insert(key.to_owned(), number.into());
        }
    }
    let blank = |v: Option<&JsonValue>| v.is_none_or(|v| v.is_null() || v.as_str() == Some(""));
    if path_aliases && blank(map.get("path")) {
        let alias = ["root", "directory", "dir"].iter().find_map(|key| map.get(*key).filter(|v| v.is_string() && !blank(Some(v))).cloned());
        if let Some(alias) = alias {
            map.insert("path".to_owned(), alias);
        }
    }
    args
}

/// Marks a request that named `output_mode:"content"` with no context flag (set by [`promote_output_mode`]).
const BARE_CONTENT: &str = "_bareContent";

/// grep-request.mjs `resolveGrepWindow`: an explicit `output_mode` is the grep's mode (`content` is the bare listing,
/// `content_with_context` and no mode the one with the automatic window, which is this surface's `content`).
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
fn promote_output_mode(mut args: JsonValue) -> Result<JsonValue, ToolError> {
    let Some(map) = args.as_object_mut() else { return Ok(args) };
    let Some(raw) = map.get("output_mode").and_then(JsonValue::as_str).map(|s| mixdog_js::js_trim(s).to_owned()).filter(|s| !s.is_empty()) else {
        return Ok(args);
    };
    let (mode, bare) = match raw.as_str() {
        "files_with_matches" => ("files", false),
        "count" => ("count", false),
        "content" => ("content", true),
        "content_with_context" => ("content", false),
        _ => {
            let shown = serde_json::to_string(&map["output_mode"]).unwrap_or_default();
            return Err(invalid(
                "output_mode",
                "enum",
                format!("Error: invalid output_mode {shown}; expected one of files_with_matches, content, content_with_context, count"),
            ));
        }
    };
    map.shift_remove("output_mode");
    map.insert("mode".to_owned(), mode.into());
    if bare && map.get("context").is_none_or(JsonValue::is_null) {
        map.insert("context".to_owned(), 0.into());
        // `clampGrepContextHeadLimit` leaves a bare `content` request without context flags unclamped.
        map.insert(BARE_CONTENT.to_owned(), true.into());
    }
    Ok(args)
}

/// Gitignore-style globs (`!` excludes) in the order given: the last glob that matches a path decides it, as rg's later
/// glob wins; a path no glob matches is kept only when there is no positive glob.
struct OrderedGlobs {
    rules: Vec<(GlobMatcher, bool)>,
    any_include: bool,
}

impl OrderedGlobs {
    fn keeps(&self, relative: &str) -> bool {
        self.rules.iter().rev().find(|(glob, _)| glob.is_match(relative)).map_or(!self.any_include, |(_, negated)| !negated)
    }
}

#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
fn compile_globs(patterns: &[String]) -> Result<OrderedGlobs, ToolError> {
    let mut rules = Vec::with_capacity(patterns.len());
    let mut any_include = false;
    for raw in patterns {
        let (neg, body) = match raw.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, raw.as_str()),
        };
        // On POSIX a backslash is a glob escape; `canonical_glob_slashes` already made it a separator on Windows.
        let mut p = body.trim().to_owned();
        // A leading `/` anchors the glob at the walk root, as rg reads it.
        let anchored = p.starts_with('/');
        p = p.trim_start_matches("./").trim_start_matches('/').to_owned();
        if p.ends_with('/') {
            p.push_str("**");
        }
        if !anchored && !p.contains('/') {
            p = format!("**/{p}");
        }
        let glob: Glob =
            GlobBuilder::new(&p).literal_separator(true).build().map_err(|e| invalid("pattern", "glob", format!("Error: invalid glob {raw:?}: {e}")))?;
        any_include |= !neg;
        rules.push((glob.compile_matcher(), neg));
    }
    Ok(OrderedGlobs { rules, any_include })
}

/// The mtime in ms (0 when the file service has none); `None` when the stat failed.
async fn mtime_millis(ctx: &ToolContext, path: &AbsPath) -> Option<u128> {
    let stat = ctx.files.stat(ctx.io.interactive, path.clone()).await.ok()?;
    Some(epoch_millis(stat.modified))
}

async fn locator_mtime(ctx: &ToolContext, path: &AbsPath) -> Option<u128> {
    let stat = ctx.files.stat_for_locator(ctx.io.interactive, path.clone()).await.ok()?;
    Some(epoch_millis(stat.modified))
}

fn epoch_millis(modified: Option<std::time::SystemTime>) -> u128 {
    modified.and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis())
}

/// Lower ranks are better; only the current worst retained rank can be displaced.
struct Top<T: Ord> {
    bound: usize,
    ranks: BinaryHeap<T>,
}

impl<T: Ord> Top<T> {
    fn new(bound: usize) -> Self {
        Self { bound, ranks: BinaryHeap::new() }
    }

    fn push(&mut self, rank: T) {
        if self.ranks.len() < self.bound {
            self.ranks.push(rank);
        } else if let Some(mut worst) = self.ranks.peek_mut()
            && rank < *worst
        {
            *worst = rank;
        }
    }

    fn sorted(self) -> Vec<T> {
        self.ranks.into_sorted_vec()
    }

    fn into_page(self, offset: usize) -> impl Iterator<Item = T> {
        let mut ranks = self.ranks.into_vec();
        let offset = offset.min(ranks.len());
        if offset > 0 && offset < ranks.len() {
            ranks.select_nth_unstable(offset);
        }
        ranks[offset..].sort_unstable();
        ranks.into_iter().skip(offset)
    }
}

/// Node's `searchIoAdmission` (`tool-workload-gates.mjs`, `search-admission.mjs`): broad searches (a `--files` walk, a fuzzy
/// find, a bulk grep) take turns in the process, and the others wait behind them, session by session
/// (`createOwnerFairGate`: a free turn goes round the sessions that wait, not to the oldest waiter). Node holds one turn,
/// its one search server on a single-threaded host; the core's many sessions run [`broad_search_limit`] at once, and no
/// session is handed the last free turn while another session waits.
static BROAD_SEARCH: std::sync::LazyLock<mixdog_rt::OwnerGate> = std::sync::LazyLock::new(|| mixdog_rt::OwnerGate::with_limit(broad_search_limit()));

/// The broad searches that run at once: `MIXDOG_BROAD_SEARCH_MAX_INFLIGHT` above 0, else the available parallelism
/// within 2..=8 (as the content search's `SchedulerConfig::from_env` derives its `total`); then within 1..=16. 1 is
/// Node's one at a time.
fn broad_search_limit() -> usize {
    let available = std::thread::available_parallelism().map_or(2, |n| n.get());
    std::env::var("MIXDOG_BROAD_SEARCH_MAX_INFLIGHT")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| available.clamp(2, 8))
        .clamp(1, 16)
}

/// The process's broad-search gate, for tests that hold its turns or set its limit.
#[cfg(test)]
pub(super) fn broad_search_gate() -> &'static mixdog_rt::OwnerGate {
    &BROAD_SEARCH
}

/// What a tool call's broad searches waited for admission and ran, summed over the call ([`with_broad_times`]).
#[derive(Default)]
struct BroadTimes {
    /// The call's id, tool and session, from its first broad search.
    call: Option<(String, String, String)>,
    searches: u64,
    wait_ms: u64,
    run_ms: u64,
}

tokio::task_local! {
    static BROAD_TIMES: std::cell::RefCell<BroadTimes>;
}

/// A tool call that may run broad searches: its answer's local-search telemetry (`meta.localSearchTelemetry`, the trace
/// row's `local_search`) gets `broad_searches`, `broad_wait_ms` (the time they waited for their turns, a refused one's
/// whole wait included) and `broad_run_ms` (the time they ran once admitted), so a slow call tells waiting from running.
/// Node has no such keys; they are the core's own, beside Node's `broad_admissions`/`broad_admission_wait_ms`.
///
/// Every outcome, a refusal or a cancel included, is also told to the process trace (target `broad_search`, with the
/// call's id, tool and session), since a failed call's trace row carries no telemetry of its tool.
pub(super) async fn with_broad_times(call: impl Future<Output = ToolOutcome>) -> ToolOutcome {
    let (times, outcome) = BROAD_TIMES
        .scope(std::cell::RefCell::new(BroadTimes::default()), async {
            let outcome = call.await;
            (BROAD_TIMES.with(|times| times.take()), outcome)
        })
        .await;
    if times.searches == 0 {
        return outcome;
    }
    let (call, tool, session) = times.call.as_ref().map_or(("", "", ""), |(call, tool, session)| (call.as_str(), tool.as_str(), session.as_str()));
    let result = match &outcome {
        Ok(_) => "ok",
        Err(e) if matches!(e.code, ToolErrorCode::Cancelled) => "cancelled",
        Err(_) => "failed",
    };
    tracing::info!(
        target: "broad_search",
        call_id = call,
        tool,
        session,
        result,
        searches = times.searches,
        wait_ms = times.wait_ms,
        run_ms = times.run_ms,
        "broad search admission wait and run"
    );
    let mut output = outcome?;
    let meta = output.meta.get_or_insert_with(|| JsonValue::Object(serde_json::Map::new()));
    if let Some(meta) = meta.as_object_mut() {
        let telemetry = meta.entry(LOCAL_SEARCH_META).or_insert_with(|| JsonValue::Object(serde_json::Map::new()));
        if let Some(telemetry) = telemetry.as_object_mut() {
            telemetry.insert("broad_searches".to_owned(), times.searches.into());
            telemetry.insert("broad_wait_ms".to_owned(), times.wait_ms.into());
            telemetry.insert("broad_run_ms".to_owned(), times.run_ms.into());
        }
    }
    Ok(output)
}

/// Adds one broad search of `ctx`'s call, its wait and run, to the call's [`BroadTimes`]; outside [`with_broad_times`]
/// there is none to add to.
fn record_broad_times(ctx: &ToolContext, wait_ms: u64, run_ms: u64) {
    let _ = BROAD_TIMES.try_with(|times| {
        let mut sum = times.borrow_mut();
        sum.call.get_or_insert_with(|| (ctx.call_id.as_str().to_owned(), ctx.tool.clone(), ctx.thread_id.as_str().to_owned()));
        sum.searches += 1;
        sum.wait_ms = sum.wait_ms.saturating_add(wait_ms);
        sum.run_ms = sum.run_ms.saturating_add(run_ms);
    });
}

/// A tree listing's walk (`list` with `mode: "tree"`), as `work` given its budget: a broad search, admitted and bounded
/// as a deep list's inventory is ([`broad_listing`]).
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
pub(super) async fn broad_tree<T, W: Future<Output = Result<T, ToolError>>>(ctx: &ToolContext, work: impl FnOnce(u64) -> W) -> Result<T, ToolError> {
    broad_search(ctx, BROAD_REFUSALS[1], work).await
}

/// The gate's owner key of a call. Node's is the session id of the loop that ran the tool (`executeTool`'s
/// `callerSessionId`, `runWithToolExecutionOwner`, tool-execution-owner.mjs), which is the thread id here: a sub-agent's
/// run has its own session and so its own thread, never its parent's; the core keys a session by its thread id, so a
/// session's threads are the owners its sessions are in Node. A call with no session is `anonymous`, and the key is trimmed and cut at 240
/// characters (owner-fair-gate.mjs `run`).
fn gate_owner(thread: &str) -> String {
    let owner: String = thread.trim().chars().take(240).collect();
    if owner.is_empty() { "anonymous".to_owned() } else { owner }
}

/// The broad searches running and waiting on [`BROAD_SEARCH`], so a refusal can say what the search waited behind.
static BROAD_RUNNING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static BROAD_WAITING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A count held for as long as the value lives.
struct Counted(&'static std::sync::atomic::AtomicUsize);

impl Counted {
    fn new(count: &'static std::sync::atomic::AtomicUsize) -> Self {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(count)
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// How a broad search came by its turn, and how long its work then ran.
pub(super) struct Turn {
    /// It waited behind another search. Node tells such a search's admission to whichever call was running when the
    /// turn was handed over (`onAdmit` runs in the dispatching call's context), so it is not the search's own to report.
    pub queued: bool,
    /// From the turn to the work's end (the wait before it goes to the call's [`BroadTimes`]).
    pub ran_ms: u64,
}

#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn require_dir(ctx: &ToolContext, raw: &str, abs: &AbsPath) -> Result<Option<String>, ToolError> {
    match guarded(ctx, "search", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
        Ok(_) => Ok(None),
        // Several paths joined in one string (and one of them there): glob's own repair, not a suggestion built from the joined text.
        Err(e) if super::not_found::missing_code(&e.kind).is_some() && super::not_found::joined_list(raw) => {
            let code = super::not_found::missing_code(&e.kind).unwrap_or("ENOENT");
            if let Some(text) = super::not_found::joined_path_answer(ctx, abs, raw, code, super::not_found::PathTool::Glob).await {
                return Ok(Some(text));
            }
            // No part of it exists: nothing says it is a list, so no list is claimed.
            Ok(Some(super::not_found::missing_with_tool(ctx, abs, raw, code, super::not_found::PathTool::Glob).await))
        }
        Err(e) if matches!(e.kind, FsErrorKind::NotFound | FsErrorKind::NotADirectory) => {
            let hint = ReadTool::not_found(ctx, raw, abs).await;
            let hint = hint.trim_start_matches("[path absent] ENOENT: no such file or directory, stat ");
            Ok(Some(format!("Error: path does not exist: {} (ENOENT) {hint}", fwd(abs.as_path()))))
        }
        Err(e) => Err(fs_failure(&e, raw)),
    }
}

/// Node's `isAbsolute` of a glob pattern: on Windows a rooted `/x` counts too.
fn is_absolute_pattern(pattern: &str) -> bool {
    pattern.starts_with('/') || Path::new(pattern).is_absolute()
}

/// `requestedGlobPatterns`: each pattern as `normalizeInputPath` (`~` expanded) and `canonicalizeGlobSlashes` leave it,
/// without repeats.
pub(super) fn glob_patterns(args: &JsonValue) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for pattern in arg_strings(args, "pattern").iter().filter(|p| !p.is_empty()) {
        let pattern = canonical_glob_slashes(&super::read::normalize_input_path(pattern));
        if !out.contains(&pattern) {
            out.push(pattern);
        }
    }
    out
}

/// The `path` and patterns as the glob reads them, shared by the call and its cache roots: `path` as `normalizeInputPath`
/// leaves it (`~` expanded; search-glob-tool.mjs:553), and a glob written as the path (with no pattern) is the pattern,
/// searched from the cwd (`requestedGlobPatterns`), unless the path is a UNC or device spelling, which stays a path to be refused.
pub(super) fn glob_scope(path: Option<&str>, mut patterns: Vec<String>) -> (String, Vec<String>) {
    let mut path = super::read::normalize_input_path(path.unwrap_or("."));
    if path.is_empty() {
        path = ".".to_owned();
    }
    let unc = is_unc_or_smb(&path) || win32_unc_resolution(&path).is_some();
    if !unc && patterns.is_empty() && has_glob_magic(&path) {
        patterns = vec![canonical_glob_slashes(&path)];
        path = ".".to_owned();
    }
    (path, patterns)
}

/// `globBaseEntry`: the walk root and pattern prefix of a `path` carrying glob magic, unless it literally names a directory.
async fn wildcard_scope(ctx: &ToolContext, raw: &str) -> (String, String) {
    let literal = async {
        let abs = resolve_path(&ctx.cwd, raw).ok()?;
        ctx.files.stat(ctx.io.interactive, abs).await.ok().filter(|stat| stat.kind == EntryKind::Dir)
    };
    if !has_glob_magic(raw) || literal.await.is_some() {
        return (raw.to_owned(), String::new());
    }
    let (base, rest) = extract_glob_base_directory(&canonical_glob_slashes(raw));
    let mut segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    // A trailing `*` ("cache/*") is the children themselves: the pattern supplies the leaf match.
    if segments.last() == Some(&"*") {
        segments.pop();
    }
    (base.unwrap_or_else(|| ".".to_owned()), segments.join("/"))
}

/// path-utils.mjs `canonicalizeGlobSlashes`: rg reads `/` only, so on Windows a glob's `\` is a separator.
fn canonical_glob_slashes(glob: &str) -> String {
    if cfg!(windows) { glob.replace('\\', "/") } else { glob.to_owned() }
}

/// The base used by each glob group, including groups outside the caller's project.
pub fn glob_result_roots(args: &JsonValue) -> Option<Vec<String>> {
    let args = promote_legacy_args(args.clone(), true);
    let given = super::common::optional_path_arg(&args, "path", |_| String::new()).ok()?;
    let (mut path, patterns) = glob_scope(given, glob_patterns(&args));
    // A `path` naming a set of directories is walked from its static base, as the call does; a directory literally so
    // named lies below that base, so the base covers it.
    if has_glob_magic(&path) && !is_unc_or_smb(&path) && win32_unc_resolution(&path).is_none() {
        path = extract_glob_base_directory(&canonical_glob_slashes(&path)).0.unwrap_or_else(|| ".".to_owned());
    }
    let mut roots = Vec::new();
    if patterns.is_empty() || patterns.iter().any(|p| !is_absolute_pattern(p.trim_start_matches('!'))) {
        roots.push(path.clone());
    }
    roots.extend(patterns.iter().filter(|p| is_absolute_pattern(p)).map(|p| extract_glob_base_directory(p).0.unwrap_or_else(|| path.clone())));
    Some(roots)
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
                let inner: String = rest[..end].chars().map(|c| if matches!(c, '\\' | '[' | '&' | '~') { format!("\\{c}") } else { c.to_string() }).collect();
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
        Self { spec: spec_from_def(GLOB_SPEC, true, &[]) }
    }
}

impl Default for GlobTool {
    fn default() -> Self {
        Self::new()
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

// ---------------------------------------------------------------------------
// find

pub struct FindTool {
    spec: ToolSpec,
}

impl FindTool {
    pub fn new() -> Self {
        Self { spec: spec_from_def(FIND_SPEC, true, &[]) }
    }
}

impl Default for FindTool {
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
    static SPLIT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r":([0-9]+):").expect("a fixed pattern"));
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
    let under_cwd = Path::new(raw.trim()).is_absolute().then(|| root.as_path().strip_prefix(cwd.as_path()).ok().map(fwd)).flatten();
    let shown = match under_cwd {
        Some(rel) if rel.is_empty() => ".".to_owned(),
        Some(rel) => rel,
        None => given,
    };
    shown.trim_end_matches('/').trim_start_matches("./").to_owned().pipe_dot()
}

trait PipeDot {
    fn pipe_dot(self) -> String;
}
impl PipeDot for String {
    fn pipe_dot(self) -> String {
        if self.is_empty() { ".".to_owned() } else { self }
    }
}

/// A combined scan's or a prefilter's failure declines it, as Node's callers catch it (`streamCombinedLines`,
/// `fanoutPrefilterCandidates`, `runCombinedPathFanout`); a cancel ends the call, and so does a refusal at admission: the
/// search never started, the budget is spent waiting, and another strategy would be a second search on no budget. (Node
/// swallowed it and ran the per-pattern greps; that is a decided departure, listed in `departures.json`.)
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
fn declined_on_failure<T>(outcome: Result<T, ToolError>) -> Result<Option<T>, ToolError> {
    match outcome {
        Ok(value) => Ok(Some(value)),
        Err(e) if matches!(e.code, ToolErrorCode::Cancelled) || refused_with(&e).is_some_and(|reason| reason.starts_with(BROAD_REFUSALS[0])) => Err(e),
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

/// The deadline can expire while waiting for a producer, not only while scanning.
const TIMEOUT_WARNING: &str = "\n[warning] search deadline reached; partial results shown.";

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
    format!("\n[warning] rg exit 2 (partial results): {scan_errors} file(s) could not be read (permission or I/O error); matches from those files are missing")
}

static CONTEXT_HEADER: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"^# ([^\n\r\u{2028}\u{2029}]+):([0-9]+) \[lines ([0-9]+)-([0-9]+)\]$").expect("a fixed pattern"));
static MATCH_PREFIX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r":([0-9]+):|-([0-9]+)-").expect("a fixed pattern"));

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
        let scope = if items.len() == patterns.len() { String::new() } else { format!(" {plural}={}", serde_json::to_string(&items).unwrap_or_default()) };
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
    arg_bool(args, "multiline") || bytes.iter().enumerate().any(|(at, &b)| b == b'n' && bytes[..at].iter().rev().take_while(|&&c| c == b'\\').count() % 2 == 1)
}

/// A root's hits under the names grep shows: a file's path from the cwd, a folder's hits under the folder as given.
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
fn label_hits(ctx: &ToolContext, raw: &str, is_file: bool, hits: Vec<Hit>) -> Result<Vec<(String, Hit)>, ToolError> {
    let abs = resolve_path(&ctx.cwd, raw)?;
    let prefix = grep_display_root(raw, &abs, &ctx.cwd);
    Ok(hits
        .into_iter()
        .map(|h| {
            let label = if is_file { display_path(h.path.as_path(), &ctx.cwd) } else { format!("{prefix}/{}", display_under(h.path.as_path(), abs.as_path())) };
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

fn sort_hits(all: &mut Vec<(String, Hit)>, mode: Mode) {
    if mode == Mode::Count {
        // Display paths can be lossy (including Unix backslashes). The absolute path still identifies the file.
        all.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.path.as_path().cmp(b.1.path.as_path())));
        all.dedup_by(|a, b| a.0 == b.0 && a.1.path == b.1.path);
    } else {
        all.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.line.cmp(&b.1.line)));
        all.dedup_by(|a, b| a.0 == b.0 && a.1.line == b.1.line);
    }
}

/// What one section's rendering delivered: its text, how many whole results, and where the next begins when the byte
/// cap or the result limit cut it (`None`: nothing was left behind). `oversize`: its first result alone passes the cap,
/// so none is shown; it is named, and `next` is the result after it.
struct Paged {
    text: String,
    next: Option<usize>,
    delivered: usize,
    oversize: bool,
    /// The byte cap, not the result limit, left `next` behind.
    by_cap: bool,
}

impl Paged {
    /// An answer with no results of its own (an error): nothing delivered, nothing left.
    fn whole(text: String) -> Self {
        Self { text, next: None, delivered: 0, oversize: false, by_cap: false }
    }

    /// A page of `window` over `available` results after its offset, rendered as the window gave it: the results it
    /// delivered, and the offset of the first one the limit left behind.
    fn of(text: String, window: &Window, available: usize) -> Self {
        let delivered = available.min(window.limit);
        let next = (available > window.limit).then(|| window.offset + window.limit);
        Self { text, next, delivered, oversize: false, by_cap: false }
    }
}

/// `path` and line of a rendered result's first line (`# path:line [lines a-b]` or `path:line:text`).
fn unit_location(first: &str) -> Option<(String, u64)> {
    static LOCATION: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^(?:# )?(.+?):([0-9]+)(?:[: ]|$)").expect("a fixed pattern"));
    let found = LOCATION.captures(first)?;
    Some((found[1].to_owned(), found[2].parse().ok()?))
}

/// What an [`oversize_notice`] says of the result, before the cap it passes.
const OVERSIZE_MARK: &str = "alone is larger than the";

/// The answer when the first result after the offset is larger than the cap by itself: it is named, and read directly. A
/// section of a compound answer goes on after it with its cursor.
pub(super) fn oversize_notice(cap: usize, offset: usize, first: &str, at: Option<(String, u64)>) -> String {
    let shown: String = first.chars().take(160).collect();
    let read = at
        .map(|(path, line)| format!(" Read it with read {}.", serde_json::json!({ "file_path": path, "offset": line.saturating_sub(3).max(1), "limit": 9 })))
        .unwrap_or_default();
    format!("[result {offset} {OVERSIZE_MARK} {} response limit, so none is shown here: {shown}…]{read}", format_cap_size(cap))
}

/// One call's page: `limit` (`usize::MAX` for none) and `offset` count matches, files or count rows; `context` is the
/// explicit radius (none is the automatic window, 0 bare match lines).
#[derive(Clone, Copy)]
struct Window {
    limit: usize,
    offset: usize,
    context: Option<u64>,
    /// `-i`: the anchors' branch ranking matches case-insensitively, as the scan did.
    case_insensitive: bool,
}

impl Window {
    fn of(args: &JsonValue, mode: Mode) -> Self {
        let limit = match arg_u64(args, "limit") {
            Some(0) => usize::MAX,
            // arg-guard.mjs `clampGrepContextHeadLimit`: in content mode the limit counts match blocks, at most 40.
            Some(n) if mode == Mode::Content && args.get(BARE_CONTENT).is_none() => (n as usize).min(GREP_CONTEXT_LIMIT_MAX),
            Some(n) => n as usize,
            None => env_default_limit("MIXDOG_GREP_DEFAULT_HEAD_LIMIT", GREP_DEFAULT_LIMIT),
        };
        let offset = arg_u64(args, "offset").unwrap_or(0) as usize;
        // `GREP_CONTEXT_MAX`.
        let context = arg_u64(args, "context").map(|c| c.min(200));
        Self { limit, offset, context, case_insensitive: args.get("-i") == Some(&JsonValue::Bool(true)) }
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

struct PageRender<'a> {
    all: &'a [(String, Hit)],
    errors: &'a [String],
    shape: Shape,
    pattern: &'a str,
    budget: usize,
    partial: &'a str,
}

impl PageRender<'_> {
    async fn compose(&self, io: GrepIo<'_>, window: Window, prefix: bool) -> Result<String, ToolError> {
        let mut text = render(io, self.all, &window, self.shape, self.pattern, self.budget, prefix).await?;
        for e in self.errors {
            text.push('\n');
            text.push_str(e);
        }
        text.push_str(self.partial);
        Ok(text)
    }
}

#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn render(io: GrepIo<'_>, all: &[(String, Hit)], window: &Window, shape: Shape, pattern: &str, budget: usize, prefix: bool) -> Result<String, ToolError> {
    Ok(match shape.mode {
        Mode::Files => files_body(io.0, all, window, shape).await,
        Mode::Count => count_body(all, window, shape.complete),
        Mode::Content if window.context != Some(0) => adaptive_body(io, all, window, shape, pattern, budget, prefix).await?,
        Mode::Content => bare_body(all, window, shape),
    })
}

/// `runAdaptiveContextGrep`: the anchors after the stream's cap, whose total is known only when the stream ended inside
/// it; a cut stream says so after the rendering.
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn adaptive_body(
    io: GrepIo<'_>,
    all: &[(String, Hit)],
    window: &Window,
    shape: Shape,
    pattern: &str,
    budget: usize,
    prefix: bool,
) -> Result<String, ToolError> {
    let cap = match shape.totals {
        Totals::Streamed => window.anchor_cap(),
        Totals::Combined => usize::MAX,
    };
    let known = shape.complete && all.len() <= cap;
    let anchors = &all[..all.len().min(cap)];
    let matches = anchors.iter().map(|(label, h)| super::grep_context::Match { label, path: &h.path, line: h.line, text: h.text.clone() }).collect();
    let text = super::grep_context::expand(
        io,
        matches,
        pattern,
        window.case_insensitive,
        window.offset,
        window.limit,
        known,
        window.context.unwrap_or(0),
        budget,
        prefix,
    )
    .await?;
    let mut out = if text.is_empty() { no_matches(known) } else { text };
    if shape.complete && !known {
        out.push_str(&format!("\n[warning] anchor output capped at {cap} matches; results partial — narrow path/glob/pattern for the full match set."));
    }
    Ok(out)
}

/// `formatGrepOutput`'s page: the rows after `offset`, at most `limit`, with the paging line when rows remain or the
/// total is unknown (`total` is `offset` plus the rows after it).
fn page_rows<'a, T>(rows: &'a [T], window: &Window, known: bool) -> (&'a [T], String) {
    let after = rows.get(window.offset..).unwrap_or(&[]);
    let page = &after[..after.len().min(window.limit)];
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
    let known = shape.complete && (shape.totals == Totals::Combined || window.limit == usize::MAX || after.len() <= window.limit);
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
    let rows: Vec<&str> = if shape.totals == Totals::Streamed && files.len() > 1 {
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
        statted.into_iter().map(|(l, _)| l).chain(unstatted).collect()
    } else {
        files.into_iter().map(|(l, _, _)| l).collect()
    };
    let (page, notice) = page_rows(&rows, window, shape.complete);
    empty_page(format!("{}{notice}", page.join("\n")), shape.complete, shape.totals)
}

/// `path:count` rows in path order (code units), each file's count its lines' ([`Hit::count`]), the summary counting
/// the rows shown (`grepCountSummary`); with no row the summary alone. A file whose count comes to 0 has no row, as
/// grep-printer's summary printer leaves it out (serve_search/matching.rs `exclude_zero(true)`): a multi-line match
/// whose recount, at most 128 bytes past it, finds nothing.
fn count_body(all: &[(String, Hit)], window: &Window, complete: bool) -> String {
    let mut rows: Vec<(&str, u64)> = all.iter().filter(|(_, h)| h.count > 0).map(|(label, h)| (label.as_str(), h.count)).collect();
    rows.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let (page, notice) = page_rows(&rows, window, complete);
    let total: u64 = page.iter().map(|(_, n)| n).sum();
    let files = page.len();
    format!(
        "{}{notice}\n[total {total} match{} across {files} file{}]",
        page.iter().map(|(p, n)| format!("{p}:{n}")).collect::<Vec<_>>().join("\n"),
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
        let all = vec![("./a.ts".to_owned(), hit(2)), ("./b.ts".to_owned(), hit(0))];
        let window = Window { limit: usize::MAX, offset: 0, context: None, case_insensitive: false };
        assert_eq!(count_body(&all, &window, true), "./a.ts:2\n[total 2 matches across 1 file]");
    }

    #[test]
    fn count_rows_keep_distinct_files_with_the_same_display_label() {
        let root = AbsPath::new(if cfg!(windows) { "C:\\a" } else { "/a" }).expect("an absolute path");
        let row = |file, count| ("./same.ts".to_owned(), Hit { path: root.join(file), line: 0, text: String::new(), count });
        let mut all = vec![row("b.ts", 3), row("a.ts", 2), row("a.ts", 2)];
        sort_hits(&mut all, Mode::Count);
        let window = Window { limit: usize::MAX, offset: 0, context: None, case_insensitive: false };
        assert_eq!(count_body(&all, &window, true), "./same.ts:2\n./same.ts:3\n[total 5 matches across 2 files]");
    }
}

#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
#[cfg(test)]
pub(super) async fn walk_entries_pruned(
    ctx: &ToolContext,
    root: &AbsPath,
    respect_ignore: bool,
    keep: impl Fn(&DirEntry) -> bool,
    prune: Vec<AbsPath>,
    cap: Option<usize>,
    server: Option<(SearchClass, u64)>,
) -> Result<Walked, ToolError> {
    walk_descending(ctx, root, respect_ignore, keep, prune, Descent::default(), cap, server).await
}
/// [`walk_entries_pruned`] that stops at `descent`: a folder it names is listed but not entered, so nothing under it is
/// read. A caller names only folders whose every entry its `keep` drops: the kept entries are those of the full walk.
#[cfg(test)]
#[allow(clippy::too_many_arguments, reason = "the walk request's fields, each a caller's choice")]
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn walk_descending(
    ctx: &ToolContext,
    root: &AbsPath,
    respect_ignore: bool,
    keep: impl Fn(&DirEntry) -> bool,
    prune: Vec<AbsPath>,
    descent: Descent,
    cap: Option<usize>,
    server: Option<(SearchClass, u64)>,
) -> Result<Walked, ToolError> {
    let budget_ms = server.map_or(u64::MAX, |(_, budget)| budget);
    let server = server.map(|(class, _)| class);
    let request = WalkRequest {
        root: root.clone(),
        recursive: true,
        include_hidden: true,
        respect_ignore,
        require_git: true,
        include_dirs: false,
        prune,
        descent,
        server,
    };
    walk_kept(ctx, request, keep, cap, budget_ms).await
}
/// Files and directories under `root` (nothing ignored or hidden skipped; the kernel trees of a
/// filesystem root pruned), at most `cap` kept entries.
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
pub(super) async fn walk_inventory(
    ctx: &ToolContext,
    root: &AbsPath,
    descent: Descent,
    keep: impl Fn(&DirEntry) -> bool,
    cap: usize,
) -> Result<Walked, ToolError> {
    let prune = root_scan_prunes(root, cfg!(not(windows)));
    let request = WalkRequest {
        root: root.clone(),
        recursive: true,
        include_hidden: true,
        respect_ignore: false,
        require_git: true,
        include_dirs: true,
        prune,
        descent,
        server: None,
    };
    walk_kept(ctx, request, keep, Some(cap), u64::MAX).await
}
/// A deep `list`'s inventory (`tryNativeDeepListRows`): files and directories under `root`, nothing ignored, at most `cap`
/// kept, as one `--files --directories` request to the search server, which is a broad search (`isBroadSearchRequest`: its
/// args hold `--files`) and takes its turn on the broad-search gate within the search's budget. It is refused or ends past
/// its budget as a glob's inventory does (`BROAD_REFUSALS`). The walk itself stops at `descent` (`--max-depth`, the
/// noise folders and, unless hidden, dotted folders listed but not entered), so nothing `keep` would drop is read.
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
pub(super) async fn broad_listing(
    ctx: &ToolContext,
    root: &AbsPath,
    descent: Descent,
    keep: impl Fn(&DirEntry) -> bool,
    cap: usize,
) -> Result<Walked, ToolError> {
    let request = WalkRequest {
        root: root.clone(),
        recursive: true,
        include_hidden: true,
        respect_ignore: false,
        require_git: true,
        include_dirs: true,
        prune: Vec::new(),
        descent,
        server: Some(SearchClass::Bulk),
    };
    broad_search(ctx, BROAD_REFUSALS[1], |budget| walk_kept(ctx, request, keep, Some(cap), budget)).await
}
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn walk_kept(ctx: &ToolContext, request: WalkRequest, keep: impl Fn(&DirEntry) -> bool, cap: Option<usize>, budget_ms: u64) -> Result<Walked, ToolError> {
    let mut entries = Vec::new();
    let (complete, capped) = visit_walk(ctx, request, keep, cap, budget_ms, |entry| entries.push(entry)).await?;
    Ok(Walked { entries, complete, capped })
}

#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn visit_walk(
    ctx: &ToolContext,
    request: WalkRequest,
    mut keep: impl FnMut(&DirEntry) -> bool,
    cap: Option<usize>,
    budget_ms: u64,
    mut visit: impl FnMut(DirEntry),
) -> Result<(bool, bool), ToolError> {
    let include_dirs = request.include_dirs;
    // A walk the search server runs answers what it found at its soft deadline, before the client's hard timeout would refuse the
    // search (`softDeadlineMs`, native-search-client.mjs): the served partial. Admission has already spent part of that
    // total budget; restarting it here would put the partial beyond the enclosing hard deadline.
    let soft = request.server.map(|_| SearchDeadlines::within(ctx, budget_ms).soft);
    let mut walk = ctx.files.walk(ctx.io.maintenance, request);
    let mut kept = 0usize;
    let mut capped = false;
    let mut refused = None;
    let mut missed_entry = false;
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
                    if cap.is_some_and(|cap| kept >= cap) {
                        capped = true;
                        return false;
                    }
                    kept += 1;
                    visit(entry);
                }
            }
            Err(FsError { kind, .. }) => {
                missed_entry = true;
                refused = refused.take().or_else(|| refusal_reason(&kind));
            }
        }
        true
    })
    .await;
    let complete = match end {
        PullEnd::Cancelled => return Err(cancelled()),
        PullEnd::Deadline | PullEnd::Timer => false,
        PullEnd::Exhausted => !missed_entry,
    };
    if let Some(reason) = refused {
        return Err(refusal(reason));
    }
    Ok((complete, capped))
}
/// `work`, a broad search whose hard timeout is worded `kind` (`BROAD_REFUSALS`: a file inventory's, a fuzzy search's or a
/// content search's), run in its turn on the process's one broad-search gate, for the session of the call.
/// The search's budget (`SearchDeadlines`, native-search-client.mjs `requestNativeWithRestart`) covers the wait and the
/// work: a turn not had within it is refused (the gate's `waitTimeoutMs` is the budget left at the call, its whole
/// budget here as no setup is spent), and the work has what the wait left, at least 1 ms
/// (`searchRemainingMs`), before the search's hard timeout (`requestNative`). A cancel ends the wait, or the work and
/// its turn with it; the turn is released as the work ends, however it ends.
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn broad_search<T, W: Future<Output = Result<T, ToolError>>>(ctx: &ToolContext, kind: &str, work: impl FnOnce(u64) -> W) -> Result<T, ToolError> {
    broad_search_turn(ctx, kind, work).await.map(|(out, _)| out)
}
/// As [`broad_search`], with how the turn came and went; `work` is given the budget left, in ms.
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
pub(super) async fn broad_search_turn<T, W: Future<Output = Result<T, ToolError>>>(
    ctx: &ToolContext,
    kind: &str,
    work: impl FnOnce(u64) -> W,
) -> Result<(T, Turn), ToolError> {
    let budget = SearchDeadlines::of(ctx).hard_ms;
    let queued = mixdog_rt::time::Instant::now();
    // What it queues behind, as it queued: by the time the budget ends, a holder with the same budget may have ended too.
    let ahead = (BROAD_RUNNING.load(std::sync::atomic::Ordering::SeqCst), BROAD_WAITING.load(std::sync::atomic::Ordering::SeqCst));
    let waiting = Counted::new(&BROAD_WAITING);
    let waited = mixdog_rt::Scope::new()
        .cancel(&ctx.cancel)
        .within(Duration::from_millis(budget))
        .run(BROAD_SEARCH.enter(&gate_owner(ctx.thread_id.as_str()), &ctx.cancel))
        .await;
    let elapsed_ms = |since: mixdog_rt::time::Instant| u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX);
    let turn = match waited {
        mixdog_rt::Scoped::Done(Ok(turn)) => turn,
        mixdog_rt::Scoped::Done(Err(mixdog_rt::GateCancelled)) | mixdog_rt::Scoped::Cancelled => {
            record_broad_times(ctx, elapsed_ms(queued), 0);
            return Err(cancelled());
        }
        mixdog_rt::Scoped::DeadlineExceeded => {
            record_broad_times(ctx, elapsed_ms(queued), 0);
            // Facts the model can act on: how long it waited and behind how many (it never started, so nothing ran).
            let (running, queued_behind) = ahead;
            return Err(refusal(format!(
                "{}waited {budget}ms for admission behind {running} running and {queued_behind} queued broad searches",
                BROAD_REFUSALS[0]
            )));
        }
    };
    drop(waiting);
    let running = Counted::new(&BROAD_RUNNING);
    let queued_behind_others = turn.queued();
    let waited_ms = elapsed_ms(queued);
    let admitted = mixdog_rt::time::Instant::now();
    let left = budget.saturating_sub(waited_ms).max(1);
    let ran = mixdog_rt::Scope::new().cancel(&ctx.cancel).within(Duration::from_millis(left)).run(work(left)).await;
    // The run ends with the work, before the turn is handed on.
    let ran_ms = elapsed_ms(admitted);
    drop(turn);
    drop(running);
    let turn = Turn { queued: queued_behind_others, ran_ms };
    record_broad_times(ctx, waited_ms, ran_ms);
    match ran {
        mixdog_rt::Scoped::Done(out) => out.map(|out| (out, turn)),
        mixdog_rt::Scoped::Cancelled => Err(cancelled()),
        mixdog_rt::Scoped::DeadlineExceeded => Err(refusal(format!("{kind}{left}ms remaining budget."))),
    }
}
/// Visit files under `root` matching any pattern, in walk order.
#[allow(clippy::too_many_arguments, reason = "the walk scope, budget and visitor are independent inputs")]
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn visit_glob(
    ctx: &ToolContext,
    root: &AbsPath,
    globs: OrderedGlobs,
    include_noise: bool,
    cap: Option<usize>,
    budget: u64,
    unique: bool,
    visit: impl FnMut(DirEntry),
) -> Result<(bool, bool), ToolError> {
    let root_path = root.as_path();
    let descent = Descent { bare: if include_noise { Vec::new() } else { noise_bare() }, ..Descent::default() };
    let request = WalkRequest {
        root: root.clone(),
        recursive: true,
        include_hidden: true,
        respect_ignore: !include_noise,
        require_git: true,
        include_dirs: false,
        prune: root_scan_prunes(root, cfg!(not(windows))),
        descent,
        server: Some(SearchClass::Bulk),
    };
    let mut seen = HashSet::new();
    visit_walk(
        ctx,
        request,
        |entry| {
            let path = entry.path.as_path();
            if !include_noise && in_noise_dir(path, root_path) {
                return false;
            }
            let relative = fwd(path.strip_prefix(root_path).unwrap_or(path));
            globs.keeps(&relative) && (!unique || seen.insert(entry.path.clone()))
        },
        cap,
        budget,
        visit,
    )
    .await
}

/// The read tool's inventory, with its own path guard and subsequent ranking.
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
pub(crate) async fn glob_files(
    ctx: &ToolContext,
    root: &AbsPath,
    patterns: &[String],
    include_noise: bool,
    cap: Option<usize>,
    guard_read_targets: bool,
) -> Result<(Vec<(AbsPath, Option<u128>)>, bool, bool, bool, Turn), ToolError> {
    let globs = compile_globs(patterns)?;
    let work = |budget: u64| async move {
        let mut entries = Vec::new();
        let (complete, capped) = visit_glob(ctx, root, globs, include_noise, cap, budget, false, |entry| entries.push(entry)).await?;
        // The mtimes are read 64 at a time, in the walk's order (as `find` reads its stats).
        use futures::StreamExt as _;
        let mut out = Vec::with_capacity(entries.len());
        let followed_link = entries.iter().any(|e| e.kind == EntryKind::Symlink);
        let mut stamped = futures::stream::iter(entries.into_iter().map(|e| async move {
            let allowed = !guard_read_targets || super::read::read_target(ctx, &fwd(e.path.as_path())).await?.is_ok();
            let m = if allowed { mtime_millis(ctx, &e.path).await } else { None };
            Ok::<_, ToolError>((e.path, m))
        }))
        .buffered(64);
        while let Some(row) = stamped.next().await {
            if ctx.cancel.is_cancelled() {
                return Err(cancelled());
            }
            out.push(row?);
        }
        Ok::<_, ToolError>((out, complete, capped, followed_link))
    };
    let ((found, complete, capped, followed_link), turn) = broad_search_turn(ctx, BROAD_REFUSALS[1], work).await?;
    Ok((found, complete, capped, followed_link, turn))
}

#[derive(Eq, Ord, PartialEq, PartialOrd)]
enum GlobOrder {
    Natural,
    Stamped(Reverse<u128>, String),
    Unstamped,
}

#[derive(Eq, PartialEq)]
struct GlobRank {
    path: AbsPath,
    order: GlobOrder,
    ordinal: usize,
}

impl Ord for GlobRank {
    fn cmp(&self, other: &Self) -> Ordering {
        self.order
            .cmp(&other.order)
            .then_with(|| {
                if matches!(&self.order, GlobOrder::Natural) { self.path.cmp(&other.path) } else { Ordering::Equal }
                // Keep failed stats in walk order, and retain the order of case-folded ties on Windows.
            })
            .then_with(|| self.ordinal.cmp(&other.ordinal))
            .then_with(|| self.path.cmp(&other.path))
    }
}

impl PartialOrd for GlobRank {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

struct GlobRanking {
    top: Top<GlobRank>,
    natural: bool,
    cap: Option<usize>,
    total: usize,
    missing_stat: bool,
}

impl GlobRanking {
    fn rank(&self, number: usize, path: AbsPath, mtime: Option<u128>) -> GlobRank {
        let order = if self.natural {
            GlobOrder::Natural
        } else if let Some(mtime) = mtime {
            let key = fwd(path.as_path());
            GlobOrder::Stamped(Reverse(mtime), if cfg!(windows) { key.to_lowercase() } else { key })
        } else {
            GlobOrder::Unstamped
        };
        GlobRank { path, order, ordinal: self.total + number }
    }
}

struct GlobBatch {
    top: Top<GlobRank>,
    added: Option<HashSet<AbsPath>>,
    total: usize,
    missing_stat: bool,
    followed_link: bool,
    complete: bool,
    capped: bool,
}

fn new_glob_path(path: &AbsPath, seen: Option<&HashSet<AbsPath>>, added: Option<&mut HashSet<AbsPath>>) -> bool {
    match (seen, added) {
        (Some(seen), Some(added)) => !seen.contains(path) && added.insert(path.clone()),
        _ => true,
    }
}

/// Rank a group transactionally: a refusal must not leak its paths or affect a later group's deduplication.
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn rank_glob_group(
    ctx: &ToolContext,
    root: &AbsPath,
    patterns: &[String],
    include_noise: bool,
    ranking: &GlobRanking,
    seen: Option<&HashSet<AbsPath>>,
) -> Result<(GlobBatch, Turn), ToolError> {
    let globs = compile_globs(patterns)?;
    broad_search_turn(ctx, BROAD_REFUSALS[1], |budget| async move {
        use futures::StreamExt as _;
        let mut added = seen.map(|_| HashSet::new());
        let mut top = Top::new(ranking.top.bound);
        let mut total = 0;
        // The unbounded variant caps the combined inventory in walk order, before ranking.
        let remaining = ranking.cap.map_or(usize::MAX, |cap| cap - ranking.total);
        if ranking.natural {
            let mut merged_cap = false;
            let (complete, walk_cap) = visit_glob(ctx, root, globs, include_noise, ranking.cap, budget, true, |entry| {
                if !merged_cap && new_glob_path(&entry.path, seen, added.as_mut()) {
                    if total == remaining {
                        merged_cap = true;
                    } else {
                        top.push(ranking.rank(total, entry.path, None));
                        total += 1;
                    }
                }
            })
            .await?;
            return Ok(GlobBatch { top, added, total, missing_stat: false, followed_link: false, complete, capped: walk_cap || merged_cap });
        }

        // Keep the enumeration's soft deadline separate from the metadata budget.
        let mut entries = Vec::new();
        let mut followed_link = false;
        let (complete, mut capped) = visit_glob(ctx, root, globs, include_noise, ranking.cap, budget, true, |entry| {
            followed_link |= entry.kind == EntryKind::Symlink;
            if entries.len() <= remaining && new_glob_path(&entry.path, seen, added.as_mut()) {
                entries.push(entry.path);
            }
        })
        .await?;
        if entries.len() > remaining {
            entries.truncate(remaining);
            capped = true;
        }
        let mut missing_stat = false;
        {
            let mut stamped = futures::stream::iter(entries.into_iter().enumerate().map(|(number, path)| async move {
                let mtime = locator_mtime(ctx, &path).await;
                (number, path, mtime)
            }))
            .buffer_unordered(64);
            while let Some((number, path, mtime)) = stamped.next().await {
                if ctx.cancel.is_cancelled() {
                    return Err(cancelled());
                }
                total += 1;
                missing_stat |= mtime.is_none();
                top.push(ranking.rank(number, path, mtime));
            }
        }
        Ok(GlobBatch { top, added, total, missing_stat, followed_link, complete, capped })
    })
    .await
}
#[async_trait]
impl Tool for GlobTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        with_broad_times(self.respond(ctx, args)).await
    }
}
impl GlobTool {
    async fn respond(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let args = promote_legacy_args(args, true);
        // arg-guard.mjs (glob): a `path` or `root` that is not a string, an array included, is refused; a null or
        // blank one is absent and the search runs from the cwd.
        let path = super::common::optional_path_arg(&args, "path", |got| format!("Error: glob arg \"path\" must be string (got {got})"))?;
        super::common::optional_path_arg(&args, "root", |got| format!("Error: glob arg \"root\" must be string (got {got})"))?;
        let (mut raw, mut patterns) = glob_scope(path, glob_patterns(&args));
        // `globBaseEntry`: a `path` that names a set of directories walks from its static base, its wildcard part
        // folded into each relative pattern.
        // A UNC or device spelling (`\\?\…`) is refused whole below, never read as a glob.
        let (scoped, prefix) = if glob_unc_refusal(ctx, &raw, &patterns).is_some() { (raw.clone(), String::new()) } else { wildcard_scope(ctx, &raw).await };
        raw = scoped;
        if !prefix.is_empty() {
            for pattern in patterns.iter_mut().filter(|p| !is_absolute_pattern(p.trim_start_matches('!'))) {
                *pattern = match pattern.strip_prefix('!') {
                    Some(rest) => format!("!{prefix}/{}", rest.trim_start_matches('/')),
                    None => format!("{prefix}/{}", pattern.trim_start_matches('/')),
                };
            }
        }
        let raw = raw.as_str();
        // arg-guard.mjs (glob): `sort` is natural or mtime (after a trim) and nothing else.
        let natural = match args.get("sort") {
            None => false,
            Some(JsonValue::String(sort)) => match mixdog_js::js_trim(sort) {
                "natural" => true,
                "mtime" => false,
                _ => {
                    let got = JsonValue::String(mixdog_js::js_trim(sort).to_owned());
                    return Err(invalid("sort", "type", format!("Error: glob arg \"sort\" must be one of natural|mtime (got {got})")));
                }
            },
            Some(other) => {
                return Err(invalid(
                    "sort",
                    "type",
                    format!("Error: glob arg \"sort\" must be one of natural|mtime (got {})", super::read_legacy::describe_type(other)),
                ));
            }
        };
        let limit = match arg_u64(&args, "limit") {
            Some(0) => usize::MAX,
            Some(n) => n as usize,
            None => env_default_limit("MIXDOG_GLOB_DEFAULT_HEAD_LIMIT", GLOB_DEFAULT_LIMIT),
        };
        let offset = arg_u64(&args, "offset").unwrap_or(0) as usize;
        if let Some(text) = glob_unc_refusal(ctx, raw, &patterns) {
            return Err(fail(ToolErrorCode::Failed { reason: text.clone() }, text));
        }
        let root = resolve_path(&ctx.cwd, raw)?;
        // Node `buildGlobPatternGroups`: an absolute pattern is walked from its own static prefix,
        // anchored there; the others from `path`.
        let (absolute, relative): (Vec<String>, Vec<String>) = patterns.iter().cloned().partition(|p| is_absolute_pattern(p));
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
        let mut bound = offset.saturating_add(limit);
        if cap.is_some() || !natural {
            bound = bound.min(GLOB_ACCUM_CAP);
        }
        let mut ranking = GlobRanking { top: Top::new(bound), natural, cap, total: 0, missing_stat: false };
        let include_noise = arg_bool(&args, "include_noise");
        let (mut complete, mut capped) = (true, false);
        let mut followed_link = false;
        let mut errors = Vec::new();
        // Each walk deduplicates its own paths. Only overlapping roots need cross-group deduplication.
        let mut seen = groups
            .iter()
            .enumerate()
            .any(|(index, (root, _, _))| {
                groups[..index].iter().any(|(other, _, _)| root.as_path().starts_with(other.as_path()) || other.as_path().starts_with(root.as_path()))
            })
            .then(HashSet::new);
        let (mut walk_ms, mut admitted_directly, mut queued_behind_others) = (0u64, 0usize, false);
        for (group_root, rels, label) in &groups {
            if let Some(missing) = require_dir(ctx, &fwd(group_root.as_path()), group_root).await? {
                errors.push(missing.trim_start_matches("Error: ").to_owned());
                continue;
            }
            let (batch, turn) = match rank_glob_group(ctx, group_root, rels, include_noise, &ranking, seen.as_ref()).await {
                Err(e) if refused_with(&e).is_some() => {
                    errors.push(format!("rg failed for {label}: {}", refused_with(&e).unwrap_or_default()));
                    continue;
                }
                found => found?,
            };
            walk_ms += turn.ran_ms;
            admitted_directly += usize::from(!turn.queued);
            queued_behind_others |= turn.queued;
            complete &= batch.complete;
            capped |= batch.capped;
            followed_link |= batch.followed_link;
            ranking.missing_stat |= batch.missing_stat;
            ranking.total += batch.total;
            if let Some(added) = batch.added {
                seen.as_mut().expect("deduplicated walk").extend(added);
            }
            if ranking.top.ranks.is_empty() {
                ranking.top = batch.top;
            } else {
                for rank in batch.top.ranks {
                    ranking.top.push(rank);
                }
            }
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
        for (key, value) in
            [("native_bulk_requests", 1), ("native_bulk_queue_ms", 0), ("native_bulk_handler_ms", walk_ms), ("native_hits", 1), ("native_ms", walk_ms)]
        {
            local_search.insert(key.to_owned(), value.into());
        }
        let local_search = JsonValue::Object(local_search);
        let text_output = |text: String, complete: bool, cache_safe: bool| {
            let mut output = text_output(text);
            output.meta = Some(serde_json::json!({
                "complete": complete,
                "cacheSafe": cache_safe,
                LOCAL_SEARCH_META: local_search,
            }));
            output
        };
        // `scanGlobGroups`' `Error: …` answer, a failure as Node's result classifier reads that text.
        if ranking.total == 0 && !errors.is_empty() {
            let text = format!("Error: {}", errors.join(" | "));
            return Err(fail(ToolErrorCode::Failed { reason: text.clone() }, text));
        }
        let total = ranking.total;
        // Node's bounded newest-first page is a top-(offset+limit+1) window of the whole set, counted in full, that
        // then passes the same GLOB_ACCUM_CAP fold as every listing (`mergeGlobRuns`).
        if !natural && limit != usize::MAX && offset.saturating_add(limit).saturating_add(1).min(total) > GLOB_ACCUM_CAP {
            capped = true;
        }
        let missing_stat = ranking.missing_stat;
        let page = ranking.top.into_page(offset).take(limit);
        // Node's `relativeSearchResultPath` strips `<cwd>/`; a filesystem root as the cwd already ends in its separator, so
        // no path starts with `<cwd>//` and every one stays absolute.
        let root_cwd = ctx.cwd.as_path().parent().is_none();
        let lines: Vec<String> = page.map(|row| if root_cwd { fwd(row.path.as_path()) } else { display_path(row.path.as_path(), &ctx.cwd) }).collect();
        let remaining = total.saturating_sub(offset + lines.len());
        let mut direct_fallback = false;
        let mut text = lines.join("\n");
        if remaining > 0 {
            text.push_str(&format!(
                "\n{}",
                window_marker("entries", offset as u64 + 1, (offset + lines.len()) as u64, Some(total as u64), Some((offset + lines.len()) as u64), None)
            ));
        }
        if lines.is_empty() {
            let shown_patterns = if patterns.len() == 1 { serde_json::to_string(&patterns[0]) } else { serde_json::to_string(&patterns) }.unwrap_or_default();
            let base_label = fwd(Path::new(raw));
            if total > 0 && offset >= total {
                text = format!("(no entries after offset={offset}; total={total}) pattern={shown_patterns} path={base_label}");
            } else {
                // The walk never follows a directory link; an absolute pattern that found nothing is
                // expanded straight off the filesystem before the miss is declared (Node `directAbsoluteMatches`).
                if errors.is_empty() {
                    direct_fallback = !absolute.is_empty();
                    let want = if limit == usize::MAX { 50 } else { offset.saturating_add(limit) };
                    let direct = expand_absolute_globs(ctx, &patterns, want).await;
                    let shown: Vec<String> = direct.into_iter().skip(offset).take(limit).collect();
                    if !shown.is_empty() {
                        // The direct fallback can cross links outside the scanned roots.
                        return Ok(text_output(shown.join("\n"), false, false));
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
            text.push_str(&format!("\n{}", cap_marker(&format!("{GLOB_ACCUM_CAP} matches"), "results incomplete", None, "narrow the pattern or path")));
        }
        if !complete {
            text.push_str("\n[warning] search deadline reached; partial results shown.");
        }
        let whole = complete && !capped && errors.is_empty() && !direct_fallback && text.len() <= locator_max_bytes() && !missing_stat;
        Ok(text_output(locator_budget(text, &locator_targets(&args), offset), whole, natural || !followed_link))
    }
}
#[async_trait]
impl Tool for FindTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        with_broad_times(self.respond(ctx, args)).await
    }
}
impl FindTool {
    async fn respond(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let args = promote_legacy_args(args, false);
        let query = arg_str(&args, "query").unwrap_or("").trim().to_owned();
        if query.is_empty() {
            return Err(invalid("query", "required", "Error: find requires query."));
        }
        // arg-guard.mjs (find): a `path` that is not a string is refused; a null or blank one is the cwd.
        let raw = super::common::optional_path_arg(&args, "path", |got| format!("Error: find arg \"path\" must be a string (got {got})"))?.unwrap_or(".");
        let limit = match arg_u64(&args, "limit") {
            Some(0) => FIND_UNLIMITED_CAP,
            Some(n) => n as usize,
            None => env_default_limit("MIXDOG_FIND_DEFAULT_HEAD_LIMIT", FIND_DEFAULT_LIMIT),
        };
        let include_noise = arg_bool(&args, "include_noise");
        // find-files-tool.mjs `fuzzyFindRequest`: dot-directories are searched unless `hidden:false`; `depth` bounds the walk.
        let hidden = args.get("hidden") != Some(&JsonValue::Bool(false));
        let depth = match args.get("depth") {
            Some(JsonValue::Null) | None => None,
            // `Math.max(parseInt(args.depth, 10) || 1, 1)`: "2levels" is 2, "1e2" is 1.
            Some(value) => Some(super::list::js_parse_int(value).filter(|n| *n != 0).unwrap_or(1).max(1) as usize),
        };
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
            include_hidden: hidden,
            respect_ignore: !include_noise,
            require_git: false,
            include_dirs: true,
            prune: root_scan_prunes(&root, cfg!(not(windows))),
            descent: Descent { max_depth: depth, bare, bare_dotted: !hidden, guard: None },
            server: Some(SearchClass::Fuzzy),
        };
        // Ranking must not slow the timed enumeration or cut better matches from its tail.
        let Walked { entries, complete, .. } = broad_search(ctx, BROAD_REFUSALS[2], |budget| {
            walk_kept(
                ctx,
                request,
                |entry| {
                    let dotted = !hidden
                        && entry
                            .path
                            .as_path()
                            .strip_prefix(&root_path)
                            .is_ok_and(|rel| rel.components().any(|part| part.as_os_str().to_string_lossy().starts_with('.')));
                    !dotted && (include_noise || !in_noise_dir(entry.path.as_path().parent().unwrap_or(&root_path), &root_path))
                },
                None,
                budget,
            )
        })
        .await?;
        // serve_search/fuzzy.rs: every whitespace-separated fragment is a nucleo fuzzy atom (case ignored, Unicode
        // normalised "smart"), all must match one path, the scores add, and the best score comes first, a tie by path.
        let atoms: Vec<Pattern> = query.split_whitespace().map(|t| Pattern::new(t, CaseMatching::Ignore, Normalization::Smart, AtomKind::Fuzzy)).collect();
        let mut matcher = FuzzyMatcher::new(FuzzyConfig::DEFAULT.match_paths());
        let mut top = Top::new(limit);
        let mut matched = 0usize;
        for (index, entry) in entries.into_iter().enumerate() {
            if index > 0 && index % 256 == 0 {
                tokio::task::yield_now().await;
            }
            if ctx.cancel.is_cancelled() {
                return Err(cancelled());
            }
            let rel = display_under(entry.path.as_path(), &root_path);
            let text = Utf32String::from(rel.as_str());
            if let Some(score) = atoms.iter().try_fold(0u32, |sum, atom| atom.score(text.slice(..), &mut matcher).map(|score| sum.saturating_add(score))) {
                matched += 1;
                top.push((Reverse(score), rel));
            }
        }
        if ctx.cancel.is_cancelled() {
            return Err(cancelled());
        }
        let more = matched > limit;
        let mut lines: Vec<String> = top.sorted().into_iter().map(|(_, path)| path).collect();
        if lines.is_empty() {
            lines.push(format!("(no fuzzy match for \"{query}\")"));
        } else if more {
            lines.push(format!("... (top {limit}; additional matches omitted)"));
        }
        if !complete {
            lines.push("... [search deadline reached; partial results shown]".to_owned());
        }
        let text = lines.join("\n");
        let output = |text, complete| {
            let mut output = text_output(text);
            output.meta = Some(serde_json::json!({ "complete": complete }));
            output
        };
        if text.len() > locator_max_bytes() {
            let (kept, dropped) = cap_lines(&text, locator_max_bytes());
            let rows = lines.len().saturating_sub(dropped);
            let marker = cap_marker(
                &format_cap_size(locator_max_bytes()),
                &format!("{rows} match row(s) shown for query={query:?}"),
                None,
                "use a more specific query or add path",
            );
            return Ok(output(format!("{kept}\n{marker}"), false));
        }
        Ok(output(text, complete))
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
impl GrepTool {
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    async fn run_one_root(
        &self,
        ctx: &ToolContext,
        (raw, args, pattern, globs): (&str, &JsonValue, &str, &[String]),
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
            let parent = AbsPath::new(abs.as_path().parent().unwrap_or(abs.as_path()).to_path_buf()).unwrap_or_else(|| abs.clone());
            // Anchored to the parent: a bare name would match that name in every folder below it.
            let name = abs.as_path().file_name().map(|n| format!("/{}", escape_glob(&n.to_string_lossy())));
            (parent, name.into_iter().collect::<Vec<_>>())
        } else {
            (abs.clone(), Vec::new())
        };
        let mut exclude_globs = Vec::new();
        if single_file {
            // The file is its parent's own entry: no folder beside it is entered to find it.
            exclude_globs.push("/*/".to_owned());
        }
        // grep-request.mjs `resolveGrepScope`: a caller's glob with each Windows `\` a `/` (`canonicalizeGlobSlashes`).
        for g in globs.iter().map(|g| canonical_glob_slashes(g)) {
            match g.strip_prefix('!') {
                Some(neg) => exclude_globs.push(neg.to_owned()),
                // A file operand is its one candidate: an include glob, which only ever added files beside the name it
                // matched, neither widens nor narrows it (the file is searched whether the glob matches it or not).
                None if single_file => {}
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
        let request = SearchRequest {
            root,
            pattern: pattern.to_owned(),
            regex: true,
            // `-i` (`caseInsensitive` of grep-request.mjs, ripgrep's `-i`).
            case_sensitive: args.get("-i") != Some(&JsonValue::Bool(true)),
            include_globs,
            exclude_globs,
            include_hidden: true,
            // A file named as the path is searched whatever the ignore rules say, as ripgrep does a file operand.
            respect_ignore: !include_noise && !single_file,
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
        };
        let mut stream =
            if mode == Mode::Content { ctx.files.search_text(ctx.io.maintenance, request) } else { ctx.files.search_summary(ctx.io.maintenance, request) };
        let mut hits = Vec::new();
        let mut summaries = std::collections::HashMap::<AbsPath, u64>::new();
        let mut errors = 0usize;
        let mut bad_pattern = None;
        let mut timed_out = false;
        let mut refused = None;
        // The stream is read to its end, past the bound: the scan stops itself at its limit, and the deadline it may
        // report after its last match belongs to the answer (Node's server checks it once more after its scan).
        let end = pull_until(ctx, stream.as_mut(), (self.timer)(deadlines.hard.into_std()), |item| {
            match item {
                Ok(SearchMatch { path, line, text, count, .. }) => {
                    if mode == Mode::Content {
                        if hits.len() >= CONTENT_MATCH_CAP {
                            return false;
                        }
                        if !bound.is_some_and(|n| hits.len() >= n.max(1)) {
                            hits.push(Hit { path, line, text, count });
                        }
                    } else if mode == Mode::Count {
                        *summaries.entry(path).or_default() += count;
                    } else if !bound.is_some_and(|n| summaries.len() >= n.max(1)) {
                        summaries.entry(path).or_insert(count);
                    }
                }
                Err(FsError { kind: FsErrorKind::TimedOut, path, .. }) => {
                    timed_out = true;
                    // A file the deadline cut is not answered in part.
                    if let Some(cut) = path {
                        hits.retain(|h| h.path != cut);
                        summaries.remove(&cut);
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
                            summaries.remove(&failed);
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
                let text = format!("Error: native content search exceeded its {}ms total deadline.", deadlines.hard_ms);
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
        if mode != Mode::Content {
            // Summaries have no line number; counts are identified by path rather than this sentinel.
            hits = summaries.into_iter().map(|(path, count)| Hit { path, line: 0, text: String::new(), count }).collect();
        }
        Ok(Scanned { hits, complete, timed_out, scan_errors: errors, error: String::new(), single_file, bad_pattern: false })
    }
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
        let caller =
            ctx.deadline.map(|at| u64::try_from(mixdog_rt::time::Instant::from_std(at).saturating_duration_since(now).as_millis()).unwrap_or(u64::MAX));
        // The search ends this much before the call's own deadline, so its typed stage ("not started: waiting for
        // admission", "exceeded its budget while scanning") is what the call reports, not the generic outer timeout.
        const OUTER_MARGIN_MS: u64 = 250;
        let hard_ms = caller.filter(|ms| *ms > 0).map_or(REQUEST_TIMEOUT_MS, |ms| ms.saturating_sub(OUTER_MARGIN_MS).clamp(1, REQUEST_TIMEOUT_MS)).min(left_ms);
        let margin = (hard_ms * 75 / 1000).clamp(250, 2000);
        let ms = std::time::Duration::from_millis;
        Self { soft: now + ms(hard_ms.saturating_sub(margin).max(1)), hard: now + ms(hard_ms), hard_ms }
    }
}
#[async_trait]
impl Tool for GrepTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        with_broad_times(self.respond(ctx, args)).await
    }
}
impl GrepTool {
    /// The answer within Node's context budget (`GREP_OUTPUT_MAX_BYTES` characters), then capped as
    /// executeBuiltinTool caps it (builtin.mjs `_budgetBuiltinOutput`: `capLineOrientedToolOutput` at
    /// `GREP_OUTPUT_MAX_BYTES` bytes with `_grepBudgetFooter`).
    async fn respond(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let args = promote_output_mode(promote_legacy_args(args, true))?;
        let cap = grep_max_bytes();
        let mut complete = true;
        let mut sources = SourceCache::default();
        let output = |text, complete| {
            let mut output = text_output(text);
            output.meta = Some(serde_json::json!({ "complete": complete }));
            output
        };
        // A resumed fan-out (`section`) goes straight to the sections it names.
        if args.get("section").is_some() {
            return match self.fanout_paged((ctx, &mut sources), &args, cap, &mut complete).await? {
                Some(text) => Ok(output(text, complete)),
                None => {
                    Err(invalid("section", "range", "Error: grep arg \"section\" continues a call over several paths or patterns; this call has one section."))
                }
            };
        }
        let text = self.answer((ctx, &mut sources), args.clone(), cap, Some(cap), &mut complete).await?;
        // One section is fitted to the cap where it is rendered. Sections assembled past it, or one that names a result too
        // large for the cap in place of showing it, are re-delivered as whole units from the first section onward, ending at
        // a (section, offset) cursor ([`Self::fanout_paged`]), so what follows a named result is not lost.
        if (text.len() > cap || text.contains(OVERSIZE_MARK))
            && let Some(paged) = self.fanout_paged((ctx, &mut sources), &args, cap, &mut complete).await?
        {
            return Ok(output(paged, complete));
        }
        Ok(output(text, complete))
    }
}
impl GrepTool {
    /// One grep call's text, its context renderings fitted to `budget` characters.
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    async fn answer(&self, (ctx, sources): GrepIo<'_>, args: JsonValue, budget: usize, fit: Option<usize>, complete: &mut bool) -> Result<String, ToolError> {
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
                if let Some(bodies) = self.combined_paths((ctx, sources), &args, &list, &patterns, per_path).await? {
                    return Ok(fanout_sections(Fanout::Path, &list, &bodies));
                }
                // `runGrepPathFanout`'s fallback: each path an independent grep.
                let mut bodies = Vec::with_capacity(list.len());
                for p in &list {
                    let mut one = args.clone();
                    one["path"] = JsonValue::String(p.clone());
                    bodies.push(match self.answer_one((ctx, sources), &one, &patterns, per_path, None, complete).await {
                        Ok(text) => text,
                        Err(e) if matches!(e.code, ToolErrorCode::Cancelled) => return Err(e),
                        Err(e) => {
                            *complete = false;
                            e.message_for_model
                        }
                    });
                }
                return Ok(fanout_sections(Fanout::Path, &list, &bodies));
            }
            if let Some(one) = list.pop() {
                args["path"] = JsonValue::String(one);
            }
        }
        self.answer_one((ctx, sources), &args, &patterns, budget, fit, complete).await
    }

    async fn answer_one(
        &self,
        io: GrepIo<'_>,
        args: &JsonValue,
        patterns: &[String],
        budget: usize,
        fit: Option<usize>,
        complete: &mut bool,
    ) -> Result<String, ToolError> {
        let (patterns, note) = pattern_list(patterns);
        let mode = mode_of(args);
        Ok(format!("{note}{}", self.answer_patterns(io, args, &patterns, mode, budget, fit, complete).await?))
    }

    /// One path's answer to its (distinct, capped) patterns.
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    #[allow(clippy::too_many_arguments)]
    async fn answer_patterns(
        &self,
        (ctx, sources): GrepIo<'_>,
        args: &JsonValue,
        patterns: &[String],
        mode: Mode,
        budget: usize,
        fit: Option<usize>,
        complete: &mut bool,
    ) -> Result<String, ToolError> {
        let args = args.clone();
        let patterns = patterns.to_vec();
        // Node `runGrepPatternFanout`: several content patterns are independent greps, one section
        // each; a match line or block an earlier pattern showed is not repeated.
        if patterns.len() > 1 && mode == Mode::Content {
            // `perPatternCharBudget` (grep-pattern-fanout.mjs).
            let per_pattern = (budget / patterns.len()).max(512);
            let (bodies, residual, partial) = match self.combined_patterns((ctx, sources), &args, &patterns, per_pattern).await? {
                Some(answer) => answer,
                // `runPerPatternFanout`: each pattern an independent grep.
                None => {
                    if self.no_candidate_files(ctx, &args, &patterns).await? {
                        return Ok(no_matches(true));
                    }
                    let mut bodies = Vec::with_capacity(patterns.len());
                    // A pattern's failure is its section's text (`runPattern`'s catch, grep-pattern-fanout.mjs:336-339).
                    for pattern in &patterns {
                        bodies.push(match self.search((ctx, sources), &args, pattern, mode, true, per_pattern, None, complete).await {
                            Ok(text) => text,
                            Err(e) if matches!(e.code, ToolErrorCode::Cancelled) => return Err(e),
                            Err(e) => {
                                *complete = false;
                                e.message_for_model
                            }
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
                *complete = false;
                text.push_str(&warning);
            }
            return Ok(text);
        }
        let pattern = if patterns.len() == 1 { patterns[0].clone() } else { combined_regex(&patterns) };
        self.search((ctx, sources), &args, &pattern, mode, false, budget, fit, complete).await
    }

    /// One grep of `pattern`, rendered. `fanout`: a section of a several-pattern answer, whose
    /// bare match lines carry their file (Node's combined pass, `disableContentGrouping`). `fit`: the byte cap the text must
    /// come within, by delivering fewer whole results ([`Paged`]).
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    #[allow(clippy::too_many_arguments)]
    async fn search(
        &self,
        io: GrepIo<'_>,
        args: &JsonValue,
        pattern: &str,
        mode: Mode,
        fanout: bool,
        budget: usize,
        fit: Option<usize>,
        complete: &mut bool,
    ) -> Result<String, ToolError> {
        let paged = self.search_paged(io, args, pattern, mode, fanout, false, budget, fit, complete).await?;
        *complete &= !paged.by_cap;
        match (paged.oversize, paged.next) {
            // A result named for being too large is not skipped: the call that goes on after it is given, as a section of a
            // compound answer gives its cursor.
            (true, Some(next)) => {
                let mut after = args.clone();
                if let Some(object) = after.as_object_mut() {
                    object.insert("offset".to_owned(), JsonValue::from(next));
                }
                Ok(format!("{}\n[the results after it start at offset {next}. Continue with grep {after}]", paged.text))
            }
            // Rows were dropped to fit the byte cap: the renderer's notice only pages, so the cap is named here.
            (false, Some(next)) if paged.by_cap => {
                let cap = fit.map(format_cap_size).unwrap_or_default();
                Ok(format!("{}\n[response limit {cap} reached after {} result(s); the rest starts at offset {next}]", paged.text, paged.delivered))
            }
            _ => Ok(paged.text),
        }
    }

    /// [`Self::search`] with what the page delivered and where it continues, whether the cut came from the byte cap or
    /// from the result limit. The collected hits are rendered as often as the fit needs; nothing is scanned again. A page
    /// cut to fit is the first `n` results after the offset (a prefix of whole logical units: a match row, a context block
    /// with the matches it covers, a file row, a count row), and the renderer's own paging notice names the offset of the
    /// first one not delivered. `section`: the page is one section of a compound answer, whose cursor names that offset,
    /// so it is rendered as such a prefix whatever left results behind (the limit, the context budget or the byte cap).
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    #[allow(clippy::too_many_arguments)]
    async fn search_paged(
        &self,
        io: GrepIo<'_>,
        args: &JsonValue,
        pattern: &str,
        mode: Mode,
        fanout: bool,
        section: bool,
        budget: usize,
        fit: Option<usize>,
        complete: &mut bool,
    ) -> Result<Paged, ToolError> {
        let window = Window::of(args, mode);
        // The native search window (serve_search/search.rs `collect_until`): the scan stops one hit past what the call
        // can show, so the length of a cut stream is unknown.
        let collected = self.collect(io.0, args, pattern, mode, window.stream_bound(mode), SearchClass::Interactive).await?;
        *complete &= collected.complete && collected.errors.is_empty();
        Self::page(io, collected, window, pattern, (mode, fanout, section), budget, fit, Totals::Streamed).await
    }

    /// The page of hits already collected: rendered as `totals` says (a path's own scan is a stream cut at its window; a
    /// section of the combined scan knows its totals and keeps the scan's order), cut to fit `fit`, with what it delivered.
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    #[allow(clippy::too_many_arguments)]
    async fn page(
        (ctx, sources): GrepIo<'_>,
        collected: Collected,
        window: Window,
        pattern: &str,
        (mode, fanout, section): (Mode, bool, bool),
        budget: usize,
        fit: Option<usize>,
        totals: Totals,
    ) -> Result<Paged, ToolError> {
        let Collected { all, complete, timed_out, scan_errors, errors, single, all_bad } = collected;
        if all.is_empty() && !errors.is_empty() {
            // A pattern the parser refused is a failed call, as Node's caller takes it; a missing path is a miss.
            // In a several-pattern answer it fails only its own section.
            if all_bad && !fanout {
                let text = errors.join("\n");
                return Err(fail(ToolErrorCode::Failed { reason: text.clone() }, text));
            }
            return Ok(Paged::whole(errors.join("\n")));
        }
        let shape = Shape { mode, single: single && !fanout, fanout, complete, totals };
        let streamed = window.stream_bound(mode).is_some();
        let partial = if complete { String::new() } else { partial_warning(timed_out, scan_errors, streamed) };
        let render = PageRender { all: &all, errors: &errors, shape, pattern, budget, partial: &partial };
        let units = if mode == Mode::Content { all.len() } else { all.iter().filter(|(_, hit)| hit.count > 0).count() };
        let available = units.saturating_sub(window.offset);
        // A section of a compound answer is always the first `limit` results after its offset, none dropped out of order by
        // the context budget or skipped: what the renderer cannot fit is cut by the page below, and the cursor names it.
        let text = render.compose((ctx, sources), window, section).await?;
        let Some(cap) = fit.filter(|cap| text.len() > *cap) else { return Ok(Paged::of(text, &window, available)) };
        // The most results after the offset whose rendering fits.
        let upper = if window.limit == usize::MAX { available } else { window.limit.min(available) }.max(1);
        let (mut low, mut high, mut best) = (1usize, upper, None::<(usize, String)>);
        while low <= high {
            let mid = low + (high - low) / 2;
            let page = render.compose((ctx, sources), Window { limit: mid, ..window }, true).await?;
            if page.len() <= cap {
                best = Some((mid, page));
                low = mid + 1;
            } else if mid == 1 {
                break;
            } else {
                high = mid - 1;
            }
        }
        match best {
            Some((delivered, text)) => {
                let delivered = delivered.min(available);
                let next = (delivered < available).then_some(window.offset + delivered);
                Ok(Paged { text, next, delivered, oversize: false, by_cap: delivered < upper })
            }
            None => {
                let one = render.compose((ctx, sources), Window { limit: 1, ..window }, true).await?;
                let first = one.lines().next().unwrap_or_default();
                let at = if mode == Mode::Content && window.context == Some(0) {
                    all.get(window.offset).map(|(label, hit)| (label.clone(), hit.line))
                } else {
                    unit_location(first)
                };
                // It is named, not skipped; the page goes on after it.
                let next = (available > 1).then_some(window.offset + 1);
                Ok(Paged { text: oversize_notice(cap, window.offset, first, at), next, delivered: 0, oversize: true, by_cap: true })
            }
        }
    }

    /// A call over several paths and/or patterns whose assembled answer passes the byte cap, delivered as whole sections in a
    /// deterministic order (paths in the order given, each with the patterns in the order given), the last one cut to
    /// whole results if it alone passes what is left. What is not delivered is named by the compound cursor `section`
    /// (the index in that order) with `offset` (the first undelivered result of that section; later sections start at their
    /// first result): the footer gives the exact call that continues. `None` when the call has a single section.
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    async fn fanout_paged(&self, (ctx, sources): GrepIo<'_>, args: &JsonValue, cap: usize, complete: &mut bool) -> Result<Option<String>, ToolError> {
        let (patterns, note) = pattern_list(&arg_strings(args, "pattern"));
        let mode = mode_of(args);
        let by_pattern = patterns.len() > 1 && mode == Mode::Content;
        let mut list: Vec<String> = Vec::new();
        if let Some(JsonValue::Array(items)) = args.get("path") {
            for item in items {
                let p = mixdog_js::js_trim(item.as_str().unwrap_or_default()).to_owned();
                if !p.is_empty() && !list.contains(&p) {
                    list.push(p);
                }
            }
        }
        let by_path = list.len() > 1;
        if !by_pattern && !by_path {
            return Ok(None);
        }
        let pats: Vec<String> = if by_pattern || patterns.len() == 1 { patterns } else { vec![combined_regex(&patterns)] };
        // The paths the combined scan takes keep its order and totals, as in the answer they continue (a file list is in scan
        // order there, not newest first); the others are searched one by one.
        let combined = if by_path && !by_pattern { self.combined_collect(ctx, args, &list, &arg_strings(args, "pattern")).await? } else { None };
        let paths: Vec<Option<String>> = if by_path { list.into_iter().map(Some).collect() } else { vec![None] };
        let total = paths.len() * pats.len();
        let resumed = args.get("section").is_some();
        let (start, given) = (arg_u64(args, "section").unwrap_or(0) as usize, arg_u64(args, "offset").unwrap_or(0) as usize);
        if start >= total {
            return Err(invalid(
                "section",
                "range",
                format!("Error: grep arg \"section\" is {start}, but this call has {total} section(s) (0-{}).", total - 1),
            ));
        }
        let label_of = |i: usize, j: usize| match (&paths[i], by_pattern) {
            (Some(path), true) => format!("{path} pattern:{}", serde_json::to_string(&pats[j]).unwrap_or_default()),
            (Some(path), false) => path.clone(),
            (None, _) => format!("pattern:{}", serde_json::to_string(&pats[j]).unwrap_or_default()),
        };
        // What the footer needs room for: the exact call that continues.
        let reserve = 320 + args.to_string().len();
        let (mut parts, mut missed, mut used) = (Vec::<String>::new(), Vec::<String>::new(), note.len());
        let (mut cursor, mut delivered_units) = (None::<(usize, usize)>, 0usize);
        // Whether the byte cap, not the result limit, ended the page: the footer names the one that did.
        let mut cut_by_cap = true;
        for section in start..total {
            let (i, j) = (section / pats.len(), section % pats.len());
            // `section` given: its offset is the first section's alone; none: Node's, every section's.
            let offset = if resumed { if section == start { given } else { 0 } } else { given };
            let mut one = args.clone();
            if let Some(object) = one.as_object_mut() {
                object.shift_remove("section");
                object.insert("offset".to_owned(), JsonValue::from(offset));
                object.insert("pattern".to_owned(), JsonValue::String(pats[j].clone()));
                if let Some(path) = &paths[i] {
                    object.insert("path".to_owned(), JsonValue::String(path.clone()));
                }
            }
            let header = format!("# grep {}\n", label_of(i, j));
            let room = cap.saturating_sub(used + header.len() + reserve + 2);
            if room == 0 && !parts.is_empty() {
                cursor = Some((section, offset));
                break;
            }
            let outcome = match &combined {
                Some((pattern, sections)) => {
                    let (hits, is_file) = &sections[i];
                    if hits.is_empty() {
                        Ok(Paged::whole(no_matches(true)))
                    } else {
                        let collected = Collected {
                            all: hits.clone(),
                            complete: true,
                            timed_out: false,
                            scan_errors: 0,
                            errors: Vec::new(),
                            single: *is_file,
                            all_bad: false,
                        };
                        Self::page(
                            (ctx, sources),
                            collected,
                            Window::of(&one, mode),
                            pattern,
                            (mode, false, true),
                            room.max(512),
                            Some(room.max(1)),
                            Totals::Combined,
                        )
                        .await
                    }
                }
                None => self.search_paged((ctx, sources), &one, &pats[j], mode, by_pattern, true, room.max(512), Some(room.max(1)), complete).await,
            };
            let paged = match outcome {
                Ok(paged) => paged,
                Err(e) if matches!(e.code, ToolErrorCode::Cancelled) => return Err(e),
                Err(e) => {
                    *complete = false;
                    Paged::whole(e.message_for_model)
                }
            };
            if paged.oversize && !parts.is_empty() {
                // It starts the next call, which has the whole cap for it and names it.
                cursor = Some((section, offset));
                break;
            }
            // Node drops from a later pattern's section the lines an earlier one showed; a cursor cannot know what an earlier
            // response showed, so here each section is its own complete result and a line two patterns match is in both.
            let body = paged.text.clone();
            if body == no_matches(true) || body == no_matches(false) {
                missed.push(label_of(i, j));
                continue;
            }
            if body.trim().is_empty() {
                continue;
            }
            used += header.len() + body.len() + 2;
            parts.push(format!("{header}{body}"));
            delivered_units += paged.delivered;
            // The page ends where the section does not: whatever cut it (the byte cap, the result limit, or a result
            // named instead of shown), the cursor is the first result after what was delivered or named.
            if let Some(next) = paged.next {
                cursor = Some((section, next));
                cut_by_cap = paged.by_cap;
                break;
            }
        }
        if !missed.is_empty() {
            let kind = match (by_path, by_pattern) {
                (true, true) => "sections",
                (true, false) => "paths",
                _ => "patterns",
            };
            let all_missed = missed.len() == total && parts.is_empty();
            parts.push(if all_missed {
                no_matches(true)
            } else {
                format!("{} {kind}={}", no_matches(true), serde_json::to_string(&missed).unwrap_or_default())
            });
        }
        let mut text = format!("{note}{}", parts.join("\n\n"));
        if let Some((section, offset)) = cursor {
            *complete &= !cut_by_cap;
            let mut next = args.clone();
            if let Some(object) = next.as_object_mut() {
                object.insert("section".to_owned(), JsonValue::from(section));
                object.insert("offset".to_owned(), JsonValue::from(offset));
            }
            let reached =
                if cut_by_cap { format!("response limit {}", format_cap_size(cap)) } else { format!("result limit {}", Window::of(args, mode).limit) };
            text.push_str(&format!(
                "\n[{reached} reached after {delivered_units} result(s); the first not delivered is in section {section} ({}) at offset {offset}; later sections start at their first result. Continue with grep {}]",
                label_of(section / pats.len(), section % pats.len()),
                next
            ));
        }
        Ok(Some(text))
    }

    /// grep-pattern-fanout.mjs `runCombinedFanout`: one scan carrying every pattern over a folder, its lines attributed
    /// to each pattern they match, when every pattern compiles as a JavaScript regex. It keeps `min(4000, max(400,
    /// (offset + limit + 4) × patterns))` lines (300 per pattern when unlimited); past that, or over a file, a missing
    /// path or a pattern the scan refuses, it declines (`None`). Its sections know their totals.
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    async fn combined_patterns(
        &self,
        (ctx, sources): GrepIo<'_>,
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
        let lines: Vec<String> =
            found.all.iter().map(|(label, h)| format!("{}:{}:{}", label.replace('/', std::path::MAIN_SEPARATOR_STR), h.line, h.text)).collect();
        let Some((by_pattern, residual)) = attribute_combined(&lines, &regexes) else { return Ok(None) };
        let mut bodies = Vec::with_capacity(patterns.len());
        for (pattern, indices) in patterns.iter().zip(&by_pattern) {
            bodies.push(if indices.is_empty() {
                no_matches(!partial)
            } else {
                let all: Vec<(String, Hit)> = indices.iter().map(|&i| found.all[i].clone()).collect();
                let shape = Shape { mode: Mode::Content, single: false, fanout: true, complete: !partial, totals: Totals::Combined };
                render((ctx, sources), &all, &window, shape, pattern, budget, false).await?
            });
        }
        let residual = residual.into_iter().map(|i| lines[i].clone()).collect();
        Ok(Some((bodies, residual, partial.then(|| partial_warning(found.timed_out, found.scan_errors, true)))))
    }

    /// grep-pattern-fanout.mjs `fanoutPrefilterCandidates`: before the per-pattern greps, one files-with-matches scan of
    /// every pattern over a folder; when it completes with no file the call is one no-match answer. A file, a missing
    /// path or a scan error leaves the per-pattern greps to answer.
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    async fn no_candidate_files(&self, ctx: &ToolContext, args: &JsonValue, patterns: &[String]) -> Result<bool, ToolError> {
        // Sent as a bulk search (grep-pattern-fanout.mjs:76).
        let Some(found) = declined_on_failure(self.collect(ctx, args, &combined_regex(patterns), Mode::Files, Some(1), SearchClass::Bulk).await)? else {
            return Ok(false);
        };
        Ok(found.complete && found.errors.is_empty() && !found.single && found.all.is_empty())
    }

    /// Whether `raw` names an existing file (a missing path or a stat failure is left to the scan to answer).
    async fn names_a_file(&self, ctx: &ToolContext, raw: &str) -> bool {
        let Ok(abs) = resolve_path(&ctx.cwd, raw) else { return false };
        matches!(guarded(ctx, "grep", ctx.files.stat(ctx.io.interactive, abs)).await, Ok(Ok(stat)) if stat.kind == EntryKind::File)
    }

    /// Every root's hits (at most `bound` in all, in scan order), labelled and sorted.
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    async fn collect(
        &self,
        ctx: &ToolContext,
        args: &JsonValue,
        pattern: &str,
        mode: Mode,
        bound: Option<usize>,
        class: SearchClass,
    ) -> Result<Collected, ToolError> {
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
            // Node's fan-out stats the path first and declines a path that is not a folder before any scan is sent
            // (`fanoutPrefilterCandidates`, `streamCombinedLines`: `if (!preStat.isDirectory()) return null`), so a bulk pass over
            // one file never takes a turn on the gate: it is answered as the decline it is (`single`).
            if class == SearchClass::Bulk && roots.len() == 1 && self.names_a_file(ctx, raw).await {
                single = true;
                continue;
            }
            let scanned = if class == SearchClass::Bulk {
                broad_search(ctx, BROAD_REFUSALS[3], |budget| self.run_one_root(ctx, (raw, args, pattern, &globs), mode, left, class, budget)).await?
            } else {
                self.run_one_root(ctx, (raw, args, pattern, &globs), mode, left, class, u64::MAX).await?
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
        sort_hits(&mut all, mode);
        Ok(Collected { all, complete, timed_out, scan_errors, errors, single, all_bad })
    }

    /// grep-path-fanout.mjs `runCombinedPathFanout`: one scan over every path, attributed back to each path's section,
    /// when the call is one pattern outside `count` mode over existing, non-glob, non-share paths none of which lies in
    /// another and which share one filter set. The scan keeps `min(4000, max(400, (offset + limit + 4) × paths))` hits
    /// (300 per path when unlimited); past that, or when a path cannot be scanned, it declines (`None`) and every path is
    /// searched on its own. Its sections know their totals.
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    async fn combined_paths(
        &self,
        (ctx, sources): GrepIo<'_>,
        args: &JsonValue,
        list: &[String],
        patterns: &[String],
        budget: usize,
    ) -> Result<Option<Vec<String>>, ToolError> {
        let Some((pattern, sections)) = self.combined_collect(ctx, args, list, patterns).await? else { return Ok(None) };
        let window = Window::of(args, mode_of(args));
        let mut bodies = Vec::with_capacity(sections.len());
        for (hits, is_file) in &sections {
            bodies.push(if hits.is_empty() {
                no_matches(true)
            } else {
                let shape = Shape { mode: mode_of(args), single: *is_file, fanout: false, complete: true, totals: Totals::Combined };
                render((ctx, sources), hits, &window, shape, &pattern, budget, false).await?
            });
        }
        Ok(Some(bodies))
    }

    /// The scan of [`Self::combined_paths`]: the single pattern and each path's hits (in scan order, with whether the path is
    /// a file), or `None` when the call is not one the combined scan takes.
    #[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
    async fn combined_collect(
        &self,
        ctx: &ToolContext,
        args: &JsonValue,
        list: &[String],
        patterns: &[String],
    ) -> Result<Option<(String, Vec<(Vec<(String, Hit)>, bool)>)>, ToolError> {
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
            let scanned = self.run_one_root(ctx, (raw, args, pattern, &globs), mode, Some(cap + 1 - seen), SearchClass::Interactive, u64::MAX).await;
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
            sort_hits(&mut labelled, mode);
            sections.push((labelled, is_file));
        }
        Ok(Some((pattern.to_string(), sections)))
    }
}
