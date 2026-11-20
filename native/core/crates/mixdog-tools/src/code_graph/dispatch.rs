//! Resolve the project root a `code_graph` call runs in, build its graph and route the call
//! to one of the mode answers.
#![allow(clippy::disallowed_methods, reason = "blocking filesystem reads; the whole call runs as one maintenance-lane job (CodeGraphTool::call)")]

use std::path::{Path, PathBuf};

use super::args::Args;
use super::cache::{GraphCache, Lease};
use super::federation::{TrustSnapshot, drop_cwd_anchors, plan_federation, run_federation};
use super::graph::Graph;
use super::modes::{self, Ctx};
use super::output::Warnings;
use super::roots::{FileAnchor, abs_from, find_dir_project_root, resolve_aggregate_anchor_root, resolve_directory_root, resolve_file_anchor_root};

const MODES: [&str; 12] =
    ["overview", "imports", "dependents", "related", "impact", "symbols", "find_symbol", "symbol_search", "search", "references", "callers", "callees"];

/// Path of `abs` under `root` with forward slashes, or the absolute path when outside it.
pub(super) fn display_rel(abs: &Path, root: &Path) -> String {
    if abs.strip_prefix(root).is_err() {
        // `toDisplayPath`: the prefix match ignores case on every platform, as the drive letter or a folder's casing may differ.
        let (a, r) = (abs.to_string_lossy().replace('\\', "/"), root.to_string_lossy().replace('\\', "/"));
        let r = r.trim_end_matches('/');
        if a.len() >= r.len() && a.is_char_boundary(r.len()) && a[..r.len()].to_lowercase() == r.to_lowercase() {
            if a.len() == r.len() {
                return String::new();
            }
            if let Some(rest) = a[r.len()..].strip_prefix('/') {
                return rest.to_owned();
            }
        }
    }
    abs.strip_prefix(root).unwrap_or(abs).to_string_lossy().replace('\\', "/")
}

/// A finished call: the model text, and the absolute paths the answer depends on.
///
/// `dependency_roots` is what Node's `code_graph` records through
/// `recordScopedCacheDependency` while it resolves its target, for the tool-result cache to
/// invalidate on a write: the cwd when the answer's routing hangs off it (an aggregate
/// `files:` call with no project at the cwd), the root the graph was built from, and every
/// file/dir anchor resolved against the caller's cwd. It is `None` when the call recorded
/// nothing (a missing-file answer), and such an answer is never cached.
pub(super) struct Answer {
    pub text: String,
    pub dependency_roots: Option<Vec<PathBuf>>,
    /// False when the answer is known partial (a federated section failed, or the graph hit its
    /// file cap): Node's `markScopedCacheIncomplete`, so the result is not reused.
    pub complete: bool,
    /// The whole answer is an error body (`classifyResultKind`). A single call's error does not
    /// make it incomplete, but a federated parent counts an erroring section as a failed one.
    pub error: bool,
    /// The files the graphs behind the answer held unindexed (`options._parseWarnings`).
    pub warnings: Warnings,
}

/// What a call knows beyond its arguments: where trusted roots come from, and the session's cwd
/// (always a selected directory).
pub(super) struct Env<'a> {
    pub trust: &'a TrustSnapshot,
    pub cache: &'a GraphCache,
    pub session_cwd: &'a Path,
}

pub(super) fn run(args: &Args, default_cwd: &Path, env: &Env<'_>) -> Result<Answer, String> {
    run_scoped(args, default_cwd, env, &[])
}

