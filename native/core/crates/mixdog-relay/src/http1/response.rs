//! The response a handler writes, byte for byte as Node's `ServerResponse` writes it: the handler's headers in the order and
//! spelling it gave them, then `Date`, then the `Connection` decision, then `Content-Length` or `Transfer-Encoding`.

use std::fmt;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use bytes::Bytes;

use super::conn::{ConnHandle, Shared};

/// `socket.writableHighWaterMark`: `write` answers `false` once this much is waiting to be sent.
pub const HIGH_WATER_MARK: usize = 16 * 1024;

/// `http.STATUS_CODES`.
const STATUS_CODES: &[(u16, &str)] = &[
    (100, "Continue"),
    (101, "Switching Protocols"),
    (102, "Processing"),
    (103, "Early Hints"),
    (200, "OK"),
    (201, "Created"),
    (202, "Accepted"),
    (203, "Non-Authoritative Information"),
    (204, "No Content"),
    (205, "Reset Content"),
    (206, "Partial Content"),
    (207, "Multi-Status"),
    (208, "Already Reported"),
    (226, "IM Used"),
    (300, "Multiple Choices"),
    (301, "Moved Permanently"),
    (302, "Found"),
    (303, "See Other"),
    (304, "Not Modified"),
    (305, "Use Proxy"),
    (307, "Temporary Redirect"),
    (308, "Permanent Redirect"),
    (400, "Bad Request"),
    (401, "Unauthorized"),
    (402, "Payment Required"),
    (403, "Forbidden"),
    (404, "Not Found"),
    (405, "Method Not Allowed"),
    (406, "Not Acceptable"),
    (407, "Proxy Authentication Required"),
    (408, "Request Timeout"),
    (409, "Conflict"),
    (410, "Gone"),
    (411, "Length Required"),
    (412, "Precondition Failed"),
    (413, "Payload Too Large"),
    (414, "URI Too Long"),
    (415, "Unsupported Media Type"),
    (416, "Range Not Satisfiable"),
    (417, "Expectation Failed"),
    (418, "I'm a Teapot"),
    (421, "Misdirected Request"),
    (422, "Unprocessable Entity"),
    (423, "Locked"),
    (424, "Failed Dependency"),
    (425, "Too Early"),
    (426, "Upgrade Required"),
    (428, "Precondition Required"),
    (429, "Too Many Requests"),
    (431, "Request Header Fields Too Large"),
    (451, "Unavailable For Legal Reasons"),
    (500, "Internal Server Error"),
    (501, "Not Implemented"),
    (502, "Bad Gateway"),
    (503, "Service Unavailable"),
    (504, "Gateway Timeout"),
    (505, "HTTP Version Not Supported"),
    (506, "Variant Also Negotiates"),
    (507, "Insufficient Storage"),
    (508, "Loop Detected"),
    (509, "Bandwidth Limit Exceeded"),
    (510, "Not Extended"),
    (511, "Network Authentication Required"),
];

/// `http.STATUS_CODES[code] || 'unknown'`.
pub fn status_message(code: u16) -> &'static str {
    STATUS_CODES.iter().find(|(known, _)| *known == code).map_or("unknown", |(_, text)| text)
}

/// What Node throws where the handler gave an invalid header or called a method too late.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderError {
    /// `ERR_HTTP_HEADERS_SENT`.
    HeadersSent,
    /// `ERR_INVALID_HTTP_TOKEN`: the name is not a token.
    InvalidName(String),
    /// `ERR_INVALID_CHAR`: the value holds a character a header cannot carry.
    InvalidValue(String),
    /// `ERR_HTTP_INVALID_STATUS_CODE`.
    InvalidStatus(u16),
}

impl fmt::Display for HeaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HeadersSent => f.write_str("Cannot write headers after they are sent to the client"),
            Self::InvalidName(name) => write!(f, "Header name must be a valid HTTP token [\"{name}\"]"),
            Self::InvalidValue(name) => write!(f, "Invalid character in header content [\"{name}\"]"),
            Self::InvalidStatus(code) => write!(f, "Invalid status code: {code}"),
        }
    }
}

