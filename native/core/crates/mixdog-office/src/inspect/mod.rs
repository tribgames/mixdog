//! The inspection actions of the office engine: `issues`, `validate`, `get` and `query` (`core/office-actions-inspect.mjs`
//! and `core/office-actions-read.mjs`).
//!
//! - [`issues`]: the findings list of a session, per backend, merged with the format review and normalised.
//! - [`validate`]: whether the document is sound: the package, the OOXML schema, the assertions, the LibreOffice reopen and
//!   the Office host's own verdict.
//! - [`read`]: one element by its document path, a text query, and the PDF queries (layout, tables, images) with their
//!   written files.
//!
//! Everything runs on the lane thread that owns the lane proof of the [`InspectContext`]; only the Office host's answers are
//! awaited, and the future is not `Send` (the text measurer holds a cache cell).

pub mod issues;
pub mod read;
pub mod validate;

use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::pin::pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::Poll;

use mixdog_fsio::WriteLane;
use mixdog_js::{json_number, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_ooxml::ooxml_validator::Environment;
use mixdog_ooxml::soffice::Soffice;
use mixdog_rt::{CancellationToken, InLane};
use serde_json::{Map, Value};

use crate::session::registry::lock;
use crate::session::{Backend, Mode, SessionHandle};
use crate::snapshot::{ComHost, SnapshotContext, snapshot};

pub use issues::issues;
pub use read::{csv_cell, get_office_element, query_office_document};
pub use validate::validate;

/// How many sessions' review reads are kept at once: Node keeps a session's read as long as the session lives (a weak map);
/// here the oldest read is dropped when this many are held.
const REVIEW_SNAPSHOT_SESSIONS: usize = 16;

/// What an inspection runs with: the snapshot context (the lane proof, the text measurer, the form vocabulary and the Office
/// host), the LibreOffice driver, the environment the schema validator is looked up in, the review reads kept per session and
/// the call's abort flag.
pub struct InspectContext<'a, L: WriteLane, H> {
    pub snapshot: SnapshotContext<'a, InLane<L>, H>,
    pub soffice: &'a Soffice,
    pub validator: &'a Environment,
    pub reviews: &'a ReviewSnapshots,
    /// Raised by the caller when the session's active signal is cancelled (the blocking engines, the schema validator and
    /// LibreOffice, read a flag); `None` when nothing can cancel the call.
    pub abort: Option<Arc<AtomicBool>>,
}

impl<L: WriteLane, H> InspectContext<'_, L, H> {
    pub(crate) fn lane(&self) -> &InLane<L> {
        self.snapshot.proof
    }

    pub(crate) fn flag(&self) -> Option<&AtomicBool> {
        self.abort.as_deref()
    }

    /// The question a PDF reader asks between pages: whether the call was cancelled, by the flag or by the session's signal.
    pub(crate) fn check(&self, facts: &Facts) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let (flag, signal) = (self.abort.clone(), facts.signal.clone());
        Arc::new(move || flag.as_ref().is_some_and(|flag| flag.load(Ordering::SeqCst)) || signal.as_ref().is_some_and(CancellationToken::is_cancelled))
    }
}

/// `reviewSnapshots`: the document read once per document version for every review that needs the whole document (`issues` and
/// `qa` both ask for it, and reading it twice per call costs the caller seconds on a large workbook).
#[derive(Default)]
pub struct ReviewSnapshots {
    held: Mutex<Vec<(String, u64, Value)>>,
}

impl ReviewSnapshots {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, id: &str, version: u64) -> Option<Value> {
        let held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        held.iter().find(|(held_id, held_version, _)| held_id == id && *held_version == version).map(|(_, _, read)| read.clone())
    }

    fn put(&self, id: &str, version: u64, read: Value) {
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        held.retain(|(held_id, _, _)| held_id != id);
        if held.len() >= REVIEW_SNAPSHOT_SESSIONS {
            held.remove(0);
        }
        held.push((id.to_owned(), version, read));
    }

    /// The session is closed: its read is not kept.
    pub fn forget(&self, id: &str) {
        self.held.lock().unwrap_or_else(PoisonError::into_inner).retain(|(held_id, _, _)| held_id != id);
    }
}

/// The facts of a session an inspection reads, taken once under the session's lock (the lock is never held across the host's
/// answer).
pub(crate) struct Facts {
    pub id: String,
    pub format: String,
    pub backend: Backend,
    pub mode: Mode,
    pub target: String,
    pub source: String,
    pub data_dir: PathBuf,
    pub print_sheet: bool,
    pub signal: Option<CancellationToken>,
}

