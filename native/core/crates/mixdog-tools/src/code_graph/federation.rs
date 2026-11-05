//! Federation: answering a call from a cwd that is not itself a project (a filesystem root, a
//! multi-repo parent, `files:['.']` at a sentinel-free folder) by fanning out over the trusted
//! or discovered project roots beneath it — `dispatch/federation.mjs`, `trusted-roots.mjs`.
//!
//! Trust is a routing preference, not an admission gate. The roots a federated call runs over
//! are the registered projects, the session's selected cwd and the roots the graph cache has
//! indexed (all under the cwd); a sentinel-free cwd with none of them federates over its
//! discovered child projects instead. At a filesystem root only the trusted set is used.
#![allow(
    clippy::disallowed_methods,
    reason = "blocking filesystem reads; the whole call runs as one maintenance-lane job (CodeGraphTool::call)"
)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rayon::prelude::*;

use super::args::Args;
use super::dispatch::{Answer, Env, run_scoped};
use super::roots::{
    FEDERATION_CAP, abs_from, child_project_roots, find_dir_project_root, is_filesystem_root, path_key,
};

/// Where a federated call finds the roots a user has told Mixdog about. The composition root
/// supplies it to `CodeGraphTool::new`; there is deliberately no empty default, because a tool
/// without a trust source would silently stop federating.
#[async_trait::async_trait]
pub trait TrustedRoots: Send + Sync {
    /// The registered projects (Node `listProjects`).
    async fn registered(&self) -> Vec<PathBuf>;
    /// The session's selected directories beyond the tool's own cwd (Node `explicitSessionCwd`
    /// and `readLastSessionCwd`).
    async fn selected(&self) -> Vec<PathBuf>;
}

/// The trust sources read once at dispatch, so the blocking graph work never waits on them. The
/// cached roots are the graph cache's manifest keys, filled in on the lane.
#[derive(Default)]
pub(super) struct TrustSnapshot {
    registered: Vec<PathBuf>,
    selected: Vec<PathBuf>,
    cached: Vec<PathBuf>,
}

impl TrustSnapshot {
    pub(super) async fn read(trust: &dyn TrustedRoots) -> Self {
        Self { registered: trust.registered().await, selected: trust.selected().await, cached: Vec::new() }
    }

    pub(super) fn with_cached(mut self, cached: Vec<PathBuf>) -> Self {
        self.cached = cached;
        self
    }

    #[cfg(test)]
    pub(super) fn of(registered: Vec<PathBuf>) -> Self {
        Self { registered, ..Self::default() }
    }
}

/// The modes a federated call may fan out (`ROOT_FEDERATED_MODES`).
const ROOT_FEDERATED_MODES: [&str; 10] = [
    "overview",
    "symbol",
    "find_symbol",
    "symbol_search",
    "search",
    "references",
    "callers",
    "callees",
    "symbols",
    "prewarm",
];

/// The modes whose anchors are symbols: a `file`/`files` entry equal to the cwd is scope noise
/// for them, not an anchor (`CODE_GRAPH_SYMBOL_ANCHOR_MODES`).
const SYMBOL_ANCHOR_MODES: [&str; 7] = [
    "find_symbol",
    "symbol_search",
    "search",
    "references",
    "callers",
    "callees",
    "symbols",
];

pub(super) fn is_wildcard(file: &str) -> bool {
    file.contains(['*', '?', '[', ']', '{', '}'])
}

fn norm(path: &Path) -> PathBuf {
    abs_from(Path::new(""), &path.to_string_lossy())
}

/// `canonicalGraphPath`: the resolved path as the one shared key.
fn canonical_graph_path(path: &Path) -> String {
    path_key(&norm(path))
}

/// `_pathIsWithin(root, candidate)`: the candidate is the root or under it.
fn path_within(root: &Path, candidate: &Path) -> bool {
    let (r, c) = (canonical_graph_path(root), canonical_graph_path(candidate));
    c == r || c.starts_with(&format!("{r}/"))
}

/// The deepest root that owns `file` (`owningTrustedCodeGraphRoot`).
fn owning_root(file: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    let mut matches: Vec<&PathBuf> = roots.iter().filter(|root| path_within(root, file)).collect();
    matches.sort_by_key(|root| std::cmp::Reverse(norm(root).to_string_lossy().encode_utf16().count()));
    matches.first().map(|root| (*root).clone())
}

/// The roots a federated child call must not re-index: siblings nested under it.
fn excluded_roots_for(root: &Path, roots: &[PathBuf]) -> Vec<PathBuf> {
    roots
        .iter()
        .filter(|candidate| candidate.as_path() != root && path_within(root, candidate))
        .cloned()
        .collect()
}

fn project_label(root: &Path) -> String {
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = if name.is_empty() { root.display().to_string() } else { name };
    format!("{name} [{}]", root.display())
}

