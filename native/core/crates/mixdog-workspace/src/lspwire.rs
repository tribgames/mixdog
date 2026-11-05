//! LSP wire helpers: `Content-Length` framing and `file://` URIs.

use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;

/// Incremental frame reader over a byte stream.
#[derive(Default)]
pub struct Framer {
    buffer: Vec<u8>,
}

impl Framer {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Value> {
        self.buffer.extend_from_slice(bytes);
        let mut messages = Vec::new();
        loop {
            let Some(split) = self.buffer.windows(4).position(|w| w == b"\r\n\r\n") else { break };
            let header = String::from_utf8_lossy(&self.buffer[..split]).into_owned();
            let length = header.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.trim().eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
            });
            let Some(length) = length else {
                // A header without a length cannot be framed: drop it and resynchronize.
                self.buffer.drain(..split + 4);
                continue;
            };
            let start = split + 4;
            if self.buffer.len() < start + length {
                break;
            }
            let body: Vec<u8> = self.buffer.drain(..start + length).skip(start).collect();
            if let Ok(value) = serde_json::from_slice::<Value>(&body) {
                messages.push(value);
            }
        }
        messages
    }
}

pub fn frame(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).expect("json-rpc message");
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend(body);
    out
}

const KEEP: &[u8] = b"-._~!$&'()*+,;=:@/";

/// `pathToFileURL`.
pub fn file_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file://");
    if !text.starts_with('/') {
        out.push('/');
    }
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || KEEP.contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `fileURLToPath`; `None` for anything but a `file:` URI.
pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let bytes = rest.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    let text = String::from_utf8(decoded).ok()?;
    if cfg!(windows) {
        let trimmed = text.strip_prefix('/').unwrap_or(&text);
        Some(PathBuf::from(trimmed.replace('/', "\\")))
    } else {
        Some(PathBuf::from(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_split_across_chunks() {
        let a = frame(&json!({"id": 1}));
        let b = frame(&json!({"id": 2}));
        let all = [a, b].concat();
        let mut framer = Framer::default();
        let mut out = framer.push(&all[..10]);
        out.extend(framer.push(&all[10..all.len() - 3]));
        out.extend(framer.push(&all[all.len() - 3..]));
        assert_eq!(out, [json!({"id": 1}), json!({"id": 2})]);
    }

    #[test]
    fn uri_round_trip() {
        let path = if cfg!(windows) { PathBuf::from(r"C:\My Proj\a#b.ts") } else { PathBuf::from("/my proj/a#b.ts") };
        let uri = file_uri(&path);
        assert!(uri.contains("%20") && uri.contains("%23"));
        assert_eq!(uri_to_path(&uri).unwrap(), path);
    }
}
