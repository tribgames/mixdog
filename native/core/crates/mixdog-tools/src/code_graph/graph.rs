//! The project graph a `code_graph` query answers from: one node per indexed source file,
//! built from `mixdog-graph`'s parse (symbols, call sites, tokens, raw imports) and the
//! import edges resolved over the indexed file set.
#![allow(
    clippy::disallowed_methods,
    reason = "blocking filesystem reads; the whole call runs as one maintenance-lane job (CodeGraphTool::call)"
)]

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use mixdog_graph::calls::CallInfo;
use mixdog_graph::lang::{lang_for, lang_static};
use mixdog_graph::outline::{self, SymbolInfo};
use mixdog_graph::resolve::{ImportRecord, extract_top_level_types, resolve_and_link_reporting};
use mixdog_graph::scan_lang::{ScanLang, scan_lang_for_path};
use mixdog_graph::{MAX_FILE_BYTES, walk_classified_files};
use rayon::prelude::*;

use super::cache::{CachedFile, GraphCache, GraphFiles};
use super::roots::path_key;

/// Files indexed per graph; the files after the cut are not part of any answer.
pub(super) const MAX_FILES: usize = 10_000;

pub(super) struct Node {
    pub rel: String,
    pub lang: &'static str,
    pub scan_lang: Option<ScanLang>,
    /// Where this file's source is read from when a query needs it: nodes keep no text.
    origin: Arc<Origin>,
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
    /// Sorted unique identifier tokens, as ids into the graph's word table (`Origin::intern`).
    pub tokens: Box<[u32]>,
    /// The Node-model bytes of the file's call sites; `None`: no call extraction ran for this file (unknown, not "no
    /// calls"). The call sites themselves are not kept: [`Node::calls`] extracts them from the source when asked.
    pub calls_bytes: Option<u64>,
    /// Size and modification time (ns since the epoch) the node was parsed from: the cache's
    /// signature for reusing it.
    pub fingerprint: Option<(u64, u64)>,
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

/// What a graph's nodes read their source through: the project root, and whether a read found a file no longer as
/// the graph was built from it.
pub(super) struct Origin {
    root: PathBuf,
    stale: AtomicBool,
    words: Mutex<Words>,
}

/// Every distinct token of a graph once; a node's tokens are ids into it.
#[derive(Default)]
struct Words {
    ids: HashMap<Arc<str>, u32>,
    list: Vec<Arc<str>>,
}

impl Origin {
    fn new(root: &Path) -> Arc<Self> {
        Arc::new(Self { root: root.to_path_buf(), stale: AtomicBool::new(false), words: Mutex::default() })
    }

    fn words(&self) -> std::sync::MutexGuard<'_, Words> {
        self.words.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The ids of `tokens`, sorted.
    fn intern(&self, tokens: Vec<String>) -> Box<[u32]> {
        let mut words = self.words();
        let mut ids: Vec<u32> = tokens
            .into_iter()
            .map(|token| match words.ids.get(token.as_str()) {
                Some(id) => *id,
                None => {
                    let id = words.list.len() as u32;
                    let word: Arc<str> = Arc::from(token);
                    words.list.push(word.clone());
                    words.ids.insert(word, id);
                    id
                }
            })
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids.into_boxed_slice()
    }
}

/// A file's source as a query reads it: the text, and its lines once something asks for them.
pub(super) struct Source {
    text: String,
    lines: OnceLock<Vec<String>>,
}

impl Source {
    fn new(text: String) -> Self {
        Self { text, lines: OnceLock::new() }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn lines(&self) -> &[String] {
        self.lines.get_or_init(|| split_lines(&self.text))
    }

    /// Heap held while cached: the text, and room for its lines (a `String` header and allocator slack for every
    /// line, however short: a file of blank lines costs most in its line headers).
    fn cost(&self) -> u64 {
        const PER_LINE: u64 = 24 + 16;
        let lines = self.text.bytes().filter(|b| *b == b'\n').count() as u64 + 1;
        2 * self.text.len() as u64 + PER_LINE * lines + 64
    }
}

/// What was derived from files recently, across every graph and bounded in bytes (`MIXDOG_CODE_GRAPH_SOURCE_CACHE_MB`,
/// default 8, for each of the two caches below): least recently used first. An entry is keyed by the file's path and
/// the `(size, mtime)` it was derived at.
struct Lru<T> {
    entries: Vec<(PathBuf, (u64, u64), Arc<T>, u64)>,
    bytes: u64,
}

impl<T> Lru<T> {
    const fn new() -> Self {
        Self { entries: Vec::new(), bytes: 0 }
    }

