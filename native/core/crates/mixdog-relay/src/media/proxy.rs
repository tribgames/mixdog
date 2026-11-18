//! `/media/<assetId>?variant=&sid=&enc=&token=` (`handleMediaRequest` and its parts): the gallery's byte lane through the relay.
//!
//! The files live on the desktop, so the relay proxies: it forwards one `media-request` over the desktop leg and streams the
//! `media-head`, `media-chunk`, `media-end` and `media-error` frames that come back straight into the HTTP response.
//!
//! One request is one [`MediaProxy::pump`] task-body: it owns the response, and everything that concerns the stream reaches it as
//! an event in order (a frame of the desktop, the failure the hub raises when the leg goes). The hub's `MediaSlot` holds a marker
//! per stream, which is what counts the streams of a desktop and what fails them when its leg is replaced or closes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use super::headers::media_response_headers;
use crate::http1::util::{decode_uri_component, end_text, reject_unauthorized_text, request_url};
use crate::http1::{Request, ResponseWriter};
use crate::legs::dispatch::{Handler, HandlerFuture, LegCall, Rejected};
use crate::legs::hub::{Hub, MediaPending, send_json};
use crate::rate_limit::RateLimiter;
use crate::web::headers::request_cookie_token;

/// `MEDIA_HEAD_TIMEOUT_MS`: how long the desktop has to send the first frame. A long clip then streams for as long as the
/// desktop keeps sending.
pub const MEDIA_HEAD_TIMEOUT: Duration = Duration::from_secs(30);
/// `MEDIA_STALL_TIMEOUT_MS`: how long the desktop may go quiet after each frame. A desktop that stalls mid-clip must not pin an
/// open response forever: the phone retries the range instead of watching a socket that never ends.
pub const MEDIA_STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// `MEDIA_PAUSE_BUFFER_BYTES`: the producer is paused once this much is buffered in the response. The desktop pauses on ITS socket
/// backlog, which a relay that drains eagerly never fills, so a slow phone's clip would buffer here instead.
pub const MEDIA_PAUSE_BUFFER_BYTES: usize = 1024 * 1024;
/// `MEDIA_KILL_BUFFER_BYTES`: a response that holds more than this has stopped draining: it is cut (media is retryable: the
/// browser asks for the range again).
pub const MEDIA_KILL_BUFFER_BYTES: usize = 8 * 1024 * 1024;
/// `MAX_MEDIA_STREAMS`: proxied streams per desktop. One tab opening a screenful of tiles is normal; unbounded streams are not
/// (each one holds an open response and a file read).
pub const MAX_MEDIA_STREAMS: usize = 32;

/// The numbers of the lane. They are the constants above; a test shortens the timeouts and the limits.
#[derive(Debug, Clone, Copy)]
pub struct MediaOptions {
    pub head_timeout: Duration,
    pub stall_timeout: Duration,
    pub pause_bytes: usize,
    pub kill_bytes: usize,
    pub max_streams: usize,
}

impl Default for MediaOptions {
    fn default() -> Self {
        Self {
            head_timeout: MEDIA_HEAD_TIMEOUT,
            stall_timeout: MEDIA_STALL_TIMEOUT,
            pause_bytes: MEDIA_PAUSE_BUFFER_BYTES,
            kill_bytes: MEDIA_KILL_BUFFER_BYTES,
            max_streams: MAX_MEDIA_STREAMS,
        }
    }
}

/// The only variants a request may name (`ALLOWED_VARIANTS`); `download` streams a per-lease file download.
const VARIANTS: [&str; 4] = ["original", "thumb", "display", "download"];

/// What reaches the task of a stream.
enum Event {
    /// A frame of the desktop that carries this stream's id.
    Frame(Value),
    /// The desktop's leg went away mid-stream.
    Fail,
}

/// The hub's handle on a stream: what fails it when the leg goes (`failMediaPending`).
struct Marker(UnboundedSender<Event>);

impl MediaPending for Marker {
    fn fail(self: Box<Self>) {
        let _ = self.0.send(Event::Fail);
    }
}

