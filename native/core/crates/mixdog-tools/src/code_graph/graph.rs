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
use mixdog_graph::resolve::{ImportRecord, extract_top_level_types, resolve_and_link};
use mixdog_graph::scan_lang::{ScanLang, scan_lang_for_path};
use mixdog_graph::{MAX_FILE_BYTES, walk_classified_files};
use rayon::prelude::*;

use super::cache::{CachedFile, GraphCache};
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
    /// java/kotlin `package` (`packageName`): the import index's package members and the prefix of its FQCNs.
    pub package_name: String,
    /// csharp `namespace` (`namespaceName`): the import index's namespace members.
    pub namespace_name: String,
    /// go `package` clause (`goPackageName`): the resolver does not read it; it is counted in the node's bytes.
    pub go_package_name: String,
    /// java/kotlin `topLevelTypes` word scan: the type names of the import index's FQCNs.
    pub top_level_types: Vec<String>,
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
    /// The runtime caches of the resident graph this node belongs to: a read of its source enters them at once, as
    /// Node's source accessors fill `_sourceTextCache` / `_sourceLinesCache` / `_maskedLinesCache` where they read.
    runtime: OnceLock<Lookups>,
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
        self.note_read();
        self.lines.get_or_init(|| split_lines(&self.text))
    }

    /// The file's source text, read for an answer.
    pub fn source(&self) -> &str {
        self.note_read();
        &self.text
    }

    /// A query read this file: its source-cache entries enter the resident graph's runtime caches now (again after a
    /// prune cleared them), so a prune running meanwhile measures them where Node's would.
    fn note_read(&self) {
        let Some(runtime) = self.runtime.get() else { return };
        let mut runtime = runtime.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !runtime.sources.contains_key(&self.rel) {
            runtime.sources.insert(self.rel.clone(), source_entry_bytes(self));
        }
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

/// Node's runtime caches of a resident graph (graph-model.mjs:150 `GRAPH_RUNTIME_CACHE_KEYS`) as the casing hint and
/// the memory budget see them.
#[derive(Default)]
pub(super) struct Runtime {
    /// `_symbolTokenIndex` keys (`<language|*>|<name>`) in first-lookup order, every name a query has looked up in
    /// this graph, found or not, with the bytes of its entry (the key and its candidate rels).
    pub keys: Vec<(String, u64)>,
    /// Rels whose source a query read, with the bytes of their `_sourceTextCache`, `_sourceLinesCache` and
    /// `_maskedLinesCache` entries.
    pub sources: HashMap<String, u64>,
    /// The graph's token index (symbol-index.mjs `_tokenIndexes`) is built: every query awaits it, and the runtime
    /// cache clear leaves it.
    pub queried: bool,
}

const RUNTIME_CACHE_KEYS: [&str; 6] =
    ["_referenceSearchCache", "_keywordSearchCache", "_maskedLinesCache", "_sourceLinesCache", "_sourceTextCache", "_symbolTokenIndex"];

impl Runtime {
    /// graph-model.mjs:204 `_estimateGraphRetainedBytes` over the runtime caches: each key and its Map
    /// (`_estimateRuntimeCacheBytes`, graph-model.mjs:240).
    pub fn cache_bytes(&self) -> u64 {        let maps: u64 = RUNTIME_CACHE_KEYS.iter().map(|k| 8 + js_str(k) + 48).sum();
        maps + self.keys.iter().map(|(_, b)| b).sum::<u64>() + self.sources.values().sum::<u64>()
    }

    /// graph-model.mjs:285 `_clearGraphRuntimeCaches`.
    pub fn clear(&mut self) {
        self.keys.clear();
        self.sources.clear();
    }
}

pub(super) type Lookups = std::sync::Arc<std::sync::Mutex<Runtime>>;

/// `_estimateValueBytes` (graph-model.mjs:249) of a string: 16 + 2 per UTF-16 unit.
pub(super) fn js_str(s: &str) -> u64 {
    js_units(s.encode_utf16().count())
}

fn js_units(n: usize) -> u64 {
    16 + 2 * n as u64
}

/// `_estimateValueBytes` of an array of strings.
fn js_strings<'a>(items: impl IntoIterator<Item = &'a str>) -> u64 {
    items.into_iter().map(|s| 8 + js_str(s)).sum::<u64>() + 24
}

/// `_estimateValueBytes` of a JSON value as Node holds it parsed.
fn js_value(value: &serde_json::Value) -> u64 {
    match value {
        serde_json::Value::Null => 0,
        serde_json::Value::Bool(_) => 4,
        serde_json::Value::Number(_) => 8,
        serde_json::Value::String(s) => js_str(s),
        serde_json::Value::Array(items) => 24 + items.iter().map(|v| 8 + js_value(v)).sum::<u64>(),
        serde_json::Value::Object(map) => 48 + map.iter().map(|(k, v)| 8 + js_str(k) + js_value(v)).sum::<u64>(),
    }
}

/// One own property of an object: its slot, its key and its value.
fn field(key: &str, value: u64) -> u64 {
    8 + js_str(key) + value
}

