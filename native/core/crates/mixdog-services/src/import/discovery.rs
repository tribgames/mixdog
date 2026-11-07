//! Listing and searching importable conversations.
//!
//! Enumeration is stat-only; per-file metadata (foreign id, cwd, title, and the message count
//! when the whole file fit the read) comes from a bounded prefix read with bounded concurrency
//! and is cached by canonical path + size + mtime. One [`Discovery`] is shared by every session
//! of the daemon: one cache, one candidate registry, one set of listing views. A listing builds
//! a *view* (fixed membership, paged by cursor); a view expires after 30 minutes idle.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use mixdog_rt::MaintenanceIo;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use crate::lane::on_lane;
use mixdog_js::device_paths::{is_unc_path, is_windows_device_path};

use super::candidate::{Candidate, Env, enumerate_candidates, import_origin_key, mtime_ms, source_root};
use super::codex::{codex_meta_from_truncated_line, rollout_id_of};
use super::convert::{Conversion, Converter, Limits, MAX_FILE_BYTES, MAX_LINE_BYTES, Source};
use super::fsutil::{ImportError, Opened, StreamOpts, case_fold, is_compressed, open_verified, real_path, stream_jsonl_lines};
use super::history::{convert_candidate_file, find_rollout_by_id};
use super::titles::load_codex_thread_titles;
use super::turns::{WARNING_CWD_MISSING, WARNING_HISTORY_UNAVAILABLE};
use crate::voice::single_flight::SingleFlight;

pub const PREFIX_CHUNK_BYTES: usize = 64 * 1024;
pub const PREFIX_MAX_BYTES: u64 = 512 * 1024;
const META_CONCURRENCY: usize = 8;
const VIEW_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_VIEWS: usize = 32;
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 100;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Meta {
    pub foreign_session_id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub internal_kind: Option<String>,
    /// Rollout id of the history base this file continues.
    pub history_base_id: Option<String>,
    pub message_count: Option<usize>,
    pub warnings: Vec<String>,
    pub error_code: Option<String>,
}

fn meta_from_conversion(conversion: &Conversion, whole: bool) -> Meta {
    Meta {
        foreign_session_id: conversion.foreign_session_id.clone(),
        cwd: conversion.cwd.clone(),
        title: conversion.title.clone(),
        // A Codex marker sits in the first line; a Claude transcript is sidechain-only only once
        // read to the end.
        internal_kind: if whole || conversion.source == Source::Codex { conversion.internal_kind.clone() } else { None },
        history_base_id: conversion
            .history_base
            .as_ref()
            .and_then(|b| b.get("thread_id"))
            .and_then(Value::as_str)
            .map(str::to_lowercase),
        message_count: (whole && conversion.error_code.is_none()).then_some(conversion.message_count),
        warnings: if whole {
            conversion.warnings.clone()
        } else {
            conversion.warnings.iter().filter(|w| *w != "malformed").cloned().collect()
        },
        error_code: if whole { conversion.error_code.clone() } else { None },
    }
}

/// The app's stored title of a conversation, else the one derived from its messages.
pub fn display_title(meta: Option<&Meta>, titles: Option<&HashMap<String, String>>, manifest_title: Option<&str>) -> Option<String> {
    manifest_title
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            let id = meta?.foreign_session_id.as_deref()?;
            titles?.get(id).cloned()
        })
        .or_else(|| meta?.title.clone())
}

/// Import keys of conversations that already exist as sessions → their session id.
#[derive(Clone, Debug, Default)]
pub struct Imported(pub HashMap<String, String>);

impl Imported {
    pub fn get(&self, key: &str) -> Option<&String> {
        self.0.get(key)
    }
    pub fn has(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }
}

pub fn candidate_key(candidate: &Candidate, meta: &Meta) -> String {
    import_origin_key(candidate.source, meta.foreign_session_id.as_deref(), &candidate.path)
}

#[derive(Clone, Debug, PartialEq)]
pub struct CwdInfo {
    pub exists: bool,
    pub path: Option<String>,
}