/// The streams in flight, by device and request id: where a frame of a desktop finds the task that waits for it.
#[derive(Default)]
struct Streams {
    senders: Mutex<HashMap<(String, String), UnboundedSender<Event>>>,
}

impl Streams {
    fn lock(&self) -> MutexGuard<'_, HashMap<(String, String), UnboundedSender<Event>>> {
        self.senders.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn insert(&self, device_id: &str, id: &str, sender: UnboundedSender<Event>) {
        self.lock().insert((device_id.to_owned(), id.to_owned()), sender);
    }

    fn remove(&self, device_id: &str, id: &str) {
        self.lock().remove(&(device_id.to_owned(), id.to_owned()));
    }

    fn forward(&self, device_id: &str, id: &str, message: Value) {
        let sender = self.lock().get(&(device_id.to_owned(), id.to_owned())).cloned();
        if let Some(sender) = sender {
            let _ = sender.send(Event::Frame(message));
        }
    }
}

/// `String(message.id || '')`.
fn frame_id(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

/// `upstreamStatus`: an integer from 100 to 599, else 502.
fn upstream_status(value: Option<&Value>) -> u16 {
    match value {
        Some(Value::Number(number)) => match number.as_f64() {
            Some(status) if status.fract() == 0.0 && (100.0..=599.0).contains(&status) => status as u16,
            _ => 502,
        },
        _ => 502,
    }
}

/// `Buffer.from(text, 'base64')`: both alphabets, characters outside them skipped, the first `=` ends the data, and a dangling
/// group gives the bytes its sextets carry.
fn decode_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut bits = 0u32;
    let mut count = 0u8;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            bits = 0;
            count = 0;
        }
    }
    match count {
        2 => out.push((bits >> 4) as u8),
        3 => out.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        _ => {}
    }
    out
}

/// `MEDIA_ROUTE` and `parseMediaRequest`: `/media/<8 to 64 hex digits or dashes>` with a known `variant` (default `original`),
/// as the asset id and the variant. The path is already percent-decoded.
fn parse_target(pathname: &str, variant: &str) -> Option<(String, String)> {
    let asset_id = pathname.strip_prefix("/media/")?;
    if !(8..=64).contains(&asset_id.len()) || !asset_id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
        return None;
    }
    let variant = if variant.is_empty() { "original" } else { variant };
    VARIANTS.contains(&variant).then(|| (asset_id.to_owned(), variant.to_owned()))
}

