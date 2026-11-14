//! What the model already holds of a window, and what changed since: the observation delta (`capture-delta.ts`), the
//! per-session capture baseline and the change summary against it (`capture-baseline.ts`, `summarizeCaptureChanges`), the
//! repeated-frame check (`capture-image-dedup.ts`) and the launch-layout re-read (`capture-launch-layout.ts`).
//!
//! Every snapshot retires the worker's refs (`s<generation>:e<n>`): a ref of an older snapshot is refused as stale and a ref
//! the model sends is never rewritten. A delta therefore cannot carry refs forward: it names which rows of the list the model
//! holds are still on screen unchanged and the live ref each has now (`unchanged: ["s1:e0..e4=s9:e0..e4"]`) and lists every
//! other row in full with its live ref. "Unchanged" asserts only that a row renders identically (role, name, value, state,
//! bounds, actions); rows are paired by an order-preserving alignment of their content.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use mixdog_rt::time::Instant;
use mixdog_rt::time::sleep;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

/// Consecutive deltas before a full list is sent again: unchanged rows are named by refs of an observation that may have
/// left the model's context.
const MAX_CONSECUTIVE_DELTAS: u32 = 8;
/// The largest changed middle section aligned exactly; beyond it everything in the section counts as changed, which only
/// makes the delta larger.
const MAX_ALIGNMENT_CELLS: usize = 250_000;
/// `MAX_COMPUTER_OBSERVED_SCOPE_AGE_MS`: a baseline older than this is not a continuation.
const MAX_OBSERVED_SCOPE_AGE: Duration = Duration::from_millis(300_000);
/// How many changed identities a capture summary names before it only counts.
const CAPTURE_CHANGE_SAMPLE: usize = 8;
/// Entries the repeated-frame store keeps (`createCaptureImageDedupStore`'s default).
const MAX_IMAGE_ENTRIES: usize = 64;
/// A launched window is listed before its content finishes laying out (Paint: 89 accessible elements half a second in, 114
/// once settled).
const LAUNCH_LAYOUT_POLL: Duration = Duration::from_millis(200);
/// Ten polls: four times the half second the example above needed.
const LAUNCH_LAYOUT_BUDGET: Duration = Duration::from_millis(2_000);

/// What the caller says of this observation (`recordObservation`'s `ObservationInput` beside the rows and generation, which
/// the snapshot carries).
#[derive(Debug, Clone, Default)]
pub struct DeltaOptions {
    /// Whether this reply may be a delta against the previous observation: the command asked for it (`observation_delta`) and
    /// the read is not a set-of-marks one, has no OCR content and no continuation.
    pub observation_delta: bool,
    /// Whether the rows describe the accessibility tree of a settled capture.
    pub recordable: bool,
    /// [`capture_baseline_key`] of the read.
    pub baseline_key: String,
    /// The window and the windows related to it (a dialog it owns).
    pub related_window_ids: Vec<String>,
}

/// The answer of [`DeltaStore::observe`].
#[derive(Debug, Clone, PartialEq)]
pub struct DeltaOutcome {
    /// The `elements_delta` row to send in place of the full list (`unchanged`, `added`, `removed`); none for the full list.
    pub delta: Option<Value>,
    /// The frame repeats the last one delivered for this window: send the text and drop the image.
    pub suppress_image: bool,
    /// The reply is the full list, which is now the baseline (or, for a read that cannot be one, the baseline is gone).
    pub baseline_reset: bool,
}

struct HeldRow {
    /// The ref the most recent reply gave this row.
    reference: String,
    fingerprint: String,
}

struct DeltaState {
    window_id: String,
    baseline_key: String,
    related_window_ids: String,
    generation: f64,
    observed_at: Instant,
    consecutive_deltas: u32,
    /// The list the model holds, in order.
    held: Vec<HeldRow>,
}

/// An insertion-ordered map of identity to signature (`captureIdentityMap`'s `Map`).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct IdentityMap {
    order: Vec<String>,
    signatures: HashMap<String, String>,
}

impl IdentityMap {
    fn set(&mut self, identity: String, signature: String) {
        if self.signatures.insert(identity.clone(), signature).is_none() {
            self.order.push(identity);
        }
    }
}

/// The last capture of a session: what `recordCaptureBaseline` compares the next one with.
struct CaptureBaseline {
    window_id: String,
    baseline_key: String,
    elements: IdentityMap,
    /// Each row's ref to its identity: what an action on a ref of this capture targets (`semanticTargetIdentity`).
    ref_identities: HashMap<String, String>,
}

#[derive(Default)]
struct Inner {
    deltas: HashMap<String, DeltaState>,
    baselines: HashMap<String, CaptureBaseline>,
    /// `session\0window` to the digest of the last frame delivered, with the tick it was recorded at (insertion order).
    images: HashMap<String, (String, u64)>,
    tick: u64,
}

/// The per-pool store of delta lists, baselines and frame digests, keyed by session (and window for frames).
#[derive(Default)]
pub struct DeltaStore(Mutex<Inner>);

