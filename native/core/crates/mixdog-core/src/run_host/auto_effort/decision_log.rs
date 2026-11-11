//! The data directory's decision log as Node keeps it (`effort-judge/decision-log.mjs`): three files
//! beside each other instead of one growing file.
//! - `decisions.jsonl`: the newest judgments as written, up to one segment;
//! - `decisions.1.jsonl`: the segment before it;
//! - `decisions-summary.jsonl`: everything older, as counts per day, provider, model and kind.
//!
//! When the newest file passes a segment, the previous one is counted into the summary and removed,
//! and the newest takes its place. A log over two segments (written before segments existed) is
//! counted whole, and a `decisions.leaving.jsonl` a stopped process left half-counted is finished
//! first. The appends run as durability-lane jobs; the rotation and the counting as a
//! maintenance-lane job, never on the turn's path.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use mixdog_js::{utf16_len, value_to_string};
use mixdog_rt::InLane;
use mixdog_statefile::WriteLane;
use serde_json::Value;

/// `DECISION_SEGMENT_BYTES`: about 17,000 judgments.
pub(super) const DECISION_SEGMENT_BYTES: u64 = 4 * 1024 * 1024;

const MS_BUCKETS: [f64; 4] = [100.0, 200.0, 300.0, 500.0];
/// How much of a segment one read takes while it is counted.
const READ_CHUNK: usize = 1 << 20;

fn ms_bucket(ms: f64) -> String {
    MS_BUCKETS.iter().find(|limit| ms < **limit).map_or_else(|| "from500".to_owned(), |limit| format!("under{limit}"))
}

/// JavaScript's `<` on strings: UTF-16 code units.
fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `at.slice(0, 10)`.
fn utf16_head(text: &str, units: usize) -> String {
    let head: Vec<u16> = text.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&head)
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// A key JavaScript keeps as an array index: object keys list these first, numerically.
fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit()));
    key.parse::<u32>().ok().filter(|n| canonical && *n < u32::MAX)
}

/// `JSON.stringify(sortedCounts(counts))`: keys sorted, as the object then lists them.
fn counts_json(counts: &HashMap<String, u64>) -> String {
    let mut keys: Vec<&String> = counts.keys().collect();
    keys.sort_by(|a, b| match (array_index(a), array_index(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => js_cmp(a, b),
    });
    let fields: Vec<String> = keys.iter().map(|key| format!("{}:{}", json_string(key), counts[*key])).collect();
    format!("{{{}}}", fields.join(","))
}

/// A `sessionId` as a `Set` tells them apart (SameValueZero; every parsed object is its own).
#[derive(PartialEq, Eq, Hash)]
enum SessionKey {
    Text(String),
    Number(u64),
    Flag,
    Object(usize),
}

struct Row {
    day: String,
    provider: String,
    model: String,
    kind: &'static str,
    from: String,
    to: String,
    judged: u64,
    sessions: HashSet<SessionKey>,
    skipped: HashMap<String, u64>,
    efforts: HashMap<String, u64>,
    ms: HashMap<String, u64>,
}

/// `createDecisionSummary()`: one row per day, provider, model and kind (a turn's judgment or a
/// tool-result step's), every count adding up with the same row of another segment.
#[derive(Default)]
pub(super) struct DecisionSummary {
    rows: BTreeMap<Vec<u16>, Row>,
    objects: usize,
}

fn bump(counts: &mut HashMap<String, u64>, key: String) {
    *counts.entry(key).or_default() += 1;
}

/// `String(value ?? '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    }
}

impl DecisionSummary {
    pub(super) fn add(&mut self, line: &str) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { return };
        let Some(at) = entry.get("at").and_then(Value::as_str) else { return };
        if utf16_len(at) < 10 {
            return;
        }
        let day = utf16_head(at, 10);
        let kind = if entry.get("atStep").is_none() { "turn" } else { "step" };
        let provider = text_or_empty(entry.get("provider"));
        let model = text_or_empty(entry.get("model"));
        let key = serde_json::to_string(&[day.as_str(), provider.as_str(), model.as_str(), kind]).unwrap_or_default();
        let row = self.rows.entry(key.encode_utf16().collect()).or_insert_with(|| Row {
            day,
            provider,
            model,
            kind,
            from: at.to_owned(),
            to: at.to_owned(),
            judged: 0,
            sessions: HashSet::new(),
            skipped: HashMap::new(),
            efforts: HashMap::new(),
            ms: HashMap::new(),
        });
        if js_cmp(at, &row.from) == Ordering::Less {
            at.clone_into(&mut row.from);
        }
        if js_cmp(at, &row.to) == Ordering::Greater {
            at.clone_into(&mut row.to);
        }
        row.judged += 1;
        let session = match entry.get("sessionId") {
            Some(Value::String(id)) if !id.is_empty() => Some(SessionKey::Text(id.clone())),
            Some(Value::Number(n)) => n.as_f64().filter(|n| *n != 0.0 && !n.is_nan()).map(|n| SessionKey::Number((n + 0.0).to_bits())),
            Some(Value::Bool(true)) => Some(SessionKey::Flag),
            Some(Value::Array(_) | Value::Object(_)) => {
                self.objects += 1;
                Some(SessionKey::Object(self.objects))
            }
            _ => None,
        };
        if let Some(session) = session {
            row.sessions.insert(session);
        }
        // `load-error: <message>` carries the message; the reason is what counts.
        if let Some(skipped) = entry.get("skipped") {
            let reason = value_to_string(skipped);
            bump(&mut row.skipped, reason.split(':').next().unwrap_or_default().to_owned());
        } else if let Some(effort) = entry.get("effort") {
            bump(&mut row.efforts, format!("{}>{}", text_or_empty(entry.get("base")), value_to_string(effort)));
        }
        if let Some(ms) = entry.get("ms").and_then(Value::as_f64).filter(|ms| ms.is_finite()) {
            bump(&mut row.ms, ms_bucket(ms));
        }
    }

    /// Each row as `JSON.stringify` writes it, in key order.
    pub(super) fn rows(&self) -> Vec<String> {
        self.rows
            .values()
            .map(|row| {
                format!(
                    r#"{{"day":{},"provider":{},"model":{},"kind":{},"from":{},"to":{},"judged":{},"sessions":{},"skipped":{},"efforts":{},"ms":{}}}"#,
                    json_string(&row.day),
                    json_string(&row.provider),
                    json_string(&row.model),
                    json_string(row.kind),
                    json_string(&row.from),
                    json_string(&row.to),
                    row.judged,
                    row.sessions.len(),
                    counts_json(&row.skipped),
                    counts_json(&row.efforts),
                    counts_json(&row.ms),
                )
            })
            .collect()
    }
}