/// `MEDIA_SESSION_ID`: the public handshake challenge of an E2EE session, 43 URL-safe characters.
fn session_label_ok(sid: &str) -> bool {
    sid.len() == 43 && sid.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// `/^[A-Za-z0-9]{0,16}$/`: the protocol opt-in; only a client that sends it is answered with encrypted frames.
fn scheme_marker_ok(enc: &str) -> bool {
    enc.len() <= 16 && enc.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// Why the desktop cannot take one more stream right now (all 503).
enum Refusal {
    Offline,
    /// An older desktop leg drops unknown frames on the floor, so asking it for media would buy nothing but a first-frame timeout
    /// on every tile; one capability bit from the leg turns that into an instant downgrade to the RPC payload.
    Unsupported,
    TooMany,
}

/// `{"status":"..."}` as JSON.
fn answer_health(response: &mut ResponseWriter, supported: bool) {
    let (status, body) = if supported { (200, "{\"status\":\"ok\"}") } else { (503, "{\"status\":\"unsupported\"}") };
    if response.write_head(status, &[("Content-Type", "application/json")]).is_ok() {
        response.end(Some(body.as_bytes()));
    }
}

/// A status and no body.
fn bare(response: &mut ResponseWriter, status: u16) {
    if response.write_head(status, &[]).is_ok() {
        response.end(None);
    }
}

/// The media lane of one relay.
pub struct MediaProxy {
    hub: Arc<Hub>,
    unauthorized: Arc<Mutex<RateLimiter>>,
    streams: Arc<Streams>,
    options: MediaOptions,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_is_an_asset_id_of_hex_digits_and_dashes_with_a_known_variant() {
        let target = |path: &str, variant: &str| parse_target(path, variant);
        assert_eq!(target("/media/0123456789abcdef", ""), Some(("0123456789abcdef".into(), "original".into())));
        assert_eq!(target("/media/0123456789abcdef", "download"), Some(("0123456789abcdef".into(), "download".into())));
        assert_eq!(target("/media/ABCDEF01-2345", "thumb"), Some(("ABCDEF01-2345".into(), "thumb".into())));
        assert_eq!(target("/media/0123456789abcdef", "bogus"), None);
        assert_eq!(target("/media/0123456789abcdef", "ORIGINAL"), None);
        for path in ["/media/short", "/media/", "/media", "/media/0123456789abcdeg", "/media/0123456789abcdef/x", "/media/x/0123456789abcdef"] {
            assert_eq!(target(path, ""), None, "{path}");
        }
        assert!(target(&format!("/media/{}", "a".repeat(64)), "").is_some());
        assert!(target(&format!("/media/{}", "a".repeat(65)), "").is_none());
    }

    #[test]
    fn the_session_label_and_the_scheme_marker_have_their_exact_alphabets() {
        assert!(session_label_ok(&"A".repeat(43)));
        assert!(session_label_ok(&format!("{}-_", "a".repeat(41))));
        assert!(!session_label_ok("short"));
        assert!(!session_label_ok(&"A".repeat(44)));
        assert!(!session_label_ok(&format!("{}+", "A".repeat(42))));
        assert!(scheme_marker_ok(""));
        assert!(scheme_marker_ok("e2ee1"));
        assert!(scheme_marker_ok(&"x".repeat(16)));
        assert!(!scheme_marker_ok(&"x".repeat(17)));
        assert!(!scheme_marker_ok("  "));
        assert!(!scheme_marker_ok("a-b"));
    }

    #[test]
    fn a_status_the_desktop_sends_is_an_integer_from_100_to_599_or_a_502() {
        assert_eq!(upstream_status(Some(&json!(200))), 200);
        assert_eq!(upstream_status(Some(&json!(206.0))), 206);
        assert_eq!(upstream_status(Some(&json!(100))), 100);
        assert_eq!(upstream_status(Some(&json!(599))), 599);
        for bad in [json!(99), json!(600), json!(200.5), json!("200"), json!(null), json!(true), json!([200])] {
            assert_eq!(upstream_status(Some(&bad)), 502, "{bad}");
        }
        assert_eq!(upstream_status(None), 502);
    }

    #[test]
    fn a_frame_id_is_the_string_of_a_truthy_value_and_empty_otherwise() {
        assert_eq!(frame_id(Some(&json!("abc"))), "abc");
        assert_eq!(frame_id(Some(&json!(5))), "5");
        for empty in [json!(null), json!(false), json!(0), json!("")] {
            assert_eq!(frame_id(Some(&empty)), "", "{empty}");
        }
        assert_eq!(frame_id(None), "");
    }

    #[test]
    fn chunks_decode_as_a_buffer_decodes_base64() {
        assert_eq!(decode_base64("aGVsbG8="), b"hello");
        assert_eq!(decode_base64("aGVsbG8"), b"hello");
        assert_eq!(decode_base64(""), b"");
        assert_eq!(decode_base64("YQ=="), b"a");
        // Whitespace and foreign characters are skipped, the URL-safe alphabet is read, the first padding ends the data.
        assert_eq!(decode_base64("aGVs\nbG8="), b"hello");
        assert_eq!(decode_base64("-_-_"), [0xfb, 0xff, 0xbf]);
        assert_eq!(decode_base64("YQ==YQ=="), b"a");
        let bytes: Vec<u8> = (0..=255).collect();
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        assert_eq!(decode_base64(&encoded), bytes);
    }
}


impl MediaProxy {
    /// Builds the lane and takes the `media-` frames of every desktop leg. `unauthorized` is the process's limiter for callers
    /// without a credential.
    pub fn start(hub: Arc<Hub>, unauthorized: Arc<Mutex<RateLimiter>>, options: MediaOptions) -> Result<Arc<Self>, Rejected> {
        let streams = Arc::new(Streams::default());
        let sink = Arc::clone(&streams);
        let handler: Handler = Arc::new(move |call: LegCall| -> HandlerFuture {
            let sink = Arc::clone(&sink);
            Box::pin(async move {
                let id = frame_id(call.message.get("id"));
                sink.forward(&call.device_id, &id, call.message);
            })
        });
        hub.dispatch().register_prefix("media-", handler)?;
        Ok(Arc::new(Self { hub, unauthorized, streams, options }))
    }

    /// `handleMediaRequest`: answers the whole request.
    pub async fn handle_request(&self, request: Request, mut response: ResponseWriter) {
        let Some(url) = request_url(&request.url) else {
            bare(&mut response, 400);
            return;
        };
        if request.method != "GET" && request.method != "HEAD" {
            bare(&mut response, 405);
            return;
        }
        // Percent-decoding fails on malformed input (`/media/%`). That input arrives unauthenticated, so it becomes a response.
        let Some(pathname) = decode_uri_component(url.path()) else {
            let _ = end_text(&mut response, 400, "Bad request.", &[]);
            return;
        };
        let query = |name: &str| url.query_pairs().find(|(key, _)| *key == name).map(|(_, value)| value.into_owned()).unwrap_or_default();
        let mut token = query("token");
        if token.is_empty() {
            token = request_cookie_token(&request.headers);
        }
        let device_id = if token.is_empty() { None } else { self.hub.store().device_id_for_client_token(&token) };
        let Some(device_id) = device_id else {
            let mut limiter = self.unauthorized.lock().unwrap_or_else(PoisonError::into_inner);
            let _ = reject_unauthorized_text(&mut limiter, request.remote_address.as_deref(), &mut response);
            return;
        };
        // The feature probe is answered for the DESKTOP that would produce the bytes. The relay serves ONE web bundle to every
        // phone while installs update on their own schedule, so this relay is routinely newer than the desktop it is paired
        // with: reporting the desktop's lane keeps that skew a plain answer instead of something the phone infers from a stall.
        if pathname == "/media/healthz" {
            let supported = self.hub.desktop_info(&device_id).is_some_and(|info| info.open && info.media_lane);
            answer_health(&mut response, supported);
            return;
        }
        let Some((asset_id, variant)) = parse_target(&pathname, &query("variant")) else {
            let _ = end_text(&mut response, 404, "Not found.", &[]);
            return;
        };
        // Names the E2EE session whose media key sealed the bytes. It is the session's public handshake challenge: the relay
        // forwards it as a label and never holds anything that could open the stream.
        let sid = query("sid");
        let enc = query("enc");
        if (!sid.is_empty() && !session_label_ok(&sid)) || !scheme_marker_ok(&enc) {
            let _ = end_text(&mut response, 400, "Bad request.", &[]);
            return;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let frame = json!({
            "type": "media-request",
            "id": id,
            "assetId": asset_id,
            "variant": variant,
            "sid": sid,
            "enc": enc,
            "method": request.method,
            "range": request.headers.get("range").unwrap_or_default(),
            "ifNoneMatch": request.headers.get("if-none-match").unwrap_or_default(),
        });
        let (sender, receiver) = unbounded_channel();
        // Counted, registered and asked in one step of the hub, so two requests cannot both take the last place.
        let admitted = self.hub.with_media(&device_id, |view| {
            if !view.open {
                return Err(Refusal::Offline);
            }
            if !view.lane {
                return Err(Refusal::Unsupported);
            }
            if view.pending.len() >= self.options.max_streams {
                return Err(Refusal::TooMany);
            }
            view.pending.insert(id.clone(), Box::new(Marker(sender.clone())));
            self.streams.insert(&device_id, &id, sender.clone());
            send_json(&**view.socket, &frame);
            Ok(())
        });
        match admitted.unwrap_or(Err(Refusal::Offline)) {
            Ok(()) => {}
            Err(Refusal::Offline) => {
                let _ = end_text(&mut response, 503, "Desktop offline.", &[]);
                return;
            }
            Err(Refusal::Unsupported) => {
                let _ = end_text(&mut response, 503, "Desktop media lane unsupported.", &[]);
                return;
            }
            Err(Refusal::TooMany) => {
                let _ = end_text(&mut response, 503, "Too many media streams.", &[("Retry-After", "1")]);
                return;
            }
        }
        drop(sender);
        self.pump(&device_id, &id, receiver, response).await;
    }

    /// Takes the stream out of the table and the hub's slot; whether the hub still held it (a leg that went has emptied it).
    fn release(&self, device_id: &str, id: &str) -> bool {
        self.streams.remove(device_id, id);
        self.hub.with_media(device_id, |view| view.pending.remove(id).is_some()).unwrap_or(false)
    }

    /// `abortMediaUpstream`: tells the desktop to stop reading for a request this relay gave up on.
    fn abort_upstream(&self, device_id: &str, id: &str) {
        self.hub.send_to_desktop(device_id, &json!({ "type": "media-abort", "id": id }));
    }

    /// Ends a response the desktop never answered with `status`, or one it answered by closing it.
    fn end_response(response: &mut ResponseWriter, head: bool, status: u16) {
        if !head {
            let _ = response.write_head(status, &[]);
        }
        response.end(None);
    }

    /// The stream: waits for what the desktop sends, writes it into the response, and ends when the desktop ends it, stalls, goes
    /// away or the phone does. The timeout covers the FIRST frame; every frame after it pushes the expiry out.
    async fn pump(&self, device_id: &str, id: &str, mut events: UnboundedReceiver<Event>, mut response: ResponseWriter) {
        let mut head = false;
        let mut paused = false;
        let mut timer = Box::pin(mixdog_rt::time::sleep_unrefed(self.options.head_timeout));
        loop {
            tokio::select! {
                biased;
                event = events.recv() => {
                    let Some(Event::Frame(message)) = event else {
                        // `failMediaPending`: the desktop vanished; the phone retries instead of hanging on an open socket.
                        self.release(device_id, id);
                        Self::end_response(&mut response, head, 503);
                        return;
                    };
                    match message.get("type").and_then(Value::as_str) {
                        Some("media-head") => {
                            head = true;
                            timer = Box::pin(mixdog_rt::time::sleep_unrefed(self.options.stall_timeout));
                            let supplied = media_response_headers(message.get("headers"));
                            let pairs: Vec<(&str, &str)> = supplied.iter().map(|(name, value)| (*name, value.as_str())).collect();
                            // A second head finds the first one sent: nothing to write.
                            let _ = response.write_head(upstream_status(message.get("status")), &pairs);
                        }
                        Some("media-chunk") => {
                            let Some(data) = message.get("data").and_then(Value::as_str) else { continue };
                            if !head {
                                continue;
                            }
                            timer = Box::pin(mixdog_rt::time::sleep_unrefed(self.options.stall_timeout));
                            response.write(&decode_base64(data));
                            // Byte-lane flow control: pause the producer once the response buffer fills, cut the stream once
                            // it stops draining.
                            let buffered = response.writable_length();
                            if buffered > self.options.kill_bytes {
                                let held = self.release(device_id, id);
                                response.destroy();
                                if held {
                                    self.abort_upstream(device_id, id);
                                }
                                return;
                            }
                            if !paused && buffered > self.options.pause_bytes {
                                paused = true;
                                self.hub.send_to_desktop(device_id, &json!({ "type": "media-pause", "id": id }));
                            }
                        }
                        Some("media-end" | "media-error") => {
                            self.release(device_id, id);
                            Self::end_response(&mut response, head, 502);
                            return;
                        }
                        _ => {}
                    }
                }
                () = &mut timer => {
                    let held = self.release(device_id, id);
                    Self::end_response(&mut response, head, 504);
                    if held {
                        self.abort_upstream(device_id, id);
                    }
                    return;
                }
                // A phone that scrolls away mid-clip must not leave the desktop pumping frames into a dead response.
                () = response.closed() => {
                    if self.release(device_id, id) {
                        self.abort_upstream(device_id, id);
                    }
                    return;
                }
                () = response.drain(), if paused => {
                    paused = false;
                    self.hub.send_to_desktop(device_id, &json!({ "type": "media-resume", "id": id }));
                }
            }
        }
    }
}