/// One call. `excluded` are nested project roots a federated child must not re-index.
pub(super) fn run_scoped(args: &Args, default_cwd: &Path, env: &Env<'_>, excluded: &[PathBuf]) -> Result<Answer, String> {
    let base = match &args.cwd {
        Some(c) => abs_from(default_cwd, c),
        None => default_cwd.to_path_buf(),
    };
    let args = drop_cwd_anchors(args, &base);
    let has_file_arg = args.file.is_some();
    let has_aggregate = !args.files.is_empty();
    let explicit = args.cwd.is_some();
    // An explicit cwd is a deliberate target: honour whatever root it resolves to. A session cwd
    // is a guess, so its ancestor walk stops at the home/temp boundary.
    let base_project_root = find_dir_project_root(&base, !explicit);
    let mut dependency_roots: Vec<PathBuf> = Vec::new();
    // The parent scope matters only when the answer's routing hangs off it: federation
    // membership or sentinel-free aggregate anchor resolution.
    let plan = plan_federation(&args, &base, base_project_root.as_ref(), has_file_arg, has_aggregate, env);
    if args.node_offset.is_some() {
        if args.mode != "callers"
            || args.depth.unwrap_or(1.0) < 2.0
            || args.user_limit() != Some(1)
            || args.symbol_list().len() != 1
            || args.file_list().len() > 1
        {
            return Err("code_graph: node_offset requires transitive callers, one symbol, at most one file, and limit:1".to_owned());
        }
        if plan.active && plan.files.is_empty() && plan.roots.len() > 1 {
            return Err("code_graph: set cwd to one project to recover a caller entry".to_owned());
        }
    }
    if plan.active || (has_aggregate && base_project_root.is_none()) {
        dependency_roots.push(base.clone());
    }
    if plan.active
        && let Some(federated) = run_federation(&plan, &args, &base, env, &dependency_roots)
    {
        return Ok(federated);
    }
    let mut root = base.clone();
    let mut args = args;
    if has_aggregate && base_project_root.is_none() {
        (root, args) = resolve_aggregate_anchor_root("code_graph", &args, &base, explicit)?;
    }
    if let Some(file) = args.file.as_deref().filter(|_| !has_aggregate) {
        match resolve_file_anchor_root("code_graph", file, &base, explicit)? {
            FileAnchor::Error(text) => return Ok(Answer { text, dependency_roots: None, complete: true, error: true, warnings: Warnings::default() }),
            FileAnchor::Root(anchor_root) => {
                if let Some(anchor_root) = anchor_root {
                    root = anchor_root;
                }
            }
        }
    }
    if !has_file_arg && !explicit {
        root = resolve_directory_root("code_graph", &root)?;
    }
    // The roots this query actually executes against: the effective graph root and each
    // absolute file anchor (a loose anchor may sit outside that root).
    dependency_roots.push(root.clone());
    dependency_roots.extend(args.file_list().iter().map(|file| abs_from(&base, file)));
    let mut seen = std::collections::HashSet::new();
    dependency_roots.retain(|path| seen.insert(path.clone()));
    let mode = args.mode.as_str();
    if !MODES.contains(&mode) {
        return Err(format!("code_graph: unknown mode \"{mode}\""));
    }
    if let Some(error) = &args.file_type_error {
        return Err(error.clone());
    }

    let anchors = args.file_list();
    let single_file = match anchors.as_slice() {
        [one] => Some(abs_from(&base, one)).filter(|p| p.is_file()),
        _ => None,
    };
    // A source read that finds a file changed marks that generation stale; the call then runs once more on the next
    // generation, which re-reads the file. Nothing discards the parsed records of the files that did not change.
    let mut attempt = 0;
    let (_graph, section, warnings) = loop {
        let (graph, one_file) = match single_file.as_ref().filter(|_| mode == "symbols") {
            Some(file) => match Graph::build_single(&root, file)? {
                Some(g) => (Lease::alone(std::sync::Arc::new(g)), true),
                None => (env.cache.graph(&root, excluded)?, false),
            },
            None => (env.cache.graph(&root, excluded)?, false),
        };
        if !graph.verify_records() {
            if attempt == 0 {
                attempt = 1;
                continue;
            }
            return Err("code_graph: could not verify the current project sources; run it again".to_owned());
        }

        // `runCodeGraphWork`: `symbols[]` and `files[]` fan out into `# <mode> <item>` sections.
        let mode = if mode == "symbols" && args.body == Some(true) && !args.symbol_list().is_empty() { "find_symbol" } else { mode };
        let batch_mode = if mode == "search" { "symbol_search" } else { mode };
        let mut warnings = Warnings::default();
        warnings.collect(one_file, &root, &graph);
        // A mode's failure fails the call; inside a fan-out it is that section's `Error:` body (`_fanoutSections`).
        let raw = |a: &Args| -> Result<Section, String> { answer(mode, a, &base, default_cwd, &root, &graph, a.file.as_deref()).map(Section::whole) };
        let caught = |section: Result<Section, String>| section.unwrap_or_else(|e| Section::whole(format!("Error: {e}")));
        // `files` scopes the symbol modes: one entry becomes the anchor, several fan out per file.
        let scope_files =
            if BATCHABLE.contains(&batch_mode) && args.file.as_deref().is_none_or(|f| f.trim().is_empty()) { args.file_list() } else { Vec::new() };
        let one = |a: &Args| -> Result<Section, String> {
            match scope_files.as_slice() {
                [] => raw(a),
                [only] => raw(&a.with_file(only)),
                many => Ok(fanout(many, |f| format!("file {f}"), |f| caught(raw(&a.with_file(f))))),
            }
        };
        let section = 'work: {
            if BATCHABLE.contains(&batch_mode) {
                let list = args.symbol_list();
                match list.as_slice() {
                    [] => {}
                    [only] if args.symbol.as_deref() == Some(only.as_str()) => {}
                    [only] => break 'work one(&args.with_symbol(only)),
                    many => break 'work Ok(fanout(many, |s| format!("{batch_mode} {s}"), |s| caught(one(&args.with_symbol(s))))),
                }
            }
            if FILE_BATCHABLE.contains(&batch_mode) {
                let list = args.file_list();
                match list.as_slice() {
                    [] => {}
                    [only] if args.file.as_deref() == Some(only.as_str()) => {}
                    [only] => break 'work one(&args.with_file(only)),
                    many => break 'work Ok(fanout(many, |f| format!("{batch_mode} {f}"), |f| caught(one(&args.with_file(f))))),
                }
            }
            one(&args)
        }?;
        if graph.source_stale() || !graph.resolver_inputs_current() {
            if attempt == 0 {
                attempt = 1;
                continue;
            }
            // The files changed again under the fresh build: the empty reads would silently drop references, bodies or
            // callers from the answer, so it fails instead.
            return Err("code_graph: source files changed while the query ran; run it again".to_owned());
        }
        break (graph, section, warnings);
    };
    // Node marks the call incomplete once a graph holds an unindexed file (`collectGraphParseWarnings`).
    let complete = section.complete && warnings.is_empty();
    let error = is_error_body(&section.text);
    Ok(Answer { text: section.text, dependency_roots: Some(dependency_roots), complete, error, warnings })
}

