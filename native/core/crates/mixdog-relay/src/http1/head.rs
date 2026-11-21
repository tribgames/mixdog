//! The request head as Node's parser (llhttp and `IncomingMessage`) hands it to a handler: the limits, what is refused,
//! the header object, and the decisions made from the head alone (keep-alive, upgrade, body framing).

use std::collections::HashMap;

/// `--max-http-header-size`: Node's default. The parser counts the bytes of the target and of every header name and
/// value (`header_nread_`), not the punctuation, and refuses the head once the count reaches this.
pub const MAX_HEADER_BYTES: usize = 16 * 1024;

/// The methods llhttp accepts in HTTP mode (`http.METHODS`).
const METHODS: &[&str] = &[
    "ACL",
    "BIND",
    "CHECKOUT",
    "CONNECT",
    "COPY",
    "DELETE",
    "GET",
    "HEAD",
    "LINK",
    "LOCK",
    "M-SEARCH",
    "MERGE",
    "MKACTIVITY",
    "MKCALENDAR",
    "MKCOL",
    "MOVE",
    "NOTIFY",
    "OPTIONS",
    "PATCH",
    "POST",
    "PROPFIND",
    "PROPPATCH",
    "PURGE",
    "PUT",
    "QUERY",
    "REBIND",
    "REPORT",
    "SEARCH",
    "SOURCE",
    "SUBSCRIBE",
    "TRACE",
    "UNBIND",
    "UNLINK",
    "UNLOCK",
    "UNSUBSCRIBE",
];

/// Header names whose repeated occurrences keep the first (`IncomingMessage._addHeaderLine`).
const SINGLE_VALUED: &[&str] = &[
    "content-type",
    "content-length",
    "user-agent",
    "referer",
    "host",
    "authorization",
    "proxy-authorization",
    "if-modified-since",
    "if-unmodified-since",
    "from",
    "location",
    "max-forwards",
    "retry-after",
    "etag",
    "last-modified",
    "server",
    "age",
    "expires",
];

/// One value of `IncomingMessage.headers`: a string, or the array `set-cookie` collects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderValue {
    One(String),
    Many(Vec<String>),
}

/// `IncomingMessage.headers`: lower-case names in first-appearance order. Values are the latin1 text of the bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Headers {
    entries: Vec<(String, HeaderValue)>,
    index: HashMap<String, usize>,
}

impl Headers {
    /// The string value of a header (`typeof headers[name] === 'string'`): `None` when absent or an array.
    pub fn get(&self, name: &str) -> Option<&str> {
        match self.index.get(name).map(|&i| &self.entries[i].1) {
            Some(HeaderValue::One(value)) => Some(value),
            _ => None,
        }
    }

    pub fn contains(&self, name: &str) -> bool {
        self.index.contains_key(name)
    }

    /// The `set-cookie` array, empty when there is none.
    pub fn set_cookies(&self) -> &[String] {
        match self.index.get("set-cookie").map(|&i| &self.entries[i].1) {
            Some(HeaderValue::Many(values)) => values,
            _ => &[],
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &HeaderValue)> {
        self.entries.iter().map(|(name, value)| (name.as_str(), value))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// `_addHeaderLine`: `name` is lower case.
    pub fn add(&mut self, name: &str, value: String) {
        let Some(&at) = self.index.get(name) else {
            let stored = if name == "set-cookie" { HeaderValue::Many(vec![value]) } else { HeaderValue::One(value) };
            self.index.insert(name.to_owned(), self.entries.len());
            self.entries.push((name.to_owned(), stored));
            return;
        };
        match &mut self.entries[at].1 {
            HeaderValue::Many(values) => values.push(value),
            HeaderValue::One(_) if SINGLE_VALUED.contains(&name) => {}
            HeaderValue::One(existing) => {
                existing.push_str(if name == "cookie" { "; " } else { ", " });
                existing.push_str(&value);
            }
        }
    }
}

/// How the request body is framed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    None,
    Length(u64),
    Chunked,
}

/// Why a head is refused: both answer with a raw status line (`431` or `400`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadError {
    /// `HPE_HEADER_OVERFLOW`.
    Overflow,
    /// Any other parser error.
    Malformed,
}

/// A complete request head.
#[derive(Debug, Clone)]
pub struct ParsedHead {
    pub method: String,
    /// `request.url`: the target exactly as sent.
    pub target: String,
    /// The minor version of `HTTP/1.x`.
    pub minor: u8,
    pub headers: Headers,
    /// The bytes the head took, blank lines before the request line included.
    pub head_len: usize,
    pub framing: Framing,
    /// llhttp's `should_keep_alive`.
    pub keep_alive: bool,
    /// llhttp's upgrade decision: `Connection: upgrade` and any `Upgrade` header, or `CONNECT`.
    pub upgrade: bool,
}

#[derive(Debug)]
pub enum Parse {
    Partial,
    Head(Box<ParsedHead>),
    Refused(HeadError),
}

