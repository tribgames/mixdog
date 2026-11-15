//! The catalogue of every operator-visible line the relay writes, with its stream: stdout for `console.log`, stderr for
//! `console.error` and `console.warn`. A line keeps its Node text, including the space `console.*` puts between its
//! arguments (`"[relay] x failed:" + " " + message`). The areas build their lines here and nowhere else.

use std::io::Write;

/// Where a line goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    /// `console.log`
    Out,
    /// `console.error` and `console.warn`
    Err,
}

/// One line, without its newline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub stream: Stream,
    pub text: String,
}

/// Writes the line and a newline to its stream. A closed pipe loses the line and nothing else.
pub fn emit(line: &Line) {
    match line.stream {
        Stream::Out => {
            let _ = writeln!(std::io::stdout().lock(), "{}", line.text);
        }
        Stream::Err => {
            let _ = writeln!(std::io::stderr().lock(), "{}", line.text);
        }
    }
}

fn out(text: String) -> Line {
    Line { stream: Stream::Out, text }
}

fn err(text: String) -> Line {
    Line { stream: Stream::Err, text }
}

/// The first eight UTF-16 units of an id, as `String(id).slice(0, 8)` writes it in a line.
fn short(id: &str) -> String {
    crate::js::js_slice(id, 8)
}

/// `[relay] http listening on :9800 (renderer: none)`
pub fn listening(scheme: &str, port: u16, renderer_dir: &str) -> Line {
    let renderer = if renderer_dir.is_empty() { "none" } else { renderer_dir };
    out(format!("[relay] {scheme} listening on :{port} (renderer: {renderer})"))
}

pub fn failed_to_start(message: &str) -> Line {
    err(format!("[relay] failed to start: {message}"))
}

pub fn turn_issuance_disabled(message: &str) -> Line {
    err(format!("[relay] TURN credential issuance disabled: {message}"))
}

pub fn websocket_upgrade_failed(message: &str) -> Line {
    err(format!("[relay] websocket upgrade failed: {message}"))
}

pub fn request_failed(message: &str) -> Line {
    err(format!("[relay] request failed: {message}"))
}

/// `[relay] <label> failed: <message>`: the terminator of an async handler (`feedback`, `pair code`, `web push`,
/// `client registration`, `claim request`, ...) and of a guarded socket callback (`phone frame`, ...).
pub fn label_failed(label: &str, message: &str) -> Line {
    err(format!("[relay] {label} failed: {message}"))
}

pub fn phone_upgrade_refused(status: u16, cause: &str, device_id: &str) -> Line {
    out(format!("[relay] phone upgrade refused status={status} cause={cause} device={}", short(device_id)))
}

pub fn phone_upgrade_refused_desktop_offline(device_id: &str) -> Line {
    out(format!("[relay] phone upgrade refused cause=desktop-offline device={}", short(device_id)))
}

pub fn sweep_terminated_leg() -> Line {
    out("[relay] sweep terminated a leg that missed its ping window".to_owned())
}

/// What the desktop leg had shown when its handshake turn ran late.
pub const HEARD_LIVE: &str = "desktop leg is live";
pub const HEARD_PROBE_ANSWERED: &str = "desktop leg answered its probe";

pub fn slow_phone_handshake(turn: u64, heard: &str) -> Line {
    out(format!("[relay] slow phone handshake turn={turn}; {heard}, leaving the leg up"))
}

pub fn desktop_leg_missed_handshake_turn(turn: u64) -> Line {
    out(format!("[relay] desktop leg missed a phone handshake turn={turn} and its probe; closing it"))
}

pub fn phone_leg_closed(client_id: &str, code: u16, reason: &str, lived_ms: i64) -> Line {
    out(format!(
        "[relay] phone leg closed client={} code={code} reason={} lived={lived_ms}ms",
        short(client_id),
        crate::js::js_slice(reason, 60)
    ))
}

pub fn device_store_not_tightened(message: &str) -> Line {
    err(format!("[relay] device store written but not tightened: {message}"))
}

pub fn device_store_persist_failed(message: &str) -> Line {
    err(format!("[relay] failed to persist device store: {message}"))
}

pub fn feedback_request_failed(code: &str) -> Line {
    err(format!("[relay] feedback request failed: {code}"))
}

/// `[relay] feedback <what> code=<code>`; `code` is `error` when the failure carries none.
pub fn feedback_diagnostic(what: &str, code: &str) -> Line {
    err(format!("[relay] feedback {what} code={code}"))
}

pub fn feedback_record_corrupt(file: &str) -> Line {
    err(format!("[relay] feedback record corrupt file={file}"))
}