/// The canonical directory when it exists, else the raw value. A relative or network/device cwd
/// is display text only: it is never handed to the filesystem (probing a UNC share can
/// negotiate credentials).
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job")]
pub fn resolve_source_cwd(raw: Option<&str>, cache: &mut HashMap<String, CwdInfo>) -> CwdInfo {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return CwdInfo { exists: false, path: None };
    };
    if let Some(hit) = cache.get(raw) {
        return hit.clone();
    }
    let mut result = CwdInfo { exists: false, path: Some(raw.to_owned()) };
    if Path::new(raw).is_absolute() && !(is_unc_path(raw) || is_windows_device_path(raw)) {
        if let Ok(real) = real_path(Path::new(raw)) {
            if !(is_unc_path(&real.to_string_lossy()) || is_windows_device_path(&real.to_string_lossy())) && real.is_dir() {
                result = CwdInfo { exists: true, path: Some(real.to_string_lossy().into_owned()) };
            }
        }
    }
    cache.insert(raw.to_owned(), result.clone());
    result
}

#[derive(Clone, Debug, Default)]
pub struct Filters {
    pub modified_after: Option<f64>,
    pub modified_before: Option<f64>,
    pub needle: String,
    pub project: Option<String>,
}

#[derive(Clone)]
struct View {
    id: String,
    source: Source,
    root: String,
    filters: Filters,
    titles: Option<Arc<HashMap<String, String>>>,
    candidate_ids: Vec<String>,
    member_ids: Vec<String>,
    selectable_ids: Vec<String>,
    projects: Vec<(String, usize)>,
    complete: bool,
    touched_at: Instant,
}

#[derive(Default)]
struct State {
    candidates: HashMap<String, Candidate>,
    /// canonical path → (stamp key, metadata)
    meta: HashMap<PathBuf, (String, Meta)>,
    views: Vec<View>,
}

pub struct Discovery {
    env: Env,
    /// Per-file byte budget of a sidechain-only scan.
    scan_max_bytes: u64,
    state: Mutex<State>,
    metas: SingleFlight<Meta>,
    permits: Semaphore,
    /// The lane enumeration, prefix reads and conversions run on.
    lane: MaintenanceIo,
}

fn fold_text(value: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    value.nfkc().collect::<String>().to_lowercase()
}

fn same_path(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(l), Some(r)) if !l.is_empty() && !r.is_empty() => {
            let abs = |p: &str| std::path::absolute(p).unwrap_or_else(|_| PathBuf::from(p));
            case_fold(&abs(l).to_string_lossy()) == case_fold(&abs(r).to_string_lossy())
        }
        _ => false,
    }
}