/// One answer text and whether it is whole: a fanned-out call is whole only when every section is.
pub(super) struct Section {
    text: String,
    complete: bool,
}

impl Section {
    fn whole(text: String) -> Self {
        Self { text, complete: true }
    }
}

/// `classifyResultKind(body) == 'error'`.
pub(super) fn is_error_body(body: &str) -> bool {
    let lower = body.trim_start().to_lowercase();
    if lower.starts_with("[error") {
        return true;
    }
    let Some(rest) = lower.strip_prefix("error") else {
        return false;
    };
    let after = rest.trim_start();
    (rest.starts_with(char::is_whitespace) && after.starts_with("[code")) || after.starts_with(':')
}

/// Modes that take `symbols[]`.
const BATCHABLE: [&str; 6] = ["symbol", "find_symbol", "symbol_search", "callers", "callees", "references"];
/// Modes that take `files[]` as separate targets.
const FILE_BATCHABLE: [&str; 6] = ["overview", "imports", "dependents", "related", "impact", "symbols"];

/// One `# header` section per item, joined by a blank line (`_fanoutSections`): a section that
/// is an error body, or itself incomplete, makes the whole answer incomplete.
fn fanout<T>(items: &[T], header: impl Fn(&T) -> String, run: impl Fn(&T) -> Section) -> Section {
    let mut complete = true;
    let mut texts = Vec::new();
    for item in items {
        let part = run(item);
        complete &= part.complete && !is_error_body(&part.text);
        texts.push(format!("# {}\n{}", header(item), part.text));
    }
    Section { text: texts.join("\n\n"), complete }
}

fn answer(mode: &str, args: &Args, base: &Path, default_cwd: &Path, root: &PathBuf, graph: &Graph, anchor: Option<&str>) -> Result<String, String> {
    let abs = anchor.map(|a| abs_from(base, a));
    let rel = abs.as_ref().map(|p| display_rel(p, root));
    let is_dir = abs.as_ref().is_some_and(|p| p.is_dir());
    let (file_rel, scope_prefix) = match (&rel, is_dir) {
        // The project root itself is no scope (`_scopeRelPrefix`).
        (Some(r), true) => match r.trim_end_matches('/') {
            "" | "." => (None, None),
            dir => (None, Some(format!("{dir}/"))),
        },
        (Some(r), false) => (Some(r.clone()), None),
        _ => (None, None),
    };
    let ctx =
        Ctx { args, cwd: root, default_cwd, graph, norm_file: anchor, node: file_rel.as_deref().and_then(|r| graph.node(r)), rel: file_rel, scope_prefix };
    match mode {
        "overview" => Ok(modes::overview(&ctx)),
        "imports" => Ok(modes::imports(&ctx)),
        "dependents" => modes::dependents(&ctx),
        "related" => Ok(modes::related(&ctx)),
        "impact" => Ok(modes::impact(&ctx)),
        "symbols" => Ok(modes::symbols(&ctx)),
        "find_symbol" => modes::find_symbol(&ctx),
        "symbol_search" | "search" => modes::symbol_search(&ctx),
        "references" => modes::references(&ctx),
        "callers" => modes::callers(&ctx),
        _ => modes::callees(&ctx),
    }
}

#[cfg(test)]
mod display_rel_tests {
    use super::*;

    /// `toDisplayPath`: on every platform a cwd that differs from the indexed root only by case still strips.
    #[test]
    fn the_root_prefix_matches_without_regard_to_case() {
        assert_eq!(display_rel(Path::new("/Proj/Src/a.ts"), Path::new("/proj")), "Src/a.ts");
        assert_eq!(display_rel(Path::new("/Proj"), Path::new("/proj/")), "");
        assert_eq!(display_rel(Path::new("/Projects/a.ts"), Path::new("/proj")), "/Projects/a.ts");
    }
}
