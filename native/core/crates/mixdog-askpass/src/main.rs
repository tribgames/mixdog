//! The helper ssh runs as `SSH_ASKPASS`: it asks the desktop (token + prompt over a local endpoint), prints the answer
//! and exits 0, and exits 1 when the user cancelled, the endpoint is gone or the reply is not an accepted one.
//!
//! Wire (the one `ssh-auth.ts` serves): `argv[1..]` joined with spaces is the prompt; `MIXDOG_ASKPASS_ENDPOINT` is a
//! named pipe (`\\.\pipe\mixdog-askpass-<24 hex>`) on Windows and a unix socket path elsewhere, `MIXDOG_ASKPASS_TOKEN`
//! the token. One line `{"token":..,"prompt":..}` goes out, one line `{"ok":bool,"secret":string}` comes back. The
//! secret is only ever written to stdout; nothing is logged. Exit 2 when either variable is missing. The request is
//! capped at 64 KiB (the prompt is cut at a character boundary to fit). The console subsystem is kept on purpose: ssh
//! reads the answer from stdout; the parent spawns the helper hidden.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::ExitCode;

/// The largest request line the desktop accepts.
const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// A reply line longer than this is not one the desktop sends.
const MAX_REPLY_BYTES: u64 = 1024 * 1024;

#[cfg(windows)]
type Stream = std::fs::File;
#[cfg(unix)]
type Stream = std::os::unix::net::UnixStream;

#[cfg(windows)]
fn connect(endpoint: &str) -> std::io::Result<Stream> {
    std::fs::OpenOptions::new().read(true).write(true).open(endpoint)
}

#[cfg(unix)]
fn connect(endpoint: &str) -> std::io::Result<Stream> {
    std::os::unix::net::UnixStream::connect(endpoint)
}