    fn get(&mut self, path: &Path, stamp: (u64, u64)) -> Option<Arc<T>> {
        let at = self.entries.iter().position(|(p, s, _, _)| p == path && *s == stamp)?;
        let entry = self.entries.remove(at);
        let value = entry.2.clone();
        self.entries.push(entry);
        Some(value)
    }

    /// Keeps `value` unless it costs more than the whole `cap` (the caller serves it uncached); older entries go
    /// while the bound is passed, so `bytes` never exceeds `cap`.
    fn put(&mut self, path: PathBuf, stamp: (u64, u64), value: Arc<T>, cost: u64, cap: u64) {
        if cost > cap {
            return;
        }
        self.bytes += cost;
        self.entries.push((path, stamp, value, cost));
        while self.bytes > cap {
            self.bytes -= self.entries.remove(0).3;
        }
    }
}

static SOURCES: Mutex<Lru<Source>> = Mutex::new(Lru::new());
static CALL_SITES: Mutex<Lru<Vec<CallInfo>>> = Mutex::new(Lru::new());

/// Bytes and entry count of the source cache.
#[cfg(test)]
pub(super) fn source_cache_state() -> (u64, usize) {
    let cache = SOURCES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    (cache.bytes, cache.entries.len())
}

/// Bytes and entry count of the call-site cache.
#[cfg(test)]
pub(super) fn call_site_cache_state() -> (u64, usize) {
    let cache = CALL_SITES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    (cache.bytes, cache.entries.len())
}

#[cfg(test)]
thread_local! {
    /// How many of the calling thread's next disk reads of a source act as if the file had changed meanwhile.
    pub(super) static FORCED_MISMATCHES: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn forced_mismatch() -> bool {
    FORCED_MISMATCHES.with(|left| {
        let forced = left.get() > 0;
        left.set(left.get().saturating_sub(1));
        forced
    })
}

#[cfg(not(test))]
fn forced_mismatch() -> bool {
    false
}

fn source_cache_cap() -> u64 {
    static CAP: OnceLock<u64> = OnceLock::new();
    *CAP.get_or_init(|| {
        let mb = std::env::var("MIXDOG_CODE_GRAPH_SOURCE_CACHE_MB").ok().and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| *v > 0.0).unwrap_or(8.0);
        (mb * 1024.0 * 1024.0) as u64
    })
}

impl Node {
    /// The file's source, read for an answer: from the bounded source cache or from disk. The file must still be as
    /// the graph was built from it; when it is not, the graph is marked stale (the caller builds again) and the read
    /// is empty.
    pub fn read(&self) -> Arc<Source> {
        let source = self.load();
        self.note_read(&source.text);
        source
    }

