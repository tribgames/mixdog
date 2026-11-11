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

use super::cache::{CachedFile, GraphCache};
use super::resolve::resolve_imports;
use super::roots::path_key;

/// Files indexed per graph; the files after the cut are not part of any answer.
pub(super) const MAX_FILES: usize = 10_000;

pub(super) struct Node {
    pub rel: String,
    pub lang: &'static str,
    pub scan_lang: Option<ScanLang>,
    pub text: String,
    /// Why the file is in the graph unindexed (`parseError`): empty for an indexed file. The
    /// only failure is a source that does not decode (the native build's `decode_source_text`).
    pub parse_error: String,
    pub symbols: Vec<SymbolInfo>,
    pub raw_imports: Vec<String>,
    /// Rels of the indexed files this file imports, in import order.
    pub resolved_imports: Vec<String>,
    /// Sorted unique identifier tokens.
    pub tokens: Vec<String>,
    /// `None`: no call extraction ran for this file (unknown, not "no calls").
    pub calls: Option<Vec<CallInfo>>,
    /// Size and modification time (ns since the epoch) the node was parsed from: the cache's
    /// signature for reusing it.
    pub fingerprint: Option<(u64, u64)>,
    lines: OnceLock<Vec<String>>,
}

/// `(size, mtime_ns)` of a file.
fn fingerprint_of(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let nanos = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some((meta.len(), u64::try_from(nanos).ok()?))
}

fn rel_of(root: &Path, path: &Path) -> Option<String> {
    Some(path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/"))
}

impl Node {
    pub fn lines(&self) -> &[String] {
        self.lines.get_or_init(|| split_lines(&self.text))
    }

    pub fn has_token(&self, name: &str) -> bool {
        self.tokens.binary_search_by(|t| t.as_str().cmp(name)).is_ok()
    }
}

pub(super) fn split_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect()
}

/// Node's `_symbolTokenIndex` keys (`<language|*>|<name>`), in first-lookup order: every name a
/// query has looked up in this graph, found or not.
pub(super) type Lookups = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

pub(super) struct Graph {
    pub nodes: Vec<Node>,
    index: HashMap<String, usize>,
    /// rel -> sorted rels of the files that import it.
    reverse: HashMap<String, BTreeSet<String>>,
    pub truncated: bool,
    lookups: Lookups,
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

    /// Candidate files of a name: the ones whose tokens contain it.
    pub fn token_candidates<'a>(
        &'a self,
        name: &'a str,
        language: Option<&'a str>,
    ) -> impl Iterator<Item = &'a Node> {
        let key = format!("{}|{name}", language.unwrap_or("*"));
        let mut seen = self.lookups.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !seen.contains(&key) {
            seen.push(key);
        }
        drop(seen);
        self.nodes
            .iter()
            .filter(move |n| language.is_none_or(|l| n.lang == l) && n.has_token(name))
    }

    /// Node `_formatNoSymbolMatches`: up to three other spellings of `symbol`, differing only in
    /// case, that a query has looked up in this graph.
    pub fn casing_variants(&self, symbol: &str) -> Vec<String> {
        let lower = symbol.to_lowercase();
        let mut out: Vec<String> = Vec::new();
        if self.nodes.is_empty() {
            return out;
        }
        for key in self.lookups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter() {
            let Some((_, name)) = key.split_once('|') else { continue };
            if name != symbol && name.to_lowercase() == lower && !out.iter().any(|n| n == name) {
                out.push(name.to_owned());
                if out.len() >= 3 {
                    break;
                }
            }
        }
        out
    }

    /// The whole project under `root`, minus the nested project roots in `excluded` (a federated
    /// child never re-indexes a sibling that owns its own graph).
    ///
    /// Files whose size and modification time match the cache's copy are not parsed again; a
    /// whole-tree build that changed anything is staged for the cache's next flush.
    pub fn build(root: &Path, excluded: &[PathBuf], cache: &GraphCache) -> Result<Graph, String> {
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
        let whole_tree = excluded.is_empty();
        // Each cached file is taken at most once, by the worker whose file still matches it.
        let previous: HashMap<String, std::sync::Mutex<Option<CachedFile>>> = if whole_tree { cache.load(root) } else { None }
            .unwrap_or_default()
            .into_iter()
            .map(|(rel, file)| (rel, std::sync::Mutex::new(Some(file))))
            .collect();
        let reused = std::sync::atomic::AtomicUsize::new(0);
        let previous_len = previous.len();
        let mut nodes = sized
            .par_iter()
            .map(|(path, lang)| {
                let stamp = fingerprint_of(path);
                let hit = rel_of(root, path).and_then(|rel| previous.get(&rel)).and_then(|slot| {
                    let mut slot = slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    if slot.as_ref().is_some_and(|file| Some((file.size, file.mtime_ns)) == stamp) { slot.take() } else { None }
                });
                match hit {
                    Some(file) => {
                        reused.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        Ok(Node::from_cache(file, path, lang))
                    }
                    None => parse_node(root, path, lang),
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        link(&mut nodes);
        // Nothing to write when every file came from the cache and none went away.
        if whole_tree && (reused.into_inner() != nodes.len() || previous_len != nodes.len()) {
            cache.stage(root, nodes.iter().filter_map(CachedFile::of).collect());
        }
        let mut graph = Self::assemble(root, nodes, truncated);
        if whole_tree {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            for node in &graph.nodes {
                (&node.rel, node.fingerprint).hash(&mut hasher);
            }
            let base_bytes = graph.nodes.iter().map(|node| node.text.len() as u64).sum();
            graph.lookups = cache.lookups_for(&path_key(root), hasher.finish(), base_bytes);
        }
        Ok(graph)
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

    fn assemble(_root: &Path, nodes: Vec<Node>, truncated: bool) -> Graph {
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
            nodes,
            index,
            reverse,
            truncated,
            lookups: Lookups::default(),
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
    let fingerprint = fingerprint_of(path);
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
        parse_error,
        symbols: extraction.symbols,
        raw_imports: extraction.imports,
        resolved_imports: Vec::new(),
        tokens: extraction.tokens,
        calls,
        fingerprint,
        lines: OnceLock::new(),
    })
}

impl Node {
    /// A node rebuilt from the cache's copy of the file.
    pub(super) fn from_cache(file: CachedFile, path: &Path, lang: &'static str) -> Node {
        Node {
            rel: file.rel,
            lang,
            scan_lang: scan_lang_for_path(path),
            text: file.text,
            parse_error: file.parse_error,
            symbols: file.symbols.into_iter().map(super::cache::CachedSymbol::into_symbol).collect(),
            raw_imports: file.raw_imports,
            resolved_imports: Vec::new(),
            tokens: file.tokens,
            calls: file.calls.map(|calls| calls.into_iter().map(super::cache::CachedCall::into_call).collect()),
            fingerprint: Some((file.size, file.mtime_ns)),
            lines: OnceLock::new(),
        }
    }
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