fn main() -> ExitCode {
    let endpoint = std::env::var("MIXDOG_ASKPASS_ENDPOINT").unwrap_or_default();
    let token = std::env::var("MIXDOG_ASKPASS_TOKEN").unwrap_or_default();
    if endpoint.is_empty() || token.is_empty() {
        return ExitCode::from(2);
    }
    let prompt = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    let Some(secret) = ask(&endpoint, &token, &prompt) else {
        return ExitCode::from(1);
    };
    let mut out = std::io::stdout().lock();
    if out.write_all(secret.as_bytes()).and_then(|()| out.write_all(b"\n")).and_then(|()| out.flush()).is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

/// The secret the desktop answered with, or `None` for a refusal, a closed endpoint or an unreadable reply.
fn ask(endpoint: &str, token: &str, prompt: &str) -> Option<String> {
    let mut stream = connect(endpoint).ok()?;
    stream.write_all(request_line(token, prompt).as_bytes()).ok()?;
    stream.flush().ok()?;
    let mut line = Vec::new();
    BufReader::new(stream.take(MAX_REPLY_BYTES)).read_until(b'\n', &mut line).ok()?;
    if line.pop() != Some(b'\n') {
        return None;
    }
    parse_reply(std::str::from_utf8(&line).ok()?)
}

/// `{"token":..,"prompt":..}` plus a newline, at most [`MAX_REQUEST_BYTES`] long.
fn request_line(token: &str, prompt: &str) -> String {
    let mut prompt = prompt;
    loop {
        let line = format!("{{\"token\":{},\"prompt\":{}}}\n", quote(token), quote(prompt));
        if line.len() <= MAX_REQUEST_BYTES {
            return line;
        }
        // Cut by at least the excess (escaping only makes the text longer), then measure again.
        let mut end = prompt.len().saturating_sub(line.len() - MAX_REQUEST_BYTES);
        while !prompt.is_char_boundary(end) {
            end -= 1;
        }
        prompt = &prompt[..end];
    }
}

fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A reply is accepted only as an object whose `ok` is `true` and whose `secret` is a string (the last of a repeated
/// key wins, as in `JSON.parse`).
fn parse_reply(text: &str) -> Option<String> {
    let Json::Object(members) = (Parser { text, at: 0 }).document()? else {
        return None;
    };
    let get = |key: &str| members.iter().rev().find(|(name, _)| name == key).map(|(_, value)| value);
    match (get("ok"), get("secret")) {
        (Some(Json::Bool(true)), Some(Json::String(secret))) => Some(secret.clone()),
        _ => None,
    }
}

enum Json {
    Null,
    Bool(bool),
    Number,
    String(String),
    Array,
    Object(Vec<(String, Json)>),
}

/// A strict reader of the subset of `JSON.parse` the reply needs: only strings, booleans and objects are kept.
struct Parser<'a> {
    text: &'a str,
    at: usize,
}

impl Parser<'_> {
    fn document(mut self) -> Option<Json> {
        let value = self.value(0)?;
        self.space();
        (self.at == self.text.len()).then_some(value)
    }

    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }

    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn eat(&mut self, byte: u8) -> Option<()> {
        self.space();
        (self.peek() == Some(byte)).then(|| self.at += 1)
    }

    fn word(&mut self, word: &str) -> Option<()> {
        self.text[self.at..].starts_with(word).then(|| self.at += word.len())
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        if depth > 64 {
            return None;
        }
        self.space();
        match self.peek()? {
            b'{' => {
                self.at += 1;
                let mut members = Vec::new();
                if self.eat(b'}').is_some() {
                    return Some(Json::Object(members));
                }
                loop {
                    self.space();
                    let key = self.string()?;
                    self.eat(b':')?;
                    members.push((key, self.value(depth + 1)?));
                    if self.eat(b',').is_none() {
                        self.eat(b'}')?;
                        return Some(Json::Object(members));
                    }
                }
            }
            b'[' => {
                self.at += 1;
                if self.eat(b']').is_some() {
                    return Some(Json::Array);
                }
                loop {
                    self.value(depth + 1)?;
                    if self.eat(b',').is_none() {
                        self.eat(b']')?;
                        return Some(Json::Array);
                    }
                }
            }
            b'"' => self.string().map(Json::String),
            b't' => self.word("true").map(|()| Json::Bool(true)),
            b'f' => self.word("false").map(|()| Json::Bool(false)),
            b'n' => self.word("null").map(|()| Json::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn number(&mut self) -> Option<Json> {
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek()? {
            b'0' => self.at += 1,
            b'1'..=b'9' => self.digits(),
            _ => return None,
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            let before = self.at;
            self.digits();
            (self.at > before).then_some(())?;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            let before = self.at;
            self.digits();
            (self.at > before).then_some(())?;
        }
        Some(Json::Number)
    }

    fn digits(&mut self) {
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
    }

    fn hex4(&mut self) -> Option<u16> {
        let digits = self.text.get(self.at..self.at + 4)?;
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        self.at += 4;
        u16::from_str_radix(digits, 16).ok()
    }

    fn string(&mut self) -> Option<String> {
        (self.peek() == Some(b'"')).then(|| self.at += 1)?;
        let mut units: Vec<u16> = Vec::new();
        let mut text = String::new();
        loop {
            match self.peek()? {
                b'"' => {
                    self.at += 1;
                    flush(&mut units, &mut text);
                    return Some(text);
                }
                0..=0x1f => return None,
                b'\\' => {
                    self.at += 1;
                    let escape = self.peek()?;
                    self.at += 1;
                    let plain = match escape {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            // Kept as UTF-16 units so a surrogate pair written as two escapes joins.
                            units.push(self.hex4()?);
                            continue;
                        }
                        _ => return None,
                    };
                    flush(&mut units, &mut text);
                    text.push(plain);
                }
                _ => {
                    flush(&mut units, &mut text);
                    let c = self.text[self.at..].chars().next()?;
                    text.push(c);
                    self.at += c.len_utf8();
                }
            }
        }
    }
}

/// Appends pending UTF-16 units as text; a lone surrogate becomes U+FFFD (what a UTF-8 write of it gives in Node).
fn flush(units: &mut Vec<u16>, text: &mut String) {
    text.extend(char::decode_utf16(units.drain(..)).map(|c| c.unwrap_or('\u{fffd}')));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_matches_json_stringify() {
        assert_eq!(quote("a\"b\\c\n\u{1}é"), "\"a\\\"b\\\\c\\n\\u0001é\"");
    }

    #[test]
    fn request_is_capped_on_a_character_boundary() {
        let line = request_line("t", &"é\u{1}".repeat(100_000));
        assert!(line.len() <= MAX_REQUEST_BYTES && line.ends_with("\"}\n"));
        assert_eq!(request_line("t", "p"), "{\"token\":\"t\",\"prompt\":\"p\"}\n");
    }

    #[test]
    fn reply_needs_ok_true_and_a_string_secret() {
        assert_eq!(
            parse_reply(r#"{"ok":true,"secret":"päss😀 \"x\""}"#).as_deref(),
            Some("päss😀 \"x\"")
        );
        assert_eq!(parse_reply(r#"{"extra":[1,{"a":null}],"secret":"s","ok":true}"#).as_deref(), Some("s"));
        for bad in [
            r#"{"ok":false,"secret":"s"}"#,
            r#"{"ok":true}"#,
            r#"{"ok":true,"secret":1}"#,
            r#"{"ok":"true","secret":"s"}"#,
            "[]",
            "",
            r#"{"ok":true,"secret":"s"} x"#,
            r#"{"ok":true,"secret":"a"#,
        ] {
            assert_eq!(parse_reply(bad), None, "{bad}");
        }
    }
}