/// Ids of Codex rollouts that an earlier revision of the same thread (same session id) names as
/// its history base. Codex lists one rollout per thread, the current one, so these stay out of
/// the list; a fork's parent is another thread and stays listed.
fn superseded_base_ids(entries: &[(Candidate, Option<Meta>)]) -> HashSet<String> {
    let rollout_of = |c: &Candidate| {
        (c.source == Source::Codex)
            .then(|| rollout_id_of(&c.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
            .flatten()
    };
    let mut by_rollout: HashMap<String, String> = HashMap::new();
    for (c, meta) in entries {
        if let (Some(m), Some(rollout)) = (meta, rollout_of(c)) {
            if let Some(session) = &m.foreign_session_id {
                by_rollout.insert(format!("{session}\0{rollout}"), c.id.clone());
            }
        }
    }
    let mut hidden: HashSet<String> = HashSet::new();
    for (c, meta) in entries {
        let Some(m) = meta else { continue };
        let (Some(base_id), Some(session)) = (&m.history_base_id, &m.foreign_session_id) else { continue };
        if let Some(base) = by_rollout.get(&format!("{session}\0{base_id}")) {
            if *base != c.id {
                hidden.insert(base.clone());
            }
        }
    }
    // A cycle of revisions must not hide a thread entirely: its newest one (first in order) stays.
    let mut newest: Vec<(String, String)> = Vec::new();
    let mut visible: HashSet<String> = HashSet::new();
    let indexed: HashSet<&String> = by_rollout.values().collect();
    for (c, meta) in entries {
        let Some(session) = meta.as_ref().and_then(|m| m.foreign_session_id.clone()) else { continue };
        if !indexed.contains(&c.id) {
            continue;
        }
        if !newest.iter().any(|(s, _)| *s == session) {
            newest.push((session.clone(), c.id.clone()));
        }
        if !hidden.contains(&c.id) {
            visible.insert(session);
        }
    }
    for (session, id) in newest {
        if !visible.contains(&session) {
            hidden.remove(&id);
        }
    }
    hidden
}

struct Filtered {
    member_ids: Vec<String>,
    selectable_ids: Vec<String>,
    projects: Vec<(String, usize)>,
    complete: bool,
}

/// Applies a view's filters (time range, query on title/cwd, project) to candidates using their
/// cached metadata; a candidate whose metadata is still pending is neither a member nor counted
/// and leaves the result incomplete. The source app's internal and empty records are never
/// members.
fn filter_candidates(
    entries: &[(Candidate, Option<Meta>)],
    filters: &Filters,
    imported: &Imported,
    titles: Option<&HashMap<String, String>>,
) -> Filtered {
    let mut cwd_cache = HashMap::new();
    let (mut member_ids, mut project_counts, mut complete) = (Vec::new(), Vec::<(String, usize)>::new(), true);
    let superseded = superseded_base_ids(entries);
    for (candidate, meta) in entries {
        if superseded.contains(&candidate.id) {
            continue;
        }
        if filters.modified_after.is_some_and(|after| candidate.mtime_ms < after) {
            continue;
        }
        if filters.modified_before.is_some_and(|before| candidate.mtime_ms > before) {
            continue;
        }
        // Unclassified yet: neither a member nor counted until its metadata is read.
        let Some(meta) = meta else {
            complete = false;
            continue;
        };
        // The source app's own records and files read to the end without a message are not
        // conversations.
        if meta.internal_kind.is_some() || meta.error_code.as_deref() == Some("empty") {
            continue;
        }
        let cwd_info = meta.cwd.as_deref().map(|c| resolve_source_cwd(Some(c), &mut cwd_cache));
        let cwd_path = cwd_info.as_ref().and_then(|i| i.path.as_deref());
        if !filters.needle.is_empty() {
            let title = display_title(Some(meta), titles, candidate.title.as_deref()).unwrap_or_default();
            if !fold_text(&title).contains(&filters.needle) && !fold_text(cwd_path.unwrap_or("")).contains(&filters.needle) {
                continue;
            }
        }
        if let Some(path) = cwd_path {
            match project_counts.iter_mut().find(|(p, _)| p == path) {
                Some((_, n)) => *n += 1,
                None => project_counts.push((path.to_owned(), 1)),
            }
        }
        if filters.project.is_some() && !same_path(cwd_path, filters.project.as_deref()) {
            continue;
        }
        // Already-imported conversations are left out of the list entirely.
        if imported.has(&candidate_key(candidate, meta)) {
            continue;
        }
        member_ids.push(candidate.id.clone());
    }
    project_counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| super::fsutil::compare_code_units(&a.0, &b.0)));
    Filtered { selectable_ids: member_ids.clone(), member_ids, projects: project_counts, complete }
}

fn row_for(candidate: &Candidate, meta: Option<&Meta>, cwd_info: Option<&CwdInfo>, imported: &Imported, titles: Option<&HashMap<String, String>>) -> Value {
    let mut warnings: Vec<String> = meta.map(|m| m.warnings.clone()).unwrap_or_default();
    let mut add = |code: &str| {
        if !warnings.iter().any(|w| w == code) {
            warnings.push(code.to_owned());
        }
    };
    if let Some(m) = meta {
        if m.error_code.is_none() && !cwd_info.is_some_and(|i| i.exists) {
            add(WARNING_CWD_MISSING);
        }
        if let Some(code) = &m.error_code {
            add(code);
        }
    }
    json!({
        "id": candidate.id,
        "source": candidate.source,
        "title": display_title(meta, titles, candidate.title.as_deref()),
        "starred": candidate.starred,
        "cwd": cwd_info.and_then(|i| i.path.clone()),
        "modifiedAt": candidate.mtime_ms,
        "messageCount": meta.and_then(|m| m.message_count),
        "importedSessionId": meta.and_then(|m| imported.get(&candidate_key(candidate, m))),
        "warnings": warnings,
    })
}

fn encode_cursor(view_id: &str, offset: usize) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json!([view_id, offset]).to_string())
}