/// The source-cache entries Node keeps for a file it read (`{ fingerprint, text }` and `{ fingerprint, lines }` twice),
/// each with its Map slot and key. The lines are counted off the text (`text.split(/\r?\n/)`: one line per `\n` plus
/// the last, each `\r\n` or `\n` dropped), not split again.
fn source_entry_bytes(node: &Node) -> u64 {
    let slot = 24 + js_str(&node.rel);
    let fingerprint = field("fingerprint", js_units(16));
    let text_units = node.text.encode_utf16().count() as u64;
    let breaks = node.text.matches('\n').count() as u64;
    let carriage = node.text.matches("\r\n").count() as u64;
    let lines_units = text_units - breaks - carriage;
    let lines_bytes = 24 + (breaks + 1) * (8 + 16) + 2 * lines_units;
    let text = slot + 48 + fingerprint + field("text", js_str(&node.text));
    let lines = slot + 48 + fingerprint + field("lines", lines_bytes);
    text + 2 * lines
}

/// Node's graph signature (`<sha1 hex>#calls2`) and record schema version.
const SIGNATURE_UNITS: usize = 47;
const SCHEMA_VERSION: &str = "sym-record-v2-unified-kinds";

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
        let candidates = move |n: &&'a Node| language.is_none_or(|l| n.lang == l) && n.has_token(name);
        let mut runtime = self.lookups.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !runtime.keys.iter().any(|(k, _)| *k == key) {
            let rels = js_strings(self.nodes.iter().filter(candidates).map(|n| n.rel.as_str()));
            let bytes = 24 + js_str(&key) + rels;
            runtime.keys.push((key, bytes));
        }
        drop(runtime);
        self.nodes.iter().filter(candidates)
    }

    /// Node `_formatNoSymbolMatches`: up to three other spellings of `symbol`, differing only in
    /// case, that a query has looked up in this graph.
    pub fn casing_variants(&self, symbol: &str) -> Vec<String> {
        let lower = symbol.to_lowercase();
        let mut out: Vec<String> = Vec::new();
        if self.nodes.is_empty() {
            return out;
        }
        for (key, _) in self.lookups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).keys.iter() {
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
        let whole_set_cached = !previous.is_empty();
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
        link(root, &mut nodes);
        // Every file came from the cache and none went away: Node's disk-cache hit (`_deserializeGraph`).
        let unchanged = whole_set_cached && reused.into_inner() == nodes.len() && previous_len == nodes.len();
        if whole_tree && !unchanged {
            cache.stage(root, nodes.iter().filter_map(CachedFile::of).collect());
        }
        let mut graph = Self::assemble(root, nodes, truncated);
        if whole_tree {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            for node in &graph.nodes {
                (&node.rel, node.fingerprint).hash(&mut hasher);
            }
            let key = path_key(root);
            let measured = || (graph.base_bytes(&key, unchanged), graph.token_index_bytes());
            let lookups = cache.lookups_for(&key, hasher.finish(), measured);
            // The query starts: it awaits the graph's token index (symbol-index.mjs `_ensureTokenIndex`), which a prune
            // from here on counts.
            lookups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).queried = true;
            for node in &graph.nodes {
                let _ = node.runtime.set(lookups.clone());
            }
            graph.lookups = lookups;
        }
        Ok(graph)
    }

    /// graph-model.mjs:167 `_estimateGraphBaseBytes` of the graph Node holds for this file set: the object
    /// build.mjs:704 assembles (nodes shaped as build-file-infos.mjs:150 `assembleGraphNodes`), or, for a set
    /// loaded unchanged from the cache, the one graph-model.mjs:72 `_deserializeGraph` returns (no call sites, the
    /// `_callsHydration` marker, `truncated` only when set, empty token lists absent).
    fn base_bytes(&self, root_key: &str, from_disk: bool) -> u64 {        let root_units = root_key.encode_utf16().count();
        let abs = |rel: &str| js_units(root_units + 1 + rel.encode_utf16().count());
        let mut imported_by: HashMap<&str, Vec<&str>> = HashMap::new();
        let mut reverse: Vec<(&str, Vec<&str>)> = Vec::new();
        for node in &self.nodes {
            for target in &node.resolved_imports {
                let sources = imported_by.entry(target.as_str()).or_default();
                if !sources.contains(&node.rel.as_str()) {
                    sources.push(node.rel.as_str());
                }
                match reverse.iter_mut().find(|(t, _)| t == target) {
                    Some((_, set)) if set.contains(&node.rel.as_str()) => {}
                    Some((_, set)) => set.push(node.rel.as_str()),
                    None => reverse.push((target.as_str(), vec![node.rel.as_str()])),
                }
            }
        }
        let mut nodes = 48 + 24 * self.nodes.len() as u64;
        for node in &self.nodes {
            let symbols = 24 + node.symbols.iter().map(|s| 8 + serde_json::to_value(s).map_or(0, |v| js_value(&v))).sum::<u64>();
            let calls = match (&node.calls, from_disk) {
                (Some(calls), false) => 24 + calls.iter().map(|c| 8 + serde_json::to_value(c).map_or(0, |v| js_value(&v))).sum::<u64>(),
                _ => 0,
            };
            let tokens = if from_disk && node.tokens.is_empty() { 0 } else { js_strings(node.tokens.iter().map(String::as_str)) };
            let resolved = node.resolved_imports.iter().map(|r| 8 + abs(r)).sum::<u64>() + 24;
            let object = 48
                + field("abs", abs(&node.rel))
                + field("rel", js_str(&node.rel))
                + field("lang", js_str(node.lang))
                + field("fingerprint", js_units(16))
                + field("parseError", js_str(&node.parse_error))
                + field("rawImports", js_strings(node.raw_imports.iter().map(String::as_str)))
                + field("resolvedImportsRel", js_strings(node.resolved_imports.iter().map(String::as_str)))
                + field("resolvedImports", resolved)
                + field("importedBy", js_strings(imported_by.get(node.rel.as_str()).into_iter().flatten().copied()))
                + field("packageName", js_str(&node.package_name))
                + field("namespaceName", js_str(&node.namespace_name))
                + field("goPackageName", js_str(&node.go_package_name))
                + field("topLevelTypes", js_strings(node.top_level_types.iter().map(String::as_str)))
                + field("tokenSymbols", tokens)
                + field("symbols", symbols)
                + field("calls", calls);
            nodes += js_str(&node.rel) + object;
        }
        let reverse_bytes = 48 + reverse.iter().map(|(t, set)| 24 + js_str(t) + 48 + set.iter().map(|s| 16 + js_str(s)).sum::<u64>()).sum::<u64>();
        let mut bytes = 48
            + field("cwd", js_units(root_units))
            + field("nodes", nodes)
            + field("reverse", reverse_bytes)
            + field("schemaVersion", js_str(SCHEMA_VERSION))
            + field("builtAt", 8)
            + field("signature", js_units(SIGNATURE_UNITS))
            + field("_symbolTokenIndexDirty", 4);
        if !from_disk || self.truncated {
            bytes += field("truncated", 4);
        }
        if from_disk {
            bytes += field("_callsHydration", js_str("pending"));
        }
        bytes
    }

    /// symbol-index.mjs:73 `_buildTokenIndex`'s byte count: per token its first file as a bare ordinal, a second
    /// file turning it into an array, each further file one more item; 16 per node.
    fn token_index_bytes(&self) -> u64 {        let mut files: HashMap<&str, usize> = HashMap::new();
        let mut bytes = 48 + 2 * 24;
        for node in &self.nodes {
            for token in &node.tokens {
                let seen = files.entry(token.as_str()).or_insert(0);
                bytes += match *seen {
                    0 => 24 + js_str(token) + 8,
                    1 => 24 + 2 * 16 - 8,
                    _ => 16,
                };
                *seen += 1;
            }
            bytes += 16;
        }
        bytes
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
    let top_level_types = extract_top_level_types(&text, lang);
    Ok(Node {
        rel,
        lang,
        scan_lang,
        text,
        parse_error,
        symbols: extraction.symbols,
        raw_imports: extraction.imports,
        package_name: extraction.package_name,
        namespace_name: extraction.namespace_name,
        go_package_name: extraction.go_package_name,
        top_level_types,
        resolved_imports: Vec::new(),
        tokens: extraction.tokens,
        calls,
        fingerprint,
        lines: OnceLock::new(),
        runtime: OnceLock::new(),
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
            package_name: file.package_name,
            namespace_name: file.namespace_name,
            go_package_name: file.go_package_name,
            top_level_types: file.top_level_types,
            resolved_imports: Vec::new(),
            tokens: file.tokens,
            calls: file.calls.map(|calls| calls.into_iter().map(super::cache::CachedCall::into_call).collect()),
            fingerprint: Some((file.size, file.mtime_ns)),
            lines: OnceLock::new(),
            runtime: OnceLock::new(),
        }
    }
}