/// What the response needs to know of its request.
#[derive(Debug, Clone)]
pub(crate) struct ResponseMeta {
    /// `HEAD`: the head is answered in full and no body follows.
    pub head_request: bool,
    /// `res.shouldKeepAlive` as the parser decided it.
    pub keep_alive: bool,
    /// `useChunkedEncodingByDefault`: HTTP/1.1, or `TE: chunked` on HTTP/1.0.
    pub chunked_by_default: bool,
    /// `Math.floor(server.keepAliveTimeout / 1000)`, the value of `Keep-Alive: timeout=`.
    pub keep_alive_secs: u64,
}

#[derive(Debug, Clone)]
struct OutHeader {
    name: String,
    lower: String,
    values: Vec<String>,
}

fn is_token(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// `checkInvalidHeaderChar`: only tab, the printable ASCII and latin1 characters pass.
fn valid_value(value: &str) -> bool {
    value.chars().all(|c| c == '\t' || ('\u{20}'..='\u{7e}').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c))
}

/// `/(?:^|\W)word(?:$|\W)/i` for a lower-case ASCII word.
pub(crate) fn has_word(value: &str, word: &str) -> bool {
    let bytes = value.as_bytes();
    let lower = value.to_ascii_lowercase();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    lower.match_indices(word).any(|(at, _)| {
        let before = at == 0 || !is_word(bytes[at - 1]);
        let after = at + word.len() >= bytes.len() || !is_word(bytes[at + word.len()]);
        before && after
    })
}

fn push_latin1(out: &mut Vec<u8>, text: &str) {
    out.extend(text.chars().map(|c| c as u8));
}

/// The response of one request. Everything written goes to the connection in order; the connection decides, from the head
/// it composed, whether it serves another request afterwards. Dropping a response that was never ended closes the
/// connection (nothing is left that could end it).
#[derive(Debug)]
pub struct ResponseWriter {
    shared: Arc<Shared>,
    epoch: u64,
    meta: ResponseMeta,
    status: u16,
    status_message: Option<String>,
    headers: Vec<OutHeader>,
    should_keep_alive: bool,
    last: bool,
    chunked: bool,
    has_body: bool,
    content_length: Option<u64>,
    send_date: bool,
    default_keep_alive: bool,
    removed_connection: bool,
    removed_content_length: bool,
    removed_transfer_encoding: bool,
    head_written: bool,
    ended: bool,
}

impl ResponseWriter {
    pub(crate) fn new(shared: Arc<Shared>, epoch: u64, meta: ResponseMeta) -> Self {
        Self {
            shared,
            epoch,
            status: 200,
            status_message: None,
            headers: Vec::new(),
            should_keep_alive: meta.keep_alive,
            last: false,
            chunked: false,
            has_body: !meta.head_request,
            content_length: None,
            send_date: true,
            default_keep_alive: true,
            removed_connection: false,
            removed_content_length: false,
            removed_transfer_encoding: false,
            head_written: false,
            ended: false,
            meta,
        }
    }

    /// The connection this response goes out on.
    pub fn conn(&self) -> ConnHandle {
        ConnHandle::new(self.shared.clone())
    }

    /// `response.statusCode = code`.
    pub fn set_status(&mut self, code: u16) -> Result<(), HeaderError> {
        if self.head_written {
            return Err(HeaderError::HeadersSent);
        }
        if !(100..=999).contains(&code) {
            return Err(HeaderError::InvalidStatus(code));
        }
        self.status = code;
        Ok(())
    }

    /// `response.statusMessage = text`.
    pub fn set_status_message(&mut self, text: &str) {
        self.status_message = Some(text.to_owned());
    }

    /// `response.setHeader(name, value)`: replaces the header in place, taking the new spelling of its name.
    pub fn set_header(&mut self, name: &str, value: &str) -> Result<(), HeaderError> {
        self.set_header_values(name, &[value])
    }