impl DeltaStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Record this observation as the one the model now holds and, when the previous one is a valid baseline and the change is
    /// smaller than the list, return the delta to send instead of the full rows (`recordObservation`); then check the frame
    /// against the last one delivered for this window. `snapshot` carries `elements` and `generation` as the capture builds it.
    pub fn observe(&self, session: &str, window_id: &str, snapshot: &Map<String, Value>, image_digest: Option<&str>, opts: &DeltaOptions) -> DeltaOutcome {
        self.observe_at(session, window_id, snapshot, image_digest, opts, Instant::now())
    }

    fn observe_at(&self, session: &str, window_id: &str, snapshot: &Map<String, Value>, image_digest: Option<&str>, opts: &DeltaOptions, now: Instant) -> DeltaOutcome {
        let elements: &[Value] = snapshot.get("elements").and_then(Value::as_array).map_or(&[], Vec::as_slice);
        let generation = snapshot.get("generation").and_then(Value::as_f64);
        let mut inner = self.inner();
        let delta = record_observation(&mut inner.deltas, session, window_id, elements, generation, opts, now);
        let suppress_image = image_digest.is_some_and(|digest| is_repeat(&mut inner, &format!("{session}\0{window_id}"), digest));
        DeltaOutcome { baseline_reset: delta.is_none(), delta, suppress_image }
    }

    /// `recordCaptureBaseline`: the change summary of this capture against the last one of the session when it read the same
    /// window with the same parameters; this capture becomes the baseline either way. `raw_elements` are the accessibility rows.
    pub fn record_baseline(&self, session: &str, window_id: &str, baseline_key: &str, raw_elements: &[Value]) -> Option<Value> {
        let mut ref_identities = HashMap::new();
        let identities = capture_identity_map(raw_elements, &mut ref_identities);
        let mut inner = self.inner();
        let changes = inner
            .baselines
            .get(session)
            .filter(|baseline| !window_id.is_empty() && baseline.window_id == window_id && baseline.baseline_key == baseline_key)
            .map(|baseline| summarize_capture_changes(&baseline.elements, &identities));
        inner.baselines.insert(session.to_string(), CaptureBaseline { window_id: window_id.to_string(), baseline_key: baseline_key.to_string(), elements: identities, ref_identities });
        changes
    }

    /// The identity the session's last capture gave this ref (`lastCaptureBySession.get(session).refIdentities.get(ref)`): the
    /// semantic target of an action on it, which decides whether the capture after it may drop its image.
    pub fn ref_identity(&self, session: &str, reference: &str) -> Option<String> {
        self.inner().baselines.get(session).and_then(|baseline| baseline.ref_identities.get(reference).cloned())
    }

    /// The model no longer holds the list of this session: the next observation is a full one.
    pub fn forget_delta(&self, session: &str) {
        self.inner().deltas.remove(session);
    }

    /// The window's frame is no longer the one delivered (`forget`).
    pub fn forget_image(&self, session: &str, window_id: &str) {
        self.inner().images.remove(&format!("{session}\0{window_id}"));
    }

    /// A released session forgets its delta list, baseline and frame digests (`releasePrefix`).
    pub fn forget_session(&self, session: &str) {
        let mut inner = self.inner();
        inner.deltas.remove(session);
        inner.baselines.remove(session);
        let prefix = format!("{session}\0");
        inner.images.retain(|key, _| !key.starts_with(&prefix));
    }
}

/// The digest [`DeltaStore::observe`] compares frames by: SHA-256 of the image bytes, in hex.
pub fn image_digest(image: &[u8]) -> String {
    Sha256::digest(image).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Records this frame for the target and reports whether it repeats the previous one (`isRepeat`).
fn is_repeat(inner: &mut Inner, target: &str, digest: &str) -> bool {
    if target.is_empty() || digest.is_empty() {
        return false;
    }
    inner.tick += 1;
    let tick = inner.tick;
    let repeat = inner.images.get(target).is_some_and(|(held, _)| held == digest);
    inner.images.insert(target.to_string(), (digest.to_string(), tick));
    while inner.images.len() > MAX_IMAGE_ENTRIES {
        let Some(oldest) = inner.images.iter().min_by_key(|(_, (_, tick))| *tick).map(|(key, _)| key.clone()) else { break };
        inner.images.remove(&oldest);
    }
    repeat
}

/// JavaScript's `String(value)` for the values a ref can be.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `JSON.stringify(...).length`: UTF-16 code units.
fn json_length(value: &impl serde::Serialize) -> usize {
    serde_json::to_string(value).map_or(0, |text| text.encode_utf16().count())
}

fn fingerprint_of(row: &Value) -> String {
    match row {
        Value::Object(fields) => {
            let content: Map<String, Value> = fields.iter().filter(|(key, _)| *key != "mark" && *key != "ref").map(|(key, value)| (key.clone(), value.clone())).collect();
            Value::Object(content).to_string()
        }
        other => other.to_string(),
    }
}

/// A row as the delta lists it: marks renumber with every capture, so none is offered for the model to quote.
fn delta_row(row: &Value) -> Value {
    match row {
        Value::Object(fields) => Value::Object(fields.iter().filter(|(key, _)| *key != "mark").map(|(key, value)| (key.clone(), value.clone())).collect()),
        other => other.clone(),
    }
}

fn related_key(ids: &[String]) -> String {
    let mut sorted: Vec<&str> = ids.iter().map(String::as_str).collect::<HashSet<_>>().into_iter().collect();
    sorted.sort_unstable_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    sorted.join("\0")
}

/// Alignment keys for one side. Rows that render identically to another row of either list cannot be told apart (which twin
/// was removed?), so they get a key nothing else shares and are reported as removed and listed again.
fn pairable_keys(own: &[&str], other: &[&str], side: &str) -> Vec<String> {
    fn count<'a>(list: &[&'a str]) -> HashMap<&'a str, usize> {
        let mut counts = HashMap::new();
        for fingerprint in list {
            *counts.entry(*fingerprint).or_insert(0) += 1;
        }
        counts
    }
    let own_counts = count(own);
    let other_counts = count(other);
    own.iter()
        .enumerate()
        .map(|(index, fingerprint)| {
            if own_counts.get(fingerprint) == Some(&1) && other_counts.get(fingerprint).copied().unwrap_or(0) <= 1 { (*fingerprint).to_string() } else { format!("\0{side}:{index}") }
        })
        .collect()
}