impl ImportRecord for Node {
    fn rel(&self) -> &str {
        &self.rel
    }

    fn lang(&self) -> &str {
        self.lang
    }

    fn raw_imports(&self) -> &[String] {
        &self.raw_imports
    }

    fn package_name(&self) -> &str {
        &self.package_name
    }

    fn namespace_name(&self) -> &str {
        &self.namespace_name
    }

    fn top_level_types(&self) -> &[String] {
        &self.top_level_types
    }

    /// The graph's reverse edges come from `resolved_imports` (`Graph::assemble`), so `importedBy` is not kept.
    fn set_edges(&mut self, resolved_imports: Vec<String>, _imported_by: Vec<String>) {
        self.resolved_imports = resolved_imports;
    }
}

/// The import edges Node's graph takes from the `mixdog-graph` binary's records (graph-binary.mjs
/// `_fileInfoFromRustRecord`): the binary's own `resolve_and_link` over every indexed file, with the project's
/// manifests (go.mod, tsconfig/jsconfig, package.json workspaces, Cargo.toml, composer, pubspec) read under `root`.
fn link(root: &Path, nodes: &mut [Node]) {
    let files: HashSet<String> = nodes.iter().map(|n| n.rel.clone()).collect();
    resolve_and_link(nodes, root, &files);
}
