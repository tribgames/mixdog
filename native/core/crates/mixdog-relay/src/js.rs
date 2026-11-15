//! The one place JSON and JavaScript string rules live, over `mixdog-js`. Every other module of the relay reads and writes
//! JSON, measures and clips text, and encodes strings for the wire only through these functions.
//!
//! "Parsed text" is the text `JSON.parse` produced, held the way `mixdog_js::json_parse` holds it: a lone surrogate is kept
//! in-band, so a profile name clipped inside an emoji round-trips as the `\ud83d` escape `JSON.stringify` writes.

use std::borrow::Cow;

use mixdog_js::JsonSyntaxError;
use serde_json::Value;

/// `Buffer.toString('utf8')`: invalid sequences become U+FFFD by the maximal-subpart rule.
pub fn decode_utf8(bytes: &[u8]) -> Cow<'_, str> {
    String::from_utf8_lossy(bytes)
}

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Result<Value, JsonSyntaxError> {
    mixdog_js::json_parse(text)
}

/// `JSON.parse(buffer.toString('utf8'))`.
pub fn parse_bytes(bytes: &[u8]) -> Result<Value, JsonSyntaxError> {
    parse(&decode_utf8(bytes))
}

/// `JSON.stringify(value)`: what the relay puts on the wire.
pub fn wire(value: &Value) -> String {
    mixdog_js::json_stringify_indent_parsed(value, 0)
}

/// `JSON.stringify(value, null, 2)`: what the relay writes to its files.
pub fn pretty(value: &Value) -> String {
    mixdog_js::json_stringify_indent_parsed(value, 2)
}

/// `text.length` of parsed text.
pub fn js_len(text: &str) -> usize {
    mixdog_js::json_parsed_utf16(text).len()
}

/// `text.slice(0, n)` of parsed text: a cut inside a surrogate pair keeps the dangling high surrogate in-band.
pub fn js_slice(text: &str, n: usize) -> String {
    let units = mixdog_js::json_parsed_utf16(text);
    mixdog_js::json_parsed_from_utf16(&units[..n.min(units.len())])
}

/// `text.trim()`.
pub fn js_trim(text: &str) -> &str {
    mixdog_js::js_trim(text)
}

/// The bytes `Buffer.from(text)` gives for parsed text: a lone surrogate becomes EF BF BD. For every parsed string the relay
/// sends as a WebSocket text frame, a close reason or an HTTP body.
pub fn node_utf8(text: &str) -> Vec<u8> {
    String::from_utf16_lossy(&mixdog_js::json_parsed_utf16(text)).into_bytes()
}
