//! The project graph a `code_graph` query answers from: one node per indexed source file,
//! built from `mixdog-graph`'s parse (symbols, call sites, tokens, raw imports) and the
//! import edges resolved over the indexed file set.
#![allow(clippy::disallowed_methods, reason = "blocking filesystem reads; the whole call runs on the graph helper's build thread (engine::GraphEngine::query)")]

use std::collections::{HashMap, HashSet};
use std::hash::BuildHasher as _;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use mixdog_graph::calls::CallInfo;
use mixdog_graph::lang::{lang_for, lang_static};
use mixdog_graph::outline;
use mixdog_graph::resolve::{ImportRecord, ObservedInput, extract_top_level_types, resolve_and_link_observing};
use mixdog_graph::scan_lang::{ScanLang, scan_lang_for_path};
use mixdog_graph::{MAX_FILE_BYTES, walk_classified_files_with_meta};
use rayon::prelude::*;
use sha2::{Digest, Sha256};

#[cfg(test)]
use super::cache::GraphFiles;
use super::cache::{CachedFile, GraphCache, Ledger, Receipts};
use super::roots::{identity_key, path_key};
use super::symbols::{Sym, Symbols};

// File versions. A file's *discovery* fingerprint is `(size, mtime_ns)`: a file whose fingerprint equals the one a record
// was made at is not read again (nobody hashes unchanged files). Session writes record a ledger revision (`note_identities`)
// so same-stamp writes are still re-parsed; when a query reads a file's source or targets an explicit file anchor, that
// file's digest is verified against disk and a mismatch re-parses only that file. A disk record written by another lifetime
// of the ledger saw none of this lifetime's notices: its source is read and digested once before the record is reused.

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
    pub symbols: Symbols,
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
        self.raw_imports.shrink_to_fit();
        self.top_level_types.shrink_to_fit();
        let symbols = self.symbols.heap_bytes();
        self.weight = (std::mem::size_of::<Record>()
            + self.rel.len()
            + self.parse_error.len()
            + self.package_name.len()
            + self.namespace_name.len()
            + self.go_package_name.len()) as u64
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
    stale_files: Mutex<Vec<String>>,
    /// Shared by every generation of one root: records carry ids into it, so a carried record stays valid.
    words: Arc<Mutex<Words>>,
    /// Where a source that is not what its record was parsed from is reported: the ledger keeps it (surviving the graph's
    /// eviction) until a refresh processes that revision.
    invalid: Option<Arc<Ledger>>,
}

/// Every distinct token in use once, with how many records hold it; a record's tokens are ids into it. A token no record
/// holds any more is removed and its id reused, so the table follows what is live, not what ever was. The texts sit in
/// one string, which is compacted once most of it is texts no longer held; the lookup table holds ids only.
#[derive(Default)]
struct Words {
    text: String,
    /// Where each id's text sits in `text`; empty for a free id.
    spans: Vec<(u32, u32)>,
    refs: Vec<u32>,
    free: Vec<u32>,
    ids: hashbrown::HashTable<u32>,
    hasher: hashbrown::DefaultHashBuilder,
    /// Bytes of `text` no id points at.
    dead: usize,
}

fn word_in<'a>(text: &'a str, spans: &[(u32, u32)], id: u32) -> &'a str {
    let (at, len) = spans[id as usize];
    &text[at as usize..(at + len) as usize]
}

impl Words {
    fn word(&self, id: u32) -> &str {
        word_in(&self.text, &self.spans, id)
    }

    fn id_of(&self, token: &str) -> Option<u32> {
        self.ids.find(self.hasher.hash_one(token), |&id| self.word(id) == token).copied()
    }

    fn acquire(&mut self, token: &str) -> u32 {
        let hash = self.hasher.hash_one(token);
        if let Some(&id) = self.ids.find(hash, |&id| word_in(&self.text, &self.spans, id) == token) {
            self.refs[id as usize] += 1;
            return id;
        }
        let span = (self.text.len() as u32, token.len() as u32);
        self.text.push_str(token);
        let id = match self.free.pop() {
            Some(id) => {
                self.spans[id as usize] = span;
                self.refs[id as usize] = 1;
                id
            }
            None => {
                self.spans.push(span);
                self.refs.push(1);
                (self.spans.len() - 1) as u32
            }
        };
        let Self { text, spans, ids, hasher, .. } = self;
        ids.insert_unique(hash, id, |&id| hasher.hash_one(word_in(text, spans, id)));
        id
    }

    fn release(&mut self, id: u32) {
        let refs = &mut self.refs[id as usize];
        if *refs == 0 {
            return;
        }
        *refs -= 1;
        if *refs > 0 {
            return;
        }
        let hash = self.hasher.hash_one(self.word(id));
        if let Ok(entry) = self.ids.find_entry(hash, |&held| held == id) {
            entry.remove();
        }
        self.dead += self.spans[id as usize].1 as usize;
        self.spans[id as usize] = (0, 0);
        self.free.push(id);
        if self.dead > 64 * 1024 && self.dead * 2 > self.text.len() {
            self.compact();
        }
    }