fn decode_cursor(cursor: &str) -> Result<(String, usize), ImportError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cursor).map_err(|_| ImportError::new("invalidCursor"))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ImportError::new("invalidCursor"))?;
    match (value.get(0).and_then(Value::as_str), value.get(1).and_then(Value::as_u64)) {
        (Some(id), Some(offset)) => Ok((id.to_owned(), offset as usize)),
        _ => Err(ImportError::new("invalidCursor")),
    }
}

/// Parameters of `listImportableConversations`, already type-checked.
#[derive(Clone, Debug, Default)]
pub struct ListParams {
    pub source: Option<Source>,
    pub query: String,
    pub project: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub modified_after: Option<f64>,
    pub modified_before: Option<f64>,
}

pub fn page_limit(limit: Option<usize>) -> usize {
    limit.map_or(DEFAULT_LIMIT, |l| l.min(MAX_LIMIT))
}

/// A prefix read: the metadata of the first lines of a candidate, whole-file when the file
/// fitted the read.
fn read_prefix_meta(candidate: &Candidate, scan_max_bytes: u64, codex_home: &Path) -> Result<Meta, ImportError> {
    let converter = RefCell::new(Converter::new(candidate.source, Limits::default()));
    let mut opened = open_verified(&candidate.path, candidate.root.as_deref())?;
    // Only the end of a Claude transcript proves it is sidechain-only, so while nothing but
    // sidechain messages has been seen the scan streams on, line by line, to EOF or to the
    // import file-size limit. A file over that limit stays unclassified (listed); importing it
    // fails as tooLarge.
    let claude = candidate.source.is_claude_format();
    let read = {
        let mut on_chunk = |position: u64| {
            // A file read to its known size keeps going to EOF (whole-file metadata).
            if position >= candidate.size {
                return true;
            }
            if claude {
                if converter.borrow().sidechain_only() {
                    return true;
                }
                if position >= PREFIX_MAX_BYTES {
                    return false;
                }
            }
            let partial = converter.borrow_mut().result();
            !(partial.foreign_session_id.is_some() && partial.cwd.is_some() && partial.title.is_some())
        };
        stream_jsonl_lines(
            &mut opened,
            &mut |line| converter.borrow_mut().push_line(line, false),
            StreamOpts {
                max_line_bytes: if claude { MAX_LINE_BYTES } else { PREFIX_MAX_BYTES as usize },
                chunk_bytes: PREFIX_CHUNK_BYTES,
                max_bytes: if claude { scan_max_bytes } else { PREFIX_MAX_BYTES },
                on_chunk: Some(&mut on_chunk),
            },
        )
        .map_err(|_| ImportError::new("unreadable"))?
    };
    // The stored title records sit near the end of a transcript.
    if claude && !read.eof {
        if let Opened::Plain(file) = &mut opened {
            for line in read_tail_lines(file, candidate.size) {
                converter.borrow_mut().push_title_line(&line);
            }
        }
    }
    let conversion = converter.borrow_mut().result();
    // A thread continuing a history base is only counted, named and judged empty once the base is
    // followed (on import).
    let listing = |meta: Meta| -> Meta {
        if conversion.history_base.is_none() {
            return meta;
        }
        let base_missing = meta
            .history_base_id
            .as_deref()
            .is_some_and(|id| find_rollout_by_id(codex_home, id).is_none());
        if base_missing {
            let mut meta = meta;
            meta.warnings.push(WARNING_HISTORY_UNAVAILABLE.to_owned());
            meta
        } else {
            let empty = meta.error_code.as_deref() == Some("empty");
            Meta { title: None, message_count: None, error_code: if empty { None } else { meta.error_code.clone() }, ..meta }
        }
    };
    if read.eof {
        return Ok(listing(meta_from_conversion(&conversion, true)));
    }
    let mut meta = listing(meta_from_conversion(&conversion, false));
    if candidate.source == Source::Codex && (meta.foreign_session_id.is_none() || meta.cwd.is_none()) {
        if let Some(partial) = &read.first_partial {
            // A session_meta line longer than the prefix still names its id/cwd.
            if let Some(from_line) = codex_meta_from_truncated_line(partial.strip_prefix('\u{feff}').unwrap_or(partial)) {
                meta.foreign_session_id = meta.foreign_session_id.or(from_line.foreign_session_id);
                meta.cwd = meta.cwd.or(from_line.cwd);
                meta.internal_kind = meta.internal_kind.or(from_line.internal_kind);
            }
        }
    }
    Ok(meta)
}