    /// `response.setHeader(name, [values])`: one line per value (`Set-Cookie`); a `Cookie` array is joined with `; `.
    pub fn set_header_values(&mut self, name: &str, values: &[&str]) -> Result<(), HeaderError> {
        if self.head_written {
            return Err(HeaderError::HeadersSent);
        }
        if !is_token(name) {
            return Err(HeaderError::InvalidName(name.to_owned()));
        }
        if !values.iter().all(|value| valid_value(value)) {
            return Err(HeaderError::InvalidValue(name.to_owned()));
        }
        let lower = name.to_ascii_lowercase();
        let entry = OutHeader { name: name.to_owned(), lower: lower.clone(), values: values.iter().map(|v| (*v).to_owned()).collect() };
        match self.headers.iter_mut().find(|h| h.lower == lower) {
            Some(existing) => *existing = entry,
            None => self.headers.push(entry),
        }
        Ok(())
    }

    /// `response.getHeader(name)` for a single-valued header.
    pub fn get_header(&self, name: &str) -> Option<&str> {
        let lower = name.to_ascii_lowercase();
        self.headers.iter().find(|h| h.lower == lower).and_then(|h| h.values.first()).map(String::as_str)
    }

    pub fn has_header(&self, name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        self.headers.iter().any(|h| h.lower == lower)
    }

    /// `response.removeHeader(name)`.
    pub fn remove_header(&mut self, name: &str) {
        if self.head_written {
            return;
        }
        let lower = name.to_ascii_lowercase();
        match lower.as_str() {
            "connection" => self.removed_connection = true,
            "content-length" => self.removed_content_length = true,
            "transfer-encoding" => self.removed_transfer_encoding = true,
            "date" => self.send_date = false,
            _ => {}
        }
        self.headers.retain(|h| h.lower != lower);
    }

    /// `response.headersSent`.
    pub fn headers_sent(&self) -> bool {
        self.head_written
    }

    /// `response.writeHead(status, headers)`: the head is composed now, from the headers set so far and these.
    pub fn write_head(&mut self, status: u16, headers: &[(&str, &str)]) -> Result<(), HeaderError> {
        if self.head_written {
            return Err(HeaderError::HeadersSent);
        }
        self.set_status(status)?;
        for (name, value) in headers {
            self.set_header(name, value)?;
        }
        self.store_head();
        Ok(())
    }

    /// `response.write(chunk)`: sends the head first if it has not gone. `false` means the buffer is at its high water mark:
    /// wait for [`drain`](Self::drain).
    pub fn write(&mut self, data: &[u8]) -> bool {
        if self.ended || self.shared.lock().destroyed {
            return false;
        }
        if !self.head_written {
            self.store_head();
        }
        self.send_body(data)
    }

    /// `response.end(data)`. With no head sent yet the body's length becomes the `Content-Length`.
    pub fn end(&mut self, data: Option<&[u8]>) {
        if self.ended {
            return;
        }
        if !self.head_written {
            self.content_length = Some(data.map_or(0, |d| d.len() as u64));
            self.store_head();
        }
        if let Some(data) = data {
            self.send_body(data);
        }
        if self.has_body && self.chunked {
            self.push(Bytes::from_static(b"0\r\n\r\n"));
        }
        self.ended = true;
        let mut out = self.shared.lock();
        out.ended = true;
        drop(out);
        self.shared.notify();
    }

    /// `response.destroy()`: closes the connection at once.
    pub fn destroy(&self) {
        self.conn().destroy();
    }

    /// `response.writableLength`: bytes accepted and not yet written to the socket.
    pub fn writable_length(&self) -> usize {
        self.shared.lock().queued
    }

    /// Resolves when the buffer is empty again (`'drain'`), or the connection is gone.
    pub async fn drain(&self) {
        self.shared.wait_for(|out| out.queued == 0 || out.destroyed).await;
    }

