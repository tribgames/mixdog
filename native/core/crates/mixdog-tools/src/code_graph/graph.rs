//! The project graph a `code_graph` query answers from: one node per indexed source file,
//! built from `mixdog-graph`'s parse (symbols, call sites, tokens, raw imports) and the
//! import edges resolved over the indexed file set.
#![allow(
    clippy::disallowed_methods,
    reason = "blocking filesystem reads; the whole call runs as one maintenance-lane job (CodeGraphTool::call)"
)]

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use mixdog_graph::calls::CallInfo;
use mixdog_graph::lang::{lang_for, lang_static};
use mixdog_graph::outline::{self, SymbolInfo};
use mixdog_graph::scan_lang::{ScanLang, scan_lang_for_path};
use mixdog_graph::{MAX_FILE_BYTES, walk_classified_files};
use rayon::prelude::*;

use super::resolve::resolve_imports;

/// Files indexed per graph; the files after the cut are not part of any answer.
pub(super) const MAX_FILES: usize = 10_000;

pub(super) struct Node {
    pub rel: String,
    pub lang: &'static str,
    pub scan_lang: Option<ScanLang>,
    pub text: String,
    pub symbols: Vec<SymbolInfo>,
    pub raw_imports: Vec<String>,
    /// Rels of the indexed files this file imports, in import order.
    pub resolved_imports: Vec<String>,
    /// Sorted unique identifier tokens.
    pub tokens: Vec<String>,
    /// `None`: no call extraction ran for this file (unknown, not "no calls").
    pub calls: Option<Vec<CallInfo>>,
    lines: OnceLock<Vec<String>>,
}

impl Node {
    pub fn lines(&self) -> &[String] {
        self.lines.get_or_init(|| split_lines(&self.text))
    }

    pub fn has_token(&self, name: &str) -> bool {
        self.tokens.binary_search_by(|t| t.as_str().cmp(name)).is_ok()
    }
}

/// A path as a comparable key: forward slashes, no trailing slash, lowercase on Windows.
fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_start_matches("//?/").trim_end_matches('/').to_owned();
    if cfg!(windows) { text.to_lowercase() } else { text }
}

pub(super) fn split_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect()
}

pub(super) struct Graph {
    pub cwd: PathBuf,
    pub nodes: Vec<Node>,
    index: HashMap<String, usize>,
    /// rel -> sorted rels of the files that import it.
    reverse: HashMap<String, BTreeSet<String>>,
    pub truncated: bool,
}

impl Graph {
    pub fn node(&self, rel: &str) -> Option<&Node> {
        self.index.get(rel).map(|i| &self.nodes[*i])
    }

    pub fn dependents(&self, rel: &str) -> Vec<String> {
        self.reverse
            .get(rel)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn has_native_symbols(&self) -> bool {
        self.nodes.iter().any(|n| !n.symbols.is_empty())
    }

    pub fn has_ast_calls(&self) -> bool {
        self.nodes.iter().any(|n| n.calls.is_some())
    }

    /// Candidate files of a name: the ones whose tokens contain it.
    pub fn token_candidates<'a>(
        &'a self,
        name: &'a str,
        language: Option<&'a str>,
    ) -> impl Iterator<Item = &'a Node> {
        self.nodes
            .iter()
            .filter(move |n| language.is_none_or(|l| n.lang == l) && n.has_token(name))
    }

    /// The whole project under `root`, minus the nested project roots in `excluded` (a federated
    /// child never re-indexes a sibling that owns its own graph).
    pub fn build(root: &Path, excluded: &[PathBuf]) -> Result<Graph, String> {
        let mut candidates = walk_classified_files(root, |p| {
            p.extension().and_then(|s| s.to_str()).and_then(lang_for)
        })?;
        if !excluded.is_empty() {
            let prefixes: Vec<String> = excluded.iter().map(|path| path_key(path)).collect();
            candidates.retain(|(path, _)| {
                let key = path_key(path);
                !prefixes.iter().any(|prefix| key == *prefix || key.starts_with(&format!("{prefix}/")))
            });
        }
        candidates.sort_by(|a, b| a.0.cmp(&b.0));
        let sized: Vec<(PathBuf, &'static str)> = candidates
            .into_par_iter()
            .filter(|(p, _)| {
                std::fs::metadata(p)
                    .map(|m| m.len() <= MAX_FILE_BYTES)
                    .unwrap_or(false)
            })
            .map(|(p, l)| (p, lang_static(l)))
            .collect();
        let truncated = sized.len() > MAX_FILES;
        let sized = &sized[..sized.len().min(MAX_FILES)];
        let mut nodes = sized
            .par_iter()
            .map(|(path, lang)| parse_node(root, path, lang))
            .collect::<Result<Vec<_>, _>>()?;
        link(&mut nodes);
        Ok(Self::assemble(root, nodes, truncated))
    }

    /// One file on its own, rooted at `root` (a symbol outline needs no edges).
    pub fn build_single(root: &Path, file: &Path) -> Result<Option<Graph>, String> {
        let Some(lang) = file
            .extension()
            .and_then(|s| s.to_str())
            .and_then(lang_for)
            .map(lang_static)
        else {
            return Ok(None);
        };
        if std::fs::metadata(file).map_err(|e| e.to_string())?.len() > MAX_FILE_BYTES {
            return Ok(None);
        }
        let node = parse_node(root, file, lang)?;
        Ok(Some(Self::assemble(root, vec![node], false)))
    }

    fn assemble(root: &Path, nodes: Vec<Node>, truncated: bool) -> Graph {
        let index = nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.rel.clone(), i))
            .collect();
        let mut reverse: HashMap<String, BTreeSet<String>> = HashMap::new();
        for node in &nodes {
            for target in &node.resolved_imports {
                if *target != node.rel {
                    reverse
                        .entry(target.clone())
                        .or_default()
                        .insert(node.rel.clone());
                }
            }
        }
        Graph {
            cwd: root.to_path_buf(),
            nodes,
            index,
            reverse,
            truncated,
        }
    }
}

fn parse_node(root: &Path, path: &Path, lang: &'static str) -> Result<Node, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("read failed for {}: {e}", path.display()))?;
    let rel = path
        .strip_prefix(root)
        .map_err(|e| format!("path is outside graph root ({}): {e}", path.display()))?
        .to_string_lossy()
        .replace('\\', "/");
    let (text, parse_error) = match String::from_utf8(bytes) {
        Ok(text) => (text, String::new()),
        Err(_) => (
            String::new(),
            "unsupported source encoding; file not indexed".to_string(),
        ),
    };
    let scan_lang = scan_lang_for_path(path);
    let extraction = match (scan_lang, parse_error.is_empty()) {
        (Some(scan), true) => outline::extract(&text, lang, scan),
        _ => outline::Extraction::default(),
    };
    let calls = if parse_error.is_empty() {
        extraction.calls
    } else {
        None
    };
    Ok(Node {
        rel,
        lang,
        scan_lang,
        text,
        symbols: extraction.symbols,
        raw_imports: extraction.imports,
        resolved_imports: Vec::new(),
        tokens: extraction.tokens,
        calls,
        lines: OnceLock::new(),
    })
}

fn link(nodes: &mut [Node]) {
    let files: HashSet<String> = nodes.iter().map(|n| n.rel.clone()).collect();
    let resolved: Vec<Vec<String>> = nodes
        .par_iter()
        .map(|n| resolve_imports(&n.rel, n.lang, &n.raw_imports, &files))
        .collect();
    for (node, edges) in nodes.iter_mut().zip(resolved) {
        node.resolved_imports = edges;
    }
}