    fn load(&self) -> Arc<Source> {
        let Some(stamp) = self.fingerprint.filter(|_| self.parse_error.is_empty()) else {
            return Arc::new(Source::new(String::new()));
        };
        let path = self.origin.root.join(&self.rel);
        if let Some(source) = SOURCES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&path, stamp) {
            return source;
        }
        let text = std::fs::read(&path)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|_| fingerprint_of(&path) == Some(stamp))
            .filter(|_| !forced_mismatch());
        let Some(text) = text else {
            self.origin.stale.store(true, Ordering::SeqCst);
            return Arc::new(Source::new(String::new()));
        };
        let source = Arc::new(Source::new(text));
        SOURCES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).put(path, stamp, source.clone(), source.cost(), source_cache_cap());
        source
    }

    /// The call sites of the file (`None`: no call extraction ran for it), extracted from its source now and kept
    /// in a bounded cache: nodes hold none, they are most of what a graph would weigh.
    pub fn calls(&self) -> Option<Arc<Vec<CallInfo>>> {
        self.calls_bytes?;
        let stamp = self.fingerprint?;
        let path = self.origin.root.join(&self.rel);
        if let Some(calls) = CALL_SITES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&path, stamp) {
            return Some(calls);
        }
        let source = self.load();
        let calls = Arc::new(self.scan_lang.and_then(|scan| outline::extract(source.text(), self.lang, scan).calls).unwrap_or_default());
        if !self.origin.stale.load(Ordering::SeqCst) {
            let cost = calls.iter().map(|c| (std::mem::size_of::<CallInfo>() + c.name.len() + c.recv.len() + c.in_symbol.len()) as u64).sum::<u64>() + 64;
            CALL_SITES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).put(path, stamp, calls.clone(), cost, source_cache_cap());
        }
        Some(calls)
    }

    /// A query read this file: its source-cache entries enter the resident graph's runtime caches now (again after a
    /// prune cleared them), so a prune running meanwhile measures them where Node's would.
    fn note_read(&self, text: &str) {
        let Some(runtime) = self.runtime.get() else { return };
        let mut runtime = runtime.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !runtime.sources.contains_key(&self.rel) {
            runtime.sources.insert(self.rel.clone(), source_entry_bytes(&self.rel, text));
        }
    }

    /// Heap bytes of the parsed data (no source text is held).
    fn heap_bytes(&self) -> u64 {
        let strings = |items: &[String]| items.iter().map(|s| 24 + s.len() as u64).sum::<u64>();
        let symbols: u64 = self.symbols.iter().map(|s| (std::mem::size_of::<SymbolInfo>() + s.name.len() + s.sig.len() + s.parent.len()) as u64).sum();
        (std::mem::size_of::<Node>() + self.rel.len() + self.parse_error.len() + self.package_name.len() + self.namespace_name.len() + self.go_package_name.len()) as u64
            + symbols
            + strings(&self.raw_imports)
            + strings(&self.top_level_types)
            + strings(&self.resolved_imports)
            + 4 * self.tokens.len() as u64
    }

    pub fn has_token(&self, name: &str) -> bool {
        let id = self.origin.words().ids.get(name).copied();
        id.is_some_and(|id| self.tokens.binary_search(&id).is_ok())
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
fn source_entry_bytes(rel: &str, text: &str) -> u64 {
    let slot = 24 + js_str(rel);
    let fingerprint = field("fingerprint", js_units(16));
    let text_units = text.encode_utf16().count() as u64;
    let breaks = text.matches('\n').count() as u64;
    let carriage = text.matches("\r\n").count() as u64;
    let lines_units = text_units - breaks - carriage;
    let lines_bytes = 24 + (breaks + 1) * (8 + 16) + 2 * lines_units;
    let text = slot + 48 + fingerprint + field("text", js_str(text));
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
    /// [`signature_of`] the indexed files when it was built (whole-tree builds only).
    pub signature: u64,
    /// What the import resolver looked at when it linked this graph, with the `(size, mtime)` of each as it was.
    inputs: Vec<(PathBuf, Option<(u64, u64)>)>,
    origin: Arc<Origin>,
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
    pub fn build(root: &Path, excluded: &[PathBuf], cache: &GraphCache) -> Result<Arc<Graph>, String> {
        let (sized, truncated) = indexed_files(root, excluded)?;
        let sized = &sized[..];
        let origin = Origin::new(root);
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
                        Ok(Node::from_cache(file, path, lang, origin.clone()))
                    }
                    None => parse_node(root, path, lang, &origin),
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        // Cached files that no longer match are not needed past here.
        drop(previous);
        let inputs = link_stable(root, &mut nodes)?;
        // Every file came from the cache and none went away: Node's disk-cache hit (`_deserializeGraph`).
        let unchanged = whole_set_cached && reused.into_inner() == nodes.len() && previous_len == nodes.len();
        let mut graph = Self::assemble(nodes, truncated, origin);
        graph.inputs = inputs;
        if whole_tree {
            graph.signature = signature_of(graph.nodes.iter().map(|n| (n.rel.as_str(), n.fingerprint)), truncated);
            let key = path_key(root);
            let measured = || (graph.base_bytes(&key, unchanged), graph.token_index_bytes());
            let lookups = cache.lookups_for(&key, graph.signature, measured);
            // The query starts: it awaits the graph's token index (symbol-index.mjs `_ensureTokenIndex`), which a prune
            // from here on counts.
            lookups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).queried = true;
            for node in &graph.nodes {
                let _ = node.runtime.set(lookups.clone());
            }
            graph.lookups = lookups;
        }
        let graph = Arc::new(graph);
        if whole_tree && !unchanged {
            cache.stage(root, GraphFiles(graph.clone()));
        }
        Ok(graph)
    }

    /// The signature a whole-tree graph built now would carry: the indexed files and their size and mtime, no
    /// parsing. A held graph is reused only while this still equals its own.
    pub fn probe(root: &Path) -> Result<u64, String> {
        let (files, truncated) = indexed_files(root, &[])?;
        let sources: Vec<(String, Option<(u64, u64)>)> =
            files.par_iter().map(|(path, _)| (rel_of(root, path).unwrap_or_default(), fingerprint_of(path))).collect();
        Ok(signature_of(sources.iter().map(|(rel, stamp)| (rel.as_str(), *stamp)), truncated))
    }

    /// The import edges are still what the resolver would make: none of the files and directories it looked at has
    /// changed since, and no read found a source file changed.
    pub fn is_fresh(&self) -> bool {
        !self.origin.stale.load(Ordering::SeqCst) && self.inputs.iter().all(|(path, stamp)| fingerprint_of(path) == *stamp)
    }

    /// The graph's words, indexed by token id (shared strings: cloning them copies pointers).
    pub fn word_table(&self) -> Vec<Arc<str>> {
        self.origin.words().list.clone()
    }

    /// A query read a source file that no longer matches the graph.
    pub fn source_stale(&self) -> bool {
        self.origin.stale.load(Ordering::SeqCst)
    }

    /// Heap bytes of the graph's parsed data; source text is read on demand and not part of it.
    pub fn base_heap_bytes(&self) -> u64 {
        self.nodes.iter().map(Node::heap_bytes).sum::<u64>()
            // One shared allocation per word, its slot in the list and its entry in the lookup table.
            + self.origin.words().list.iter().map(|w| 16 + w.len() as u64 + 16 + 28).sum::<u64>()
            + self.index.keys().map(|k| 48 + k.len() as u64).sum::<u64>()
            + self.reverse.iter().map(|(k, set)| 48 + k.len() as u64 + set.iter().map(|s| 48 + s.len() as u64).sum::<u64>()).sum::<u64>()
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
        let words = self.word_table();
        let mut nodes = 48 + 24 * self.nodes.len() as u64;
        for node in &self.nodes {
            let symbols = 24 + node.symbols.iter().map(|s| 8 + serde_json::to_value(s).map_or(0, |v| js_value(&v))).sum::<u64>();
            let calls = match (node.calls_bytes, from_disk) {
                (Some(bytes), false) => bytes,
                _ => 0,
            };
            let tokens = if from_disk && node.tokens.is_empty() { 0 } else { js_strings(node.tokens.iter().map(|id| words[*id as usize].as_ref())) };
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
    fn token_index_bytes(&self) -> u64 {
        let words = self.word_table();
        let mut files: HashMap<&str, usize> = HashMap::new();
        let mut bytes = 48 + 2 * 24;
        for node in &self.nodes {
            for id in node.tokens.iter() {
                let token: &str = &words[*id as usize];
                let seen = files.entry(token).or_insert(0);
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
        let origin = Origin::new(root);
        let node = parse_node(root, file, lang, &origin)?;
        Ok(Some(Self::assemble(vec![node], false, origin)))
    }

    fn assemble(nodes: Vec<Node>, truncated: bool, origin: Arc<Origin>) -> Graph {
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
            signature: 0,
            inputs: Vec::new(),
            origin,
        }
    }
}

#[cfg(test)]
thread_local! {
    /// A smaller cap for the calling thread's walks, so a test crosses it with a few files.
    pub(super) static FILE_CAP: std::cell::Cell<usize> = const { std::cell::Cell::new(MAX_FILES) };
}

#[cfg(test)]
fn file_cap() -> usize {
    FILE_CAP.with(std::cell::Cell::get)
}

#[cfg(not(test))]
fn file_cap() -> usize {
    MAX_FILES
}

/// The files a graph over `root` indexes, sorted, with whether the cap cut any.
fn indexed_files(root: &Path, excluded: &[PathBuf]) -> Result<(Vec<(PathBuf, &'static str)>, bool), String> {
    let mut candidates = walk_classified_files(root, |p| p.extension().and_then(|s| s.to_str()).and_then(lang_for))?;
    if !excluded.is_empty() {
        let prefixes: Vec<String> = excluded.iter().map(|path| path_key(path)).collect();
        candidates.retain(|(path, _)| {
            let key = path_key(path);
            !prefixes.iter().any(|prefix| key == *prefix || key.starts_with(&format!("{prefix}/")))
        });
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    let mut sized: Vec<(PathBuf, &'static str)> = candidates
        .into_par_iter()
        .filter(|(p, _)| std::fs::metadata(p).map(|m| m.len() <= MAX_FILE_BYTES).unwrap_or(false))
        .map(|(p, l)| (p, lang_static(l)))
        .collect();
    let truncated = sized.len() > file_cap();
    sized.truncate(file_cap());
    Ok((sized, truncated))
}

/// One hash over the indexed files' rels and signatures in order, and whether the file cap cut the set.
fn signature_of<'a>(files: impl Iterator<Item = (&'a str, Option<(u64, u64)>)>, truncated: bool) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for file in files {
        file.hash(&mut hasher);
    }
    truncated.hash(&mut hasher);
    hasher.finish()
}

/// Parses one file and drops its text: only what the graph keeps survives.
fn parse_node(root: &Path, path: &Path, lang: &'static str, origin: &Arc<Origin>) -> Result<Node, String> {
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
        origin: origin.clone(),
        parse_error,
        symbols: extraction.symbols,
        raw_imports: extraction.imports,
        package_name: extraction.package_name,
        namespace_name: extraction.namespace_name,
        go_package_name: extraction.go_package_name,
        top_level_types,
        resolved_imports: Vec::new(),
        tokens: origin.intern(extraction.tokens),
        calls_bytes: calls.as_ref().map(|calls| 24 + calls.iter().map(|c| 8 + serde_json::to_value(c).map_or(0, |v| js_value(&v))).sum::<u64>()),
        fingerprint,
        runtime: OnceLock::new(),
    })
}

