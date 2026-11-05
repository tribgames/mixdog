//! The fixed HTTP/1.1 grammar of the control listener: one request per connection, a bounded
//! head, a `Content-Length` body of at most 64 KiB, `Connection: close`.

use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;

pub const MAX_HEAD_BYTES: usize = 16 * 1024;
pub const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub struct Request {
    pub method: String,
    /// Path without the query.
    pub path: String,
    /// Names lowercased.
    headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("malformed request")]
    Malformed,
    #[error("request head too large")]
    HeadTooLarge,
    #[error("request body too large")]
    BodyTooLarge,
    #[error("connection: {0}")]
    Io(#[from] std::io::Error),
}

pub fn read_request(stream: impl Read) -> Result<Request, ParseError> {
    let mut reader = BufReader::new(stream);
    let mut head_bytes = 0;
    let mut next_line = |reader: &mut BufReader<_>| -> Result<String, ParseError> {
        let mut line = String::new();
        let read = reader
            .by_ref()
            .take((MAX_HEAD_BYTES - head_bytes + 1) as u64)
            .read_line(&mut line)?;
        head_bytes += read;
        if head_bytes > MAX_HEAD_BYTES {
            return Err(ParseError::HeadTooLarge);
        }
        if read == 0 || !line.ends_with('\n') {
            return Err(ParseError::Malformed);
        }
        Ok(line.trim_end_matches(['\r', '\n']).to_owned())
    };

    let request_line = next_line(&mut reader)?;
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(ParseError::Malformed);
    };
    if !version.starts_with("HTTP/1.") || method.is_empty() || !target.starts_with('/') {
        return Err(ParseError::Malformed);
    }
    let path = target.split('?').next().unwrap_or(target).to_owned();

    let mut headers = Vec::new();
    loop {
        let line = next_line(&mut reader)?;
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').ok_or(ParseError::Malformed)?;
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
    }

    let mut request = Request { method: method.to_owned(), path, headers, body: Vec::new() };
    if request.header("transfer-encoding").is_some() {
        return Err(ParseError::Malformed);
    }
    let length = match request.header("content-length") {
        None => 0,
        Some(text) => text.parse::<usize>().map_err(|_| ParseError::Malformed)?,
    };
    if length > MAX_BODY_BYTES {
        return Err(ParseError::BodyTooLarge);
    }
    request.body = vec![0; length];
    reader.read_exact(&mut request.body)?;
    Ok(request)
}

pub struct Response {
    pub status: u16,
    pub body: String,
}

impl Response {
    pub fn json(status: u16, value: &impl serde::Serialize) -> Self {
        let body = serde_json::to_string(value).expect("response types serialize");
        Self { status, body }
    }

    pub fn write_to(&self, out: &mut impl Write) -> std::io::Result<()> {
        let reason = match self.status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            409 => "Conflict",
            413 => "Payload Too Large",
            426 => "Upgrade Required",
            503 => "Service Unavailable",
            _ => "Error",
        };
        write!(
            out,
            "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            self.status,
            reason,
            self.body.len(),
            self.body
        )?;
        out.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Request, ParseError> {
        read_request(text.as_bytes())
    }

    #[test]
    fn parses_a_post_with_a_body() {
        let r = parse("POST /mgmt/stop?x=1 HTTP/1.1\r\nHost: a\r\nAuthorization: Bearer t\r\nContent-Length: 2\r\n\r\n{}")
            .unwrap();
        assert_eq!((r.method.as_str(), r.path.as_str()), ("POST", "/mgmt/stop"));
        assert_eq!(r.header("authorization"), Some("Bearer t"));
        assert_eq!(r.body, b"{}");
    }

    #[test]
    fn refuses_what_the_grammar_does_not_cover() {
        assert!(matches!(parse("GET / HTTP/2\r\n\r\n"), Err(ParseError::Malformed)));
        assert!(matches!(parse("GET /x HTTP/1.1\r\nbad header\r\n\r\n"), Err(ParseError::Malformed)));
        assert!(matches!(
            parse("POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"),
            Err(ParseError::Malformed)
        ));
        assert!(matches!(
            parse("POST /x HTTP/1.1\r\nContent-Length: 70000\r\n\r\n"),
            Err(ParseError::BodyTooLarge)
        ));
        let long = format!("GET /x HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(MAX_HEAD_BYTES));
        assert!(matches!(parse(&long), Err(ParseError::HeadTooLarge)));
        assert!(matches!(parse("GET /x HTTP/1.1\r\n"), Err(ParseError::Malformed)));
    }

    #[test]
    fn short_body_is_an_io_error() {
        assert!(matches!(
            parse("POST /x HTTP/1.1\r\nContent-Length: 5\r\n\r\nab"),
            Err(ParseError::Io(_))
        ));
    }
}