/// Live, non-root graph targets under `filesystem_root` from the registered projects, the
/// selected cwds and the cached roots (`collectTrustedCodeGraphRoots`), sorted by locale.
pub(super) fn collect_trusted_roots(filesystem_root: &Path, env: &Env<'_>) -> Vec<PathBuf> {
    let root = norm(filesystem_root);
    let trust = env.trust;
    let mut rows: Vec<(PathBuf, bool)> = Vec::new();
    rows.extend(trust.registered.iter().cloned().map(|p| (p, false)));
    rows.push((env.session_cwd.to_path_buf(), true));
    rows.extend(trust.selected.iter().cloned().map(|p| (p, true)));
    rows.extend(trust.cached.iter().cloned().map(|p| (p, false)));
    let mut found: HashMap<String, PathBuf> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (path, detect) in rows {
        if path.as_os_str().is_empty() {
            continue;
        }
        let mut candidate = norm(&path);
        if !candidate.is_dir() || is_filesystem_root(&candidate) || !path_within(&root, &candidate) {
            continue;
        }
        // A selected directory inside a sentinel project belongs to the nearest project graph;
        // registrations and cache keys stay exact. A home or temp sentinel never widens it.
        if detect && let Some(detected) = find_dir_project_root(&candidate, true) {
            candidate = norm(&detected);
        }
        if is_filesystem_root(&candidate) || !candidate.is_dir() || !path_within(&root, &candidate) {
            continue;
        }
        let key = canonical_graph_path(&candidate);
        if !found.contains_key(&key) {
            order.push(key.clone());
            found.insert(key, candidate);
        }
    }
    let mut roots: Vec<PathBuf> = order.into_iter().filter_map(|key| found.remove(&key)).collect();
    roots.sort_by(|a, b| mixdog_js::locale_compare(&a.to_string_lossy(), &b.to_string_lossy()));
    roots
}

/// `_dropCwdAnchors`: a symbol-mode `file`/`files` entry that is the cwd itself carries no
/// anchor.
pub(super) fn drop_cwd_anchors(args: &Args, base: &Path) -> Args {
    if !SYMBOL_ANCHOR_MODES.contains(&args.mode.as_str()) {
        return args.clone();
    }
    let mut next = args.clone();
    let base_abs = abs_from(Path::new(""), &base.to_string_lossy());
    if let Some(file) = next.file.as_deref().map(str::trim).filter(|f| !f.is_empty())
        && abs_from(base, file) == base_abs
    {
        next.file = None;
    }
    if anchors_are_cwd(&next, base) {
        next.files = Vec::new();
        next.file = None;
    }
    next
}

/// `_aggregateAnchorsAreCwd`: every anchor of an aggregate call resolves to the cwd itself, so
/// the call means "search here".
fn anchors_are_cwd(args: &Args, base: &Path) -> bool {
    if args.files.is_empty() {
        return false;
    }
    let files = args.file_list();
    if files.is_empty() {
        return false;
    }
    let base_abs = abs_from(Path::new(""), &base.to_string_lossy());
    files.iter().all(|file| {
        let file = file.trim();
        !file.is_empty() && !is_wildcard(file) && abs_from(base, file) == base_abs
    })
}

pub(super) struct Plan {
    pub active: bool,
    exact_dot: bool,
    raw_mode: String,
    roots: Vec<PathBuf>,
    files: Vec<String>,
}

/// Whether, and over which roots, this call federates (`planFederation`).
pub(super) fn plan_federation(
    args: &Args,
    base: &Path,
    base_project_root: Option<&PathBuf>,
    has_file_arg: bool,
    has_aggregate: bool,
    env: &Env<'_>,
) -> Plan {
    let filesystem_root_cwd = base_project_root.is_none() && is_filesystem_root(base);
    let files = args.file_list();
    let raw_mode = args.mode.trim().to_owned();
    let federated_mode = ROOT_FEDERATED_MODES.contains(&raw_mode.as_str());
    let exact_dot = files.len() == 1 && files[0] == "." && federated_mode;
    let parent_dot = base_project_root.is_none() && !filesystem_root_cwd && exact_dot;
    let base_abs = norm(base);
    let not_self = |root: &PathBuf| norm(root) != base_abs;
    // Trusted graph targets living UNDER a sentinel-free cwd; self is filtered out, since
    // federating a directory into itself would recurse forever.
    let trusted: Vec<PathBuf> = if base_project_root.is_some() {
        Vec::new()
    } else {
        collect_trusted_roots(base, env).into_iter().filter(not_self).collect()
    };
    // Registered roots keep priority; discovered children only fill in when registration
    // yields nothing.
    let mut federation_roots = trusted.clone();
    if trusted.is_empty() && base_project_root.is_none() {
        federation_roots = child_project_roots(base, FEDERATION_CAP).into_iter().filter(not_self).collect();
    }
    let sentinel_free = base_project_root.is_none()
        && !filesystem_root_cwd
        && !parent_dot
        && !has_file_arg
        && !has_aggregate
        && federated_mode
        && !federation_roots.is_empty();
    Plan {
        active: filesystem_root_cwd || parent_dot || sentinel_free,
        exact_dot,
        raw_mode,
        // A filesystem root stays on the registered set only: fanning out over every project
        // directory on a whole drive is a different cost class than one folder's children.
        roots: if filesystem_root_cwd { trusted } else { federation_roots },
        files: if exact_dot { Vec::new() } else { files },
    }
}

