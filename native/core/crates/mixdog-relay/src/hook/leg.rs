//! The agent's side of the tunnel: one `/hookleg` socket per device (`runHookLeg`, `answerHookFrame`, `hookContentType`,
//! `decodeHookResponseBody`). The device has authenticated by the time the socket gets here.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde_json::Value;

use super::{Answer, EntryState, HookEntry, HookHub, MAX_HOOK_BODY_BYTES};
use crate::close_codes::{SUPERSEDED, SUPERSEDED_REASON};
use crate::js;
use crate::legs::ingress::{IngressLeg, IngressLimits, LegKind};
use crate::logline;
use crate::ws::{WebSocket, WsEvent, WsEvents};

/// `MAX_HOOK_RESPONSE_BODY_BYTES`: the most the decoded body of an agent's answer may carry.
pub const MAX_HOOK_RESPONSE_BODY_BYTES: usize = MAX_HOOK_BODY_BYTES;

/// Why the body of an `http-response` was refused (the two errors of `decodeHookResponseBody`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BodyRejected {
    #[error("invalid hook response body")]
    Invalid,
    #[error("hook response body exceeds limit")]
    TooLarge,
}

fn alphabet_value(byte: u8) -> Option<u32> {
    match byte {
        b'A'..=b'Z' => Some(u32::from(byte - b'A')),
        b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// `/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/`: whole groups of four, the last of them possibly padded
/// with one or two `=`. Trailing bits of a padded group are not checked, as the expression does not.
fn is_strict_base64(text: &[u8]) -> bool {
    if text.len() % 4 != 0 {
        return false;
    }
    let padding = if text.ends_with(b"==") {
        2
    } else {
        usize::from(text.ends_with(b"="))
    };
    text[..text.len() - padding].iter().all(|byte| alphabet_value(*byte).is_some())
}

/// `Buffer.from(text, 'base64')` of text that [`is_strict_base64`].
fn decode_base64(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    for group in text.chunks(4) {
        let mut bits = 0u32;
        let mut count = 0;
        for byte in group {
            let Some(value) = alphabet_value(*byte) else { break };
            bits = (bits << 6) | value;
            count += 1;
        }
        // `count` sextets carry `count * 6 / 8` whole bytes; a partial one is dropped.
        let bytes = count * 6 / 8;
        bits <<= 6 * (4 - count);
        let wide = bits.to_be_bytes();
        out.extend_from_slice(&wide[1..=bytes]);
    }
    out
}

/// `decodeHookResponseBody`: the body of an agent's answer is strict canonical base64 (absent or null is empty; any other
/// value is read as its string form) and decodes to at most [`MAX_HOOK_RESPONSE_BODY_BYTES`].
pub fn decode_response_body(value: Option<&Value>) -> Result<Vec<u8>, BodyRejected> {
    let encoded = match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::value_to_string(value),
    };
    let maximum_encoded = MAX_HOOK_RESPONSE_BODY_BYTES.div_ceil(3) * 4;
    if encoded.len() > maximum_encoded || !is_strict_base64(encoded.as_bytes()) {
        return Err(BodyRejected::Invalid);
    }
    let body = decode_base64(encoded.as_bytes());
    if body.len() > MAX_HOOK_RESPONSE_BODY_BYTES {
        return Err(BodyRejected::TooLarge);
    }
    Ok(body)
}

/// `upstreamStatus`: a status the agent reported for an upstream answer, else 502.
fn upstream_status(value: Option<&Value>) -> u16 {
    let Some(Value::Number(number)) = value else { return 502 };
    match number.as_f64() {
        Some(status) if status.fract() == 0.0 && (100.0..=599.0).contains(&status) => status as u16,
        _ => 502,
    }
}

/// `hookContentType`: the agent's `content-type` when it is printable ASCII of 1 to 200 characters, else `application/json`.
fn content_type(headers: Option<&Value>) -> String {
    let raw = headers.and_then(|headers| headers.get("content-type")).and_then(Value::as_str).unwrap_or("");
    if (1..=200).contains(&raw.len()) && raw.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
        raw.to_owned()
    } else {
        "application/json".to_owned()
    }
}