impl Node {
    /// A node rebuilt from the cache's copy of the file.
    pub(super) fn from_cache(file: CachedFile, path: &Path, lang: &'static str, origin: Arc<Origin>) -> Node {
        Node {
            rel: file.rel,
            lang,
            scan_lang: scan_lang_for_path(path),
            parse_error: file.parse_error,
            symbols: file.symbols.into_iter().map(super::cache::CachedSymbol::into_symbol).collect(),
            raw_imports: file.raw_imports,
            package_name: file.package_name,
            namespace_name: file.namespace_name,
            go_package_name: file.go_package_name,
            top_level_types: file.top_level_types,
            resolved_imports: Vec::new(),
            tokens: origin.intern(file.tokens),
            calls_bytes: file.calls_bytes,
            fingerprint: Some((file.size, file.mtime_ns)),
            origin,
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
///
/// Returns what the resolver looked at, each with its stamp from just before the look.
fn link(root: &Path, nodes: &mut [Node]) -> Vec<(PathBuf, Option<(u64, u64)>)> {
    let files: HashSet<String> = nodes.iter().map(|n| n.rel.clone()).collect();
    resolve_and_link_reporting(nodes, root, &files)
}

#[cfg(test)]
thread_local! {
    /// Runs on the building thread after each link pass, before its inputs are checked.
    pub(super) static AFTER_LINK: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
}

/// Links, and links again while a file the resolver looked at changed after (or while) it was looked at: the edges
/// are only kept with inputs whose stamps are the ones they were made from.
fn link_stable(root: &Path, nodes: &mut [Node]) -> Result<Vec<(PathBuf, Option<(u64, u64)>)>, String> {
    for _ in 0..3 {
        let mut inputs = link(root, nodes);
        #[cfg(test)]
        AFTER_LINK.with(|hook| {
            if let Some(hook) = hook.borrow_mut().as_mut() {
                hook();
            }
        });
        inputs.sort();
        inputs.dedup();
        if inputs.iter().all(|(path, stamp)| fingerprint_of(path) == *stamp) {
            return Ok(inputs);
        }
    }
    Err("code_graph: the project's manifests kept changing while its imports were linked".to_owned())
}

#[cfg(test)]
mod bound_tests {
    use super::*;

    /// Splitting two million blank lines allocates two million `String` headers, whatever the text weighs.
    #[test]
    fn a_source_of_blank_lines_is_charged_its_line_allocations() {
        let source = Source::new("\n".repeat(2_000_000));
        assert!(source.cost() >= 2_000_000 * 24, "{}", source.cost());
    }

    #[test]
    fn a_cache_never_passes_its_cap_and_serves_an_oversized_entry_uncached() {
        let mut lru = Lru::<u8>::new();
        lru.put("a".into(), (1, 1), Arc::new(0), 600, 1000);
        lru.put("b".into(), (1, 1), Arc::new(0), 600, 1000);
        assert_eq!((lru.bytes, lru.entries.len()), (600, 1), "the older entry made room");
        lru.put("c".into(), (1, 1), Arc::new(0), 1001, 1000);
        assert_eq!((lru.bytes, lru.entries.len()), (600, 1), "an entry over the whole cap is not kept");
        assert!(lru.get(Path::new("b"), (1, 1)).is_some());
    }
}