struct Child {
    text: String,
    roots: Vec<PathBuf>,
    complete: bool,
}

fn run_child(args: &Args, root: &Path, excluded: &[PathBuf], env: &Env<'_>) -> Child {
    match run_scoped(args, root, env, excluded) {
        Ok(answer) => Child {
            complete: answer.complete && !answer.error,
            roots: answer.dependency_roots.unwrap_or_default(),
            text: answer.text,
        },
        Err(message) => Child { text: format!("Error: {message}"), roots: Vec::new(), complete: false },
    }
}

fn merge(sections: Vec<(String, Child)>, base_roots: Vec<PathBuf>) -> Answer {
    let mut roots = base_roots;
    let mut complete = true;
    let mut texts = Vec::new();
    for (header, child) in sections {
        complete &= child.complete;
        roots.extend(child.roots);
        texts.push(format!("{header}{}", child.text));
    }
    Answer { text: texts.join("\n\n"), dependency_roots: Some(roots), complete, error: false }
}

/// The federated answer, or `None` when the plan cannot route the call and the single-project
/// path must decide (`runFederation`).
pub(super) fn run_federation(plan: &Plan, args: &Args, base: &Path, env: &Env<'_>, base_roots: &[PathBuf]) -> Option<Answer> {
    if !plan.files.is_empty() {
        return Some(federate_file_anchors(plan, args, base, env, base_roots.to_vec()));
    }
    if !plan.roots.is_empty() && ROOT_FEDERATED_MODES.contains(&plan.raw_mode.as_str()) {
        return Some(federate_roots(plan, args, env, base_roots.to_vec()));
    }
    None
}

fn refusal(text: String, base_roots: Vec<PathBuf>) -> Answer {
    Answer { text, dependency_roots: Some(base_roots), complete: true, error: true }
}

fn federate_file_anchors(plan: &Plan, args: &Args, base: &Path, env: &Env<'_>, base_roots: Vec<PathBuf>) -> Answer {
    let name = "code_graph";
    if plan.files.iter().any(|file| is_wildcard(file)) {
        return refusal(format!("Error: {name}: wildcard-shaped file anchors are not allowed at a filesystem root"), base_roots);
    }
    struct Routed<'a> {
        file: &'a String,
        abs: PathBuf,
        root: Option<PathBuf>,
    }
    let routed: Vec<Routed<'_>> = plan
        .files
        .iter()
        .map(|file| {
            let abs = abs_from(base, file);
            let root = owning_root(&abs, &plan.roots);
            Routed { file, abs, root }
        })
        .collect();
    if let Some(missing) = routed.iter().find(|row| !row.abs.exists()) {
        return refusal(format!("Error: {name}: file not found: {}", missing.file), base_roots);
    }
    if let Some(untrusted) = routed.iter().find(|row| row.root.is_none()) {
        return refusal(format!("Error: {name}: file anchor is not owned by a trusted project: {}", untrusted.file), base_roots);
    }
    let mut project_args = args.clone();
    project_args.cwd = None;
    let sections: Vec<(String, Child)> = routed
        .par_iter()
        .map(|row| {
            let root = row.root.as_ref().expect("every anchor is owned");
            let mut child_args = project_args.clone();
            child_args.files = Vec::new();
            child_args.file = Some(row.abs.to_string_lossy().into_owned());
            let child = run_child(&child_args, root, &excluded_roots_for(root, &plan.roots), env);
            (format!("# {} {}\n# project {}\n", plan.raw_mode, row.file, project_label(root)), child)
        })
        .collect();
    merge(sections, base_roots)
}

fn federate_roots(plan: &Plan, args: &Args, env: &Env<'_>, base_roots: Vec<PathBuf>) -> Answer {
    let mut project_args = args.clone();
    project_args.cwd = None;
    if plan.exact_dot {
        project_args.file = None;
        project_args.files = Vec::new();
    }
    let sections: Vec<(String, Child)> = plan
        .roots
        .par_iter()
        .map(|root| {
            let child = run_child(&project_args, root, &excluded_roots_for(root, &plan.roots), env);
            (format!("# project {}\n", project_label(root)), child)
        })
        .collect();
    merge(sections, base_roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn child(text: &str, complete: bool) -> Child {
        Child { text: text.to_owned(), roots: vec![PathBuf::from("/r")], complete }
    }

    #[test]
    fn a_failed_section_makes_the_merged_answer_incomplete_and_keeps_every_root() {
        let whole = merge(vec![("# a\n".into(), child("ok", true)), ("# b\n".into(), child("ok", true))], vec![]);
        assert!(whole.complete);
        let partial = merge(vec![("# a\n".into(), child("ok", true)), ("# b\n".into(), child("Error: x", false))], vec![PathBuf::from("/base")]);
        assert!(!partial.complete);
        assert_eq!(partial.text, "# a\nok\n\n# b\nError: x");
        assert_eq!(partial.dependency_roots, Some(vec![PathBuf::from("/base"), PathBuf::from("/r"), PathBuf::from("/r")]));
    }
}