    /// Drops the texts no id holds; ids, and so the lookup table, stay as they are.
    fn compact(&mut self) {
        let mut text = String::with_capacity(self.text.len() - self.dead);
        for span in &mut self.spans {
            if span.1 > 0 {
                let at = text.len() as u32;
                text.push_str(&self.text[span.0 as usize..(span.0 + span.1) as usize]);
                *span = (at, span.1);
            }
        }
        self.text = text;
        self.dead = 0;
    }

    /// Gives back the room the buffers grew into: a generation's records are all interned by now.
    fn settle(&mut self) {
        self.text.shrink_to_fit();
        self.spans.shrink_to_fit();
        self.refs.shrink_to_fit();
        self.free.shrink_to_fit();
    }

    /// Heap held: the texts, the per-id spans and counts, and the lookup table's id slots and control bytes.
    fn heap_bytes(&self) -> u64 {
        (self.text.capacity() + 8 * self.spans.capacity() + 4 * (self.refs.capacity() + self.free.capacity()) + self.ids.allocation_size()) as u64
    }
}

/// The graph's words as they were when it was taken, by token id: a token no record holds reads as empty.
pub(super) struct WordTable {
    text: String,
    spans: Vec<(u32, u32)>,
}

impl WordTable {
    pub fn get(&self, id: u32) -> &str {
        word_in(&self.text, &self.spans, id)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.spans.len()
    }

    #[cfg(test)]
    pub fn iter(&self) -> impl Iterator<Item = &str> {
        (0..self.spans.len() as u32).map(|id| self.get(id))
    }
}

impl Origin {
    fn new(root: &Path, invalid: Option<Arc<Ledger>>) -> Arc<Self> {
        Arc::new(Self { root: root.to_path_buf(), stale: AtomicBool::new(false), stale_files: Mutex::default(), words: Arc::default(), invalid })
    }

    /// The origin of the next generation: the same root and words, a stale mark of its own (a read that found a file
    /// changed under an older generation must not condemn this one).
    fn successor(&self) -> Arc<Self> {
        Arc::new(Self {
            root: self.root.clone(),
            stale: AtomicBool::new(false),
            stale_files: Mutex::default(),
            words: self.words.clone(),
            invalid: self.invalid.clone(),
        })
    }