/// The canonical path and stat of a file chosen in a native picker.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job")]
fn stat_picked_file(requested: &str) -> Result<(PathBuf, std::fs::Metadata), ImportError> {
    let real = real_path(Path::new(requested)).map_err(|_| ImportError::new("unreadable"))?;
    let meta = std::fs::metadata(&real).map_err(|_| ImportError::new("unreadable"))?;
    Ok((real, meta))
}

/// Complete lines of the last prefix-chunk of a file (the cut-off first line dropped).
#[allow(clippy::disallowed_types, reason = "runs as a maintenance-lane job")]
fn read_tail_lines(file: &mut std::fs::File, size: u64) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    let length = size.min(PREFIX_CHUNK_BYTES as u64);
    let mut buffer = vec![0u8; length as usize];
    let ok = file.seek(SeekFrom::Start(size - length)).is_ok() && file.read(&mut buffer).is_ok();
    if !ok {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buffer).into_owned();
    let body = if size > length { text.split_once('\n').map_or("", |(_, rest)| rest) } else { text.as_str() };
    body.split('\n').map(str::to_owned).collect()
}

impl Discovery {
    pub fn new(env: Env, lane: MaintenanceIo) -> Arc<Self> {
        Self::with_scan_budget(env, MAX_FILE_BYTES, lane)
    }

    /// `scan_max_bytes` overrides the per-file budget of a sidechain-only scan.
    pub fn with_scan_budget(env: Env, scan_max_bytes: u64, lane: MaintenanceIo) -> Arc<Self> {
        Arc::new(Self {
            env,
            scan_max_bytes,
            state: Mutex::default(),
            metas: SingleFlight::default(),
            permits: Semaphore::new(META_CONCURRENCY),
            lane,
        })
    }

    pub fn env(&self) -> &Env {
        &self.env
    }

    /// The lane every file read of the import runs on.
    pub fn lane(&self) -> MaintenanceIo {
        self.lane
    }

    pub fn get_candidate(&self, id: &str) -> Option<Candidate> {
        self.state.lock().unwrap().candidates.get(id).cloned()
    }

    fn register(&self, candidate: Candidate) -> Candidate {
        self.state.lock().unwrap().candidates.insert(candidate.id.clone(), candidate.clone());
        candidate
    }

    /// Cached metadata of a candidate at its current stamp.
    pub fn cached_meta(&self, candidate: &Candidate) -> Option<Meta> {
        let state = self.state.lock().unwrap();
        state.meta.get(&candidate.path).filter(|(stamp, _)| *stamp == candidate.stamp_key()).map(|(_, m)| m.clone())
    }

    /// Records a full conversion's message count against the stamp it was read at.
    pub fn record_conversion(&self, candidate: &Candidate, conversion: &Conversion) {
        self.state
            .lock()
            .unwrap()
            .meta
            .insert(candidate.path.clone(), (candidate.stamp_key(), meta_from_conversion(conversion, true)));
    }

    /// Refreshes a candidate's stamp from the file as it is now, on the lane.
    pub async fn restamp(self: &Arc<Self>, candidate: Candidate) -> Result<Candidate, ImportError> {
        let this = self.clone();
        on_lane(self.lane, move || {
            let mut candidate = candidate;
            this.restamp_blocking(&mut candidate).map(|()| candidate)
        })
        .await
        .unwrap_or_else(|_| Err(ImportError::new("unreadable")))
    }

    #[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job")]
    fn restamp_blocking(&self, candidate: &mut Candidate) -> Result<(), ImportError> {
        let meta = std::fs::metadata(&candidate.path).map_err(|_| ImportError::new("unreadable"))?;
        if !meta.is_file() {
            return Err(ImportError::new("unreadable"));
        }
        candidate.size = meta.len();
        candidate.mtime_ms = mtime_ms(&meta);
        self.register(candidate.clone());
        Ok(())
    }

