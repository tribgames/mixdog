//! The durable record of a manual Remote ON, `channel-remote-intent.json` in the runtime root
//! (`channel-binding.mjs`, `channel-transport/remote-intent.mjs`): which session and transcript
//! the pin belongs to, so a core restart restores it (`restoreRemoteIntent`, `daemon.mjs:1289`).

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_rt::{CancellationToken, LaneToken, MaintenanceIo};
use mixdog_statefile::Opts;
use serde_json::{Value, json};

/// The file's name in the runtime root (`remote-intent.mjs` `remoteIntentPath`).
pub const INTENT_FILE: &str = "channel-remote-intent.json";

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteIntent {
    pub session_id: String,
    pub transcript_path: String,
    pub cwd: Option<String>,
    pub updated_at: f64,
}

impl RemoteIntent {
    /// The record as Node writes it, in its key order.
    pub fn to_json(&self) -> Value {
        json!({
            "version": 1,
            "sessionId": self.session_id,
            "transcriptPath": self.transcript_path,
            "cwd": self.cwd,
            "updatedAt": mixdog_js::json_number(self.updated_at),
        })
    }
}

fn is_session_id(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `basename(path).replace(/\.[^.]+$/, '')` with the platform's `path`: trailing separators
/// are not part of the name, and Windows also splits on `\` and drops a drive prefix.
fn file_stem(path: &str) -> &str {
    let separator = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let bytes = path.as_bytes();
    let path = if cfg!(windows) && bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' { &path[2..] } else { path };
    let name = path.trim_end_matches(separator).rsplit(separator).next().unwrap_or_default();
    match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => &name[..dot],
        _ => name,
    }
}

/// `String(value || '').trim()`.
fn trimmed_text(value: Option<&Value>) -> String {
    let falsy = match value {
        None | Some(Value::Null | Value::Bool(false)) => true,
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        Some(Value::String(s)) => s.is_empty(),
        Some(_) => false,
    };
    if falsy { String::new() } else { mixdog_js::js_trim(&mixdog_js::value_to_string(value.expect("a truthy value is present"))).to_string() }
}

/// `normalizeRemoteIntent`: the record a value describes, or `None` when it cannot claim a
/// session (no valid id, no transcript, or a transcript named after another session).
pub fn normalize_intent(value: &Value, now_ms: f64) -> Option<RemoteIntent> {
    let fields = value.as_object()?;
    let session_id = trimmed_text(fields.get("sessionId"));
    let transcript_path = trimmed_text(fields.get("transcriptPath"));
    if !is_session_id(&session_id) || transcript_path.is_empty() || file_stem(&transcript_path) != session_id {
        return None;
    }
    let cwd = fields.get("cwd").filter(|v| !v.is_null()).map(mixdog_js::value_to_string);
    let updated_at = mixdog_js::to_number_of(fields.get("updatedAt"));
    let updated_at = if updated_at.is_nan() || updated_at == 0.0 { now_ms } else { updated_at };
    Some(RemoteIntent { session_id, transcript_path, cwd, updated_at })
}

/// What one read of the file means (`readRemoteIntent`).
#[derive(Debug)]
pub enum IntentRead {
    /// No file: unpinned, nothing to remove.
    Absent,
    Pinned(RemoteIntent),
    /// Malformed or mismatched content is not a binding: the file is removed.
    Invalid,
    /// Any other read failure is not proof of a malformed binding: the file stays.
    Unreadable(io::Error),
}

pub fn intent_of_read(read: io::Result<Vec<u8>>, now_ms: f64) -> IntentRead {
    match read {
        Ok(bytes) => match mixdog_js::json_parse(&String::from_utf8_lossy(&bytes)) {
            Ok(value) => normalize_intent(&value, now_ms).map_or(IntentRead::Invalid, IntentRead::Pinned),
            Err(_) => IntentRead::Invalid,
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => IntentRead::Absent,
        Err(error) => IntentRead::Unreadable(error),
    }
}

pub type IntentLog = Arc<dyn Fn(&str) + Send + Sync>;
pub type IntentClock = Arc<dyn Fn() -> f64 + Send + Sync>;

fn wall_clock_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// The intent file of one runtime root, read and written on the maintenance lane.
pub struct IntentFile {
    path: PathBuf,
    lane: MaintenanceIo,
    log: IntentLog,
    now: IntentClock,
}

impl IntentFile {
    pub fn new(runtime_root: &std::path::Path, lane: MaintenanceIo, log: IntentLog) -> Self {
        Self::with_clock(runtime_root, lane, log, Arc::new(wall_clock_ms))
    }

    pub fn with_clock(runtime_root: &std::path::Path, lane: MaintenanceIo, log: IntentLog, now: IntentClock) -> Self {
        Self { path: runtime_root.join(INTENT_FILE), lane, log, now }
    }

    pub fn log(&self, line: &str) {
        (self.log)(line);
    }

    pub fn now(&self) -> f64 {
        (self.now)()
    }

    async fn job<R: Send + 'static>(&self, job: impl FnOnce(&mixdog_rt::InLane<MaintenanceIo>, PathBuf) -> io::Result<R> + Send + 'static) -> io::Result<R> {
        let path = self.path.clone();
        let handle = self.lane.submit_wait(&CancellationToken::new(), move |lane| job(lane, path)).await.map_err(io::Error::other)?;
        handle.await.map_err(io::Error::other)?
    }

    /// The boot read: a valid intent pins its session, an invalid file is removed, an
    /// unreadable one is kept and costs only the restore.
    pub async fn load(&self) -> Option<RemoteIntent> {
        let now = self.now();
        let read = self.job(|lane, path| mixdog_fsio::read(lane, path)).await;
        match intent_of_read(read, now) {
            IntentRead::Absent => None,
            IntentRead::Pinned(intent) => Some(intent),
            IntentRead::Invalid => {
                let _ = self.job(|lane, path| mixdog_statefile::remove_file(lane, &path)).await;
                None
            }
            IntentRead::Unreadable(error) => {
                self.log(&format!("channel remote intent unreadable, starting unpinned: {error}"));
                None
            }
        }
    }

    /// `writeRemoteIntent`'s file write: a failure is logged, the pin stays.
    pub async fn write(&self, intent: &RemoteIntent) {
        let document = intent.to_json();
        let opts = Opts { compact: true, ..Opts::default() };
        let written = self.job(move |lane, path| mixdog_statefile::write_json(lane, &path, &document, &opts).map(drop).map_err(io::Error::other)).await;
        if let Err(error) = written {
            self.log(&format!("remote intent write failed: {error}"));
        }
    }

    /// `clearRemoteIntent`'s file removal.
    pub async fn clear(&self, reason: &str) {
        let removed = self.job(|lane, path| match mixdog_statefile::remove_file(lane, &path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        });
        if let Err(error) = removed.await {
            self.log(&format!("remote intent clear failed ({reason}): {error}"));
        }
        self.log(&format!("remote intent cleared ({reason})"));
    }
}