    /// Resolves when the whole response is on the socket (`'finish'`): `true`; `false` when the connection closed first.
    pub async fn finished(&self) -> bool {
        let epoch = self.epoch;
        self.shared.wait_for(move |out| out.destroyed || out.epoch != epoch || out.flushed).await;
        let out = self.shared.lock();
        !out.destroyed || out.epoch != epoch || out.flushed
    }

    /// Resolves when the response is over, finished or not (`'close'`).
    pub async fn closed(&self) {
        self.finished().await;
    }

    fn push(&self, bytes: Bytes) {
        if bytes.is_empty() {
            return;
        }
        let mut out = self.shared.lock();
        if out.destroyed || out.sealed {
            return;
        }
        out.queued += bytes.len();
        out.queue.push_back(bytes);
        drop(out);
        self.shared.notify();
    }

    fn send_body(&self, data: &[u8]) -> bool {
        if !self.has_body {
            return true;
        }
        if self.chunked && !data.is_empty() {
            let mut framed = format!("{:x}\r\n", data.len()).into_bytes();
            framed.extend_from_slice(data);
            framed.extend_from_slice(b"\r\n");
            self.push(Bytes::from(framed));
        } else {
            self.push(Bytes::copy_from_slice(data));
        }
        self.shared.lock().queued < HIGH_WATER_MARK
    }

    /// `writeHead`'s tail and `_storeHeader`: composes the head and queues it.
    fn store_head(&mut self) {
        if self.status == 204 || self.status == 304 || (100..=199).contains(&self.status) {
            self.has_body = false;
        }
        let message = match &self.status_message {
            Some(text) => text.clone(),
            None => status_message(self.status).to_owned(),
        };
        let mut head = Vec::with_capacity(256);
        head.extend_from_slice(format!("HTTP/1.1 {} ", self.status).as_bytes());
        push_latin1(&mut head, &message);
        head.extend_from_slice(b"\r\n");

        let seen = self.write_header_lines(&mut head);
        self.write_implied_headers(&mut head, seen);
        head.extend_from_slice(b"\r\n");

        self.head_written = true;
        let mut out = self.shared.lock();
        out.head_sent = true;
        out.last = self.last;
        drop(out);
        self.push(Bytes::from(head));
    }

    /// Writes the headers the handler set, noting which of the framing headers it set and what they say of the connection.
    fn write_header_lines(&mut self, head: &mut Vec<u8>) -> SeenHeaders {
        let mut seen = SeenHeaders::default();
        let headers = std::mem::take(&mut self.headers);
        for header in &headers {
            let joined;
            let values: &[String] = if header.values.len() >= 2 && header.lower == "cookie" {
                joined = [header.values.join("; ")];
                &joined
            } else {
                &header.values
            };
            for value in values {
                push_latin1(head, &header.name);
                head.extend_from_slice(b": ");
                push_latin1(head, value);
                head.extend_from_slice(b"\r\n");
                match header.lower.as_str() {
                    "connection" => {
                        seen.connection = true;
                        self.removed_connection = false;
                        if has_word(value, "close") {
                            self.last = true;
                        } else {
                            self.should_keep_alive = true;
                        }
                    }
                    "content-length" => {
                        seen.content_length = true;
                        self.removed_content_length = false;
                    }
                    "transfer-encoding" => {
                        seen.transfer_encoding = true;
                        self.removed_transfer_encoding = false;
                        if has_word(value, "chunked") {
                            self.chunked = true;
                        }
                    }
                    "date" => seen.date = true,
                    "trailer" => seen.trailer = true,
                    "keep-alive" => self.default_keep_alive = false,
                    _ => {}
                }
            }
        }
        self.headers = headers;
        seen
    }

