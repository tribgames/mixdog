//! Where the connection stores live in the core data directory, and what the stores share: the error they
//! answer with, the lane job their file I/O runs as, and the few JavaScript string and number rules their
//! validation was written against (`String(x).trim()`, `.slice`, `Number(x)`).

use std::io;
use std::path::PathBuf;

use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_statefile::Opts;
use serde_json::Value;

const SSH_HOSTS_FILE: &str = "ssh-hosts.json";
const PORT_FORWARDS_FILE: &str = "port-forwards.json";
const SERVER_WINDOWS_FILE: &str = "server-windows.json";
const REMOTE_HOSTS_FILE: &str = "remote-hosts.json";
const SSH_DIR: &str = "ssh";

/// The files of the connection stores, all directly in the data directory the desktop kept them in
/// (`userData` there), so the files a desktop wrote load unchanged.
#[derive(Clone, Debug)]
pub struct ConnectionsPaths {
    data_dir: PathBuf,
}

impl ConnectionsPaths {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self { data_dir: data_dir.into() }
    }

    /// The saved SSH servers.
    pub fn ssh_hosts(&self) -> PathBuf {
        self.data_dir.join(SSH_HOSTS_FILE)
    }

    /// The port forwards of each saved SSH server.
    pub fn port_forwards(&self) -> PathBuf {
        self.data_dir.join(PORT_FORWARDS_FILE)
    }

    /// The server windows to reopen at the next launch.
    pub fn server_windows(&self) -> PathBuf {
        self.data_dir.join(SERVER_WINDOWS_FILE)
    }

    /// The saved computers reached through the relay.
    pub fn remote_hosts(&self) -> PathBuf {
        self.data_dir.join(REMOTE_HOSTS_FILE)
    }

    /// The folder of the ssh configuration this app keeps (its own `known_hosts` among it).
    pub fn ssh_dir(&self) -> PathBuf {
        self.data_dir.join(SSH_DIR)
    }
}

/// Why a store refused or failed: the words a person reads (a validation message, or the I/O error).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreError(String);

impl StoreError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<mixdog_statefile::StateError> for StoreError {
    fn from(error: mixdog_statefile::StateError) -> Self {
        Self(error.to_string())
    }
}

/// Runs `job` as a job of the I/O lane the stores were given.
pub(crate) async fn on_lane<R: Send + 'static>(
    io: DurabilityIo,
    job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static,
) -> Result<R, StoreError> {
    let handle = io.submit(&CancellationToken::new(), job).map_err(|full| StoreError::new(full.to_string()))?;
    handle.await.map_err(|dropped| StoreError::new(dropped.to_string()))
}

/// `readJsonState`: the document, or `None` when the file is missing, a newer build's, or damaged with no good copy
/// (a damaged file is kept aside as `.corrupt-<ms>` and its `.bak` restored). A `validate` that refuses marks the
/// document damaged. Only a file that cannot be read at all is an error.
pub(crate) async fn read_state(
    io: DurabilityIo,
    file: PathBuf,
    validate: Option<fn(&Value) -> Result<(), mixdog_statefile::Invalid>>,
) -> Result<Option<Value>, StoreError> {
    on_lane(io, move |lane| match validate {
        Some(check) => mixdog_statefile::read_json(lane, &file, Some(&check), &Opts::default()),
        None => mixdog_statefile::read_json(lane, &file, None, &Opts::default()),
    })
    .await?
    .map_err(StoreError::from)
}

/// `writeJsonAtomicAsync(file, value, { compact: true, backup })`.
pub(crate) async fn write_state(io: DurabilityIo, file: PathBuf, value: Value, backup: bool) -> Result<(), StoreError> {
    let opts = Opts { compact: true, backup, ..Opts::default() };
    on_lane(io, move |lane| mixdog_statefile::write_json(lane, &file, &value, &opts)).await??;
    Ok(())
}

/// `String(value ?? '')` for the values a JSON document holds.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_text(number.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `String(n)` of a finite number: integers without a fraction.
pub(crate) fn js_number_text(number: f64) -> String {
    if number.is_finite() && number.fract() == 0.0 && number.abs() < 1e15 {
        format!("{}", number as i64)
    } else {
        number.to_string()
    }
}

/// `Number(value)`; `NaN` for what JavaScript cannot read as a number here (objects, arrays).
pub(crate) fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => {
            let text = js_trim(text);
            if text.is_empty() {
                0.0
            } else {
                text.parse::<f64>().ok().filter(|number| number.is_finite()).unwrap_or(f64::NAN)
            }
        }
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}

/// `String.prototype.trim`: white space and the byte order mark.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `text.length`: UTF-16 code units.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, max)` by UTF-16 code units, never cutting a character in two.
pub(crate) fn slice_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut kept = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        kept.push(c);
    }
    kept
}

/// The current time as `Date.now()`.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// A `Number.isFinite` field of a stored row, kept as the number the file holds.
pub(crate) fn finite_number(value: Option<&Value>) -> Option<serde_json::Number> {
    match value {
        Some(Value::Number(number)) if number.as_f64().is_some_and(f64::is_finite) => Some(number.clone()),
        _ => None,
    }
}