impl Facts {
    pub fn of(handle: &SessionHandle) -> Self {
        let session = lock(handle);
        Self {
            id: session.id.clone(),
            format: session.format.clone(),
            backend: session.backend,
            mode: session.mode,
            target: session.target.clone(),
            source: session.source.clone(),
            data_dir: session.data_dir.clone(),
            print_sheet: session.authored.print_sheet,
            signal: session.active_signal.clone(),
        }
    }

    pub fn is_microsoft_office(&self) -> bool {
        self.backend == Backend::MicrosoftOfficeCom
    }
}

/// `String(args[key] || '')` for the string options of a call.
pub(crate) fn text_arg(args: &Value, key: &str) -> String {
    match args.get(key) {
        Some(value) if truthy(value) => value_to_string(value),
        _ => String::new(),
    }
}

/// The text of a host's failure: its `error` when it has one.
pub(crate) fn failure_text(answer: &Value, fallback: &str) -> String {
    match answer.get("error") {
        Some(error) if truthy(error) => value_to_string(error),
        _ => fallback.to_owned(),
    }
}

/// `x || fallback` over a number.
pub(crate) fn or_number(value: f64, fallback: f64) -> f64 {
    if value.is_nan() || value == 0.0 { fallback } else { value }
}

/// A count asked for by a call (`args.limit || fallback`) as a count of items: a fraction rounds up (`count >= 2.5` holds from
/// three items), a negative count is none.
pub(crate) fn count_arg(args: &Value, key: &str, fallback: f64) -> usize {
    or_number(to_number_of(args.get(key)), fallback).ceil().max(0.0) as usize
}

/// `${code}\0${path}`: a finding is the same finding wherever its code and path agree.
pub(crate) fn finding_key(entry: &Value) -> String {
    let template = |key: &str| entry.get(key).map_or_else(|| "undefined".to_owned(), value_to_string);
    format!("{}\0{}", template("code"), template("path"))
}

/// The findings a result already holds.
pub(crate) fn known_findings(result: &Value) -> HashSet<String> {
    list_of(result.get("issues")).iter().map(finding_key).collect()
}

/// The entries of an array field; none for anything else.
pub(crate) fn list_of(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// `{ ...result, ...fields }`: the fields set on a copy of the result, an existing key keeping its place.
pub(crate) fn with_fields(result: &Value, fields: Vec<(&str, Value)>) -> Value {
    let mut map = match result {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    for (key, value) in fields {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

/// `...value` into a map: every own field of an object.
pub(crate) fn spread(into: &mut Map<String, Value>, value: &Value) {
    if let Value::Object(map) = value {
        for (key, field) in map {
            into.insert(key.clone(), field.clone());
        }
    }
}

/// Two futures run together on this thread, each polled in turn: the first one's request reaches the host before the second's,
/// and what one computes while the other waits on the host overlaps it.
pub(crate) async fn both<A: Future, B: Future>(first: A, second: B) -> (A::Output, B::Output) {
    let (mut first, mut second) = (pin!(first), pin!(second));
    let (mut left, mut right) = (None, None);
    std::future::poll_fn(|cx| {
        if left.is_none()
            && let Poll::Ready(done) = first.as_mut().poll(cx)
        {
            left = Some(done);
        }
        if right.is_none()
            && let Poll::Ready(done) = second.as_mut().poll(cx)
        {
            right = Some(done);
        }
        if left.is_some() && right.is_some() { Poll::Ready(()) } else { Poll::Pending }
    })
    .await;
    (left.expect("the first future finished"), right.expect("the second future finished"))
}

/// `reviewSnapshot(session, args)`: the whole document with its styles, at most 100 items a page, once per document version.
pub async fn review_snapshot<L: WriteLane, H: ComHost>(cx: &InspectContext<'_, L, H>, handle: &SessionHandle, args: &Value) -> Result<Value, String> {
    let (id, version) = {
        let session = lock(handle);
        (session.id.clone(), session.snapshot_version)
    };
    if let Some(read) = cx.reviews.get(&id, version) {
        return Ok(read);
    }
    let mut request = match args {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    request.insert("includeStyles".to_owned(), Value::Bool(true));
    request.insert("limit".to_owned(), json_number(or_number(to_number_of(args.get("limit")), 100.0).min(100.0)));
    request.insert("maxChars".to_owned(), Value::from(100_000));
    let read = snapshot(&cx.snapshot, handle, &Value::Object(request), true).await?;
    cx.reviews.put(&id, version, read.clone());
    Ok(read)
}
