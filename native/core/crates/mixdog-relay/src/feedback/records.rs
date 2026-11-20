//! The durable feedback records: one file `<DATA_DIR>/feedback/<uuid>.json` per submission, written compact (feedback.mjs
//! persists `JSON.stringify(record)`, no indent) by a temp file that is flushed and renamed, and read back by the strict
//! loader of `validRecord`. A record Node wrote loads, hashes and is mailed as Node would.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use mixdog_fsio::{DirBuilder, OpenOptions};
use mixdog_js::JsRegex;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::attachments::{self, Attachment};
use crate::js;

pub const KINDS: [&str; 3] = ["bug", "suggestion", "other"];

/// What a record holds until its mail is accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payload {
    pub kind: String,
    pub message: String,
    pub reply_to: String,
    /// `None`: a record without an `attachments` key (one written before attachments existed, or without any).
    pub attachments: Option<Vec<Attachment>>,
}

/// `{id, hash, payload, createdAt, attempts, nextAttemptAt, sentAt}`; a sent record has no payload.
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub id: String,
    pub hash: String,
    pub payload: Option<Payload>,
    pub created_at: f64,
    pub attempts: f64,
    pub next_attempt_at: f64,
    /// 0 until the mail is accepted.
    pub sent_at: f64,
}

impl Record {
    pub fn is_sent(&self) -> bool {
        self.sent_at != 0.0
    }

    /// Raw bytes of the attachments an undelivered record holds.
    pub fn pending_attachment_bytes(&self) -> usize {
        match (&self.payload, self.is_sent()) {
            (Some(payload), false) => payload.attachments.as_deref().map_or(0, attachments::bytes_of),
            _ => 0,
        }
    }

    /// `JSON.stringify(record)`: the text of the record file.
    pub fn to_text(&self) -> String {
        let mut map = Map::new();
        map.insert("id".to_owned(), Value::String(self.id.clone()));
        map.insert("hash".to_owned(), Value::String(self.hash.clone()));
        if let Some(payload) = &self.payload {
            let mut inner = Map::new();
            inner.insert("kind".to_owned(), Value::String(payload.kind.clone()));
            inner.insert("message".to_owned(), Value::String(payload.message.clone()));
            inner.insert("replyTo".to_owned(), Value::String(payload.reply_to.clone()));
            if let Some(list) = &payload.attachments {
                inner.insert("attachments".to_owned(), Value::Array(list.iter().map(Attachment::to_value).collect()));
            }
            map.insert("payload".to_owned(), Value::Object(inner));
        }
        map.insert("createdAt".to_owned(), mixdog_js::json_number(self.created_at));
        map.insert("attempts".to_owned(), mixdog_js::json_number(self.attempts));
        map.insert("nextAttemptAt".to_owned(), mixdog_js::json_number(self.next_attempt_at));
        map.insert("sentAt".to_owned(), mixdog_js::json_number(self.sent_at));
        js::wire(&Value::Object(map))
    }
}

/// `RECORD_FILE`: a lowercase uuid and `.json`.
pub fn is_record_file(name: &str) -> bool {
    static PATTERN: OnceLock<JsRegex> = OnceLock::new();
    PATTERN.get_or_init(|| JsRegex::new_static(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$", "")).is_match(name)
}

/// `UUID` (case-insensitive).
pub fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36 && bytes.iter().enumerate().all(|(at, b)| if matches!(at, 8 | 13 | 18 | 23) { *b == b'-' } else { b.is_ascii_hexdigit() })
}

/// Lowercase hex of the SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// `payloadHash`: the SHA-256 of the exact `JSON.stringify` of `[kind, message, replyTo]`, with the attachment digests
/// (name, type and the SHA-256 of the base64 text) as a fourth element only when there are attachments.
pub fn payload_hash(kind: &str, message: &str, reply_to: &str, attachments: &[Attachment]) -> String {
    let text = |value: &str| Value::String(value.to_owned());
    let mut parts = vec![text(kind), text(message), text(reply_to)];
    if !attachments.is_empty() {
        let digests = attachments.iter().map(|a| Value::Array(vec![text(&a.name), text(&a.mime_type), text(&sha256_hex(a.data.as_bytes()))])).collect();
        parts.push(Value::Array(digests));
    }
    sha256_hex(js::wire(&Value::Array(parts)).as_bytes())
}

/// `Number.isFinite(v) && v >= 0` of a JSON number.
fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0)
}

/// `validRecord(name, data)`: the record the file holds, or `None` when it is not one.
fn valid_record(name: &str, data: &Value) -> Option<Record> {
    let object = data.as_object()?;
    let id = object.get("id")?.as_str()?;
    if name != format!("{id}.json") {
        return None;
    }
    let hash = object.get("hash")?.as_str()?;
    let sent_at = number(object.get("sentAt"))?;
    let created_at = number(object.get("createdAt"))?;
    let attempts = number(object.get("attempts"))?;
    let next_attempt_at = number(object.get("nextAttemptAt"))?;
    let record = |payload| Record { id: id.to_owned(), hash: hash.to_owned(), payload, created_at, attempts, next_attempt_at, sent_at };
    if sent_at != 0.0 {
        return Some(record(None));
    }
    let payload = object.get("payload")?.as_object()?;
    let kind = payload.get("kind")?.as_str().filter(|kind| KINDS.contains(kind))?;
    let message = payload.get("message")?.as_str()?;
    let reply_to = payload.get("replyTo")?.as_str()?;
    // `attachments === undefined` is a record from before attachments; null or anything else must validate.
    let attachments = match payload.get("attachments") {
        None => None,
        Some(value) => Some(attachments::normalize(Some(value)).ok()?),
    };
    Some(record(Some(Payload { kind: kind.to_owned(), message: message.to_owned(), reply_to: reply_to.to_owned(), attachments })))
}

