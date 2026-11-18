//! The project graph a `code_graph` query answers from: one node per indexed source file,
//! built from `mixdog-graph`'s parse (symbols, call sites, tokens, raw imports) and the
//! import edges resolved over the indexed file set.
#![allow(
    clippy::disallowed_methods,
    reason = "blocking filesystem reads; the whole call runs as one maintenance-lane job (CodeGraphTool::call)"
)]

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use mixdog_graph::calls::CallInfo;
use mixdog_graph::lang::{lang_for, lang_static};
use mixdog_graph::outline::{self, SymbolInfo};
use mixdog_graph::resolve::{ImportRecord, ObservedInput, extract_top_level_types, resolve_and_link_observing};
use mixdog_graph::scan_lang::{ScanLang, scan_lang_for_path};
use mixdog_graph::{MAX_FILE_BYTES, walk_classified_files};
use rayon::prelude::*;
use sha2::{Digest, Sha256};

use super::cache::{CachedFile, GraphCache, Ledger, Receipts};
#[cfg(test)]
use super::cache::GraphFiles;
use super::roots::{identity_key, path_key};

// File versions. A file's *discovery* fingerprint is `(size, mtime_ns)`: a file whose fingerprint equals the one a record
// was made at is not read again (nobody hashes unchanged files). A rewrite from outside that preserves both size and
// modification time is not detected by discovery alone. Before serving derived answers we verify the record's digest
// against accessible source bytes. A mismatch invalidates that record's version so the next refresh parses it again.