/// Index pairs (before, after) of equal keys, in order on both sides.
fn align_rows(before: &[String], after: &[String]) -> Vec<(usize, usize)> {
    let mut head = 0;
    while head < before.len() && head < after.len() && before[head] == after[head] {
        head += 1;
    }
    let mut before_end = before.len();
    let mut after_end = after.len();
    while before_end > head && after_end > head && before[before_end - 1] == after[after_end - 1] {
        before_end -= 1;
        after_end -= 1;
    }
    let mut pairs: Vec<(usize, usize)> = (0..head).map(|index| (index, index)).collect();
    let rows = before_end - head;
    let columns = after_end - head;
    if rows > 0 && columns > 0 && rows * columns <= MAX_ALIGNMENT_CELLS {
        // lengths[i][j]: the longest common subsequence of the middle sections from i, j on.
        let width = columns + 1;
        let mut lengths = vec![0_u32; (rows + 1) * width];
        for i in (0..rows).rev() {
            for j in (0..columns).rev() {
                lengths[i * width + j] = if before[head + i] == after[head + j] { lengths[(i + 1) * width + j + 1] + 1 } else { lengths[(i + 1) * width + j].max(lengths[i * width + j + 1]) };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < rows && j < columns {
            if before[head + i] == after[head + j] {
                pairs.push((head + i, head + j));
                i += 1;
                j += 1;
            } else if lengths[(i + 1) * width + j] >= lengths[i * width + j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    for offset in 0..before.len() - before_end {
        pairs.push((before_end + offset, after_end + offset));
    }
    pairs
}

/// `/^(.+:e)(\d+)$/`: the prefix through `:e`, the number after it and its digits.
fn split_ref(reference: &str) -> Option<(&str, f64, &str)> {
    let at = reference.rfind(":e")?;
    let (prefix, digits) = (&reference[..at + 2], &reference[at + 2..]);
    let plain = at > 0 && !prefix.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    (plain && !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| (prefix, digits.parse::<f64>().unwrap_or(f64::NAN), digits))
}

/// Pairs "held ref = live ref", folding consecutive refs on both sides into `s1:e0..e4=s9:e0..e4` so a mostly unchanged list
/// stays a few bytes.
fn pair_runs(pairs: &[(&str, &str)]) -> Vec<String> {
    let mut runs = Vec::new();
    let mut index = 0;
    while index < pairs.len() {
        let (held, live) = pairs[index];
        let held_match = split_ref(held);
        let live_match = split_ref(live);
        let mut end = index;
        if let (Some(held_split), Some(live_split)) = (held_match, live_match) {
            while end + 1 < pairs.len() {
                let length = (end + 1 - index) as f64;
                let (Some(next_held), Some(next_live)) = (split_ref(pairs[end + 1].0), split_ref(pairs[end + 1].1)) else { break };
                if next_held.0 != held_split.0 || next_live.0 != live_split.0 || next_held.1 != held_split.1 + length || next_live.1 != live_split.1 + length {
                    break;
                }
                end += 1;
            }
        }
        match (end == index, held_match, live_match) {
            (false, Some(_), Some(_)) => {
                let last_held = split_ref(pairs[end].0).map_or("", |split| split.2);
                let last_live = split_ref(pairs[end].1).map_or("", |split| split.2);
                runs.push(format!("{held}..e{last_held}={live}..e{last_live}"));
            }
            _ => runs.push(format!("{held}={live}")),
        }
        index = end + 1;
    }
    runs
}

fn same_window_lineage(previous: &DeltaState, window_id: &str, opts: &DeltaOptions, generation: f64, now: Instant) -> bool {
    let age = now.checked_duration_since(previous.observed_at);
    previous.window_id == window_id
        && previous.baseline_key == opts.baseline_key
        && previous.related_window_ids == related_key(&opts.related_window_ids)
        && generation > previous.generation
        && previous.consecutive_deltas < MAX_CONSECUTIVE_DELTAS
        && age.is_some_and(|age| age <= MAX_OBSERVED_SCOPE_AGE)
}

/// Anything that cannot be proven a continuation (no baseline, another window or read, a dialog, a generation that did not
/// advance, OCR rows, a delta no smaller) answers none and resets the baseline to this full list.
fn record_observation(store: &mut HashMap<String, DeltaState>, session: &str, window_id: &str, elements: &[Value], generation: Option<f64>, opts: &DeltaOptions, now: Instant) -> Option<Value> {
    let generation = match generation {
        Some(generation) if opts.recordable && !elements.iter().any(|row| row.get("source").and_then(Value::as_str) == Some("ocr")) => generation,
        _ => {
            store.remove(session);
            return None;
        }
    };
    let rows: Vec<(String, String, &Value)> = elements.iter().map(|row| (row.get("ref").map_or_else(|| "undefined".to_string(), js_string), fingerprint_of(row), row)).collect();
    let live_refs: HashSet<&str> = rows.iter().map(|(reference, _, _)| reference.as_str()).collect();
    // A ref the model holds that is also a live one (a worker whose generation restarted) would name another element than the
    // model means.
    let delta = store.get(session).filter(|previous| opts.observation_delta && same_window_lineage(previous, window_id, opts, generation, now) && !previous.held.iter().any(|held| live_refs.contains(held.reference.as_str()))).and_then(|previous| {
        let held_prints: Vec<&str> = previous.held.iter().map(|held| held.fingerprint.as_str()).collect();
        let live_prints: Vec<&str> = rows.iter().map(|(_, fingerprint, _)| fingerprint.as_str()).collect();
        let pairs = align_rows(&pairable_keys(&held_prints, &live_prints, "held"), &pairable_keys(&live_prints, &held_prints, "live"));
        let live_paired: HashSet<usize> = pairs.iter().map(|(_, live)| *live).collect();
        let kept_held: HashSet<usize> = pairs.iter().map(|(held, _)| *held).collect();
        let added: Vec<Value> = rows.iter().enumerate().filter(|(index, _)| !live_paired.contains(index)).map(|(_, (_, _, row))| delta_row(row)).collect();
        let removed: Vec<Value> = previous.held.iter().enumerate().filter(|(index, _)| !kept_held.contains(index)).map(|(_, held)| json!(held.reference)).collect();
        let named: Vec<(&str, &str)> = pairs.iter().map(|(held, live)| (previous.held[*held].reference.as_str(), rows[*live].0.as_str())).collect();
        let mut delta = Map::new();
        delta.insert("unchanged".into(), json!(pair_runs(&named)));
        if !added.is_empty() {
            delta.insert("added".into(), Value::Array(added));
        }
        if !removed.is_empty() {
            delta.insert("removed".into(), Value::Array(removed));
        }
        let delta = Value::Object(delta);
        (json_length(&delta) < json_length(&elements)).then(|| (delta, previous.consecutive_deltas + 1))
    });
    // The model applies a delta reply to its list, so it then holds exactly the live refs published here: the next delta
    // addresses these, not older ones.
    let (delta, consecutive_deltas) = match delta {
        Some((delta, consecutive)) => (Some(delta), consecutive),
        None => (None, 0),
    };
    let held = rows.iter().map(|(reference, fingerprint, _)| HeldRow { reference: reference.clone(), fingerprint: fingerprint.clone() }).collect();
    store.insert(
        session.to_string(),
        DeltaState { window_id: window_id.to_string(), baseline_key: opts.baseline_key.clone(), related_window_ids: related_key(&opts.related_window_ids), generation, observed_at: now, consecutive_deltas, held },
    );
    delta
}

/// `captureBaselineKey`: the read parameters two captures must share before one can stand as the other's baseline, for both the
/// change summary and the observation delta.
pub fn capture_baseline_key(command: &Map<String, Value>, mode: &str, total_element_budget: u64) -> String {
    let field = |name: &str| command.get(name).filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
    json!({
        "mode": mode,
        "query": field("query"),
        "role": field("role"),
        "visible_only": field("visible_only"),
        "include_noninteractive": field("include_noninteractive"),
        "include_structure": field("include_structure"),
        "max_elements": total_element_budget,
        "continuation": field("continuation"),
    })
    .to_string()
}

/// JavaScript truthiness of a row field.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(_) => true,
    }
}

/// `value ?? ''` as template text.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}

/// `captureIdentityMap`: each row's identity (`role|name`, numbered `#n` from its second occurrence) and the signature that
/// says whether it changed (value, state, enabled). OCR rows are not identities. `ref_identities` receives each row's ref.
pub fn capture_identity_map(elements: &[Value], ref_identities: &mut HashMap<String, String>) -> IdentityMap {
    let mut identities = IdentityMap::default();
    let mut occurrences: HashMap<String, usize> = HashMap::new();
    for element in elements {
        if element.get("source").and_then(Value::as_str) == Some("ocr") {
            continue;
        }
        let part = |name: &str| if truthy(element.get(name)) { text_or_empty(element.get(name)) } else { String::new() };
        let base = format!("{}|{}", part("role"), part("name"));
        let occurrence = occurrences.entry(base.clone()).and_modify(|count| *count += 1).or_insert(1);
        let identity = if *occurrence > 1 { format!("{base}#{occurrence}") } else { base };
        let enabled = if element.get("enabled") == Some(&Value::Bool(false)) { "disabled" } else { "enabled" };
        identities.set(identity.clone(), format!("{}\0{}\0{}", text_or_empty(element.get("value")), text_or_empty(element.get("state")), enabled));
        if truthy(element.get("ref")) {
            ref_identities.insert(text_or_empty(element.get("ref")), identity);
        }
    }
    identities
}

/// `summarizeCaptureChanges`.
pub fn summarize_capture_changes(previous: &IdentityMap, current: &IdentityMap) -> Value {
    let (mut added, mut removed, mut updated) = (Vec::new(), Vec::new(), Vec::new());
    let mut unchanged = 0_u64;
    for identity in &current.order {
        match previous.signatures.get(identity) {
            None => added.push(identity.as_str()),
            Some(signature) if *signature != current.signatures[identity] => updated.push(identity.as_str()),
            Some(_) => unchanged += 1,
        }
    }
    for identity in &previous.order {
        if !current.signatures.contains_key(identity) {
            removed.push(identity.as_str());
        }
    }
    let group = |values: &[&str]| {
        let mut group = Map::new();
        group.insert("count".into(), json!(values.len()));
        if !values.is_empty() {
            group.insert("sample".into(), json!(values.iter().take(CAPTURE_CHANGE_SAMPLE).collect::<Vec<_>>()));
        }
        Value::Object(group)
    };
    json!({"baseline": "previous_capture_of_same_window", "added": group(&added), "removed": group(&removed), "updated": group(&updated), "unchanged": unchanged})
}

/// The window's read-only accessible roles and names as one string, or none when unreadable (`layoutFingerprint`): the
/// `elements` array of a `window_predicates` reply.
pub fn layout_fingerprint(elements: Option<&Value>) -> Option<String> {
    let rows = elements?.as_array()?;
    let pairs: Vec<Value> = rows.iter().map(|row| json!([row.get("role").cloned().unwrap_or(Value::Null), row.get("name").cloned().unwrap_or(Value::Null)])).collect();
    Some(Value::Array(pairs).to_string())
}

/// `awaitSettledLayout`: wait, within a bound, until two reads of the launched window agree; true when they did. `read` is one
/// read-only `window_predicates` read (`max_elements` 400, the command's session) answered through [`layout_fingerprint`] (none when it failed); `check_running` fails the
/// wait when the command was cancelled. The reads never touch the session's refs, so the capture that follows is the only
/// observation the caller receives.
pub async fn launch_layout_reread<E, R, Fut>(mut read: R, mut check_running: impl FnMut() -> Result<(), E>) -> Result<bool, E>
where
    R: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    let deadline = Instant::now() + LAUNCH_LAYOUT_BUDGET;
    let mut previous = read().await;
    while previous.is_some() && Instant::now() < deadline {
        sleep(LAUNCH_LAYOUT_POLL).await;
        check_running()?;
        let next = read().await;
        if next.is_none() || next == previous {
            return Ok(next.is_some());
        }
        previous = next;
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    const WORDS: [&str; 12] = ["File", "Edit", "View", "Save", "Open", "Close", "Search", "Settings", "Help", "Refresh", "Share", "Copy"];
    const ROLES: [&str; 6] = ["Button", "MenuItem", "ListItem", "CheckBox", "Hyperlink", "TabItem"];

    #[derive(Clone)]
    struct Row {
        role: String,
        name: String,
        y: i64,
        value: String,
        state: String,
    }

    fn row(role: &str, name: &str, y: i64) -> Row {
        Row { role: role.into(), name: name.into(), y, value: String::new(), state: String::new() }
    }

    fn tree_rows(count: usize) -> Vec<Row> {
        (0..count).map(|index| row(ROLES[index % 6], &format!("{} {}", WORDS[index % 12], index / 12 + 1), 20 * index as i64)).collect()
    }

    fn twin(y: i64) -> Row {
        row("ListItem", "Untitled", y)
    }

    fn snapshot(generation: u64, rows: &[Row]) -> Map<String, Value> {
        let elements: Vec<Value> = rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                json!({"mark": index + 1, "ref": format!("s{generation}:e{index}"), "source": "uia", "role": row.role, "name": row.name, "value": row.value, "state": row.state,
                    "enabled": true, "x": 10, "y": row.y, "width": 120, "height": 18, "center_x": 70, "center_y": row.y + 9, "actions": ["click", "invoke"]})
            })
            .collect();
        match json!({"window_id": "hwnd:0x1", "generation": generation, "total_elements": rows.len(), "elements": elements}) {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    fn options() -> DeltaOptions {
        DeltaOptions { observation_delta: true, recordable: true, baseline_key: "k".into(), related_window_ids: vec!["hwnd:0x1".into()] }
    }

    /// The world a fixture's actions observe: every observation advances the generation by two (an action retires the refs once
    /// and the observation's snapshot again).
    struct World {
        store: DeltaStore,
        generation: u64,
        advance: u64,
        window: String,
        rows: Vec<Row>,
    }

    impl World {
        fn new(rows: Vec<Row>) -> Self {
            Self { store: DeltaStore::new(), generation: 0, advance: 2, window: "hwnd:0x1".into(), rows }
        }

        fn after(&mut self) -> DeltaOutcome {
            self.after_with(&options())
        }

        fn after_with(&mut self, options: &DeltaOptions) -> DeltaOutcome {
            self.generation += self.advance;
            self.store.observe("a", &self.window, &snapshot(self.generation, &self.rows), None, options)
        }

        fn refs(&self) -> Vec<String> {
            (0..self.rows.len()).map(|index| format!("s{}:e{index}", self.generation)).collect()
        }

        fn live(&self, index: usize) -> String {
            format!("s{}:e{index}", self.generation)
        }
    }

    /// `s2:e7..e29=s4:e6..e28` runs to held ref -> live ref.
    fn expand_runs(runs: &Value) -> HashMap<String, String> {
        fn range(text: &str) -> Vec<String> {
            let (prefix, digits) = text.rsplit_once(":e").unwrap_or_else(|| panic!("{text}"));
            let (from, to) = match digits.split_once("..e") {
                Some((from, to)) => (from.parse::<usize>().unwrap(), to.parse::<usize>().unwrap()),
                None => (digits.parse().unwrap(), digits.parse().unwrap()),
            };
            (from..=to).map(|number| format!("{prefix}:e{number}")).collect()
        }
        let mut pairs = HashMap::new();
        for run in runs.as_array().unwrap() {
            let (held, live) = run.as_str().unwrap().split_once('=').unwrap();
            let (held, live) = (range(held), range(live));
            assert_eq!(held.len(), live.len());
            pairs.extend(held.into_iter().zip(live));
        }
        pairs
    }

    fn strings(value: &Value) -> Vec<String> {
        value.as_array().map_or_else(Vec::new, |rows| rows.iter().map(|row| row.as_str().unwrap().to_string()).collect())
    }

    /// Every ref the model holds is accounted for exactly once: paired or removed.
    fn accounts_for_every_ref(delta: &Value, held: &[String]) -> HashMap<String, String> {
        let paired = expand_runs(&delta["unchanged"]);
        let removed = strings(&delta["removed"]);
        for reference in held {
            assert_eq!(usize::from(paired.contains_key(reference)) + usize::from(removed.contains(reference)), 1, "{reference}");
        }
        assert_eq!(paired.len() + removed.len(), held.len());
        paired
    }

    #[test]
    fn an_unchanged_window_answers_unchanged_with_the_live_ref_of_every_row() {
        let mut world = World::new(tree_rows(40));
        let first = world.after();
        assert_eq!((first.delta, first.baseline_reset), (None, true));
        let held = world.refs();
        let second = world.after();
        assert!(!second.baseline_reset);
        assert_eq!(second.delta, Some(json!({"unchanged": ["s2:e0..e39=s4:e0..e39"]})));
        accounts_for_every_ref(&second.delta.unwrap(), &held);
    }

    #[test]
    fn an_add_a_removal_and_an_update_produce_exactly_that_delta() {
        let mut world = World::new(tree_rows(30));
        world.after();
        let held = world.refs();
        let rows = tree_rows(30);
        let updated = Row { value: "on".into(), ..rows[5].clone() };
        world.rows = [rows[..5].to_vec(), vec![updated], rows[7..].to_vec(), vec![row("Button", "Brand new", 900)]].concat();
        let delta = world.after().delta.unwrap();
        assert_eq!(delta["unchanged"], json!(["s2:e0..e4=s4:e0..e4", "s2:e7..e29=s4:e6..e28"]));
        assert_eq!(delta["removed"], json!([held[5], held[6]]), "an updated row is its old ref removed and its new row listed");
        let added: Vec<(&str, &str, &str, Option<&Value>)> = delta["added"].as_array().unwrap().iter().map(|row| (row["name"].as_str().unwrap(), row["value"].as_str().unwrap(), row["ref"].as_str().unwrap(), row.get("mark"))).collect();
        assert_eq!(added, vec![(rows[5].name.as_str(), "on", "s4:e5", None), ("Brand new", "", "s4:e29", None)]);
        accounts_for_every_ref(&delta, &held);
    }

    #[test]
    fn removing_one_of_two_identical_rows_never_pairs_a_held_ref_with_a_sibling() {
        let mut world = World::new([tree_rows(10), vec![twin(300), twin(300)]].concat());
        world.after();
        let held = world.refs();
        world.rows = [tree_rows(10), vec![twin(300)]].concat();
        let delta = world.after().delta.unwrap();
        let paired = accounts_for_every_ref(&delta, &held);
        assert!(!paired.contains_key(&held[10]), "the removed twin is not paired");
        assert!(!paired.contains_key(&held[11]), "and neither is the survivor, which cannot be told from it");
        assert_eq!(delta["removed"], json!([held[10], held[11]]));
        assert_eq!(delta["added"].as_array().unwrap().len(), 1);
        assert_eq!(delta["added"][0]["ref"], json!(world.live(10)));
    }

    #[test]
    fn a_lookalike_replacement_is_a_row_with_a_new_ref_never_the_destroyed_element() {
        let mut world = World::new([tree_rows(10), vec![row("Button", "Delete", 300)]].concat());
        world.after();
        let original = world.refs()[10].clone();
        world.rows = [tree_rows(10), vec![row("Button", "Delete", 300)]].concat();
        let delta = world.after().delta.unwrap();
        let live = world.live(10);
        assert_ne!(original, live);
        assert_eq!(expand_runs(&delta["unchanged"]).get(&original), Some(&live));
        assert!(original.starts_with("s2:"), "the original ref belongs to a retired generation");
    }

    #[test]
    fn reordered_rows_are_paired_by_what_they_render_never_by_position() {
        let mut world = World::new([tree_rows(10), vec![twin(300), twin(320)]].concat());
        world.after();
        let held = world.refs();
        world.rows = [tree_rows(10), vec![twin(320), twin(300)]].concat();
        let delta = world.after().delta.unwrap();
        let paired = accounts_for_every_ref(&delta, &held);
        if let Some(live) = paired.get(&held[10]) {
            assert_eq!(*live, world.live(11));
        }
        if let Some(live) = paired.get(&held[11]) {
            assert_eq!(*live, world.live(10));
        }
        assert_eq!(delta["removed"].as_array().unwrap().len(), 1, "only one of the two can keep its place in the list");
        assert_eq!(delta["added"].as_array().unwrap().len(), 1);

        // Reordered twins that render identically cannot be told apart at all.
        let mut same = World::new([tree_rows(10), vec![twin(300), twin(300)]].concat());
        same.after();
        let held = same.refs();
        same.rows = [tree_rows(10), vec![twin(300), twin(300), row("Button", "More", 700)]].concat();
        let delta = same.after().delta.unwrap();
        assert_eq!(accounts_for_every_ref(&delta, &held).len(), 10);
        assert_eq!(delta["removed"], json!([held[10], held[11]]));
    }

    #[test]
    fn a_twin_whose_sibling_changed_is_still_not_paired_with_it() {
        let mut world = World::new([tree_rows(10), vec![twin(300), twin(300)]].concat());
        world.after();
        let held = world.refs();
        world.rows = [tree_rows(10), vec![twin(300), Row { value: "edited".into(), ..twin(300) }]].concat();
        let delta = world.after().delta.unwrap();
        let paired = accounts_for_every_ref(&delta, &held);
        assert!(!paired.contains_key(&held[10]) && !paired.contains_key(&held[11]));
        assert_eq!(delta["added"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn the_observation_is_the_full_list_for_a_new_window_a_stalled_generation_or_a_different_read() {
        let mut world = World::new(tree_rows(25));
        assert!(world.after().delta.is_none(), "no baseline");
        assert!(world.after().delta.is_some());

        // The model asked for the full list: an explicit capture is never a delta, and is a baseline.
        let explicit = world.after_with(&DeltaOptions { observation_delta: false, ..options() });
        assert_eq!((explicit.delta, explicit.baseline_reset), (None, true));
        assert!(world.after().delta.is_some(), "an explicit capture is a baseline");

        world.window = "hwnd:0x2".into();
        assert!(world.after().delta.is_none(), "another window");
        assert!(world.after().delta.is_some());

        world.advance = 0; // the worker restarted: the generation did not advance
        assert!(world.after().delta.is_none(), "generation lineage broken");
        world.advance = 2;
        assert!(world.after().delta.is_some());

        // A different read of the window is never compared with the baseline.
        let other = DeltaOptions { baseline_key: "other".into(), ..options() };
        assert!(world.after_with(&other).delta.is_none());
    }

    #[test]
    fn a_delta_that_would_be_larger_than_the_list_falls_back_to_the_list() {
        let mut world = World::new(tree_rows(4));
        world.after();
        world.rows = tree_rows(4).into_iter().map(|row| Row { name: format!("Renamed {}", row.name), ..row }).collect();
        assert!(world.after().delta.is_none());
    }

    #[test]
    fn a_long_run_of_deltas_returns_to_the_full_list() {
        let mut world = World::new(tree_rows(20));
        world.after();
        for index in 0..8 {
            assert!(world.after().delta.is_some(), "delta {}", index + 1);
        }
        assert!(world.after().delta.is_none());
        assert!(world.after().delta.is_some());
    }

    #[test]
    fn each_delta_addresses_the_refs_the_previous_reply_published_and_rebuilds_the_full_list() {
        fn describe(row: &Value) -> String {
            format!("{}|{}|{}", row["role"].as_str().unwrap(), row["name"].as_str().unwrap(), row["y"])
        }
        let mut world = World::new(tree_rows(30));
        world.after();
        let mut model: HashMap<String, String> = snapshot(world.generation, &world.rows)["elements"].as_array().unwrap().iter().map(|row| (row["ref"].as_str().unwrap().to_string(), describe(row))).collect();
        let rows = tree_rows(30);
        let steps = [
            [rows[..12].to_vec(), rows[14..].to_vec(), vec![row("Button", "Late", 900)]].concat(),
            [rows[..12].to_vec(), rows[14..25].to_vec(), vec![row("Button", "Late", 900)]].concat(),
            [vec![row("Button", "First", 5)], rows[..12].to_vec(), rows[14..25].to_vec()].concat(),
        ];
        let mut published = Vec::new();
        for step in steps {
            world.rows = step;
            let delta = world.after().delta.expect("a delta, not the full list");
            published.push(model.keys().cloned().collect::<Vec<_>>());
            let mut next = HashMap::new();
            for (held, live) in expand_runs(&delta["unchanged"]) {
                next.insert(live, model.get(&held).unwrap_or_else(|| panic!("{held} is a ref the previous reply published")).clone());
            }
            for reference in strings(&delta["removed"]) {
                assert!(model.contains_key(&reference));
            }
            for added in delta["added"].as_array().into_iter().flatten() {
                next.insert(added["ref"].as_str().unwrap().to_string(), describe(added));
            }
            let expected: HashMap<String, String> = world.rows.iter().zip(world.refs()).map(|(row, reference)| (reference, format!("{}|{}|{}", row.role, row.name, row.y))).collect();
            assert_eq!(next, expected, "the rebuilt list is the full list");
            model = next;
        }
        let prefix = format!("s{}:", world.generation - 2);
        assert!(published[2].iter().all(|reference| reference.starts_with(&prefix)));
    }

    fn rows_of(refs: &[&str], extra: Option<(&str, &str)>) -> Map<String, Value> {
        let elements: Vec<Value> = refs
            .iter()
            .enumerate()
            .map(|(index, reference)| {
                let mut value = json!({"mark": 1, "ref": reference, "role": "Button", "name": if index == 1 { "Cancel" } else { "OK" }});
                if let Some((key, text)) = extra {
                    value[key] = json!(text);
                }
                value
            })
            .collect();
        match json!({"elements": elements}) {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    fn with_generation(mut map: Map<String, Value>, generation: Option<u64>) -> Map<String, Value> {
        if let Some(generation) = generation {
            map.insert("generation".into(), json!(generation));
        }
        map
    }

    #[test]
    fn ocr_rows_failed_reads_and_unsettled_captures_never_form_a_baseline() {
        let store = DeltaStore::new();
        let held = |store: &DeltaStore| store.inner().deltas.contains_key("a");
        let observe = |snapshot: Map<String, Value>, opts: &DeltaOptions| store.observe("a", "w", &snapshot, None, opts).delta;
        let opts = DeltaOptions { observation_delta: true, recordable: true, baseline_key: "k".into(), related_window_ids: vec!["w".into()] };
        assert_eq!(observe(with_generation(rows_of(&["s1:e0"], None), Some(1)), &opts), None);
        assert!(held(&store));
        assert_eq!(observe(with_generation(rows_of(&["ocr:1:2"], Some(("source", "ocr"))), Some(3)), &opts), None);
        assert!(!held(&store));
        observe(with_generation(rows_of(&["s5:e0"], None), Some(5)), &opts);
        observe(with_generation(rows_of(&["s7:e0"], None), Some(7)), &DeltaOptions { recordable: false, ..opts.clone() });
        assert!(!held(&store));
        observe(with_generation(rows_of(&["s5:e0"], None), Some(5)), &opts);
        observe(with_generation(rows_of(&["s7:e0"], None), None), &opts);
        assert!(!held(&store), "a generation that is not a number");
        // A ref the model holds that is also live in the new snapshot would name another element.
        observe(with_generation(rows_of(&["s1:e0", "s1:e1"], None), Some(1)), &opts);
        assert_eq!(observe(with_generation(rows_of(&["s1:e1", "s1:e0"], None), Some(2)), &opts), None);
    }

    #[test]
    fn a_dialog_owned_by_the_window_forces_the_full_list() {
        let mut world = World::new(tree_rows(20));
        world.after();
        let dialog = DeltaOptions { related_window_ids: vec!["hwnd:0x1".into(), "hwnd:0x9".into()], ..options() };
        assert!(world.after_with(&dialog).delta.is_none());
        assert!(world.after_with(&dialog).delta.is_some(), "the same set of windows is a continuation again");
    }

    #[test]
    fn a_baseline_older_than_the_observed_scope_age_is_not_a_continuation() {
        let store = DeltaStore::new();
        let start = Instant::now();
        let rows = tree_rows(20);
        let at = |generation: u64, now: Instant| store.observe_at("a", "hwnd:0x1", &snapshot(generation, &rows), None, &options(), now);
        at(2, start);
        assert!(at(4, start + Duration::from_secs(299)).delta.is_some());
        assert!(at(6, start + Duration::from_secs(600)).delta.is_none());
    }

    #[test]
    fn a_released_session_drops_its_list_baseline_and_frames() {
        let store = DeltaStore::new();
        let rows = tree_rows(20);
        store.record_baseline("a", "w", "k", &[]);
        store.observe("a", "hwnd:0x1", &snapshot(2, &rows), Some("d"), &options());
        store.observe("b", "hwnd:0x1", &snapshot(2, &rows), Some("d"), &options());
        {
            let inner = store.inner();
            assert_eq!((inner.deltas.len(), inner.baselines.len(), inner.images.len()), (2, 1, 2));
        }
        store.forget_session("a");
        let inner = store.inner();
        assert_eq!((inner.deltas.keys().collect::<Vec<_>>(), inner.baselines.len(), inner.images.len()), (vec![&"b".to_string()], 0, 1));
    }

    #[test]
    fn only_an_identical_frame_for_the_same_target_counts_as_a_repeat() {
        let store = DeltaStore::new();
        let frame = |session: &str, window: &str, data: &str| store.observe(session, window, &Map::new(), Some(&image_digest(data.as_bytes())), &DeltaOptions::default()).suppress_image;
        assert!(!frame("s1", "hwnd:0x1", "AAAA"));
        assert!(frame("s1", "hwnd:0x1", "AAAA"));
        assert!(!frame("s1", "hwnd:0x1", "BBBB"));
        assert!(!frame("s1", "hwnd:0x2", "BBBB"));
        assert!(!frame("s2", "hwnd:0x1", "BBBB"), "a different conversation still needs its image");
        store.forget_image("s1", "hwnd:0x1");
        assert!(!frame("s1", "hwnd:0x1", "BBBB"));
        assert!(!store.observe("s1", "hwnd:0x1", &Map::new(), None, &DeltaOptions::default()).suppress_image);
        assert!(!store.observe("s1", "hwnd:0x1", &Map::new(), Some(""), &DeltaOptions::default()).suppress_image);
    }

    #[test]
    fn the_frame_store_keeps_the_newest_sixty_four_targets() {
        let store = DeltaStore::new();
        for index in 0..65 {
            store.observe("s", &format!("w{index}"), &Map::new(), Some("d"), &DeltaOptions::default());
        }
        assert_eq!(store.inner().images.len(), 64);
        assert!(!store.observe("s", "w0", &Map::new(), Some("d"), &DeltaOptions::default()).suppress_image, "the oldest was evicted");
        assert!(store.observe("s", "w64", &Map::new(), Some("d"), &DeltaOptions::default()).suppress_image);
    }

    #[test]
    fn the_digest_is_the_hex_sha256() {
        assert_eq!(image_digest(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    fn elements(rows: &[(&str, &str, &str)]) -> Vec<Value> {
        rows.iter().enumerate().map(|(index, (role, name, value))| json!({"ref": format!("s1:e{index}"), "role": role, "name": name, "value": value})).collect()
    }

    #[test]
    fn the_change_summary_compares_only_a_capture_of_the_same_window_and_read() {
        let store = DeltaStore::new();
        let before = elements(&[("Button", "OK", ""), ("Button", "OK", ""), ("Edit", "Name", "a"), ("Button", "Gone", "")]);
        assert_eq!(store.record_baseline("a", "w", "k", &before), None);
        let after = elements(&[("Button", "OK", ""), ("Button", "OK", ""), ("Edit", "Name", "b"), ("Button", "New", ""), ("", "", "")]);
        let changes = store.record_baseline("a", "w", "k", &after).unwrap();
        assert_eq!(
            changes,
            json!({"baseline": "previous_capture_of_same_window", "added": {"count": 2, "sample": ["Button|New", "|"]}, "removed": {"count": 1, "sample": ["Button|Gone"]},
                "updated": {"count": 1, "sample": ["Edit|Name"]}, "unchanged": 2})
        );
        assert_eq!(store.record_baseline("a", "other", "k", &after), None, "another window");
        assert_eq!(store.record_baseline("a", "other", "k2", &after), None, "another read");
        assert_eq!(store.record_baseline("a", "", "k2", &after), None, "a baseline without a window is never compared");
        assert_eq!(store.ref_identity("a", "s1:e1"), Some("Button|OK#2".into()), "the last capture names what a ref targets");
        assert_eq!(store.ref_identity("a", "s1:e9"), None);
        assert_eq!(store.ref_identity("b", "s1:e1"), None);
    }

    #[test]
    fn identities_number_repeats_skip_ocr_rows_and_sign_the_changeable_fields() {
        let mut refs = HashMap::new();
        let rows = vec![
            json!({"ref": "s1:e0", "role": "Button", "name": "OK", "value": 3, "enabled": false}),
            json!({"ref": "s1:e1", "role": "Button", "name": "OK", "state": "checked"}),
            json!({"ref": "ocr:1", "source": "ocr", "role": "Text", "name": "x"}),
        ];
        let map = capture_identity_map(&rows, &mut refs);
        assert_eq!(map.order, ["Button|OK", "Button|OK#2"]);
        assert_eq!(map.signatures["Button|OK"], "3\0\0disabled");
        assert_eq!(map.signatures["Button|OK#2"], "\0checked\0enabled");
        assert_eq!(refs, HashMap::from([("s1:e0".to_string(), "Button|OK".to_string()), ("s1:e1".to_string(), "Button|OK#2".to_string())]));
    }

    #[test]
    fn nine_changes_name_eight_and_count_all() {
        let names: Vec<String> = (0..9).map(|index| format!("n{index}")).collect();
        let rows: Vec<(&str, &str, &str)> = names.iter().map(|name| ("Button", name.as_str(), "")).collect();
        let changes = summarize_capture_changes(&IdentityMap::default(), &capture_identity_map(&elements(&rows), &mut HashMap::new()));
        assert_eq!(changes["added"]["count"], json!(9));
        assert_eq!(changes["added"]["sample"].as_array().unwrap().len(), 8);
        assert_eq!(changes["removed"], json!({"count": 0}));
    }

    #[test]
    fn the_baseline_key_names_every_read_parameter() {
        let command = match json!({"query": "q", "visible_only": true, "continuation": {"after": 3}, "role": null}) {
            Value::Object(map) => map,
            _ => unreachable!(),
        };
        assert_eq!(
            capture_baseline_key(&command, "ax", 80),
            r#"{"mode":"ax","query":"q","role":null,"visible_only":true,"include_noninteractive":null,"include_structure":null,"max_elements":80,"continuation":{"after":3}}"#
        );
    }

    #[test]
    fn runs_fold_only_consecutive_refs_on_both_sides() {
        let pairs = [("s1:e0", "s9:e0"), ("s1:e1", "s9:e1"), ("s1:e2", "s9:e5"), ("s1:e3", "s9:e6"), ("other", "s9:e7"), ("s1:e9", "s9:e8")];
        assert_eq!(pair_runs(&pairs), ["s1:e0..e1=s9:e0..e1", "s1:e2..e3=s9:e5..e6", "other=s9:e7", "s1:e9=s9:e8"]);
    }

    #[test]
    fn a_layout_fingerprint_is_the_roles_and_names_or_none() {
        assert_eq!(layout_fingerprint(Some(&json!([{"role": "Button", "name": "File"}, {"name": "x"}]))), Some(r#"[["Button","File"],[null,"x"]]"#.into()));
        assert_eq!(layout_fingerprint(None), None);
        assert_eq!(layout_fingerprint(Some(&json!("no"))), None);
    }

    async fn reread(layouts: Vec<Option<&str>>, reads: &AtomicUsize) -> Result<bool, ()> {
        let layouts: Vec<Option<String>> = layouts.into_iter().map(|layout| layout.map(str::to_string)).collect();
        launch_layout_reread(
            || {
                let index = reads.fetch_add(1, Ordering::SeqCst);
                let answer = layouts.get(index).or(layouts.last()).cloned().flatten();
                async move { answer }
            },
            || Ok(()),
        )
        .await
    }

    #[tokio::test(start_paused = true)]
    async fn a_launch_capture_waits_until_two_reads_of_the_new_window_agree() {
        let reads = AtomicUsize::new(0);
        // The partial first layout differs from the second, which the third repeats.
        assert_eq!(reread(vec![Some("one"), Some("two"), Some("two")], &reads).await, Ok(true));
        assert_eq!(reads.load(Ordering::SeqCst), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unreadable_window_or_a_layout_that_never_settles_ends_the_wait() {
        let reads = AtomicUsize::new(0);
        assert_eq!(reread(vec![None], &reads).await, Ok(false));
        assert_eq!(reads.load(Ordering::SeqCst), 1);

        let reads = AtomicUsize::new(0);
        assert_eq!(reread(vec![Some("a"), None], &reads).await, Ok(false));
        assert_eq!(reads.load(Ordering::SeqCst), 2);

        let moving = AtomicUsize::new(0);
        let answer = launch_layout_reread(
            || {
                let index = moving.fetch_add(1, Ordering::SeqCst);
                async move { Some(index.to_string()) }
            },
            || Ok::<(), ()>(()),
        )
        .await;
        assert_eq!(answer, Ok(false));
        assert_eq!(moving.load(Ordering::SeqCst), 11, "ten polls inside the two second budget, after the first read");
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancelled_command_ends_the_wait_with_its_error() {
        let answer = launch_layout_reread(|| async { Some("a".to_string()) }, || Err("cancelled")).await;
        assert_eq!(answer, Err("cancelled"));
    }
}