/// What one file of the feedback directory came to.
#[derive(Debug, Clone, PartialEq)]
pub enum Loaded {
    Record(Box<Record>),
    /// The file could not be read or is not JSON: `code` is the error code Node would log (`error` when it has none).
    Unreadable {
        file: String,
        code: String,
    },
    /// JSON that is not a record, or a record of another file.
    Corrupt {
        file: String,
    },
}

/// The code of an I/O failure as a log line writes it: Node's `error.code`, or `error`.
pub fn error_code(error: &io::Error) -> String {
    mixdog_js::uv_error::error_code(error).unwrap_or("error").to_owned()
}

fn judge(file: String, bytes: &[u8]) -> Loaded {
    match js::parse_bytes(bytes) {
        Err(_) => Loaded::Unreadable { file, code: "error".to_owned() },
        Ok(data) => match valid_record(&file, &data) {
            Some(record) => Loaded::Record(Box::new(record)),
            None => Loaded::Corrupt { file },
        },
    }
}

/// The temp file written and flushed (mode 0600), then renamed over the record file.
fn write_file(lane: &InLane<DurabilityIo>, tmp: &Path, target: &Path, text: &str, fail_rename: bool) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(lane, tmp)?;
    file.write_all(text.as_bytes())?;
    file.sync_all(lane)?;
    drop(file);
    if fail_rename {
        return Err(io::Error::other("injected rename failure"));
    }
    mixdog_fsio::rename(lane, tmp, target)
}

/// Faults a test puts on the next rename and unlink.
#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
pub struct Faults {
    pub rename: std::sync::atomic::AtomicBool,
    pub unlink: std::sync::atomic::AtomicBool,
}

/// The feedback directory: every call is a `DurabilityIo` lane job.
pub struct Disk {
    dir: PathBuf,
    io: DurabilityIo,
    #[cfg(any(test, feature = "test-support"))]
    pub faults: Faults,
}

impl Disk {
    pub fn new(data_dir: &Path, io: DurabilityIo) -> Self {
        Self {
            dir: data_dir.join("feedback"),
            io,
            #[cfg(any(test, feature = "test-support"))]
            faults: Faults::default(),
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    fn injected(&self, fault: &std::sync::atomic::AtomicBool) -> bool {
        fault.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn path_of(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    async fn job<R: Send + 'static>(&self, body: impl FnOnce(&InLane<DurabilityIo>) -> io::Result<R> + Send + 'static) -> io::Result<R> {
        let handle = self.io.submit(&CancellationToken::new(), body).map_err(|_| io::Error::other("lane"))?;
        handle.await.map_err(|_| io::Error::other("lane"))?
    }

    /// Creates the directory (0700) and reads every record file, in name order. An error is the storage being unavailable.
    pub async fn load(&self) -> io::Result<Vec<Loaded>> {
        let dir = self.dir.clone();
        self.job(move |lane| {
            let mut builder = DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            builder.mode(0o700);
            builder.create(lane, &dir)?;
            let mut names = Vec::new();
            for entry in mixdog_fsio::read_dir(lane, &dir)? {
                let name = entry?.file_name();
                if let Some(name) = name.to_str().filter(|name| is_record_file(name)) {
                    names.push(name.to_owned());
                }
            }
            names.sort();
            Ok(names
                .into_iter()
                .map(|name| match mixdog_fsio::read(lane, dir.join(&name)) {
                    Ok(bytes) => judge(name, &bytes),
                    Err(error) => Loaded::Unreadable { file: name, code: error_code(&error) },
                })
                .collect())
        })
        .await
    }

    /// `persist`: `<id>.json.tmp` flushed to disk (mode 0600) and renamed over `<id>.json`. With `clean_up` a failure also
    /// unlinks the temp file.
    pub async fn persist(&self, id: &str, text: String, clean_up: bool) -> io::Result<()> {
        let target = self.path_of(id);
        let tmp = self.dir.join(format!("{id}.json.tmp"));
        let fail = self.rename_fails();
        self.job(move |lane| {
            let written = write_file(lane, &tmp, &target, &text, fail);
            if written.is_err() && clean_up {
                let _ = mixdog_fsio::remove_file(lane, &tmp);
            }
            written
        })
        .await
    }

    /// Unlinks a record file; a file that is already gone is fine.
    pub async fn remove(&self, id: &str) -> io::Result<()> {
        let path = self.path_of(id);
        let fail = self.unlink_fails();
        self.job(move |lane| {
            if fail {
                return Err(io::Error::other("injected unlink failure"));
            }
            match mixdog_fsio::remove_file(lane, path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                other => other,
            }
        })
        .await
    }

    #[cfg(any(test, feature = "test-support"))]
    fn rename_fails(&self) -> bool {
        self.injected(&self.faults.rename)
    }

    #[cfg(not(any(test, feature = "test-support")))]
    fn rename_fails(&self) -> bool {
        false
    }

    #[cfg(any(test, feature = "test-support"))]
    fn unlink_fails(&self) -> bool {
        self.injected(&self.faults.unlink)
    }

    #[cfg(not(any(test, feature = "test-support")))]
    fn unlink_fails(&self) -> bool {
        false
    }
}