/// Parses the head at the start of `buf`.
pub fn parse(buf: &[u8], max_header_bytes: usize) -> Parse {
    let (tracked, complete) = tracked_len(buf);
    if tracked >= max_header_bytes {
        return Parse::Refused(HeadError::Overflow);
    }
    if !complete && buf.len() > max_header_bytes.saturating_mul(4) {
        return Parse::Refused(HeadError::Overflow);
    }
    let mut capacity = 64;
    loop {
        let mut slots = vec![httparse::EMPTY_HEADER; capacity];
        let mut request = httparse::Request::new(&mut slots);
        match request.parse(buf) {
            Ok(httparse::Status::Complete(head_len)) => {
                return match build(&request, head_len) {
                    Ok(head) => Parse::Head(Box::new(head)),
                    Err(error) => Parse::Refused(error),
                };
            }
            Ok(httparse::Status::Partial) => return Parse::Partial,
            Err(httparse::Error::TooManyHeaders) if capacity < 8192 => capacity *= 8,
            Err(_) => return Parse::Refused(HeadError::Malformed),
        }
    }
}

/// The bytes the parser counts toward the header limit in `buf` (the target, and each header's name and trimmed value; a
/// line still being received counts whole) and whether the head's blank line has been seen.
fn tracked_len(buf: &[u8]) -> (usize, bool) {
    let mut total = 0;
    let mut pos = 0;
    let mut first = true;
    while pos < buf.len() {
        let rest = &buf[pos..];
        let (line, advance, terminated) = match rest.iter().position(|&b| b == b'\n') {
            Some(i) => (&rest[..i], i + 1, true),
            None => (rest, rest.len(), false),
        };
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        pos += advance;
        if line.is_empty() && terminated {
            if first {
                continue;
            }
            return (total, true);
        }
        if first {
            let mut parts = line.split(|&b| b == b' ');
            parts.next();
            total += parts.next().map_or(0, <[u8]>::len);
            first = false;
        } else if let Some(colon) = line.iter().position(|&b| b == b':') {
            total += colon + trim_ows(&line[colon + 1..]).len();
        } else {
            total += line.len();
        }
    }
    (total, false)
}

fn trim_ows(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|&b| b != b' ' && b != b'\t').unwrap_or(bytes.len());
    let end = bytes.iter().rposition(|&b| b != b' ' && b != b'\t').map_or(start, |i| i + 1);
    &bytes[start..end]
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

fn has_token(value: &str, token: &str) -> bool {
    value.split(',').any(|part| part.trim().eq_ignore_ascii_case(token))
}

fn framing_of(content_length: Option<u64>, transfer_encoding: Option<String>) -> Result<Framing, HeadError> {
    match (content_length, transfer_encoding) {
        (Some(_), Some(_)) => Err(HeadError::Malformed),
        (None, Some(coding)) => {
            let last = coding.rsplit(',').next().map_or("", str::trim);
            if last.eq_ignore_ascii_case("chunked") { Ok(Framing::Chunked) } else { Err(HeadError::Malformed) }
        }
        (Some(0), None) | (None, None) => Ok(Framing::None),
        (Some(length), None) => Ok(Framing::Length(length)),
    }
}