/// SHA-256 of a file's bytes: the version of what a record was parsed from.
pub(super) fn digest_of(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub(super) fn digest_hex(digest: &[u8; 32]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The digest a cached record carries; `None` for a record written without one (it is parsed again).
fn digest_from_hex(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (at, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(at * 2..at * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// What the parse of one file yields. A record is immutable and shared (`Arc`) by every generation of the graph that
/// holds the file unchanged: a refresh carries it over without copying it.
pub(super) struct Record {
    pub rel: String,
    pub lang: &'static str,
    pub scan_lang: Option<ScanLang>,
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
    /// Sorted unique identifier tokens, as ids into the graph's word table (`Origin::intern`).
    pub tokens: Box<[u32]>,
    /// The Node-model bytes of the file's call sites; `None`: no call extraction ran for this file (unknown, not "no
    /// calls"). The call sites themselves are not kept: [`Node::calls`] extracts them from the source when asked.
    pub calls_bytes: Option<u64>,
    /// Size and modification time (ns since the epoch) the file had when its bytes were read: the signature a later
    /// inventory is compared with, and the cache's signature for reusing the record.
    pub fingerprint: Option<(u64, u64)>,
    /// SHA-256 of the exact bytes this record was parsed from.
    pub digest: [u8; 32],
    /// Estimated heap bytes of the record (no source text is held).
    pub weight: u64,
    /// The word table `tokens` index into: a record gives its tokens back when the last generation holding it is gone.
    words: Arc<Mutex<Words>>,
}

impl Drop for Record {
    fn drop(&mut self) {
        let mut words = self.words.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        for id in self.tokens.iter() {
            words.release(*id);
        }
    }
}

impl Record {
    fn weigh(mut self) -> Self {
        let strings = |items: &[String]| items.iter().map(|s| 24 + s.len() as u64).sum::<u64>();
        let symbols: u64 = self.symbols.iter().map(|s| (std::mem::size_of::<SymbolInfo>() + s.name.len() + s.sig.len() + s.parent.len()) as u64).sum();
        self.weight = (std::mem::size_of::<Record>() + self.rel.len() + self.parse_error.len() + self.package_name.len() + self.namespace_name.len() + self.go_package_name.len()) as u64
            + symbols
            + strings(&self.raw_imports)
            + strings(&self.top_level_types)
            + 4 * self.tokens.len() as u64;
        self
    }
}

/// One file in one generation of a graph: the shared record, the generation's own origin (so a read that finds the file
/// changed marks this generation and no other) and the edges linked for this generation.
pub(super) struct Node {
    record: Arc<Record>,
    /// Where this file's source is read from when a query needs it: nodes keep no text.
    origin: Arc<Origin>,
    /// Rels of the indexed files this file imports, in import order.
    pub resolved_imports: Vec<String>,
    /// The runtime caches of the resident graph this node belongs to: a read of its source enters them at once, as
    /// Node's source accessors fill `_sourceTextCache` / `_sourceLinesCache` / `_maskedLinesCache` where they read.
    runtime: OnceLock<Lookups>,
}

impl std::ops::Deref for Node {
    type Target = Record;

    fn deref(&self) -> &Record {
        &self.record
    }
}

fn rel_of(root: &Path, path: &Path) -> Option<String> {
    Some(path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/"))
}

/// What a graph's nodes read their source through: the project root, and whether a read found a file no longer as
/// the graph was built from it.
pub(super) struct Origin {
    root: PathBuf,
    stale: AtomicBool,
    /// Shared by every generation of one root: records carry ids into it, so a carried record stays valid.
    words: Arc<Mutex<Words>>,
    /// Where a source that is not what its record was parsed from is reported: the ledger keeps it (surviving the graph's
    /// eviction) until a refresh processes that revision.
    invalid: Option<Arc<Ledger>>,
}

/// Every distinct token in use once, with how many records hold it; a record's tokens are ids into it. A token no record
/// holds any more is removed and its id reused, so the table follows what is live, not what ever was.
#[derive(Default)]
struct Words {
    ids: HashMap<Arc<str>, u32>,
    list: Vec<Option<Arc<str>>>,
    refs: Vec<u32>,
    free: Vec<u32>,
}

impl Words {
    fn acquire(&mut self, token: String) -> u32 {
        if let Some(id) = self.ids.get(token.as_str()).copied() {
            self.refs[id as usize] += 1;
            return id;
        }
        let word: Arc<str> = Arc::from(token);
        let id = match self.free.pop() {
            Some(id) => {
                self.list[id as usize] = Some(word.clone());
                self.refs[id as usize] = 1;
                id
            }
            None => {
                self.list.push(Some(word.clone()));
                self.refs.push(1);
                (self.list.len() - 1) as u32
            }
        };
        self.ids.insert(word, id);
        id
    }

    fn release(&mut self, id: u32) {
        let refs = &mut self.refs[id as usize];
        *refs = refs.saturating_sub(1);
        if *refs == 0
            && let Some(word) = self.list[id as usize].take()
        {
            self.ids.remove(&*word);
            self.free.push(id);
        }
    }
}

impl Origin {
    fn new(root: &Path, invalid: Option<Arc<Ledger>>) -> Arc<Self> {
        Arc::new(Self { root: root.to_path_buf(), stale: AtomicBool::new(false), words: Arc::default(), invalid })
    }

    /// The origin of the next generation: the same root and words, a stale mark of its own (a read that found a file
    /// changed under an older generation must not condemn this one).
    fn successor(&self) -> Arc<Self> {
        Arc::new(Self { root: self.root.clone(), stale: AtomicBool::new(false), words: self.words.clone(), invalid: self.invalid.clone() })
    }

    fn words(&self) -> std::sync::MutexGuard<'_, Words> {
        self.words.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A source read for `rel` was not what its record was parsed from: a new revision of the file in the ledger, so the
    /// next refresh parses it.
    fn invalidate(&self, rel: &str) {
        let Some(ledger) = &self.invalid else { return };
        match identity_key(&self.root.join(rel)) {
            Ok(identity) => {
                ledger.note(&identity);
            }
            Err(why) => {
                ledger.note(Ledger::UNKNOWN);
                tracing::warn!(target: "code_graph", file = rel, reason = %why, "code_graph: the file has no resolvable identity; every root parses its files again once");
            }
        }
    }

    /// The ids of `tokens`, sorted; each token is held once for the record that asks.
    fn intern(&self, mut tokens: Vec<String>) -> Box<[u32]> {
        tokens.sort_unstable();
        tokens.dedup();
        let mut words = self.words();
        let mut ids: Vec<u32> = tokens.into_iter().map(|token| words.acquire(token)).collect();
        ids.sort_unstable();
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
/// default 8, for each of the two caches below): least recently used first. An entry is keyed by the file's path and the
/// version it was derived from (the content digest; for call sites also the extraction language and schema).
struct Lru<T> {
    entries: Vec<(PathBuf, String, Arc<T>, u64)>,
    bytes: u64,
}

impl<T> Lru<T> {
    const fn new() -> Self {
        Self { entries: Vec::new(), bytes: 0 }
    }

    fn get(&mut self, path: &Path, version: &str) -> Option<Arc<T>> {
        let at = self.entries.iter().position(|(p, v, _, _)| p == path && v == version)?;
        let entry = self.entries.remove(at);
        let value = entry.2.clone();
        self.entries.push(entry);
        Some(value)
    }

    /// Keeps `value` unless it costs more than the whole `cap` (the caller serves it uncached); older entries go
    /// while the bound is passed, so `bytes` never exceeds `cap`.
    fn put(&mut self, path: PathBuf, version: String, value: Arc<T>, cost: u64, cap: u64) {
        if cost > cap {
            return;
        }
        self.bytes += cost;
        self.entries.push((path, version, value, cost));
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

/// `_estimateValueBytes` of a JSON value as Node holds it parsed: what [`symbol_bytes`] and [`call_bytes`] count directly.
#[cfg(test)]
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

/// `js_value` of a symbol as it serializes (an object of its set members), counted off the symbol itself: a value tree
/// built per symbol only to be measured was most of what indexing a tree allocated.
fn symbol_bytes(symbol: &SymbolInfo) -> u64 {
    let mut bytes = 48
        + field("name", js_str(&symbol.name))
        + field("kind", js_str(symbol.kind))
        + field("startLine", 8)
        + field("endLine", 8)
        + field("startCol", 8)
        + field("endCol", 8);
    if symbol.exported {
        bytes += field("exported", 4);
    }
    if !symbol.sig.is_empty() {
        bytes += field("sig", js_str(&symbol.sig));
    }
    if !symbol.parent.is_empty() {
        bytes += field("parent", js_str(&symbol.parent));
    }
    bytes
}

/// `js_value` of a call as it serializes (the tuple of name, line, column, kind code, receiver and enclosing symbol).
fn call_bytes(call: &CallInfo) -> u64 {
    24 + 6 * 8 + js_str(&call.name) + 3 * 8 + js_str(&call.recv) + js_str(&call.in_symbol)
}

#[cfg(test)]
mod measured_tests {
    use super::*;

    /// The counted sizes are the sizes of the serialized values, member for member.
    #[test]
    fn a_symbol_and_a_call_measure_as_their_serialized_values() {
        let of = |value: serde_json::Value| js_value(&value);
        let mut symbol = SymbolInfo { name: "읽기".into(), kind: "function", start_line: 3, end_line: 9, start_col: 1, end_col: 2, exported: false, sig: String::new(), parent: String::new() };
        assert_eq!(symbol_bytes(&symbol), of(serde_json::to_value(&symbol).unwrap()));
        symbol.exported = true;
        symbol.sig = "pub fn 읽기(path: &Path) -> io::Result<String>".into();
        symbol.parent = "Store".into();
        assert_eq!(symbol_bytes(&symbol), of(serde_json::to_value(&symbol).unwrap()));
        for (recv, in_symbol, kind) in [("", "", "call"), ("self.store", "Store", "method"), ("", "main", "new")] {
            let call = CallInfo { name: "open😀".into(), line: 12, col: 4, end_col: 9, kind, recv: recv.into(), in_symbol: in_symbol.into() };
            assert_eq!(call_bytes(&call), of(serde_json::to_value(&call).unwrap()));
        }
    }
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
const SIGNATURE_UNITS: usize = 47;const SCHEMA_VERSION: &str = "sym-record-v2-unified-kinds";

pub(super) struct Graph {
    pub nodes: Vec<Node>,
    index: HashMap<String, usize>,
    /// rel -> sorted rels of the files that import it.
    reverse: HashMap<String, BTreeSet<String>>,
    /// Eligible files that could not be verified in this generation (their bytes changed while they were read): they are
    /// not in the graph, no earlier record of them stands in for them, and the next query reconsiders them.
    pub unverified: Vec<String>,
    /// The hinted files this generation processed, with the revision of each: a verified parse of the file, a reused record
    /// that carried the same receipt, or the file found to contribute no record. A file that could not be verified has none.
    pub receipts: Receipts,
    /// Every file came from the disk cache's copy and none went away: the cache already holds this graph.
    pub unchanged: bool,
    lookups: Lookups,
    /// [`signature_of`] the indexed files when it was built (whole-tree builds only).
    pub signature: u64,
    /// What the import resolver looked at when it linked this graph, with the `(size, mtime)` of each as it was.
    inputs: Vec<ObservedInput>,
    origin: Arc<Origin>,
}

#[cfg(test)]
thread_local! {
    /// How many files the calling thread's parses have read (a refresh on a thread parses few, on that thread).
    pub(super) static PARSED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// Runs on the reading thread after each read of a file, before its stamp is compared with the one before it.
    pub(super) static AFTER_READ: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
}

/// What one file became in a generation.
enum Slot {
    Node(Node),
    /// Its bytes changed while they were read: it is not in the graph this time.
    Unverified(String),
}

/// One eligible file of an inventory.
pub(super) struct Entry {
    pub path: PathBuf,
    pub rel: String,
    pub lang: &'static str,
    pub stamp: Option<(u64, u64)>,
    /// The file's identity ([`identity_key`]): what hints and receipts name it by. The walker follows no link and lists no
    /// link as a file (`ignore`'s default, `file_type().is_file()` on the entry itself), so every entry is physically under
    /// the root and its identity is the root's identity plus its rel; membership of a hint is this mapping, not a prefix.
    pub identity: String,
}

/// A rel as the session's write notices are compared with it: lower case where the file system is case-blind.
pub(super) fn fold(rel: &str) -> String {
    if cfg!(windows) { rel.to_lowercase() } else { rel.to_owned() }
}

/// One hash over an inventory's rels and fingerprints in order.
pub(super) fn inventory_signature(entries: &[Entry]) -> u64 {
    signature_of(entries.iter().map(|e| (e.rel.as_str(), e.stamp)))
}

fn signature_of<'a>(files: impl Iterator<Item = (&'a str, Option<(u64, u64)>)>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for file in files {
        file.hash(&mut hasher);
    }
    hasher.finish()
}

/// A record rebuilt from the cache's copy of the file.
fn record_from_cache(file: CachedFile, digest: [u8; 32], path: &Path, lang: &'static str, origin: &Origin) -> Record {
    Record {
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
        tokens: origin.intern(file.tokens),
        calls_bytes: file.calls_bytes,
        fingerprint: Some((file.size, file.mtime_ns)),
        digest,
        weight: 0,
        words: origin.words.clone(),
    }
    .weigh()
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
/// Returns the observations the resolver used to make those edges.
fn link(root: &Path, nodes: &mut [Node]) -> Vec<ObservedInput> {
    let files: HashSet<String> = nodes.iter().map(|n| n.rel.clone()).collect();
    resolve_and_link_observing(nodes, root, &files)
}

#[cfg(test)]
thread_local! {
    /// Runs on the building thread after each link pass, before its inputs are checked.
    pub(super) static AFTER_LINK: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
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
        lru.put("a".into(), "v".into(), Arc::new(0), 600, 1000);
        lru.put("b".into(), "v".into(), Arc::new(0), 600, 1000);
        assert_eq!((lru.bytes, lru.entries.len()), (600, 1), "the older entry made room");
        lru.put("c".into(), "v".into(), Arc::new(0), 1001, 1000);
        assert_eq!((lru.bytes, lru.entries.len()), (600, 1), "an entry over the whole cap is not kept");
        assert!(lru.get(Path::new("b"), "v").is_some());
    }
}


/// `(size, mtime_ns)` of a file, from one metadata call.
fn stamp_of(meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    let nanos = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some((meta.len(), u64::try_from(nanos).ok()?))
}

/// Open a source within the selected root; refuse raced links and check the actual open handle.
fn open_source(root: &Path, rel: &Path) -> Option<(std::fs::File, PathBuf)> {
    use mixdog_workspace::pathguard::canonical;
    use mixdog_workspace::ident::names_equal;
    let mut path = canonical(root).ok()?;
    for component in rel.components() {
        let std::path::Component::Normal(name) = component else { return None };
        path.push(name);
        if std::fs::symlink_metadata(&path).ok()?.file_type().is_symlink() {
            return None;
        }
    }
    if !names_equal(canonical(&path).ok()?.as_os_str(), path.as_os_str()) || !std::fs::symlink_metadata(&path).ok()?.is_file() {
        return None;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&path).ok()?;
    (file.metadata().ok()?.is_file() && source_here(&file, &path)).then_some((file, path))
}

fn source_here(file: &std::fs::File, path: &Path) -> bool {
    use mixdog_workspace::ident::{handle_path, is_current_regular_leaf, names_equal};
    handle_path(file).is_ok_and(|p| names_equal(p.as_os_str(), path.as_os_str()))
        && mixdog_workspace::pathguard::canonical(path).is_ok_and(|p| names_equal(p.as_os_str(), path.as_os_str()))
        && is_current_regular_leaf(file, path)
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
        if self.fingerprint.is_none() || !self.parse_error.is_empty() {
            return Arc::new(Source::new(String::new()));
        }
        let Some(bytes) = self.verified_source() else { return Arc::new(Source::new(String::new())) };
        self.source_from_verified(bytes)
    }

    /// The digest is an identity for parsed bytes, not an access check. Even a cache hit
    /// must still open the current regular file and prove that it holds that digest.
    fn verified_source(&self) -> Option<Vec<u8>> {
        self.verify_source(true)
    }

    fn verify_source(&self, for_body: bool) -> Option<Vec<u8>> {
        let read = || -> Option<Vec<u8>> {
            let (file, path) = open_source(&self.origin.root, Path::new(&self.rel))?;
            let mut bytes = Vec::new();
            (&file).take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut bytes).ok()?;
            (bytes.len() as u64 <= MAX_FILE_BYTES as u64
                && source_here(&file, &path)
                && digest_of(&bytes) == self.digest && (!for_body || !forced_mismatch())).then_some(bytes)
        };
        let bytes = read();
        if bytes.is_none() {
            self.origin.stale.store(true, Ordering::SeqCst);
            self.origin.invalidate(&self.rel);
        }
        bytes
    }

    fn source_from_verified(&self, bytes: Vec<u8>) -> Arc<Source> {
        let path = self.origin.root.join(&self.rel);
        let version = digest_hex(&self.digest);
        if let Some(source) = SOURCES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&path, &version) {
            return source;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            return Arc::new(Source::new(String::new()));
        };
        let source = Arc::new(Source::new(text));
        SOURCES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).put(path, version, source.clone(), source.cost(), source_cache_cap());
        source
    }

    /// The call sites of the file (`None`: no call extraction ran for it), extracted from its source now and kept
    /// in a bounded cache: nodes hold none, they are most of what a graph would weigh.
    pub fn calls(&self) -> Option<Arc<Vec<CallInfo>>> {
        self.calls_bytes?;
        self.fingerprint?;
        let bytes = self.verified_source()?;
        let path = self.origin.root.join(&self.rel);
        let version = format!("{}|{}|{SCHEMA_VERSION}", digest_hex(&self.digest), self.lang);
        if let Some(calls) = CALL_SITES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&path, &version) {
            return Some(calls);
        }
        let source = self.source_from_verified(bytes);
        let calls = Arc::new(self.scan_lang.and_then(|scan| outline::extract(source.text(), self.lang, scan).calls).unwrap_or_default());
        if !self.origin.stale.load(Ordering::SeqCst) {
            let cost = calls.iter().map(|c| (std::mem::size_of::<CallInfo>() + c.name.len() + c.recv.len() + c.in_symbol.len()) as u64).sum::<u64>() + 64;
            CALL_SITES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).put(path, version, calls.clone(), cost, source_cache_cap());
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
        std::mem::size_of::<Node>() as u64 + self.record.weight + strings(&self.resolved_imports)
    }

    /// A node of this generation over a record.
    fn of(record: Arc<Record>, origin: &Arc<Origin>) -> Node {
        Node { record, origin: origin.clone(), resolved_imports: Vec::new(), runtime: OnceLock::new() }
    }

    pub fn has_token(&self, name: &str) -> bool {
        let id = self.origin.words().ids.get(name).copied();
        id.is_some_and(|id| self.tokens.binary_search(&id).is_ok())
    }
}
impl Graph {
    /// The tokens still held by some record, as text.
    #[cfg(test)]
    pub(super) fn live_words(&self) -> Vec<String> {
        self.word_table().iter().filter(|w| !w.is_empty()).map(|w| w.to_string()).collect()
    }

    /// The project root the graph was built over.
    pub fn root(&self) -> &Path {
        &self.origin.root
    }

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
    #[cfg(test)]
    pub fn build(root: &Path, excluded: &[PathBuf], cache: &GraphCache) -> Result<Arc<Graph>, String> {
        // The hints before the inventory, as a refresh takes them (`GraphCache::reconcile`).
        let key = identity_key(root)?;
        let hints = if excluded.is_empty() { cache.ledger().snapshot(&key) } else { Receipts::new() };
        let entries = Self::inventory(root, &key, excluded)?;
        let graph = Self::generation(root, &key, &entries, None, &hints, excluded.is_empty().then_some(cache))?;
        if excluded.is_empty() && !graph.unchanged {
            cache.stage_with(root, key, GraphFiles(graph.clone()), graph.receipts.clone());
        }
        Ok(graph)
    }

    /// The first generation of a scoped build of `root` over `entries`, every file parsed (as [`build`](Self::build) of a scope):
    /// the scope has no disk copy to start from.
    pub(super) fn scoped(root: &Path, key: &str, entries: &[Entry]) -> Result<Arc<Graph>, String> {
        Self::generation(root, key, entries, None, &Receipts::new(), None)
    }
    /// The eligible files of `root` with their fingerprints, from one walk: what membership, fingerprints and a refresh
    /// are all derived from. Nothing is parsed.
    pub(super) fn inventory(root: &Path, key: &str, excluded: &[PathBuf]) -> Result<Vec<Entry>, String> {
        let started = std::time::Instant::now();
        let entries = indexed_files(root, key, excluded);
        super::cache::note(|t| t.inventory_ms += super::cache::elapsed_ms(started));
        entries
    }

    /// The first generation of `root`'s graph over `entries`, from the cache's parsed files where they still match and
    /// where the payload processed the exact revision of each file in `hints` (revisions by folded rel; see
    /// [`Ledger`]): a hinted file whose record the disk copy cannot vouch for is parsed.
    pub(super) fn first(root: &Path, key: &str, entries: &[Entry], hints: &Receipts, cache: &GraphCache) -> Result<Arc<Graph>, String> {
        Self::generation(root, key, entries, None, hints, Some(cache))
    }

    /// The next generation over `entries`, the inventory of the tree now: a file added or whose fingerprint changed (or
    /// that is hinted at a revision this generation did not process: a session tool wrote it since, a rewrite inside the
    /// clock's granularity) is parsed, a file gone or no longer eligible is left out, every other record is shared with this
    /// generation, and the edges are linked again over the whole set (an importer elsewhere may newly resolve, a package may
    /// gain a member). A manifest change alone is the same refresh with nothing parsed. A file that could not be verified
    /// last time has no record here and is parsed again.
    pub(super) fn refreshed(&self, key: &str, entries: &[Entry], hints: &Receipts, cache: &GraphCache) -> Result<Arc<Graph>, String> {
        Self::generation(&self.origin.root, key, entries, Some(self), hints, Some(cache))
    }

    fn generation(root: &Path, key: &str, entries: &[Entry], base: Option<&Graph>, hints: &Receipts, cache: Option<&GraphCache>) -> Result<Arc<Graph>, String> {        use std::sync::atomic::AtomicUsize;
        let origin = match (base, cache) {
            (Some(base), _) => base.origin.successor(),
            (None, Some(cache)) => Origin::new(root, Some(cache.ledger())),
            (None, None) => Origin::new(root, None),
        };
        // Each cached file is taken at most once, by the worker whose file still matches it.
        let (previous, disk_receipts): (HashMap<String, Mutex<Option<CachedFile>>>, Receipts) = match (base, cache) {
            (None, Some(cache)) => {
                let started = std::time::Instant::now();
                let (files, receipts) = cache.load_with_receipts(root).unwrap_or_default();
                let loaded = files.into_iter().map(|(rel, file)| (rel, Mutex::new(Some(file)))).collect();
                super::cache::note(|t| t.cache_load_ms += super::cache::elapsed_ms(started));
                (loaded, receipts)
            }
            _ => (HashMap::new(), Receipts::new()),
        };
        let no_receipts = Receipts::new();
        let base_receipts = base.map_or(&no_receipts, |b| &b.receipts);
        let old: HashMap<&str, &Node> = base.map(|b| b.nodes.iter().map(|n| (n.rel.as_str(), n)).collect()).unwrap_or_default();
        let (from_disk, carried, parsed) = (AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0));
        let whole_set_cached = !previous.is_empty();
        let previous_len = previous.len();
        let one = |entry: &Entry| -> Result<Slot, String> {
            // A record of a hinted file stands only where its artifact processed exactly the hinted revision.
            // The unknown-location entry is every file's hint too.
            let vouched = |receipts: &Receipts| [entry.identity.as_str(), Ledger::UNKNOWN].iter().all(|id| hints.get(*id).is_none_or(|revision| receipts.get(*id) == Some(revision)));
            if let Some(node) = old.get(entry.rel.as_str())
                && entry.stamp.is_some()
                && node.lang == entry.lang
                && node.fingerprint == entry.stamp
                && vouched(base_receipts)
            {
                carried.fetch_add(1, Ordering::Relaxed);
                return Ok(Slot::Node(Node::of(node.record.clone(), &origin)));
            }
            let hit = previous.get(&entry.rel).filter(|_| vouched(&disk_receipts)).and_then(|slot| {
                let mut slot = slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if slot.as_ref().is_some_and(|file| Some((file.size, file.mtime_ns)) == entry.stamp && digest_from_hex(&file.digest).is_some()) { slot.take() } else { None }
            });
            let record = match hit {
                Some(file) => {
                    from_disk.fetch_add(1, Ordering::Relaxed);
                    let digest = digest_from_hex(&file.digest).expect("checked above");
                    record_from_cache(file, digest, &entry.path, entry.lang, &origin)
                }
                None => {
                    parsed.fetch_add(1, Ordering::Relaxed);
                    match parse_record(root, &entry.path, entry.lang, &origin)? {
                        Some(record) => record,
                        None => return Ok(Slot::Unverified(entry.rel.clone())),
                    }
                }
            };
            Ok(Slot::Node(Node::of(Arc::new(record), &origin)))
        };
        let started = std::time::Instant::now();
        let mut nodes: Vec<Node> = Vec::with_capacity(entries.len());
        let mut unverified: Vec<String> = Vec::new();
        for chunk in entries.chunks(256) {
            // Few files are parsed on this thread: a refresh after a handful of edits is not worth a thread pool.
            let made = if chunk.len() > 32 {
                chunk.par_iter().map(&one).collect::<Result<Vec<Slot>, String>>()?
            } else {
                chunk.iter().map(&one).collect::<Result<Vec<Slot>, String>>()?
            };
            for slot in made {
                match slot {
                    Slot::Node(node) => nodes.push(node),
                    Slot::Unverified(rel) => unverified.push(rel),
                }
            }
        }
        super::cache::note(|t| {
            t.parse_ms += super::cache::elapsed_ms(started);
            t.reused += carried.load(Ordering::Relaxed) + from_disk.load(Ordering::Relaxed);
            t.parsed += parsed.load(Ordering::Relaxed);
            t.omitted += unverified.len();
        });
        // Cached files that no longer match are not needed past here.
        drop(previous);
        let kept = nodes.len();
        // What this generation processed of the hints: a file with a node was parsed now or vouched for by its artifact's
        // receipt; a file with no entry in the inventory contributes no record; an unverified one earns nothing.
        let in_graph: HashSet<&str> = nodes.iter().map(|node| node.rel.as_str()).collect();
        let in_inventory: HashSet<&str> = entries.iter().map(|entry| entry.identity.as_str()).collect();
        let with_node: HashSet<&str> = entries.iter().filter(|entry| in_graph.contains(entry.rel.as_str())).map(|entry| entry.identity.as_str()).collect();
        let receipts: Receipts = hints.iter().filter(|(id, _)| with_node.contains(id.as_str()) || !in_inventory.contains(id.as_str())).map(|(id, revision)| (id.clone(), *revision)).collect();
        let started = std::time::Instant::now();
        let inputs = link_stable(root, &mut nodes)?;
        super::cache::note(|t| t.link_ms += super::cache::elapsed_ms(started));
        // Every file came from the cache and none went away: Node's disk-cache hit (`_deserializeGraph`).
        let unchanged = whole_set_cached && from_disk.load(Ordering::Relaxed) == kept && previous_len == kept && unverified.is_empty();
        let started = std::time::Instant::now();
        let mut graph = Self::assemble(nodes, origin);
        graph.unverified = unverified;
        graph.unchanged = unchanged;
        graph.inputs = inputs;
        graph.signature = inventory_signature(entries);
        graph.receipts = receipts;
        if let Some(cache) = cache {
            let carried_lookups = base.and_then(|b| cache.carry_lookups(&key, b.signature, graph.signature));
            let lookups = match carried_lookups {
                Some(lookups) => lookups,
                None => {
                    let measured = || (graph.base_bytes(&key, unchanged), graph.token_index_bytes());
                    let lookups = cache.lookups_for(&key, graph.signature, measured);
                    // The query starts: it awaits the graph's token index (symbol-index.mjs `_ensureTokenIndex`), which a
                    // prune from here on counts.
                    lookups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).queried = true;
                    lookups
                }
            };
            for node in &graph.nodes {
                let _ = node.runtime.set(lookups.clone());
            }
            graph.lookups = lookups;
        }
        super::cache::note(|t| t.assemble_ms += super::cache::elapsed_ms(started));
        Ok(Arc::new(graph))
    }

    /// What a reader of the answer is told when files could not be verified: how many and which first.
    pub fn incomplete_note(&self) -> String {
        format!(
            "graph incomplete: {} file(s) changed while they were being read and are not in it this time (first: {}); anything about them is unknown, not absent",
            self.unverified.len(),
            self.unverified.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
        )
    }

    /// Whether files had to be left out of this generation.
    pub fn incomplete(&self) -> bool {
        !self.unverified.is_empty()
    }

    /// The import edges are still what the resolver would make: none of the files and directories it looked at has
    /// changed since, and no read found a source file changed.
    pub fn is_fresh(&self) -> bool {
        self.unverified.is_empty() && !self.origin.stale.load(Ordering::SeqCst) && self.resolver_inputs_current()
    }

    pub(super) fn resolver_inputs_current(&self) -> bool {
        self.inputs.iter().all(ObservedInput::is_current)
    }

    /// All nodes can contribute to metadata-only answers, including a negative result.
    pub(super) fn verify_records(&self) -> bool {
        let mut current = true;
        for node in &self.nodes {
            current &= node.verify_source(false).is_some();
        }
        current
    }

    /// The graph's words, indexed by token id (shared strings: cloning them copies pointers).
    pub fn word_table(&self) -> Vec<Arc<str>> {
        let gone: Arc<str> = Arc::from("");
        self.origin.words().list.iter().map(|w| w.clone().unwrap_or_else(|| gone.clone())).collect()
    }

    /// A query read a source file that no longer matches the graph.
    pub fn source_stale(&self) -> bool {
        self.origin.stale.load(Ordering::SeqCst)
    }

    /// Heap bytes of the graph's parsed data; source text is read on demand and not part of it.
    pub fn base_heap_bytes(&self) -> u64 {
        self.nodes.iter().map(Node::heap_bytes).sum::<u64>()
            // One shared allocation per word, its slot in the list and its entry in the lookup table.
            + self.origin.words().list.iter().flatten().map(|w| 16 + w.len() as u64 + 16 + 28).sum::<u64>()
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
            let symbols = 24 + node.symbols.iter().map(|s| 8 + symbol_bytes(s)).sum::<u64>();
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
        if !from_disk {
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
        let origin = Origin::new(root, None);
        let Some(record) = parse_record(root, file, lang, &origin)? else {
            return Err(format!("code_graph: {} changed while it was being read; run the query again", file.display()));
        };
        let node = Node::of(Arc::new(record), &origin);
        Ok(Some(Self::assemble(vec![node], origin)))
    }

    fn assemble(nodes: Vec<Node>, origin: Arc<Origin>) -> Graph {
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
            unverified: Vec::new(),
            receipts: Receipts::new(),
            unchanged: false,
            lookups: Lookups::default(),
            signature: 0,
            inputs: Vec::new(),
            origin,
        }
    }
}
/// The eligible files of a graph over `root`, sorted, each with its fingerprint: one walk, one stat per file.
fn indexed_files(root: &Path, key: &str, excluded: &[PathBuf]) -> Result<Vec<Entry>, String> {
    let base = key.trim_end_matches('/');
    let mut candidates = walk_classified_files(root, |p| p.extension().and_then(|s| s.to_str()).and_then(lang_for))?;
    if !excluded.is_empty() {
        let prefixes: Vec<String> = excluded.iter().map(|path| path_key(path)).collect();
        candidates.retain(|(path, _)| {
            let key = path_key(path);
            !prefixes.iter().any(|prefix| key == *prefix || key.starts_with(&format!("{prefix}/")))
        });
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(candidates
        .into_par_iter()
        .filter_map(|(path, lang)| {
            let meta = std::fs::metadata(&path).ok()?;
            if meta.len() > MAX_FILE_BYTES {
                return None;
            }
            let rel = rel_of(root, &path)?;
            let identity = format!("{base}/{}", fold(&rel));
            Some(Entry { path, rel, lang: lang_static(lang), stamp: stamp_of(&meta), identity })
        })
        .collect())
}
/// The bytes of a file and the fingerprint they were read at, from one observation: the metadata before and after the read
/// must agree with each other and with the length read. `None`: the file changed while it was being read, the bytes may be
/// a mixture and are discarded.
fn read_observed(root: &Path, rel: &Path) -> Option<(Vec<u8>, (u64, u64))> {
    let (file, path) = open_source(root, rel)?;
    let before = stamp_of(&file.metadata().ok()?)?;
    let mut bytes = Vec::new();
    (&file).take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut bytes).ok()?;
    #[cfg(test)]
    AFTER_READ.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook();
        }
    });
    let after = stamp_of(&file.metadata().ok()?)?;
    (before == after && before.0 == bytes.len() as u64 && before.0 <= MAX_FILE_BYTES as u64
        && source_here(&file, &path)).then_some((bytes, before))
}
/// Parses one file and drops its text: only what the graph keeps survives. `None`: the file could not be verified.
fn parse_record(root: &Path, path: &Path, lang: &'static str, origin: &Origin) -> Result<Option<Record>, String> {
    #[cfg(test)]
    PARSED.with(|n| n.set(n.get() + 1));
    let relative = path
        .strip_prefix(root)
        .map_err(|e| format!("path is outside graph root ({}): {e}", path.display()))?;
    let Some((bytes, fingerprint)) = read_observed(root, relative) else { return Ok(None) };
    let digest = digest_of(&bytes);
    let rel = relative.to_string_lossy().replace('\\', "/");
    let (text, parse_error) = match String::from_utf8(bytes) {
        Ok(text) => (text, String::new()),
        Err(_) => (String::new(), "unsupported source encoding; file not indexed".to_string()),
    };
    let scan_lang = scan_lang_for_path(path);
    let extraction = match (scan_lang, parse_error.is_empty()) {
        (Some(scan), true) => outline::extract(&text, lang, scan),
        _ => outline::Extraction::default(),
    };
    let calls = if parse_error.is_empty() { extraction.calls } else { None };
    let top_level_types = extract_top_level_types(&text, lang);
    Ok(Some(
        Record {
            rel,
            lang,
            scan_lang,
            parse_error,
            symbols: extraction.symbols,
            raw_imports: extraction.imports,
            package_name: extraction.package_name,
            namespace_name: extraction.namespace_name,
            go_package_name: extraction.go_package_name,
            top_level_types,
            tokens: origin.intern(extraction.tokens),
            calls_bytes: calls.as_ref().map(|calls| 24 + calls.iter().map(|c| 8 + call_bytes(c)).sum::<u64>()),
            fingerprint: Some(fingerprint),
            digest,
            weight: 0,
            words: origin.words.clone(),
        }
        .weigh(),
    ))
}
/// Links, and links again while a file the resolver looked at changed after (or while) it was looked at: the edges
/// are only kept with inputs whose stamps are the ones they were made from.
fn link_stable(root: &Path, nodes: &mut [Node]) -> Result<Vec<ObservedInput>, String> {
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
        if inputs.iter().all(ObservedInput::is_current) {
            return Ok(inputs);
        }
    }
    Err("code_graph: the project's manifests kept changing while its imports were linked".to_owned())
}