/// `answerHookFrame`: one `http-response` frame from the agent settles its parked inbound request.
fn answer_frame(entry: &HookEntry, raw: &[u8]) {
    let Ok(frame) = js::parse_bytes(raw) else { return };
    if frame.is_null() {
        // `frame.type` of `null` throws in the guarded listener.
        logline::emit(&logline::label_failed("hook frame", "Cannot read properties of null (reading 'type')"));
        return;
    }
    if frame.get("type").and_then(Value::as_str) != Some("http-response") {
        return;
    }
    let Some(id) = frame.get("id").and_then(Value::as_str) else { return };
    let Some(sender) = entry.take(id) else { return };
    let answer = match decode_response_body(frame.get("body")) {
        Ok(body) => Answer::Reply { status: upstream_status(frame.get("status")), content_type: content_type(frame.get("headers")), body },
        Err(_) => Answer::Failed("invalid agent response"),
    };
    // The caller may be gone: nobody to tell.
    let _ = sender.send(answer);
}

impl HookHub {
    /// `runHookLeg`: serve one agent leg until its socket closes. Call it right after the upgrade, with the socket and its
    /// events. A leg of the same device that is already live is superseded: closed 4000 and its parked requests fail 502.
    pub async fn run_leg(self: &Arc<Self>, device_id: &str, socket: WebSocket, mut events: WsEvents) {
        // `{ ...ingress, limit: MAX_HOOK_BODY_BYTES }`: whatever numbers the server gives, a hook leg's own limit is 1 MiB.
        let limits = IngressLimits { limit: MAX_HOOK_BODY_BYTES, ..self.options.ingress };
        let ingress = IngressLeg::install(&self.pool, &socket, LegKind::Hook, limits);
        let entry = Arc::new(HookEntry {
            socket,
            state: std::sync::Mutex::new(EntryState::default()),
            alive: AtomicBool::new(true),
            ingress: ingress.clone(),
        });
        let previous = super::lock(&self.legs).insert(device_id.to_owned(), Arc::clone(&entry));
        if let Some(previous) = previous {
            // Already gone is not an error here.
            let _ = previous.socket.close(SUPERSEDED, SUPERSEDED_REASON);
            previous.fail_pending();
        }
        while let Some(event) = events.next().await {
            match event {
                WsEvent::Message { data, .. } => {
                    ingress.note_delivery();
                    entry.alive.store(true, std::sync::atomic::Ordering::SeqCst);
                    answer_frame(&entry, &data);
                }
                WsEvent::Pong(_) => entry.alive.store(true, std::sync::atomic::Ordering::SeqCst),
                // A protocol error surfaces as the close that follows; a ping is answered by the socket itself.
                WsEvent::Error(_) | WsEvent::Ping(_) => {}
                WsEvent::Close { .. } => {
                    ingress.release();
                    let mut legs = super::lock(&self.legs);
                    if legs.get(device_id).is_some_and(|live| Arc::ptr_eq(live, &entry)) {
                        legs.remove(device_id);
                        drop(legs);
                        entry.fail_pending();
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn response_bodies_are_strict_base64_inside_the_byte_limit() {
        assert_eq!(decode_response_body(Some(&json!("b2s="))).as_deref(), Ok(&b"ok"[..]));
        assert_eq!(decode_response_body(None).as_deref(), Ok(&b""[..]));
        assert_eq!(decode_response_body(Some(&Value::Null)).as_deref(), Ok(&b""[..]));
        assert_eq!(decode_response_body(Some(&json!(""))).as_deref(), Ok(&b""[..]));
        for bad in ["not base64!", "b2s", "b2s==", "=b2s", "b2=s", "A===", "b2s=b2s=", "b2s=\n", "b2sé"] {
            assert_eq!(decode_response_body(Some(&json!(bad))), Err(BodyRejected::Invalid), "{bad:?}");
        }
        assert_eq!(decode_response_body(Some(&json!("A".repeat(MAX_HOOK_RESPONSE_BODY_BYTES.div_ceil(3) * 4 + 4)))), Err(BodyRejected::Invalid));
        // The longest text the length check lets through can still decode to more than the limit.
        let longest = "A".repeat(MAX_HOOK_RESPONSE_BODY_BYTES.div_ceil(3) * 4);
        assert_eq!(decode_response_body(Some(&json!(longest))), Err(BodyRejected::TooLarge));
        let exact = "A".repeat(MAX_HOOK_RESPONSE_BODY_BYTES / 3 * 4) + "AA==";
        assert_eq!(decode_response_body(Some(&json!(exact))).map(|body| body.len()), Ok(MAX_HOOK_RESPONSE_BODY_BYTES));
        let over = "A".repeat(MAX_HOOK_RESPONSE_BODY_BYTES / 3 * 4) + "AAA=";
        assert_eq!(decode_response_body(Some(&json!(over))), Err(BodyRejected::TooLarge));
    }

    #[test]
    fn a_value_that_is_not_text_is_read_as_its_string_form() {
        // `String(1234)` is `1234`, which is four base64 digits; `String(true)` is `true`.
        assert_eq!(decode_response_body(Some(&json!(1234))).map(|body| body.len()), Ok(3));
        assert_eq!(decode_response_body(Some(&json!(true))).map(|body| body.len()), Ok(3));
        assert_eq!(decode_response_body(Some(&json!(["AAAA"]))).map(|body| body.len()), Ok(3));
        assert_eq!(decode_response_body(Some(&json!(12))), Err(BodyRejected::Invalid));
        assert_eq!(decode_response_body(Some(&json!({}))), Err(BodyRejected::Invalid));
    }

    #[test]
    fn base64_decodes_like_buffer_from() {
        assert_eq!(decode_base64(b"aGVsbG8="), b"hello");
        assert_eq!(decode_base64(b"aGVsbA=="), b"hell");
        assert_eq!(decode_base64(b"+/+/"), [0xfb, 0xff, 0xbf]);
        // Trailing bits are ignored: `AB==` is the byte 0x00.
        assert_eq!(decode_base64(b"AB=="), [0x00]);
    }

    #[test]
    fn the_status_is_an_integer_from_100_to_599_else_502() {
        for (value, expected) in [(json!(200), 200), (json!(100), 100), (json!(599), 599), (json!(200.0), 200), (json!(99), 502), (json!(600), 502), (json!(200.5), 502), (json!("200"), 502), (json!(null), 502), (json!(true), 502)] {
            assert_eq!(upstream_status(Some(&value)), expected, "{value}");
        }
        assert_eq!(upstream_status(None), 502);
    }

    #[test]
    fn the_content_type_is_printable_ascii_of_one_to_200_characters() {
        assert_eq!(content_type(Some(&json!({ "content-type": "text/plain; charset=utf-8" }))), "text/plain; charset=utf-8");
        let longest = "a".repeat(200);
        assert_eq!(content_type(Some(&json!({ "content-type": longest }))), longest);
        for headers in [
            json!({ "content-type": "a".repeat(201) }),
            json!({ "content-type": "" }),
            json!({ "content-type": "text/plain\r\nx: y" }),
            json!({ "content-type": "text/é" }),
            json!({ "content-type": 5 }),
            json!({ "Content-Type": "text/plain" }),
            json!({}),
            json!(null),
            json!([]),
        ] {
            assert_eq!(content_type(Some(&headers)), "application/json", "{headers}");
        }
        assert_eq!(content_type(None), "application/json");
    }
}