/// `${file without .jsonl}${suffix}`.
fn sibling(file: &Path, suffix: &str) -> PathBuf {
    let text = file.to_string_lossy();
    PathBuf::from(format!("{}{suffix}", text.strip_suffix(".jsonl").unwrap_or(&text)))
}

fn size_on_disk<L: WriteLane>(lane: &InLane<L>, file: &Path) -> u64 {
    mixdog_statefile::metadata(lane, file).map_or(0, |meta| meta.len())
}

/// Counts `segment` into `summary` and removes it; a segment that is not there is nothing to do.
fn fold<L: WriteLane>(lane: &InLane<L>, segment: &Path, summary: &Path) -> io::Result<()> {
    let mut counts = DecisionSummary::default();
    let mut rest: Vec<u8> = Vec::new();
    let mut offset = 0u64;
    loop {
        let chunk = match mixdog_statefile::read_range(lane, segment, offset, READ_CHUNK) {
            Ok(chunk) => chunk,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if chunk.is_empty() {
            break;
        }
        offset += chunk.len() as u64;
        rest.extend_from_slice(&chunk);
        let complete = rest.iter().rposition(|byte| *byte == b'\n').map_or(0, |end| end + 1);
        for line in rest[..complete].split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
            counts.add(&String::from_utf8_lossy(line));
        }
        rest.drain(..complete);
        mixdog_rt::job_progress();
    }
    if !rest.is_empty() {
        counts.add(&String::from_utf8_lossy(&rest));
    }
    let rows = counts.rows();
    if !rows.is_empty() {
        mixdog_statefile::append_file(lane, summary, format!("{}\n", rows.join("\n")).as_bytes())?;
    }
    mixdog_statefile::remove_file(lane, segment)
}

#[derive(Default)]
struct State {
    /// The newest file's size as this process last knew it; `None` until read from disk.
    bytes: Option<u64>,
    rotating: bool,
}

/// `decisionLog(file)`: one log and its segments. Other processes append to the same file; the size
/// is read when this one first appends and again before a rotation.
pub(super) struct Segments {
    file: PathBuf,
    previous: PathBuf,
    leaving: PathBuf,
    summary: PathBuf,
    segment_bytes: u64,
    state: Mutex<State>,
}

impl Segments {
    pub(super) fn new(file: PathBuf, segment_bytes: u64) -> Self {
        Self {
            previous: sibling(&file, ".1.jsonl"),
            leaving: sibling(&file, ".leaving.jsonl"),
            summary: sibling(&file, "-summary.jsonl"),
            file,
            segment_bytes,
            state: Mutex::default(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Appends `line`; `true` when the file passed its segment and this caller is to start the
    /// rotation. A failed append is dropped (the log is diagnostic only).
    pub(super) fn append<L: WriteLane>(&self, lane: &InLane<L>, line: &str) -> bool {
        if mixdog_statefile::append_file(lane, &self.file, line.as_bytes()).is_err() {
            return false;
        }
        let mut state = self.state();
        // Unknown: the size on disk, this line included.
        let bytes = state.bytes.map_or_else(|| size_on_disk(lane, &self.file), |bytes| bytes + line.len() as u64);
        state.bytes = Some(bytes);
        if bytes > self.segment_bytes && !state.rotating {
            state.rotating = true;
            return true;
        }
        false
    }

    /// A rotation that could not start: the next record past the segment tries again.
    pub(super) fn rotation_refused(&self) {
        self.state().rotating = false;
    }

    /// The rotation job.
    pub(super) fn rotate<L: WriteLane>(&self, lane: &InLane<L>) {
        let outcome = self.rotate_once(lane);
        let mut state = self.state();
        if outcome.is_err() {
            state.bytes = None;
        }
        state.rotating = false;
    }

    fn rotate_once<L: WriteLane>(&self, lane: &InLane<L>) -> io::Result<()> {
        // A segment a stopped process left half-counted goes first.
        fold(lane, &self.leaving, &self.summary)?;
        let size = size_on_disk(lane, &self.file);
        if size <= self.segment_bytes {
            // Another process rotated it.
            self.state().bytes = Some(size);
            return Ok(());
        }
        if size > 2 * self.segment_bytes {
            // A log from before segments existed: counted whole, not kept as a segment.
            mixdog_statefile::rename_with_retry(lane, &self.file, &self.leaving)?;
        } else {
            let _ = mixdog_statefile::rename_with_retry(lane, &self.previous, &self.leaving);
            mixdog_statefile::rename_with_retry(lane, &self.file, &self.previous)?;
        }
        self.state().bytes = Some(0);
        fold(lane, &self.leaving, &self.summary)
    }
}