fn build(request: &httparse::Request<'_, '_>, head_len: usize) -> Result<ParsedHead, HeadError> {
    let method = request.method.ok_or(HeadError::Malformed)?;
    if !METHODS.contains(&method) {
        return Err(HeadError::Malformed);
    }
    let minor = request.version.ok_or(HeadError::Malformed)?;
    let mut headers = Headers::default();
    let mut content_length: Option<u64> = None;
    let mut transfer_encoding: Option<String> = None;
    let (mut connection_close, mut connection_keep_alive, mut connection_upgrade, mut upgrade_header) = (false, false, false, false);
    for header in request.headers.iter() {
        let name = header.name.to_ascii_lowercase();
        let value = latin1(trim_ows(header.value));
        match name.as_str() {
            "content-length" => {
                if content_length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(HeadError::Malformed);
                }
                content_length = Some(value.parse::<u64>().map_err(|_| HeadError::Malformed)?);
            }
            "transfer-encoding" => transfer_encoding = Some(value.clone()),
            "connection" => {
                connection_close |= has_token(&value, "close");
                connection_keep_alive |= has_token(&value, "keep-alive");
                connection_upgrade |= has_token(&value, "upgrade");
            }
            "upgrade" => upgrade_header = true,
            _ => {}
        }
        headers.add(&name, value);
    }
    let framing = framing_of(content_length, transfer_encoding)?;
    let keep_alive = if minor == 1 { !connection_close } else { connection_keep_alive };
    Ok(ParsedHead {
        method: method.to_owned(),
        target: request.path.ok_or(HeadError::Malformed)?.to_owned(),
        minor,
        headers,
        head_len,
        framing,
        keep_alive,
        upgrade: method == "CONNECT" || (connection_upgrade && upgrade_header),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(text: &str) -> ParsedHead {
        match parse(text.as_bytes(), MAX_HEADER_BYTES) {
            Parse::Head(head) => *head,
            other => panic!("not a head: {other:?}"),
        }
    }

    #[test]
    fn duplicate_headers_follow_the_rules_of_the_header_object() {
        let parsed = head(
            "GET /a?b=1 HTTP/1.1\r\nHost: h\r\nX-A: 1\r\nUser-Agent: one\r\nx-a: 2\r\nUser-Agent: two\r\nCookie: a=1\r\nCookie: b=2\r\nSet-Cookie: s\r\nSet-Cookie: t\r\n\r\n",
        );
        assert_eq!(parsed.headers.get("x-a"), Some("1, 2"));
        assert_eq!(parsed.headers.get("user-agent"), Some("one"));
        assert_eq!(parsed.headers.get("cookie"), Some("a=1; b=2"));
        assert_eq!(parsed.headers.set_cookies(), ["s".to_owned(), "t".to_owned()]);
        assert_eq!(parsed.headers.iter().map(|(name, _)| name).collect::<Vec<_>>(), ["host", "x-a", "user-agent", "cookie", "set-cookie"]);
        assert_eq!(parsed.target, "/a?b=1");
    }

    #[test]
    fn the_head_length_and_the_framing_are_read_from_the_head() {
        let parsed = head("POST /p HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\n\r\nbody");
        assert_eq!(parsed.framing, Framing::Length(4));
        assert_eq!(parsed.head_len, "POST /p HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\n\r\n".len());
        assert_eq!(head("POST /p HTTP/1.1\r\nTransfer-Encoding: gzip, Chunked\r\n\r\n").framing, Framing::Chunked);
        assert_eq!(head("GET / HTTP/1.1\r\n\r\n").framing, Framing::None);
    }

    #[test]
    fn keep_alive_and_upgrade_are_llhttps_decisions() {
        assert!(head("GET / HTTP/1.1\r\n\r\n").keep_alive);
        assert!(!head("GET / HTTP/1.1\r\nConnection: close\r\n\r\n").keep_alive);
        assert!(!head("GET / HTTP/1.0\r\n\r\n").keep_alive);
        assert!(head("GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n").keep_alive);
        assert!(head("GET / HTTP/1.1\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\n\r\n").upgrade);
        assert!(!head("GET / HTTP/1.1\r\nConnection: upgrade\r\n\r\n").upgrade);
        assert!(!head("GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n").upgrade);
        assert!(head("CONNECT h:443 HTTP/1.1\r\n\r\n").upgrade);
    }

    #[test]
    fn what_llhttp_refuses_is_refused() {
        for text in [
            "GARBAGE\r\n\r\n",
            "FOO / HTTP/1.1\r\n\r\n",
            "GET / HTTP/1.1\r\nBad Header\r\n\r\n",
            "POST / HTTP/1.1\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n",
            "POST / HTTP/1.1\r\nContent-Length: x\r\n\r\n",
            "POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n",
            "POST / HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n",
            "GET / HTTP/2.0\r\n\r\n",
        ] {
            assert!(matches!(parse(text.as_bytes(), MAX_HEADER_BYTES), Parse::Refused(HeadError::Malformed)), "{text:?}");
        }
    }

    #[test]
    fn a_head_is_too_large_by_the_bytes_of_its_target_names_and_values() {
        let value = "a".repeat(MAX_HEADER_BYTES);
        let complete = format!("GET / HTTP/1.1\r\nHost: h\r\nX-Big: {value}\r\n\r\n");
        assert!(matches!(parse(complete.as_bytes(), MAX_HEADER_BYTES), Parse::Refused(HeadError::Overflow)));
        let partial = format!("GET / HTTP/1.1\r\nHost: h\r\nX-Big: {value}");
        assert!(matches!(parse(partial.as_bytes(), MAX_HEADER_BYTES), Parse::Refused(HeadError::Overflow)));
        let fits = format!("GET / HTTP/1.1\r\nHost: h\r\nX-Big: {}\r\n\r\n", "a".repeat(MAX_HEADER_BYTES - 100));
        assert!(matches!(parse(fits.as_bytes(), MAX_HEADER_BYTES), Parse::Head(_)));
    }

    #[test]
    fn an_incomplete_head_waits_and_blank_lines_before_it_are_skipped() {
        assert!(matches!(parse(b"GET / HTTP/1.1\r\nHost: h", MAX_HEADER_BYTES), Parse::Partial));
        let parsed = head("\r\n\r\nGET / HTTP/1.1\r\n\r\n");
        assert_eq!(parsed.method, "GET");
        assert_eq!(parsed.head_len, 4 + "GET / HTTP/1.1\r\n\r\n".len());
    }

    #[test]
    fn header_values_are_latin1_text_without_the_white_space_around_them() {
        let parsed = parse(b"GET / HTTP/1.1\r\nX-Pad:   v\xe9 \t\r\n\r\n", MAX_HEADER_BYTES);
        let Parse::Head(parsed) = parsed else { panic!("not a head") };
        assert_eq!(parsed.headers.get("x-pad"), Some("v\u{e9}"));
    }
}