    pub fn codex_home(&self, candidate: &Candidate) -> PathBuf {
        let root = candidate.root.clone().or_else(|| source_root(Source::Codex, &self.env)).unwrap_or_default();
        root.parent().map(Path::to_path_buf).unwrap_or_default()
    }

    /// Titles the source app stores per foreign session id (Codex only), read fresh.
    pub async fn load_stored_titles(&self, source: Source) -> Option<Arc<HashMap<String, String>>> {
        if source != Source::Codex {
            return None;
        }
        let home = source_root(source, &self.env)?.parent()?.to_path_buf();
        on_lane(self.lane, move || Arc::new(load_codex_thread_titles(&home))).await.ok()
    }

    /// Metadata of a candidate, read through the bounded queue when not cached.
    pub async fn resolve_meta(self: &Arc<Self>, candidate: &Candidate) -> Meta {
        if let Some(meta) = self.cached_meta(candidate) {
            return meta;
        }
        let key = format!("{}\0{}", candidate.path.display(), candidate.stamp_key());
        let this = self.clone();
        let cand = candidate.clone();
        self.metas
            .run(&key, move || async move {
                let _permit = this.permits.acquire().await.expect("semaphore is never closed");
                let home = this.codex_home(&cand);
                let (c, scan) = (cand.clone(), this.scan_max_bytes);
                let read = on_lane(this.lane, move || read_prefix_meta(&c, scan, &home)).await;
                let ran = read.is_ok();
                let meta = read
                    .unwrap_or_else(|_| Err(ImportError::new("unreadable")))
                    .unwrap_or_else(|e| Meta { error_code: Some(e.0), ..Meta::default() });
                // A read that never ran is not cached: "unreadable" would stick to the file's stamp.
                if ran {
                    this.state.lock().unwrap().meta.insert(cand.path.clone(), (cand.stamp_key(), meta.clone()));
                }
                meta
            })
            .await
    }

    /// Starts the metadata reads of all candidates (bounded by the permit pool), in order.
    fn spawn_resolve(self: &Arc<Self>, candidates: &[Candidate]) -> Vec<tokio::task::JoinHandle<Meta>> {
        candidates
            .iter()
            .map(|candidate| {
                let (this, c) = (self.clone(), candidate.clone());
                tokio::spawn(async move { this.resolve_meta(&c).await })
            })
            .collect()
    }

    /// An unreadable root lists nothing (the scan ran); a scan that never ran is an error, not an
    /// empty listing the view would keep.
    async fn enumerate(&self, source: Source) -> Result<(String, Vec<Candidate>), ImportError> {
        let env = self.env.clone();
        let found = on_lane(self.lane, move || enumerate_candidates(source, &env)).await.map_err(|_| ImportError::new("unreadable"))?;
        for candidate in &found.candidates {
            self.register(candidate.clone());
        }
        Ok((found.root, found.candidates))
    }

    fn snapshot(&self, ids: &[String]) -> Vec<(Candidate, Option<Meta>)> {
        let candidates: Vec<Candidate> = {
            let state = self.state.lock().unwrap();
            ids.iter().filter_map(|id| state.candidates.get(id).cloned()).collect()
        };
        candidates
            .into_iter()
            .map(|c| {
                let meta = self.cached_meta(&c);
                (c, meta)
            })
            .collect()
    }

    fn prune_views(state: &mut State) {
        let now = Instant::now();
        state.views.retain(|v| now.duration_since(v.touched_at) <= VIEW_TTL);
        while state.views.len() > MAX_VIEWS {
            state.views.remove(0);
        }
    }

    /// A live listing view, or an error when it expired (membership is never re-derived).
    fn require_view(&self, view_id: &str) -> Result<View, ImportError> {
        let mut state = self.state.lock().unwrap();
        Self::prune_views(&mut state);
        let view = state.views.iter_mut().find(|v| v.id == view_id).ok_or_else(|| ImportError::new("viewExpired"))?;
        view.touched_at = Instant::now();
        Ok(view.clone())
    }