    fn words(&self) -> std::sync::MutexGuard<'_, Words> {
        self.words.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn mark_stale(&self, rel: &str) {
        self.stale.store(true, Ordering::SeqCst);
        let mut files = self.stale_files.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !files.iter().any(|seen| seen == rel) {
            files.push(rel.to_owned());
        }
        drop(files);
        self.invalidate(rel);
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
    fn intern(&self, tokens: &[String]) -> Box<[u32]> {
        let mut tokens: Vec<&str> = tokens.iter().map(String::as_str).collect();
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
}

/// What was derived from files recently, across every graph and bounded in bytes (`MIXDOG_CODE_GRAPH_SOURCE_CACHE_MB`,
/// default 8): least recently used first. An entry is keyed by the file's path and the version it was derived from (the
/// content digest, the extraction language and schema). Source text has no such cache: every read verifies the file's
/// bytes against its digest, so a cached text would only have saved decoding them.
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

static CALL_SITES: Mutex<Lru<Vec<CallInfo>>> = Mutex::new(Lru::new());

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
    text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect()
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
    pub fn cache_bytes(&self) -> u64 {
        let maps: u64 = RUNTIME_CACHE_KEYS.iter().map(|k| 8 + js_str(k) + 48).sum();
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
fn symbol_bytes(symbol: &Sym<'_>) -> u64 {
    let mut bytes = 48
        + field("name", js_str(symbol.name))
        + field("kind", js_str(symbol.kind))
        + field("startLine", 8)
        + field("endLine", 8)
        + field("startCol", 8)
        + field("endCol", 8);
    if symbol.exported {
        bytes += field("exported", 4);
    }
    if !symbol.sig.is_empty() {
        bytes += field("sig", js_str(symbol.sig));
    }
    if !symbol.parent.is_empty() {
        bytes += field("parent", js_str(symbol.parent));
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
        let mut symbol = mixdog_graph::outline::SymbolInfo {
            name: "읽기".into(),
            kind: "function",
            start_line: 3,
            end_line: 9,
            start_col: 1,
            end_col: 2,
            exported: false,
            sig: String::new(),
            parent: String::new(),
        };
        assert_eq!(symbol_bytes(&Sym::from(&symbol)), of(serde_json::to_value(&symbol).unwrap()));
        symbol.exported = true;
        symbol.sig = "pub fn 읽기(path: &Path) -> io::Result<String>".into();
        symbol.parent = "Store".into();
        assert_eq!(symbol_bytes(&Sym::from(&symbol)), of(serde_json::to_value(&symbol).unwrap()));
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
const SIGNATURE_UNITS: usize = 47;
const SCHEMA_VERSION: &str = "sym-record-v2-unified-kinds";

pub(super) struct Graph {
    pub nodes: Vec<Node>,
    /// Node positions, found by their rel.
    index: hashbrown::HashTable<u32>,
    hasher: hashbrown::DefaultHashBuilder,
    /// By node position: the positions of the other files that import it, in the order of their rels.
    reverse: Vec<Box<[u32]>>,
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
    inputs: Arc<Vec<ObservedInput>>,
    origin: Arc<Origin>,
}

#[cfg(test)]
thread_local! {
    /// How many files the calling thread's parses have read (a refresh on a thread parses few, on that thread).
    pub(super) static PARSED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// How many project-wide inventory walks the calling thread has run.
    pub(super) static INVENTORIES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// How many source-digest verification reads the calling thread has run.
    pub(super) static VERIFIED_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// Runs on the reading thread after each read of a file, before its stamp is compared with the one before it.
    pub(super) static AFTER_READ: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
    /// Runs on the calling thread just before `stale_resolver_inputs` checks manifest observations.
    pub(super) static BEFORE_RESOLVER_CHECK: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
}

/// What one file became in a generation.
enum Slot {
    Node(Node),
    /// Its bytes changed while they were read: it is not in the graph this time.
    Unverified(String),
}

/// A re-parse's nodes on the next generation `origin`, the files it left unindexed, and whether an import changed.
struct Reparsed {
    origin: Arc<Origin>,
    nodes: Vec<Node>,
    unverified: Vec<String>,
    imports_changed: bool,
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
        symbols: Symbols::pack(file.symbols.iter().map(super::cache::CachedSymbol::view)),
        raw_imports: file.raw_imports,
        package_name: file.package_name,
        namespace_name: file.namespace_name,
        go_package_name: file.go_package_name,
        top_level_types: file.top_level_types,
        tokens: origin.intern(&file.tokens),
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

/// What a generation processed of the hints: a file with a node was parsed now or vouched for by its artifact's
/// receipt; a file with no entry in the inventory contributes no record; an unverified one earns nothing.
fn processed_hints(hints: &Receipts, nodes: &[Node], entries: &[Entry]) -> Receipts {
    let in_graph: HashSet<&str> = nodes.iter().map(|node| node.rel.as_str()).collect();
    let in_inventory: HashSet<&str> = entries.iter().map(|entry| entry.identity.as_str()).collect();
    let with_node: HashSet<&str> = entries.iter().filter(|entry| in_graph.contains(entry.rel.as_str())).map(|entry| entry.identity.as_str()).collect();
    hints
        .iter()
        .filter(|(id, _)| with_node.contains(id.as_str()) || !in_inventory.contains(id.as_str()))
        .map(|(id, revision)| (id.clone(), *revision))
        .collect()
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

    /// Released words leave the table and the text; the words still held keep their ids through a compaction.
    #[test]
    fn the_word_table_keeps_held_words_through_compaction() {
        let mut words = Words::default();
        let ids: Vec<u32> = (0..20_000).map(|n| words.acquire(&format!("token_{n:06}"))).collect();
        assert_eq!(words.acquire("token_000007"), ids[7], "a held word is found, not added");
        for (n, id) in ids.iter().enumerate().filter(|(n, _)| n % 4 != 0) {
            words.release(*id);
            if n == 7 {
                words.release(*id);
            }
        }
        assert!(words.text.len() <= 20_000 * 12 / 2, "compacted: {} bytes", words.text.len());
        for (n, id) in ids.iter().enumerate() {
            let held = n % 4 == 0;
            assert_eq!(words.id_of(&format!("token_{n:06}")), held.then_some(*id));
            assert_eq!(words.word(*id), if held { format!("token_{n:06}") } else { String::new() });
        }
        let again = words.acquire("fresh");
        assert!(ids.contains(&again), "a freed id is reused");
        assert_eq!((words.word(again), words.id_of("fresh")), ("fresh", Some(again)));
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
fn open_source(root: &Path, rel: &Path) -> Option<(mixdog_fsio::File, PathBuf)> {
    use mixdog_workspace::ident::names_equal;
    use mixdog_workspace::pathguard::canonical;
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
    let mut options = mixdog_fsio::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&mixdog_fsio::Unlaned, &path).ok()?;
    (file.metadata(&mixdog_fsio::Unlaned).ok()?.is_file() && source_here(&file, &path)).then_some((file, path))
}

fn source_here(file: &mixdog_fsio::File, path: &Path) -> bool {
    use mixdog_workspace::ident::{handle_path, is_current_regular_leaf, names_equal};
    let file = file.as_std();
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
    /// The file's source, read from disk for an answer. The file must still be as
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
        let mut bytes = Vec::new();
        self.verify_source_into(&mut bytes, for_body).then_some(bytes)
    }

    fn verify_source_into(&self, bytes: &mut Vec<u8>, for_body: bool) -> bool {
        #[cfg(test)]
        VERIFIED_READS.with(|n| n.set(n.get() + 1));
        bytes.clear();
        // The size the record was parsed at: a read into a growing buffer would hold up to twice the text.
        if let Some((size, _)) = self.fingerprint {
            bytes.reserve_exact(size.min(MAX_FILE_BYTES) as usize);
        }
        let mut read = || -> Option<bool> {
            let (file, path) = open_source(&self.origin.root, Path::new(&self.rel))?;
            (&file).take(MAX_FILE_BYTES + 1).read_to_end(bytes).ok()?;
            Some(bytes.len() as u64 <= MAX_FILE_BYTES && source_here(&file, &path) && digest_of(bytes) == self.digest && (!for_body || !forced_mismatch()))
        };
        let current = read().unwrap_or(false);
        if !current {
            self.origin.mark_stale(&self.rel);
        }
        current
    }

    fn source_from_verified(&self, bytes: Vec<u8>) -> Arc<Source> {
        Arc::new(Source::new(String::from_utf8(bytes).unwrap_or_default()))
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
        let id = self.origin.words().id_of(name);
        id.is_some_and(|id| self.tokens.binary_search(&id).is_ok())
    }
}
impl Graph {
    /// The tokens still held by some record, as text.
    #[cfg(test)]
    pub(super) fn live_words(&self) -> Vec<String> {
        self.word_table().iter().filter(|w| !w.is_empty()).map(str::to_owned).collect()
    }

    /// The project root the graph was built over.
    pub fn root(&self) -> &Path {
        &self.origin.root
    }

    fn position(&self, rel: &str) -> Option<usize> {
        self.index.find(self.hasher.hash_one(rel), |&at| self.nodes[at as usize].rel == rel).map(|&at| at as usize)
    }

    pub fn node(&self, rel: &str) -> Option<&Node> {
        self.position(rel).map(|at| &self.nodes[at])
    }

    pub fn dependents(&self, rel: &str) -> Vec<String> {
        self.position(rel).map(|at| self.reverse[at].iter().map(|&from| self.nodes[from as usize].rel.clone()).collect()).unwrap_or_default()
    }

    /// Candidate files of a name: the ones whose tokens contain it.
    pub fn token_candidates<'a>(&'a self, name: &'a str, language: Option<&'a str>) -> impl Iterator<Item = &'a Node> {
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
        #[cfg(test)]
        INVENTORIES.with(|n| n.set(n.get() + 1));
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

    fn generation(root: &Path, key: &str, entries: &[Entry], base: Option<&Graph>, hints: &Receipts, cache: Option<&GraphCache>) -> Result<Arc<Graph>, String> {
        use std::sync::atomic::AtomicUsize;
        let origin = match (base, cache) {
            (Some(base), _) => base.origin.successor(),
            (None, Some(cache)) => Origin::new(root, Some(cache.ledger())),
            (None, None) => Origin::new(root, None),
        };
        // Each cached file is taken at most once, by the worker whose file still matches it.
        let (previous, disk_receipts, foreign): (HashMap<String, Mutex<Option<CachedFile>>>, Receipts, bool) = match (base, cache) {
            (None, Some(cache)) => {
                let started = std::time::Instant::now();
                let copy = cache.load_with_receipts(root).unwrap_or_default();
                let loaded = copy.files.into_iter().map(|(rel, file)| (rel, Mutex::new(Some(file)))).collect();
                super::cache::note(|t| t.cache_load_ms += super::cache::elapsed_ms(started));
                (loaded, copy.receipts, copy.foreign)
            }
            _ => (HashMap::new(), Receipts::new(), false),
        };
        let no_receipts = Receipts::new();
        let base_receipts = base.map_or(&no_receipts, |b| &b.receipts);
        let old: HashMap<&str, &Node> = base.map(|b| b.nodes.iter().map(|n| (n.rel.as_str(), n)).collect()).unwrap_or_default();
        let (from_disk, carried, parsed, verified) = (AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0));
        let whole_set_cached = !previous.is_empty();
        let previous_len = previous.len();
        let one = |entry: &Entry| -> Result<Slot, String> {
            // A record of a hinted file stands only where its artifact processed exactly the hinted revision.
            // The unknown-location entry is every file's hint too.
            let vouched = |receipts: &Receipts| {
                [entry.identity.as_str(), Ledger::UNKNOWN].iter().all(|id| hints.get(*id).is_none_or(|revision| receipts.get(*id) == Some(revision)))
            };
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
                if slot.as_ref().is_some_and(|file| Some((file.size, file.mtime_ns)) == entry.stamp && digest_from_hex(&file.digest).is_some()) {
                    slot.take()
                } else {
                    None
                }
            });
            let record = match hit {
                Some(file) if foreign => {
                    verified.fetch_add(1, Ordering::Relaxed);
                    let digest = digest_from_hex(&file.digest).expect("checked above");
                    match verified_from_cache(root, entry, file, digest, &origin)? {
                        Some((record, true)) => {
                            from_disk.fetch_add(1, Ordering::Relaxed);
                            record
                        }
                        Some((record, false)) => {
                            parsed.fetch_add(1, Ordering::Relaxed);
                            record
                        }
                        None => return Ok(Slot::Unverified(entry.rel.clone())),
                    }
                }
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
            t.verified += verified.load(Ordering::Relaxed);
        });
        // Cached files that no longer match are not needed past here.
        drop(previous);
        origin.words().settle();
        let kept = nodes.len();
        let receipts = processed_hints(hints, &nodes, entries);
        let started = std::time::Instant::now();
        let inputs = link_stable(root, &mut nodes)?;
        super::cache::note(|t| t.link_ms += super::cache::elapsed_ms(started));
        // Every file came from the cache and none went away: Node's disk-cache hit (`_deserializeGraph`).
        let unchanged = whole_set_cached && from_disk.load(Ordering::Relaxed) == kept && previous_len == kept && unverified.is_empty();
        let started = std::time::Instant::now();
        let mut graph = Self::assemble(nodes, origin);
        graph.unverified = unverified;
        graph.unchanged = unchanged;
        graph.inputs = Arc::new(inputs);
        graph.signature = inventory_signature(entries);
        graph.receipts = receipts;
        if let Some(cache) = cache {
            graph.attach_lookups(key, base, cache);
        }
        super::cache::note(|t| t.assemble_ms += super::cache::elapsed_ms(started));
        Ok(Arc::new(graph))
    }

    fn attach_lookups(&mut self, key: &str, base: Option<&Graph>, cache: &GraphCache) {
        let carried_lookups = base.and_then(|b| cache.carry_lookups(key, b.signature, self.signature));
        let lookups = match carried_lookups {
            Some(lookups) => lookups,
            None => {
                let measured = || (self.base_bytes(key, self.unchanged), self.token_index_bytes());
                let lookups = cache.lookups_for(key, self.signature, measured);
                // The query starts: it awaits the graph's token index (symbol-index.mjs `_ensureTokenIndex`), which a
                // prune from here on counts.
                lookups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).queried = true;
                lookups
            }
        };
        for node in &self.nodes {
            let _ = node.runtime.set(lookups.clone());
        }
        self.lookups = lookups;
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

    pub(super) fn stale_resolver_inputs(&self) -> Vec<PathBuf> {
        #[cfg(test)]
        BEFORE_RESOLVER_CHECK.with(|hook| {
            if let Some(hook) = hook.borrow_mut().as_mut() {
                hook();
            }
        });
        let started = std::time::Instant::now();
        let stale: Vec<PathBuf> = self.inputs.iter().filter(|input| !input.is_current()).map(|input| input.path().to_path_buf()).collect();
        super::cache::note(|t| t.resolver_check_ms += super::cache::elapsed_ms(started));
        stale
    }

    pub(super) fn resolver_inputs_current(&self) -> bool {
        self.stale_resolver_inputs().is_empty()
    }

    /// Verifies only the named anchor nodes against disk so explicit file-anchored queries
    /// detect same-stamp rewrites without reading or hashing the rest of the project.
    pub(super) fn verify_nodes(&self, rels: &[String]) -> bool {
        if rels.is_empty() {
            return true;
        }
        let started = std::time::Instant::now();
        let mut bytes = Vec::new();
        let mut current = true;
        let mut verified = 0usize;
        let mut seen = HashSet::new();
        for rel in rels {
            if !seen.insert(rel.as_str()) {
                continue;
            }
            if let Some(node) = self.node(rel) {
                current &= node.verify_source_into(&mut bytes, false);
                verified += 1;
            }
        }
        super::cache::note(|t| {
            t.verify_ms += super::cache::elapsed_ms(started);
            t.verified += verified;
        });
        current
    }

    /// The relative paths whose source reads did not match this generation's digest.
    pub fn stale_files(&self) -> Vec<String> {
        self.origin.stale_files.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// The graph's words, by token id: a copy of the table's two buffers, read without holding its lock.
    pub fn word_table(&self) -> WordTable {
        let words = self.origin.words();
        WordTable { text: words.text.clone(), spans: words.spans.clone() }
    }

    /// A query read a source file that no longer matches the graph.
    pub fn source_stale(&self) -> bool {
        self.origin.stale.load(Ordering::SeqCst)
    }

    /// Heap bytes of the graph's parsed data; source text is read on demand and not part of it.
    pub fn base_heap_bytes(&self) -> u64 {
        self.nodes.iter().map(Node::heap_bytes).sum::<u64>()
            + self.origin.words().heap_bytes()
            + self.index.allocation_size() as u64
            + self.reverse.iter().map(|importers| 16 + 4 * importers.len() as u64).sum::<u64>()
    }

    /// graph-model.mjs:167 `_estimateGraphBaseBytes` of the graph Node holds for this file set: the object
    /// build.mjs:704 assembles (nodes shaped as build-file-infos.mjs:150 `assembleGraphNodes`), or, for a set
    /// loaded unchanged from the cache, the one graph-model.mjs:72 `_deserializeGraph` returns (no call sites, the
    /// `_callsHydration` marker, `truncated` only when set, empty token lists absent).
    fn base_bytes(&self, root_key: &str, from_disk: bool) -> u64 {
        let root_units = root_key.encode_utf16().count();
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
            let symbols = 24 + node.symbols.iter().map(|s| 8 + symbol_bytes(&s)).sum::<u64>();
            let calls = match (node.calls_bytes, from_disk) {
                (Some(bytes), false) => bytes,
                _ => 0,
            };
            let tokens = if from_disk && node.tokens.is_empty() { 0 } else { js_strings(node.tokens.iter().map(|id| words.get(*id))) };
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
                let token: &str = words.get(*id);
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

    /// A small explicit set of files on their own, rooted at `root`, without walking the project
    /// or linking edges. Returns `Ok(None)` when any file is outside `root`, unsupported, or over
    /// `MAX_FILE_BYTES`, so the caller can fall back to the full graph.
    pub(super) fn build_files(root: &Path, files: &[PathBuf]) -> Result<Option<Graph>, String> {
        if files.is_empty() {
            return Ok(None);
        }
        let mut targets: Vec<(PathBuf, String, &'static str)> = Vec::with_capacity(files.len());
        let mut seen = HashSet::new();
        for file in files {
            let Some(lang) = file.extension().and_then(|s| s.to_str()).and_then(lang_for).map(lang_static) else {
                return Ok(None);
            };
            let meta = match std::fs::metadata(file) {
                Ok(meta) => meta,
                Err(_) => return Ok(None),
            };
            if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
                return Ok(None);
            }
            let (path, rel) = match file.strip_prefix(root) {
                Ok(relative) => (file.clone(), relative.to_string_lossy().replace('\\', "/")),
                Err(_) => {
                    let rel = super::dispatch::display_rel(file, root);
                    if rel.is_empty() || Path::new(&rel).is_absolute() {
                        return Ok(None);
                    }
                    (root.join(&rel), rel)
                }
            };
            if seen.insert(rel.clone()) {
                targets.push((path, rel, lang));
            }
        }
        let origin = Origin::new(root, None);
        let started = std::time::Instant::now();
        let parse_one = |(path, rel, lang): &(PathBuf, String, &'static str)| -> Result<Slot, String> {
            match parse_record(root, path, lang, &origin)? {
                Some(record) => Ok(Slot::Node(Node::of(Arc::new(record), &origin))),
                None => Ok(Slot::Unverified(rel.clone())),
            }
        };
        let made: Vec<Slot> = if targets.len() > 4 {
            targets.par_iter().map(parse_one).collect::<Result<Vec<_>, _>>()?
        } else {
            targets.iter().map(parse_one).collect::<Result<Vec<_>, _>>()?
        };
        let mut nodes = Vec::with_capacity(made.len());
        let mut unverified = Vec::new();
        for slot in made {
            match slot {
                Slot::Node(node) => nodes.push(node),
                Slot::Unverified(rel) => unverified.push(rel),
            }
        }
        super::cache::note(|t| {
            t.parse_ms += super::cache::elapsed_ms(started);
            t.parsed += nodes.len();
            t.omitted += unverified.len();
        });
        origin.words().settle();
        let mut graph = Self::assemble(nodes, origin);
        graph.unverified = unverified;
        Ok(Some(graph))
    }

    fn reparse_nodes(&self, target_set: &HashSet<&str>, carry_imports: bool) -> Result<Reparsed, String> {
        let origin = self.origin.successor();
        let started = std::time::Instant::now();
        let mut nodes = Vec::with_capacity(self.nodes.len());
        let mut unverified: Vec<String> = self.unverified.iter().filter(|rel| !target_set.contains(rel.as_str())).cloned().collect();
        let mut imports_changed = false;
        let (mut reused, mut parsed, mut omitted) = (0usize, 0usize, 0usize);

        for node in &self.nodes {
            if !target_set.contains(node.rel.as_str()) {
                let mut carried = Node::of(node.record.clone(), &origin);
                if carry_imports {
                    carried.resolved_imports = node.resolved_imports.clone();
                }
                nodes.push(carried);
                reused += 1;
                continue;
            }
            let path = self.origin.root.join(&node.rel);
            let eligible = std::fs::symlink_metadata(&path).ok().is_some_and(|m| m.is_file() && m.len() <= MAX_FILE_BYTES);
            if !eligible {
                imports_changed = true;
                continue;
            }
            parsed += 1;
            match parse_record(&self.origin.root, &path, node.lang, &origin)? {
                Some(record) => {
                    if carry_imports
                        && (record.raw_imports != node.raw_imports
                            || record.package_name != node.package_name
                            || record.namespace_name != node.namespace_name
                            || record.top_level_types != node.top_level_types)
                    {
                        imports_changed = true;
                    }
                    let mut updated = Node::of(Arc::new(record), &origin);
                    if carry_imports {
                        updated.resolved_imports = node.resolved_imports.clone();
                    }
                    nodes.push(updated);
                }
                None => {
                    unverified.push(node.rel.clone());
                    imports_changed = true;
                    omitted += 1;
                }
            }
        }
        super::cache::note(|t| {
            t.parse_ms += super::cache::elapsed_ms(started);
            t.reused += reused;
            t.parsed += parsed;
            t.omitted += omitted;
        });
        origin.words().settle();
        Ok(Reparsed { origin, nodes, unverified, imports_changed })
    }

    /// Re-parses only `rels` against the current generation, carrying over every other node's
    /// record and edges without walking the tree. Re-links only when a re-parsed file changed
    /// its import metadata, was removed/unverified, or `force_relink` is set.
    pub(super) fn reparse_subset(
        &self,
        key: &str,
        rels: &[String],
        hints: &Receipts,
        force_relink: bool,
        cache: Option<&GraphCache>,
    ) -> Result<Arc<Graph>, String> {
        let target_set: HashSet<&str> = rels.iter().map(String::as_str).collect();
        let Reparsed { origin, mut nodes, unverified, imports_changed } = self.reparse_nodes(&target_set, true)?;

        let inputs = if imports_changed || force_relink || !self.resolver_inputs_current() {
            let linking = std::time::Instant::now();
            let linked = link_stable(&self.origin.root, &mut nodes)?;
            super::cache::note(|t| t.link_ms += super::cache::elapsed_ms(linking));
            Arc::new(linked)
        } else {
            self.inputs.clone()
        };

        let base_key = key.trim_end_matches('/');
        let mut receipts = self.receipts.clone();
        for rel in &target_set {
            let id = format!("{base_key}/{}", fold(rel));
            if unverified.iter().any(|u| u == rel) {
                receipts.remove(&id);
            } else if let Some(&rev) = hints.get(&id) {
                receipts.insert(id, rev);
            }
        }
        let signature = signature_of(nodes.iter().map(|n| (n.rel.as_str(), n.fingerprint)));

        let assembling = std::time::Instant::now();
        let mut graph = Self::assemble(nodes, origin);
        graph.unverified = unverified;
        graph.unchanged = false;
        graph.inputs = inputs;
        graph.signature = signature;
        graph.receipts = receipts;
        if let Some(cache) = cache {
            graph.attach_lookups(key, Some(self), cache);
        }
        super::cache::note(|t| t.assemble_ms += super::cache::elapsed_ms(assembling));
        Ok(Arc::new(graph))
    }

    /// Re-parses only `rels` on a standalone (`build_files`) graph without linking or caching.
    pub(super) fn reparse_subset_standalone(&self, rels: &[String]) -> Result<Arc<Graph>, String> {
        let target_set: HashSet<&str> = rels.iter().map(String::as_str).collect();
        let Reparsed { origin, nodes, unverified, .. } = self.reparse_nodes(&target_set, false)?;
        let mut graph = Self::assemble(nodes, origin);
        graph.unverified = unverified;
        Ok(Arc::new(graph))
    }

    /// A view of this graph with persistently unstable files omitted into `unverified`, so the
    /// query can still answer for the rest of the project with a completeness warning.
    pub(super) fn without_unverified(&self, drop_rels: &HashSet<String>) -> Arc<Graph> {
        let origin = self.origin.successor();
        let mut nodes = Vec::with_capacity(self.nodes.len());
        for node in &self.nodes {
            if drop_rels.contains(&node.rel) {
                continue;
            }
            let mut carried = Node::of(node.record.clone(), &origin);
            carried.resolved_imports = node.resolved_imports.clone();
            let _ = carried.runtime.set(self.lookups.clone());
            nodes.push(carried);
        }
        let mut unverified = self.unverified.clone();
        let mut added: Vec<String> = drop_rels.iter().filter(|rel| !unverified.contains(*rel)).cloned().collect();
        added.sort();
        unverified.extend(added);
        let mut graph = Self::assemble(nodes, origin);
        graph.unverified = unverified;
        graph.inputs = self.inputs.clone();
        graph.signature = self.signature;
        graph.receipts = self.receipts.clone();
        graph.lookups = self.lookups.clone();
        Arc::new(graph)
    }

    fn assemble(nodes: Vec<Node>, origin: Arc<Origin>) -> Graph {
        let hasher = hashbrown::DefaultHashBuilder::default();
        let mut index = hashbrown::HashTable::with_capacity(nodes.len());
        for (at, node) in nodes.iter().enumerate() {
            index.insert_unique(hasher.hash_one(node.rel.as_str()), at as u32, |&at| hasher.hash_one(nodes[at as usize].rel.as_str()));
        }
        let position = |rel: &str| index.find(hasher.hash_one(rel), |&at| nodes[at as usize].rel == rel).copied();
        let mut importers: Vec<Vec<u32>> = vec![Vec::new(); nodes.len()];
        for (from, node) in nodes.iter().enumerate() {
            for target in &node.resolved_imports {
                if *target != node.rel
                    && let Some(to) = position(target)
                {
                    importers[to as usize].push(from as u32);
                }
            }
        }
        let reverse = importers
            .into_iter()
            .map(|mut from| {
                from.sort_unstable_by(|a, b| nodes[*a as usize].rel.cmp(&nodes[*b as usize].rel));
                from.dedup();
                from.into_boxed_slice()
            })
            .collect();
        Graph {
            nodes,
            index,
            hasher,
            reverse,
            unverified: Vec::new(),
            receipts: Receipts::new(),
            unchanged: false,
            lookups: Lookups::default(),
            signature: 0,
            inputs: Arc::default(),
            origin,
        }
    }
}
/// The eligible files of a graph over `root`, sorted, each with its fingerprint: one parallel walk
/// reading directory-entry metadata directly (no second per-file `stat` on Windows).
fn indexed_files(root: &Path, key: &str, excluded: &[PathBuf]) -> Result<Vec<Entry>, String> {
    let base = key.trim_end_matches('/');
    let prefixes: Vec<String> = excluded.iter().map(|path| path_key(path)).collect();
    let skip_dir = |dir: &Path| {
        if prefixes.is_empty() {
            return false;
        }
        let dir_key = path_key(dir);
        prefixes.iter().any(|prefix| dir_key == *prefix || dir_key.starts_with(&format!("{prefix}/")))
    };
    let mut candidates = walk_classified_files_with_meta(root, |p| p.extension().and_then(|s| s.to_str()).and_then(lang_for), skip_dir)?;
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(candidates
        .into_iter()
        .filter_map(|(path, lang, meta)| {
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
    let before = stamp_of(&file.metadata(&mixdog_fsio::Unlaned).ok()?)?;
    let mut bytes = Vec::new();
    (&file).take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    #[cfg(test)]
    AFTER_READ.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook();
        }
    });
    let after = stamp_of(&file.metadata(&mixdog_fsio::Unlaned).ok()?)?;
    (before == after && before.0 == bytes.len() as u64 && before.0 <= MAX_FILE_BYTES && source_here(&file, &path)).then_some((bytes, before))
}
fn relative_to<'a>(root: &Path, path: &'a Path) -> Result<&'a Path, String> {
    path.strip_prefix(root).map_err(|e| format!("path is outside graph root ({}): {e}", path.display()))
}

/// Parses one file and drops its text: only what the graph keeps survives. `None`: the file could not be verified.
fn parse_record(root: &Path, path: &Path, lang: &'static str, origin: &Origin) -> Result<Option<Record>, String> {
    #[cfg(test)]
    PARSED.with(|n| n.set(n.get() + 1));
    let relative = relative_to(root, path)?;
    let Some((bytes, fingerprint)) = read_observed(root, relative) else { return Ok(None) };
    let digest = digest_of(&bytes);
    Ok(Some(record_of(relative, path, bytes, digest, fingerprint, lang, origin)))
}

/// The record of a cached file another lifetime of the ledger wrote: its stamp may be the stamp of other bytes (a rewrite
/// inside the clock's granularity that no notice of this lifetime covers), so the source is read once, and the record stands
/// when those bytes are the ones it was parsed from; otherwise the bytes read are parsed (`false`). `None`: the source could
/// not be verified.
fn verified_from_cache(root: &Path, entry: &Entry, file: CachedFile, digest: [u8; 32], origin: &Origin) -> Result<Option<(Record, bool)>, String> {
    #[cfg(test)]
    VERIFIED_READS.with(|n| n.set(n.get() + 1));
    let relative = relative_to(root, &entry.path)?;
    let Some((bytes, fingerprint)) = read_observed(root, relative) else { return Ok(None) };
    let read = digest_of(&bytes);
    if read == digest && Some(fingerprint) == entry.stamp {
        return Ok(Some((record_from_cache(file, digest, &entry.path, entry.lang, origin), true)));
    }
    #[cfg(test)]
    PARSED.with(|n| n.set(n.get() + 1));
    Ok(Some((record_of(relative, &entry.path, bytes, read, fingerprint, entry.lang, origin), false)))
}

/// The record of `bytes`, read from `path` at `fingerprint`.
fn record_of(relative: &Path, path: &Path, bytes: Vec<u8>, digest: [u8; 32], fingerprint: (u64, u64), lang: &'static str, origin: &Origin) -> Record {
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
    Record {
        rel,
        lang,
        scan_lang,
        parse_error,
        symbols: Symbols::from(extraction.symbols),
        raw_imports: extraction.imports,
        package_name: extraction.package_name,
        namespace_name: extraction.namespace_name,
        go_package_name: extraction.go_package_name,
        top_level_types,
        tokens: origin.intern(&extraction.tokens),
        calls_bytes: calls.as_ref().map(|calls| 24 + calls.iter().map(|c| 8 + call_bytes(c)).sum::<u64>()),
        fingerprint: Some(fingerprint),
        digest,
        weight: 0,
        words: origin.words.clone(),
    }
    .weigh()
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
        inputs.shrink_to_fit();
        if inputs.iter().all(ObservedInput::is_current) {
            return Ok(inputs);
        }
    }
    Err("code_graph: the project's manifests kept changing while its imports were linked".to_owned())
}
