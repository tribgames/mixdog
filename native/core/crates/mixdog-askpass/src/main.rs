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
    // Every instance of the pipe busy: wait for one and try again for up to 30 s, as Node's pipe connect (libuv,
    // WaitNamedPipe) does, then give up.
    const ERROR_PIPE_BUSY: i32 = 231;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(endpoint) {
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            result => return result,
        }
    }
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
    let prompt = std::env::args_os().skip(1).map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
    let Some(secret) = ask(&endpoint, &token, &prompt, identity()) else {
        return ExitCode::from(1);
    };
    let mut out = std::io::stdout().lock();
    if out.write_all(secret.as_bytes()).and_then(|()| out.write_all(b"\n")).and_then(|()| out.flush()).is_ok() { ExitCode::SUCCESS } else { ExitCode::from(1) }
}

/// Which ssh invocation this helper was spawned for (the number the session put in its environment) and which process ran it
/// (the ssh that asks: a jump host's ssh is another process of the same invocation); sent so a question is told from the
/// same question of another authentication. `None` without the number.
fn identity() -> Option<(u64, u64)> {
    let child = std::env::var("MIXDOG_ASKPASS_CHILD").ok()?.parse().ok()?;
    Some((child, u64::from(parent_process())))
}

#[cfg(unix)]
fn parent_process() -> u32 {
    std::os::unix::process::parent_id()
}

/// The parent of this process from the toolhelp snapshot; 0 when it cannot be read.
#[cfg(windows)]
fn parent_process() -> u32 {
    use core::ffi::c_void;
    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        usage: u32,
        process_id: u32,
        heap_id: usize,
        module_id: u32,
        threads: u32,
        parent_process_id: u32,
        priority: i32,
        flags: u32,
        exe_file: [u16; 260],
    }
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    const TH32CS_SNAPPROCESS: u32 = 2;
    let me = std::process::id();
    // SAFETY: the snapshot handle is checked, closed on every path, and `entry` is a zeroed plain-data struct with its size set.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot as isize == -1 {
            return 0;
        }
        let mut entry: ProcessEntry = core::mem::zeroed();
        entry.size = core::mem::size_of::<ProcessEntry>() as u32;
        let mut parent = 0;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            if entry.process_id == me {
                parent = entry.parent_process_id;
                break;
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        parent
    }
}
/// The secret the desktop answered with, or `None` for a refusal, a closed endpoint or an unreadable reply.
fn ask(endpoint: &str, token: &str, prompt: &str, who: Option<(u64, u64)>) -> Option<String> {
    let mut stream = connect(endpoint).ok()?;
    stream.write_all(request_line(token, prompt, who).as_bytes()).ok()?;
    stream.flush().ok()?;
    let mut line = Vec::new();
    BufReader::new(stream.take(MAX_REPLY_BYTES)).read_until(b'\n', &mut line).ok()?;
    if line.pop() != Some(b'\n') {
        return None;
    }
    parse_reply(std::str::from_utf8(&line).ok()?)
}

/// `{"token":..,"prompt":..}` (plus `"child"` and `"process"` when given) and a newline, at most [`MAX_REQUEST_BYTES`] long.
/// A question too long for that is cut to its longest prefix of whole characters that fits beside the fixed parts, which stay.
fn request_line(token: &str, prompt: &str, who: Option<(u64, u64)>) -> String {
    let who = who.map(|(child, process)| format!(",\"child\":{child},\"process\":{process}")).unwrap_or_default();
    let line = |prompt: &str| format!("{{\"token\":{},\"prompt\":{}{who}}}\n", quote(token), quote(prompt));
    let whole = line(prompt);
    if whole.len() <= MAX_REQUEST_BYTES {
        return whole;
    }
    // Escaping makes the text longer by up to six times, so what is cut is counted in the bytes each character takes quoted.
    let mut room = MAX_REQUEST_BYTES.saturating_sub(line("").len());
    let mut end = 0;
    for (at, c) in prompt.char_indices() {
        let width = quote(c.encode_utf8(&mut [0; 4])).len() - 2;
        if width > room {
            break;
        }
        room -= width;
        end = at + c.len_utf8();
    }
    line(&prompt[..end])
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
        let long = "é\u{1}".repeat(100_000);
        let line = request_line("t", &long, None);
        assert!(line.len() <= MAX_REQUEST_BYTES && line.ends_with("\"}\n"));
        assert!(line.len() > MAX_REQUEST_BYTES - 200 && line.contains("\"prompt\":\"é"), "the question is cut, never dropped");
        // With the identity fields the question is what is cut: they stay whole at the end, inside the same budget.
        let line = request_line("t", &long, Some((3, 4)));
        assert!(line.len() <= MAX_REQUEST_BYTES, "{}", line.len());
        assert!(line.ends_with("\",\"child\":3,\"process\":4}\n"));
        // A cut that would land inside a two-byte character moves back to its start: the text is a whole-character prefix.
        let start = line.find("\"prompt\":\"").unwrap() + "\"prompt\":\"".len();
        let shown = &line[start..line.len() - "\",\"child\":3,\"process\":4}\n".len()];
        assert!(shown.starts_with("é\\u0001é"), "the question was cut to nothing or mangled: {shown:.20}");
        assert!(shown.len() > MAX_REQUEST_BYTES - 200);
        let odd = request_line("t", &"é".repeat(40_000), Some((u64::MAX, u64::MAX)));
        assert!(odd.len() <= MAX_REQUEST_BYTES && odd.ends_with(&format!("\"child\":{},\"process\":{}}}\n", u64::MAX, u64::MAX)));
        assert_eq!(request_line("t", "p", None), "{\"token\":\"t\",\"prompt\":\"p\"}\n");
        assert_eq!(request_line("t", "p", Some((3, 4))), "{\"token\":\"t\",\"prompt\":\"p\",\"child\":3,\"process\":4}\n");
    }

    #[test]
    fn reply_needs_ok_true_and_a_string_secret() {
        assert_eq!(parse_reply(r#"{"ok":true,"secret":"päss😀 \"x\""}"#).as_deref(), Some("päss😀 \"x\""));
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