    async fn page_result(&self, view: &View, offset: usize, limit: usize, imported: &Imported) -> Value {
        let ids: Vec<String> = view.member_ids.iter().skip(offset).take(limit).cloned().collect();
        let entries = self.snapshot(&ids);
        let (titles, imported) = (view.titles.clone(), imported.clone());
        let rows = on_lane(self.lane, move || {
            let mut cwd_cache = HashMap::new();
            entries
                .iter()
                .map(|(c, meta)| {
                    let cwd = meta.as_ref().and_then(|m| m.cwd.as_deref()).map(|raw| resolve_source_cwd(Some(raw), &mut cwd_cache));
                    row_for(c, meta.as_ref(), cwd.as_ref(), &imported, titles.as_deref())
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        let next_offset = offset + ids.len();
        json!({
            "searchedRoot": view.root,
            "viewId": view.id,
            "complete": view.complete,
            "matchedCount": view.member_ids.len(),
            "selectableCount": view.selectable_ids.len(),
            "projects": view.projects.iter().map(|(cwd, count)| json!({"cwd": cwd, "count": count})).collect::<Vec<_>>(),
            "rows": rows,
            "nextCursor": (next_offset < view.member_ids.len()).then(|| encode_cursor(&view.id, next_offset)),
        })
    }

    /// One page of importable conversations. Without a cursor a new view (fixed membership) is
    /// built from a fresh enumeration; a cursor pages that view.
    pub async fn list_conversations(self: &Arc<Self>, params: &ListParams, imported: &Imported) -> Result<Value, ImportError> {
        let source = params.source.ok_or_else(|| ImportError::new("unsupported"))?;
        let limit = page_limit(params.limit);
        if let Some(cursor) = params.cursor.as_deref().filter(|c| !c.is_empty()) {
            let (view_id, offset) = decode_cursor(cursor)?;
            let view = self.require_view(&view_id)?;
            if view.source != source {
                return Err(ImportError::new("invalidCursor"));
            }
            return Ok(self.page_result(&view, offset, limit, imported).await);
        }
        let filters = Filters {
            modified_after: params.modified_after,
            modified_before: params.modified_before,
            needle: mixdog_js::js_trim(&fold_text(&params.query)).to_owned(),
            project: params.project.as_ref().map(|p| mixdog_js::js_trim(p).to_owned()).filter(|p| !p.is_empty()),
        };
        let (root, candidates) = self.enumerate(source).await?;
        let titles = self.load_stored_titles(source).await;
        // Background metadata for everything, newest first; the first page is awaited.
        // Candidates still unclassified stay out of the view (it is incomplete) and join it on a
        // later listing.
        let background = self.spawn_resolve(&candidates);
        if filters.needle.is_empty() && filters.project.is_none() {
            for handle in background.into_iter().take(limit) {
                let _ = handle.await;
            }
        }
        let candidate_ids: Vec<String> = candidates.iter().map(|c| c.id.clone()).collect();
        let filtered = self.filter(&candidate_ids, &filters, imported, titles.clone()).await;
        let view = View {
            id: uuid::Uuid::new_v4().to_string(),
            source,
            root,
            filters,
            titles,
            candidate_ids,
            member_ids: filtered.member_ids,
            selectable_ids: filtered.selectable_ids,
            projects: filtered.projects,
            complete: filtered.complete,
            touched_at: Instant::now(),
        };
        {
            let mut state = self.state.lock().unwrap();
            state.views.push(view.clone());
            Self::prune_views(&mut state);
        }
        Ok(self.page_result(&view, 0, limit, imported).await)
    }

    async fn filter(&self, ids: &[String], filters: &Filters, imported: &Imported, titles: Option<Arc<HashMap<String, String>>>) -> Filtered {
        let entries = self.snapshot(ids);
        let (filters, imported) = (filters.clone(), imported.clone());
        on_lane(self.lane, move || filter_candidates(&entries, &filters, &imported, titles.as_deref()))
            .await
            .unwrap_or(Filtered { member_ids: Vec::new(), selectable_ids: Vec::new(), projects: Vec::new(), complete: false })
    }

    /// Complete selectable membership of a view for select-all: waits until the metadata of
    /// every candidate the view enumerated is resolved, re-applies the view's filters, then drops
    /// `exclude_ids` and already-imported conversations. An expired view is rejected.
    pub async fn resolve_view_selection(self: &Arc<Self>, view_id: &str, exclude_ids: &[String], imported: &Imported) -> Result<Vec<String>, ImportError> {
        let view = self.require_view(view_id)?;
        let candidates: Vec<Candidate> = {
            let state = self.state.lock().unwrap();
            view.candidate_ids.iter().filter_map(|id| state.candidates.get(id).cloned()).collect()
        };
        for handle in self.spawn_resolve(&candidates) {
            let _ = handle.await;
        }
        let ids: Vec<String> = candidates.iter().map(|c| c.id.clone()).collect();
        let filtered = self.filter(&ids, &view.filters, imported, view.titles.clone()).await;
        let excluded: HashSet<&String> = exclude_ids.iter().collect();
        Ok(filtered.selectable_ids.into_iter().filter(|id| !excluded.contains(id)).collect())
    }

    /// Validates and registers a file chosen in a native picker (a local regular `.jsonl`, or a
    /// Codex `.jsonl.zst`), converts it once and returns its listing row.
    pub async fn register_file(self: &Arc<Self>, source: Source, path: &str, imported: &Imported, limits: Limits) -> Result<Value, ImportError> {
        if mixdog_js::js_trim(path).is_empty() || path.contains('\0') {
            return Err(ImportError::new("invalidPath"));
        }
        let requested = mixdog_js::js_trim(path).to_owned();
        // Network/device forms are refused before any filesystem call.
        if is_unc_path(&requested) || is_windows_device_path(&requested) {
            return Err(ImportError::new("unsupported"));
        }
        if !Path::new(&requested).is_absolute() {
            return Err(ImportError::new("invalidPath"));
        }
        let pickable = |p: &Path| {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            name.to_lowercase().ends_with(".jsonl") || (source == Source::Codex && is_compressed(p))
        };
        if !pickable(Path::new(&requested)) {
            return Err(ImportError::new("unsupported"));
        }
        let (real, meta) = on_lane(self.lane, move || stat_picked_file(&requested)).await.unwrap_or_else(|_| Err(ImportError::new("unreadable")))?;
        if is_unc_path(&real.to_string_lossy()) || is_windows_device_path(&real.to_string_lossy()) || !meta.is_file() || !pickable(&real) {
            return Err(ImportError::new("unsupported"));
        }
        let mut candidate = Candidate::for_file(source, None, real, meta.len());
        candidate.mtime_ms = mtime_ms(&meta);
        let candidate = self.register(candidate);
        let converted = self.convert(&candidate, limits).await?;
        if let Some(code) = &converted.error_code {
            return Err(ImportError::new(code));
        }
        self.record_conversion(&candidate, &converted);
        let titles = self.load_stored_titles(source).await;
        let meta = self.cached_meta(&candidate);
        let cwd = on_lane(self.lane, {
            let raw = meta.as_ref().and_then(|m| m.cwd.clone());
            move || raw.as_deref().map(|r| resolve_source_cwd(Some(r), &mut HashMap::new()))
        })
        .await
        .unwrap_or(None);
        Ok(json!({ "row": row_for(&candidate, meta.as_ref(), cwd.as_ref(), imported, titles.as_deref()) }))
    }

    /// Whole-file conversion under the import limits, off the async threads.
    pub async fn convert(&self, candidate: &Candidate, limits: Limits) -> Result<Conversion, ImportError> {
        let home = self.codex_home(candidate);
        let candidate = candidate.clone();
        on_lane(self.lane, move || {
            convert_candidate_file(&candidate, &home, limits, super::history::IMPORT_CHUNK_BYTES).map(|f| f.conversion)
        })
        .await
        .unwrap_or_else(|_| Err(ImportError::new("unreadable")))
    }
}

#[cfg(test)]
mod lane_tests {
    use super::*;

    /// A scan that never ran is an error; it is not a listing of nothing that a view would keep.
    #[tokio::test(flavor = "current_thread")]
    async fn a_listing_whose_scan_never_ran_is_an_error() {
        let discovery = Discovery::new(Env::from_process(), mixdog_rt::testing::tokens().maintenance_io);
        let params = ListParams { source: Some(Source::Claude), ..ListParams::default() };
        let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
        assert!(discovery.list_conversations(&params, &Imported::default()).await.is_err());
        assert!(discovery.state.lock().unwrap().views.is_empty());
    }
}