pub fn feedback_send_failed(id: &str, code: &str) -> Line {
    err(format!("[relay] feedback send failed id={id} code={code}"))
}

pub fn ice_servers_refused(cause: &str, device_id: &str) -> Line {
    out(format!("[relay] ice-servers refused cause={cause} device={}", short(device_id)))
}

pub fn ice_servers_issued(device_id: &str) -> Line {
    out(format!("[relay] ice-servers issued device={}", short(device_id)))
}

/// `label` is the platform: `APNs` or `FCM`.
pub fn push_credentials_unusable(label: &str, message: &str) -> Line {
    err(format!("[relay] {label} credentials unusable: {message}"))
}

pub fn web_push_identity_unreadable(message: &str) -> Line {
    err(format!("[relay] web push identity unreadable: {message}"))
}

pub fn web_push_identity_unusable(message: &str) -> Line {
    err(format!("[relay] web push identity unusable: {message}"))
}

pub fn web_push_identity_not_stored(message: &str) -> Line {
    err(format!("[relay] web push identity could not be stored: {message}"))
}

pub fn web_push_subscriptions_unreadable(message: &str) -> Line {
    err(format!("[relay] web push subscriptions unreadable: {message}"))
}

pub fn web_push_subscriptions_unusable(message: &str) -> Line {
    err(format!("[relay] web push subscriptions unusable: {message}"))
}

pub fn web_push_subscriptions_not_stored(message: &str) -> Line {
    err(format!("[relay] web push subscriptions could not be stored: {message}"))
}

/// `[relay] cannot read <file>: <message>` for a `mobile-release.json` that exists and cannot be read. `file` is the
/// `file://` URL Node prints ([`file_url`]). The relay writes this line twice at load: `readAndroidUrl` runs twice.
pub fn cannot_read(file: &str, message: &str) -> Line {
    err(format!("[relay] cannot read {file}: {message}"))
}

pub fn ignoring_malformed(file: &str) -> Line {
    err(format!("[relay] ignoring malformed {file}; /app links the releases list"))
}

/// The `file://` URL of an absolute path, as `new URL(..., import.meta.url)` prints it in a log line.
pub fn file_url(path: &std::path::Path) -> String {
    url::Url::from_file_path(path).map_or_else(|()| path.to_string_lossy().into_owned(), |url| url.to_string())
}

/// The most sockets one report names; the rest are summed.
pub const MAX_LISTED_SOCKETS: usize = 12;

/// One socket of a report.
pub struct SocketBuffer {
    pub name: String,
    pub buffered_bytes: f64,
}

/// Event-loop delay over one reporting window, in milliseconds.
pub struct LoopDelay {
    pub p50: f64,
    pub p99: f64,
    pub max: f64,
}

/// `812B`, `3.4KB`.
pub fn bytes_label(bytes: f64) -> String {
    if bytes >= 1024.0 {
        format!("{}KB", mixdog_js::math::to_fixed(bytes / 1024.0, 1))
    } else {
        format!("{}B", bytes.floor().max(0.0))
    }
}

/// `[relay] sockets 30s phones=2 buffered desktop:ab=0B ... loop-p50=0.0ms loop-p99=0.0ms loop-max=0.0ms`
pub fn sockets_report(phones: usize, sockets: &[SocketBuffer], loop_delay: &LoopDelay, interval_ms: u64) -> Line {
    let mut ordered: Vec<&SocketBuffer> = sockets.iter().collect();
    // Array.prototype.sort is stable, and so is this: equal buffers keep their order.
    ordered.sort_by(|a, b| b.buffered_bytes.total_cmp(&a.buffered_bytes));
    let (listed, rest) = ordered.split_at(ordered.len().min(MAX_LISTED_SOCKETS));
    let mut buffered: Vec<String> = listed.iter().map(|s| format!("{}={}", s.name, bytes_label(s.buffered_bytes))).collect();
    if !rest.is_empty() {
        buffered.push(format!("+{} more={}", rest.len(), bytes_label(rest.iter().map(|s| s.buffered_bytes).sum())));
    }
    let seconds = mixdog_js::math::round(interval_ms as f64 / 1000.0);
    out(format!(
        "[relay] sockets {seconds}s phones={phones} buffered {} loop-p50={}ms loop-p99={}ms loop-max={}ms",
        buffered.join(" "),
        mixdog_js::math::to_fixed(loop_delay.p50, 1),
        mixdog_js::math::to_fixed(loop_delay.p99, 1),
        mixdog_js::math::to_fixed(loop_delay.max, 1)
    ))
}