    /// Adds the headers the handler left to the relay: `Date`, `Connection` and `Keep-Alive`, and the body framing.
    fn write_implied_headers(&mut self, head: &mut Vec<u8>, seen: SeenHeaders) {
        let SeenHeaders { connection, content_length, transfer_encoding, date, trailer } = seen;
        if self.send_date && !date {
            head.extend_from_slice(b"Date: ");
            head.extend_from_slice(http_date_now().as_bytes());
            head.extend_from_slice(b"\r\n");
        }
        // A 204 or 304 never carries a chunked body: Node closes the connection instead.
        if (self.status == 204 || self.status == 304) && self.chunked {
            self.chunked = false;
            self.should_keep_alive = false;
        }
        if self.removed_connection {
            // Without the header an HTTP/1.1 connection still persists by default.
            self.last = !self.should_keep_alive;
        } else if !connection {
            let send_keep_alive = self.should_keep_alive && (content_length || self.meta.chunked_by_default);
            if send_keep_alive {
                head.extend_from_slice(b"Connection: keep-alive\r\n");
                if self.meta.keep_alive_secs > 0 && self.default_keep_alive {
                    head.extend_from_slice(format!("Keep-Alive: timeout={}\r\n", self.meta.keep_alive_secs).as_bytes());
                }
            } else {
                self.last = true;
                head.extend_from_slice(b"Connection: close\r\n");
            }
        }
        if !content_length && !transfer_encoding {
            if !self.has_body {
                self.chunked = false;
            } else if !self.meta.chunked_by_default {
                self.last = true;
            } else if let (false, false, Some(length)) = (trailer, self.removed_content_length, self.content_length) {
                head.extend_from_slice(format!("Content-Length: {length}\r\n").as_bytes());
            } else if !self.removed_transfer_encoding {
                head.extend_from_slice(b"Transfer-Encoding: chunked\r\n");
                self.chunked = true;
            } else {
                self.last = true;
            }
        }
    }
}

#[derive(Default)]
struct SeenHeaders {
    connection: bool,
    content_length: bool,
    transfer_encoding: bool,
    date: bool,
    trailer: bool,
}

impl Drop for ResponseWriter {
    fn drop(&mut self) {
        if self.ended {
            return;
        }
        let mut out = self.shared.lock();
        if out.epoch != self.epoch || out.destroyed {
            return;
        }
        // A response nobody can end any more closes the connection; one dropped by a panic is left to the connection, which
        // answers 500 as `guardedHttpHandler` does.
        if std::thread::panicking() {
            return;
        }
        out.destroyed = true;
        drop(out);
        self.shared.notify();
    }
}

const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// `new Date().toUTCString()`, on the clock of `mixdog_rt`.
fn http_date_now() -> String {
    let secs = mixdog_rt::wall_clock!().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    http_date(secs)
}

fn http_date(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let weekday = (days + 4).rem_euclid(7) as usize;
    format!("{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT", DAYS[weekday], day, MONTHS[month as usize - 1], year, rest / 3600, rest % 3600 / 60, rest % 60)
}

/// The proleptic Gregorian date of a day count from 1970-01-01.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_date_is_to_utc_string() {
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(1_700_000_000), "Tue, 14 Nov 2023 22:13:20 GMT");
        assert_eq!(http_date(951_782_400), "Tue, 29 Feb 2000 00:00:00 GMT");
    }

    #[test]
    fn status_text_is_nodes() {
        assert_eq!(status_message(431), "Request Header Fields Too Large");
        assert_eq!(status_message(418), "I'm a Teapot");
        assert_eq!(status_message(299), "unknown");
    }

    #[test]
    fn words_in_header_values_are_matched_as_node_matches_them() {
        assert!(has_word("close", "close"));
        assert!(has_word("Keep-Alive, Close", "close"));
        assert!(!has_word("enclosed", "close"));
        assert!(has_word("gzip, chunked", "chunked"));
        assert!(!has_word("unchunked", "chunked"));
    }

    #[test]
    fn names_and_values_are_checked_as_node_checks_them() {
        assert!(is_token("Content-Type") && !is_token("Bad Name") && !is_token(""));
        assert!(valid_value("caf\u{e9}\t") && !valid_value("a\nb") && !valid_value("\u{100}"));
    }
}

impl std::error::Error for HeaderError {}
