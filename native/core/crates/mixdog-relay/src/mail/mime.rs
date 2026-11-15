//! The message `nodemailer` builds for the one shape of mail the relay sends (`lib/feedback.mjs`): `from`, `to`, an optional
//! `replyTo`, `subject`, a `text` body, attachments (`contentDisposition: 'attachment'`) and a `messageId`. It is a port of the
//! parts of `mail-composer`, `mime-node`, `mime-funcs`, `qp`, `base64` and `addressparser` that shape reaches, so the receiver
//! sees the same headers, transfer encodings and encoded words. Everything in the message is ASCII on the wire.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use crate::js;

/// One attachment: `{filename, content, contentType, contentDisposition: 'attachment'}`.
#[derive(Debug, Clone)]
pub struct Attachment {
    pub filename: String,
    pub content: Vec<u8>,
    pub content_type: String,
}

/// The message handed to [`super::send`]: nodemailer's `sendMail` options for this relay.
#[derive(Debug, Clone, Default)]
pub struct Message {
    pub from: String,
    pub to: String,
    pub reply_to: Option<String>,
    pub subject: String,
    pub text: String,
    pub attachments: Vec<Attachment>,
    /// `<id@host>`; generated from the sender's domain when absent, as nodemailer does.
    pub message_id: Option<String>,
}

/// The wire form of a message and the SMTP envelope taken from its headers.
#[derive(Debug)]
pub struct Built {
    pub data: Vec<u8>,
    pub from: String,
    pub to: Vec<String>,
}

/// `message.createReadStream()` of a message dated now with a random boundary.
pub fn build(message: &Message) -> Built {
    let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    build_at(message, &date_header(seconds), &format!("{:016x}", rand::random::<u64>()))
}

pub(crate) fn build_at(message: &Message, date: &str, base_boundary: &str) -> Built {
    let (from, to) = envelope(message);
    let mut root = compose(message);
    for (key, value) in message_headers(message) {
        set_header(&mut root.headers, key, value);
    }
    if get_header(&root.headers, "Message-ID").is_none() {
        let domain = from.rsplit('@').next().filter(|d| !d.is_empty()).unwrap_or("localhost");
        set_header(&mut root.headers, "Message-ID", generated_message_id(domain));
    }
    let mut data = Vec::new();
    render(&mut root, Some(date), base_boundary, &mut data);
    Built { data, from, to }
}

// ---- the tree ----

#[derive(Debug)]
enum Body {
    Empty,
    Text(String),
    Bytes(Vec<u8>),
    Multipart(Vec<Node>),
}

#[derive(Debug)]
struct Node {
    /// `_headers`: key and unencoded value, in the order nodemailer keeps them.
    headers: Vec<(String, String)>,
    filename: Option<String>,
    body: Body,
}

/// `MailComposer.compile`: the text and the attachments as one leaf, or as a `multipart/mixed` root. The multipart root is the
/// first node of the tree, so its boundary ends in `Part_1`.
fn compose(message: &Message) -> Node {
    let has_text = !message.text.is_empty();
    let attached = message.attachments.len();
    if attached > 1 || (has_text && attached == 1) {
        let mut children = Vec::new();
        if has_text {
            children.push(text_node(message));
        }
        children.extend(message.attachments.iter().map(attachment_node));
        let mut root = Node { headers: Vec::new(), filename: None, body: Body::Multipart(children) };
        set_header(&mut root.headers, "Content-Type", "multipart/mixed".to_owned());
        return root;
    }
    if has_text {
        return text_node(message);
    }
    if let Some(first) = message.attachments.first() {
        return attachment_node(first);
    }
    let mut node = Node { headers: Vec::new(), filename: None, body: Body::Empty };
    set_header(&mut node.headers, "Content-Type", "text/plain".to_owned());
    node
}

fn text_node(message: &Message) -> Node {
    let mut node = Node { headers: Vec::new(), filename: None, body: Body::Text(message.text.clone()) };
    set_header(&mut node.headers, "Content-Type", "text/plain; charset=utf-8".to_owned());
    node
}

fn attachment_node(attachment: &Attachment) -> Node {
    let mut node = Node {
        headers: Vec::new(),
        filename: Some(attachment.filename.clone()).filter(|name| !name.is_empty()),
        body: Body::Bytes(attachment.content.clone()),
    };
    set_header(&mut node.headers, "Content-Type", attachment.content_type.clone());
    set_header(&mut node.headers, "Content-Transfer-Encoding", "base64".to_owned());
    set_header(&mut node.headers, "Content-Disposition", "attachment".to_owned());
    node
}

/// The headers `compile` sets on the root, in its order and only when given.
fn message_headers(message: &Message) -> Vec<(&'static str, String)> {
    [
        ("From", Some(message.from.as_str())),
        ("To", Some(message.to.as_str())),
        ("Reply-To", message.reply_to.as_deref()),
        ("Subject", Some(message.subject.as_str())),
        ("Message-ID", message.message_id.as_deref()),
    ]
    .into_iter()
    .filter_map(|(key, value)| value.filter(|v| !v.is_empty()).map(|v| (key, v.to_owned())))
    .collect()
}

/// `setHeader`: the first header of that name is replaced in place, otherwise the header is appended.
fn set_header(headers: &mut Vec<(String, String)>, key: &str, value: String) {
    if let Some(slot) = headers.iter_mut().find(|(k, _)| k == key) {
        slot.1 = value;
    } else {
        headers.push((key.to_owned(), value));
    }
}

fn get_header<'a>(headers: &'a [(String, String)], key: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// `node.stream` of a node and of its children; `date` is given for the root node only.
fn render(node: &mut Node, date: Option<&str>, base_boundary: &str, out: &mut Vec<u8>) {
    let encoding = transfer_encoding(node);
    if let Some(encoding) = &encoding {
        set_header(&mut node.headers, "Content-Transfer-Encoding", encoding.clone());
    }
    if node.filename.is_some() && get_header(&node.headers, "Content-Disposition").is_none() {
        set_header(&mut node.headers, "Content-Disposition", "attachment".to_owned());
    }
    if let Some(date) = date {
        if get_header(&node.headers, "Date").is_none() {
            set_header(&mut node.headers, "Date", date.to_owned());
        }
        if get_header(&node.headers, "MIME-Version").is_none() {
            set_header(&mut node.headers, "MIME-Version", "1.0".to_owned());
        }
        // Content-Type is the last header of the root node.
        if let Some(at) = node.headers.iter().position(|(k, _)| k == "Content-Type") {
            let content_type = node.headers.remove(at);
            node.headers.push(content_type);
        }
    }
    let (header_block, content_type, boundary) = build_headers(node, base_boundary);
    out.extend_from_slice(header_block.as_bytes());
    out.extend_from_slice(b"\r\n\r\n");
    match &mut node.body {
        Body::Empty => {}
        Body::Text(text) => out.extend_from_slice(&encode_body(text.as_bytes(), encoding.as_deref(), &content_type)),
        Body::Bytes(bytes) => out.extend_from_slice(&encode_body(bytes, encoding.as_deref(), &content_type)),
        Body::Multipart(children) => {
            let boundary = boundary.unwrap_or_default();
            for (index, child) in children.iter_mut().enumerate() {
                if index > 0 {
                    out.extend_from_slice(b"\r\n");
                }
                out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
                render(child, None, base_boundary, out);
            }
            out.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        }
    }
}

/// `getTransferEncoding()`.
fn transfer_encoding(node: &Node) -> Option<String> {
    let truthy = match &node.body {
        Body::Empty | Body::Multipart(_) => false,
        Body::Text(text) => !text.is_empty(),
        Body::Bytes(_) => true,
    };
    if !truthy {
        return None;
    }
    let content_type = get_header(&node.headers, "Content-Type").unwrap_or("").to_lowercase();
    let content_type = content_type.trim();
    let mut encoding = get_header(&node.headers, "Content-Transfer-Encoding").unwrap_or("").to_lowercase().trim().to_owned();
    if encoding != "base64" && encoding != "quoted-printable" {
        if content_type.starts_with("text/") {
            let (plain, long) = match &node.body {
                Body::Text(text) => {
                    let plain = is_plain_text(text, false);
                    (plain, plain && has_longer_lines(text, 76))
                }
                _ => (false, false),
            };
            if plain && !long {
                encoding = "7bit".to_owned();
            } else {
                let sample = match &node.body {
                    Body::Text(text) => text.clone(),
                    Body::Bytes(bytes) => String::from_utf8_lossy(bytes).into_owned(),
                    _ => String::new(),
                };
                encoding = if text_encoding(&sample) == 'Q' { "quoted-printable" } else { "base64" }.to_owned();
            }
        } else if !content_type.starts_with("multipart/") && !content_type.starts_with("message/") && encoding.is_empty() {
            encoding = "base64".to_owned();
        }
    }
    Some(encoding)
}

fn encode_body(bytes: &[u8], encoding: Option<&str>, content_type: &str) -> Vec<u8> {
    match encoding {
        Some("base64") => base64_wrapped(bytes).into_bytes(),
        Some("quoted-printable") => qp_stream(bytes, !content_type.starts_with("text/")).into_bytes(),
        _ => bytes.to_vec(),
    }
}

/// The header block of a node (`buildHeaders`), its lower-case content type and its multipart boundary.
fn build_headers(node: &Node, base_boundary: &str) -> (String, String, Option<String>) {
    let mut lines: Vec<String> = Vec::new();
    let mut content_type_value = String::new();
    let mut boundary = None;
    for (key, raw) in &node.headers {
        let mut value = raw.clone();
        match key.as_str() {
            "Content-Disposition" => {
                let (head, mut params) = parse_header_value(&value);
                if let Some(filename) = &node.filename {
                    set_param(&mut params, "filename", filename.clone());
                }
                value = build_header_value(&head, &params);
            }
            "Content-Type" => {
                let (head, mut params) = parse_header_value(&value);
                let head = strip_controls(&head);
                content_type_value = head.trim().to_lowercase();
                if content_type_value.starts_with("multipart/") {
                    let declared = params.iter().find(|(k, _)| k == "boundary").map(|(_, v)| strip_controls(v)).filter(|v| !v.is_empty());
                    let chosen = declared.unwrap_or_else(|| format!("--_NmP-{}-Part_1", strip_controls(base_boundary)));
                    set_param(&mut params, "boundary", chosen.clone());
                    boundary = Some(chosen);
                }
                if let Body::Text(text) = &node.body {
                    let plain_type = head.strip_prefix("text/plain").is_some_and(|rest| !rest.chars().next().is_some_and(is_word_char));
                    if plain_type && text.chars().any(|c| c as u32 >= 0x80) {
                        set_param(&mut params, "charset", "utf-8".to_owned());
                    }
                }
                if node.filename.is_some() {
                    params.retain(|(k, _)| !(k == "name" || k.starts_with("name*")));
                }
                value = build_header_value(&head, &params);
                if let Some(filename) = &node.filename {
                    let mut param = if filename.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) {
                        encode_word(filename, text_encoding(filename), 52)
                    } else {
                        encode_words(filename, text_encoding(filename), 52)
                    };
                    if &param != filename || needs_quotes(&param) {
                        param = json_quote(&param);
                    }
                    value.push_str("; name=");
                    value.push_str(&param);
                }
            }
            _ => {}
        }
        let encoded = encode_header_value(key, &value);
        if encoded.trim().is_empty() {
            continue;
        }
        lines.push(fold_lines(&format!("{key}: {encoded}"), 76));
    }
    (lines.join("\r\n"), content_type_value, boundary)
}

fn set_param(params: &mut Vec<(String, String)>, key: &str, value: String) {
    if let Some(slot) = params.iter_mut().find(|(k, _)| k == key) {
        slot.1 = value;
    } else {
        params.push((key.to_owned(), value));
    }
}

fn strip_controls(value: &str) -> String {
    value.chars().filter(|c| !((*c as u32) < 0x20 || *c as u32 == 0x7f)).collect()
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `parseHeaderValue` for the values this relay builds: `type/subtype; key=value; key="quoted"`.
fn parse_header_value(input: &str) -> (String, Vec<(String, String)>) {
    let mut parts = input.split(';');
    let head = parts.next().unwrap_or("").trim().to_owned();
    let mut params = Vec::new();
    for part in parts {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match part.split_once('=') {
            Some((key, value)) => {
                let value = value.trim();
                let value = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(value);
                params.push((key.trim().to_lowercase(), value.to_owned()));
            }
            None => params.push((part.to_lowercase(), String::new())),
        }
    }
    (head, params)
}

// ---- header values ----

/// `encodeHeaderValue(key, value)`.
fn encode_header_value(key: &str, value: &str) -> String {
    let one_line = value.replace("\r\n", " ").replace(['\n', '\r'], " ");
    match key {
        "From" | "Sender" | "To" | "Cc" | "Bcc" | "Reply-To" => convert_addresses(&parse_addresses(value)).0,
        "Message-ID" | "In-Reply-To" | "Content-Id" => {
            let mut cleaned: String = one_line.chars().filter(|c| !matches!(*c as u32, 0..=8 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f)).collect();
            if !cleaned.starts_with('<') {
                cleaned.insert(0, '<');
            }
            if !cleaned.ends_with('>') {
                cleaned.push('>');
            }
            cleaned
        }
        "Content-Type" | "Content-Disposition" => one_line,
        _ => encode_header_text(&one_line),
    }
}

/// `_encodeHeaderText`.
fn encode_header_text(value: &str) -> String {
    if value.chars().any(|c| matches!(c as u32, 0..=8 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f)) {
        encode_word(value, text_encoding(value), 52)
    } else {
        encode_words(value, text_encoding(value), 52)
    }
}

/// `_getTextEncoding`: `Q` when the Latin letters outnumber the binary and non-ASCII characters, otherwise `B`.
fn text_encoding(value: &str) -> char {
    let mut non_latin = 0usize;
    let mut latin = 0usize;
    for unit in value.encode_utf16() {
        if matches!(unit, 0..=8 | 0x0b | 0x0c | 0x0e..=0x1f) || unit >= 0x80 {
            non_latin += 1;
        } else if (0x41..=0x5a).contains(&unit) || (0x61..=0x7a).contains(&unit) {
            latin += 1;
        }
    }
    if non_latin < latin { 'Q' } else { 'B' }
}

/// `isPlainText`.
fn is_plain_text(value: &str, is_param: bool) -> bool {
    !value.chars().any(|c| {
        let code = c as u32;
        if is_param {
            code < 0x20 || code == 0x7f || c == '"' || code >= 0x80
        } else {
            matches!(code, 0..=8 | 0x0b | 0x0c | 0x0e..=0x1f) || code >= 0x80
        }
    })
}

fn is_plain_param_value(value: &str) -> bool {
    is_plain_text(value, true) && !value.contains("=?")
}

/// `hasLongerLines(text, 76)`: a line of 77 or more characters, or a text past 128 KiB.
fn has_longer_lines(text: &str, line_length: usize) -> bool {
    if text.encode_utf16().count() > 128 * 1024 {
        return true;
    }
    text.split(['\n', '\r', '\u{2028}', '\u{2029}']).any(|line| line.encode_utf16().count() > line_length)
}

fn json_quote(value: &str) -> String {
    js::wire(&Value::String(value.to_owned()))
}

/// `/[\s'"\\;:/=(),<>@[\]?]|^-/`
fn needs_quotes(value: &str) -> bool {
    value.starts_with('-') || value.chars().any(|c| c.is_whitespace() || "'\"\\;:/=(),<>@[]?".contains(c))
}

/// `buildHeaderValue`.
fn build_header_value(head: &str, params: &[(String, String)]) -> String {
    let mut built: Vec<String> = Vec::new();
    for (key, value) in params {
        let param = strip_controls(key);
        if !is_plain_param_value(value) || value.encode_utf16().count() >= 75 {
            for (piece_key, piece) in build_header_param(&param, value, 50) {
                let special = piece.starts_with(['-', '\'']) || piece.ends_with('\'') || piece.chars().any(|c| c.is_whitespace() || "\"\\;:/=(),<>@[]?".contains(c));
                if !special || piece_key.ends_with('*') {
                    built.push(format!("{piece_key}={piece}"));
                } else {
                    built.push(format!("{piece_key}={}", json_quote(&piece)));
                }
            }
        } else if value.is_empty() || needs_quotes(value) {
            built.push(format!("{param}={}", json_quote(value)));
        } else {
            built.push(format!("{param}={value}"));
        }
    }
    let head = strip_controls(head);
    if built.is_empty() { head } else { format!("{head}; {}", built.join("; ")) }
}

/// `safeEncodeURIComponent` of text: every UTF-8 byte but the unreserved `A-Za-z0-9-_.!~` is `%XX`.
fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `buildHeaderParam`: RFC 2231 continuation sections of a parameter value.
fn build_header_param(key: &str, data: &str, max_length: usize) -> Vec<(String, String)> {
    struct Piece {
        line: String,
        encoded: bool,
    }
    let mut list: Vec<Piece> = Vec::new();
    if is_plain_param_value(data) {
        let chars: Vec<char> = data.chars().collect();
        if chars.len() <= max_length {
            return vec![(key.to_owned(), data.to_owned())];
        }
        for chunk in chars.chunks(max_length) {
            list.push(Piece { line: chunk.iter().collect(), encoded: false });
        }
    } else {
        let chars: Vec<String> = data.chars().map(|c| c.to_string()).collect();
        let mut line = "utf-8''".to_owned();
        let mut encoded = true;
        let mut start_pos: isize = 0;
        let mut i: isize = 0;
        while (i as usize) < chars.len() {
            let raw = &chars[i as usize];
            let mut chr;
            if encoded {
                chr = percent_encode(raw);
            } else {
                chr = if raw == " " { " ".to_owned() } else { percent_encode(raw) };
                if &chr != raw {
                    if percent_encode(&line).len() + chr.len() >= max_length {
                        list.push(Piece { line: std::mem::take(&mut line), encoded });
                        encoded = true;
                    } else {
                        encoded = true;
                        i = start_pos + 1;
                        line = String::new();
                        continue;
                    }
                }
            }
            if line.len() + chr.len() >= max_length {
                list.push(Piece { line: std::mem::take(&mut line), encoded });
                chr = if raw == " " { " ".to_owned() } else { percent_encode(raw) };
                line = chr.clone();
                if &chr == raw {
                    encoded = false;
                    start_pos = i - 1;
                } else {
                    encoded = true;
                }
            } else {
                line.push_str(&chr);
            }
            i += 1;
        }
        if !line.is_empty() {
            list.push(Piece { line, encoded });
        }
    }
    list.into_iter().enumerate().map(|(i, piece)| (format!("{key}*{i}{}", if piece.encoded { "*" } else { "" }), piece.line)).collect()
}

/// `foldLines(text, lineLength)`.
fn fold_lines(text: &str, line_length: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut pos = 0;
    let mut result = String::new();
    while pos < len {
        let end = (pos + line_length).min(len);
        let mut line: Vec<char> = chars[pos..end].to_vec();
        if line.len() < line_length {
            result.extend(line.iter());
            break;
        }
        // `^[^\n\r]*(\r?\n|\r)`
        if let Some(at) = line.iter().position(|c| *c == '\n' || *c == '\r') {
            let mut upto = at + 1;
            if line[at] == '\r' && line.get(at + 1) == Some(&'\n') {
                upto += 1;
            }
            line.truncate(upto);
            result.extend(line.iter());
            pos += line.len();
            continue;
        }
        // `(\s+)[^\s]*$`: the last whitespace run and the word after it.
        let mut word_start = line.len();
        while word_start > 0 && !line[word_start - 1].is_whitespace() {
            word_start -= 1;
        }
        let mut run_start = word_start;
        while run_start > 0 && line[run_start - 1].is_whitespace() {
            run_start -= 1;
        }
        if run_start < word_start && run_start > 0 {
            line.truncate(run_start);
        } else {
            let rest = &chars[pos + line.len()..];
            let word = rest.iter().take_while(|c| !c.is_whitespace()).count();
            line.extend(rest[..word].iter());
        }
        result.extend(line.iter());
        pos += line.len();
        if pos < len {
            result.push_str("\r\n");
        }
    }
    result
}

// ---- encoded words ----

fn base64_plain(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// `base64.encode` then `wrap(…, 76)`: lines joined by CRLF, none after the last.
fn base64_wrapped(bytes: &[u8]) -> String {
    STANDARD.encode(bytes).as_bytes().chunks(76).map(|chunk| String::from_utf8_lossy(chunk).into_owned()).collect::<Vec<_>>().join("\r\n")
}

/// `encodeWords(value, encoding, maxLength, true)`.
fn encode_words(value: &str, encoding: char, max_length: usize) -> String {
    if value.chars().any(|c| c == '"' || c as u32 >= 0x80) { encode_word(value, encoding, max_length) } else { value.to_owned() }
}

/// `encodeWord`: UTF-8 RFC 2047 words, split to fit `max_length`.
fn encode_word(data: &str, encoding: char, max_length: usize) -> String {
    let mut max = max_length;
    if max > 7 + "UTF-8".len() {
        max -= 7 + "UTF-8".len();
    }
    let mut encoded: String;
    if encoding == 'Q' {
        encoded = qp_encode_bytes(data.as_bytes(), None, false, None)
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "!*+-/=".contains(c) {
                    c.to_string()
                } else if c == ' ' {
                    "_".to_owned()
                } else {
                    format!("={:02X}", c as u32)
                }
            })
            .collect();
    } else {
        encoded = data.to_owned();
        max = if max > 0 { 3.max(((max - max % 4) / 4) * 3) } else { 0 };
    }
    let measured = if encoding == 'Q' { encoded.len() } else { base64_plain(data.as_bytes()).len() };
    if max > 0 && measured > max {
        if encoding == 'Q' {
            encoded = split_mime_encoded_string(&encoded, max).join("?= =?UTF-8?Q?");
        } else {
            // An encoded word holds whole characters (RFC 2047 6.3).
            let mut parts: Vec<String> = Vec::new();
            let mut current = String::new();
            for (index, chr) in data.chars().enumerate() {
                if current.len() + chr.len_utf8() <= max || index == 0 {
                    current.push(chr);
                } else {
                    parts.push(base64_plain(current.as_bytes()));
                    current = chr.to_string();
                }
            }
            if !current.is_empty() {
                parts.push(base64_plain(current.as_bytes()));
            }
            encoded = parts.join("?= =?UTF-8?B?");
        }
    } else if encoding == 'B' {
        encoded = base64_plain(data.as_bytes());
    }
    let tail = if encoded.ends_with("?=") { "" } else { "?=" };
    format!("=?UTF-8?{encoding}?{encoded}{tail}")
}

/// `splitMimeEncodedString`: parts of at most `maxlen` characters that never cut an `=XX` escape or a UTF-8 sequence.
fn split_mime_encoded_string(text: &str, maxlen: usize) -> Vec<String> {
    let maxlen = maxlen.max(12);
    let mut lines = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let window = &rest[..maxlen.min(rest.len())];
        let mut current = window;
        if let Some(at) = current.rfind('=') {
            let tail = &current[at + 1..];
            if tail.len() <= 1 && tail.bytes().all(|b| b.is_ascii_hexdigit()) {
                current = &current[..at];
            }
        }
        let fallback = if current.is_empty() { window } else { current };
        let mut done = false;
        while !done && !current.is_empty() {
            done = true;
            let after = &rest.as_bytes()[current.len()..];
            if after.len() >= 3 && after[0] == b'=' && after[1..3].iter().all(u8::is_ascii_hexdigit) {
                let code = u8::from_str_radix(&rest[current.len() + 1..current.len() + 3], 16).unwrap_or(0);
                if (0x80..0xc2).contains(&code) {
                    current = &current[..current.len().saturating_sub(3)];
                    done = false;
                }
            }
        }
        if current.is_empty() {
            current = fallback;
        }
        lines.push(current.to_owned());
        rest = &rest[current.len()..];
    }
    lines
}

// ---- quoted-printable ----

fn qp_literal(byte: u8) -> bool {
    matches!(byte, 0x09 | 0x0a | 0x0d | 0x20..=0x3c | 0x3e..=0x7e)
}

fn is_blank(byte: u8) -> bool {
    byte == 0x20 || byte == 0x09
}

/// `qp.encode` of a chunk: `next` is the byte after it, `previous` the byte before it, `binary` keeps only CRLF pairs literal.
fn qp_encode_bytes(buffer: &[u8], next: Option<u8>, binary: bool, previous: Option<u8>) -> String {
    let mut out = String::with_capacity(buffer.len() * 3);
    for (i, &ord) in buffer.iter().enumerate() {
        let following = if i + 1 < buffer.len() { Some(buffer[i + 1]) } else { next };
        let line_break_byte = if binary && (ord == 0x0d || ord == 0x0a) {
            if ord == 0x0d { following == Some(0x0a) } else { (if i > 0 { Some(buffer[i - 1]) } else { previous }) == Some(0x0d) }
        } else {
            true
        };
        if qp_literal(ord) && line_break_byte && !(is_blank(ord) && matches!(following, None | Some(0x0a) | Some(0x0d))) {
            out.push(ord as char);
        } else {
            out.push_str(&format!("={ord:02X}"));
        }
    }
    out
}

/// The `=XX` escape, or the start of one, that ends `line`: `[=][\da-f]{0,max_hex}$`. Returns its length.
fn trailing_escape(line: &str, max_hex: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    (0..=max_hex).rev().find_map(|hex| {
        let total = hex + 1;
        (bytes.len() >= total && bytes[bytes.len() - total] == b'=' && bytes[bytes.len() - hex..].iter().all(u8::is_ascii_hexdigit)).then_some(total)
    })
}

/// `/^(?:=[\da-f]{2}){1,4}$/i`
fn whole_escapes(line: &str) -> bool {
    let bytes = line.as_bytes();
    bytes.len().is_multiple_of(3) && (3..=12).contains(&bytes.len()) && bytes.chunks(3).all(|c| c[0] == b'=' && c[1].is_ascii_hexdigit() && c[2].is_ascii_hexdigit())
}

/// `qp.wrap`: soft line breaks at `line_length` (the input is ASCII).
fn qp_wrap(text: &str, line_length: usize) -> String {
    let line_length = line_length.max(4);
    if text.len() <= line_length {
        return text.to_owned();
    }
    let len = text.len();
    let line_margin = line_length / 3;
    let breaks = [' ', '\t', '.', ',', '!', '?'];
    let mut pos = 0;
    let mut result = String::new();
    while pos < len {
        let mut line = &text[pos..(pos + line_length).min(len)];
        if let Some(at) = line.find("\r\n") {
            let upto = &line[..at + 2];
            result.push_str(upto);
            pos += upto.len();
            continue;
        }
        if line.ends_with('\n') {
            result.push_str(line);
            pos += line.len();
            continue;
        }
        let tail_from = line.len().saturating_sub(line_margin);
        let tail = &line[tail_from..];
        if let Some(at) = tail.rfind('\n').filter(|at| !tail[at + 1..].contains('\r')) {
            line = &line[..tail_from + at + 1];
            result.push_str(line);
            pos += line.len();
            continue;
        }
        if let Some(at) = tail.rfind(breaks).filter(|_| line.len() > line_length - line_margin) {
            line = &line[..tail_from + at + 1];
        } else if trailing_escape(line, 2).is_some() {
            if let Some(partial) = trailing_escape(line, 1) {
                line = &line[..line.len() - partial];
            }
            while line.len() > 3 && line.len() < len - pos && !whole_escapes(line) {
                let Some(escape) = trailing_escape(line, 2).filter(|total| *total == 3) else { break };
                let code = u8::from_str_radix(&line[line.len() - escape + 1..], 16).unwrap_or(0);
                if code < 128 {
                    break;
                }
                line = &line[..line.len() - 3];
                if code >= 0xc0 {
                    break;
                }
            }
        }
        if line.is_empty() {
            line = &text[pos..(pos + line_length).min(len)];
        }
        let mut piece = line.to_owned();
        if pos + line.len() < len && !line.ends_with('\n') {
            if line.len() == line_length && trailing_escape(line, 2) == Some(3) {
                piece.truncate(line.len() - 3);
            } else if line.len() == line_length {
                piece.truncate(line.len() - 1);
            }
            pos += piece.len();
            piece.push_str("=\r\n");
        } else {
            pos += line.len();
        }
        result.push_str(&piece);
    }
    result
}

/// The `qp.Encoder` stream over one chunk: whitespace at the end of the input is held back and encoded last.
fn qp_stream(bytes: &[u8], binary: bool) -> String {
    const SLICE: usize = 64 * 1024;
    let mut end = bytes.len();
    while end > 0 && (is_blank(bytes[end - 1]) || (binary && bytes[end - 1] == 0x0d)) {
        end -= 1;
    }
    let (main, held) = if bytes.len() - end <= SLICE { (&bytes[..end], &bytes[end..]) } else { (bytes, &bytes[..0]) };
    let mut out = String::new();
    let mut current = String::new();
    let mut last_byte: Option<u8> = None;
    for part in [main, held] {
        let mut start = 0;
        while start < part.len() {
            let stop = (start + SLICE).min(part.len());
            let next = part.get(stop).copied();
            let wrapped = qp_wrap(&format!("{current}{}", qp_encode_bytes(&part[start..stop], next, binary, last_byte)), 76);
            let cut = wrapped.rfind('\n').map_or(0, |at| at + 1);
            current = wrapped[cut..].to_owned();
            out.push_str(&wrapped[..cut]);
            last_byte = Some(part[stop - 1]);
            start = stop;
        }
    }
    out.push_str(&current);
    out
}

// ---- addresses ----

#[derive(Debug, Clone, PartialEq)]
struct Address {
    address: String,
    name: String,
}

/// `addressparser` for mailbox lists: `addr`, `Name <addr>`, `"Quoted, Name" <addr>`, separated by commas or semicolons.
/// An entry with no address is kept as a bare name, which the header leaves out.
fn parse_addresses(value: &str) -> Vec<Address> {
    let mut entries: Vec<String> = Vec::new();
    let mut current = String::new();
    let (mut quoted, mut angle, mut escaped) = (false, false, false);
    for c in value.chars() {
        if escaped {
            current.push(c);
            escaped = false;
            continue;
        }
        match c {
            '\\' if quoted => {
                current.push(c);
                escaped = true;
            }
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            '<' if !quoted => {
                angle = true;
                current.push(c);
            }
            '>' if !quoted => {
                angle = false;
                current.push(c);
            }
            ',' | ';' if !quoted && !angle => entries.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    entries.push(current);
    entries
        .into_iter()
        .map(|entry| entry.trim().to_owned())
        .filter(|entry| !entry.is_empty())
        .map(|entry| match (entry.rfind('<'), entry.rfind('>')) {
            (Some(open), Some(close)) if open < close => Address { address: entry[open + 1..close].trim().to_owned(), name: unquote(entry[..open].trim()) },
            _ if entry.contains('@') => Address { address: unquote(&entry), name: String::new() },
            _ => Address { address: String::new(), name: unquote(&entry) },
        })
        .collect()
}

fn unquote(text: &str) -> String {
    match text.strip_prefix('"').and_then(|t| t.strip_suffix('"')) {
        Some(inner) => {
            let mut out = String::new();
            let mut escaped = false;
            for c in inner.chars() {
                if c == '\\' && !escaped {
                    escaped = true;
                } else {
                    out.push(c);
                    escaped = false;
                }
            }
            out
        }
        None => text.to_owned(),
    }
}

/// `_convertAddresses`: the header text and the unique addresses in it.
fn convert_addresses(addresses: &[Address]) -> (String, Vec<String>) {
    let mut values = Vec::new();
    let mut unique: Vec<String> = Vec::new();
    for entry in addresses {
        let address = normalize_address(&entry.address);
        if address.is_empty() {
            continue;
        }
        if entry.name.is_empty() {
            values.push(if is_plain_address(&address) { address.clone() } else { format!("<{address}>") });
        } else {
            values.push(format!("{} <{address}>", encode_address_name(&entry.name)));
        }
        if !unique.contains(&address) {
            unique.push(address);
        }
    }
    (values.join(", "), unique)
}

/// `/^[^\s"(),:;<>@[\\\]]+@[^\s"(),:;<>@[\\\]]+$/`
fn is_plain_address(address: &str) -> bool {
    let special = |c: char| c.is_whitespace() || "\"(),:;<>@[\\]".contains(c);
    match address.split_once('@') {
        Some((user, domain)) => !user.is_empty() && !domain.is_empty() && !user.chars().any(special) && !domain.chars().any(special),
        None => false,
    }
}

fn encode_address_name(name: &str) -> String {
    if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ' ') {
        return name.to_owned();
    }
    if name.chars().all(|c| (0x20..=0x7e).contains(&(c as u32))) {
        return quote_string(name);
    }
    encode_word(name, text_encoding(name), 52)
}

fn quote_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// `_normalizeAddress`: the local part as a dot-atom or a quoted string, the domain as an A-label.
fn normalize_address(address: &str) -> String {
    let cleaned: String = address.chars().map(|c| if matches!(c as u32, 0..=0x1f | 0x7f) || c == '<' || c == '>' { ' ' } else { c }).collect();
    let address = cleaned.trim();
    if address.is_empty() {
        return String::new();
    }
    let literal_at = if address.ends_with(']') { address.rfind("@[").filter(|at| !address[at + 2..address.len() - 1].contains(['[', ']', '\\'])) } else { None };
    let Some(at) = literal_at.or_else(|| address.rfind('@')) else {
        return normalize_local_part(address);
    };
    let (user, domain) = (&address[..at], &address[at + 1..]);
    let smtputf8 = user.chars().any(|c| c as u32 >= 0x80);
    format!("{}@{}", normalize_local_part(user), normalize_domain(&domain.to_lowercase(), smtputf8))
}

/// `normalizeDomain`: the A-label of a domain; what is not a valid domain is kept as supplied.
fn normalize_domain(domain: &str, keep_unicode: bool) -> String {
    let unsafe_char = |c: char| "/\\?#%".contains(c) || (c as u32) <= 0x20 || c as u32 == 0x7f;
    if keep_unicode || domain.chars().any(unsafe_char) {
        return domain.to_owned();
    }
    match url::Host::parse(domain) {
        Ok(url::Host::Domain(ascii)) if !ascii.is_empty() => ascii,
        Ok(url::Host::Ipv4(ip)) => ip.to_string(),
        _ => domain.to_owned(),
    }
}

/// `_normalizeLocalPart`
fn normalize_local_part(user: &str) -> String {
    let atext = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+-/=?^_`{|}~".contains(c) || c as u32 >= 0x80;
    let dot_atom = !user.is_empty() && user.split('.').all(|part| !part.is_empty() && part.chars().all(atext));
    if dot_atom || is_quoted_string(user) { user.to_owned() } else { quote_string(user) }
}

/// `/^"(?:[^"\\]|\\[\s\S])*"$/`
fn is_quoted_string(text: &str) -> bool {
    let Some(inner) = text.strip_prefix('"').and_then(|t| t.strip_suffix('"')) else { return false };
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return false,
            '\\' if chars.next().is_none() => return false,
            _ => {}
        }
    }
    true
}

/// The envelope `getEnvelope()` takes from the headers: the first address of From and the unique recipients of To.
fn envelope(message: &Message) -> (String, Vec<String>) {
    let (_, from) = convert_addresses(&parse_addresses(&message.from));
    let (_, to) = convert_addresses(&parse_addresses(&message.to));
    (from.first().cloned().unwrap_or_default(), to)
}

fn generated_message_id(domain: &str) -> String {
    let hex = |bytes: usize| (0..bytes).map(|_| format!("{:02x}", rand::random::<u8>())).collect::<String>();
    format!("<{}-{}-{}-{}-{}@{domain}>", hex(4), hex(2), hex(2), hex(2), hex(6))
}

// ---- dates ----

/// `date.toUTCString().replace(/GMT/, '+0000')`.
pub(crate) fn date_header(unix_seconds: u64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let days = (unix_seconds / 86_400) as i64;
    let rest = unix_seconds % 86_400;
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{}, {:02} {} {:04} {:02}:{:02}:{:02} +0000",
        DAYS[((days + 4).rem_euclid(7)) as usize],
        day,
        MONTHS[(month - 1) as usize],
        year,
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

// Expectations of the tests below are the messages `nodemailer` 10.2.1 produced for the same input
// (`createTransport({ streamTransport: true, buffer: true })`), with the date and the boundary base fixed. nodemailer adds
// a closing line break before the data stream's own terminator; the SMTP client's terminator rule gives the same bytes.
#[cfg(test)]
mod tests {
    use super::*;

    const DATE: &str = "Sun, 15 Nov 2026 04:00:42 +0000";

    fn message(from: &str, to: &str, reply_to: &str, subject: &str, text: &str, attachments: Vec<Attachment>) -> Message {
        Message {
            from: from.to_owned(),
            to: to.to_owned(),
            reply_to: Some(reply_to.to_owned()).filter(|r| !r.is_empty()),
            subject: subject.to_owned(),
            text: text.to_owned(),
            attachments,
            message_id: Some("<abc@feedback.mixdog>".to_owned()),
        }
    }

    fn attachment(name: &str, content_type: &str, hex: &str) -> Attachment {
        let content = (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect();
        Attachment { filename: name.to_owned(), content_type: content_type.to_owned(), content }
    }

    /// The message as lines, the way the expectations are written (CRLF as LF).
    fn wire(message: &Message) -> String {
        String::from_utf8(build_at(message, DATE, "BASE").data).unwrap().replace("\r\n", "\n")
    }

    #[test]
    fn the_date_is_the_utc_string_of_javascript_with_a_numeric_zone() {
        assert_eq!(date_header(1_794_715_242), DATE);
        assert_eq!(date_header(0), "Thu, 01 Jan 1970 00:00:00 +0000");
        assert_eq!(date_header(951_782_400), "Tue, 29 Feb 2000 00:00:00 +0000");
    }

    #[test]
    fn the_envelope_is_taken_from_the_headers() {
        let built = build_at(&message("Bot <bot@Example.com>", "a@b.co, \"X, Y\" <c@d.co>, a@b.co", "", "s", "t", vec![]), DATE, "BASE");
        assert_eq!(built.from, "bot@example.com");
        assert_eq!(built.to, vec!["a@b.co".to_owned(), "c@d.co".to_owned()]);
    }

    #[test]
    fn a_message_id_is_made_from_the_sender_domain_when_none_is_given() {
        let mut m = message("bot@example.com", "a@b.co", "", "s", "t", vec![]);
        m.message_id = None;
        let text = String::from_utf8(build_at(&m, DATE, "BASE").data).unwrap();
        let line = text.lines().find(|l| l.starts_with("Message-ID: ")).unwrap();
        assert!(line.ends_with("@example.com>"), "{line}");
    }

    #[test]
    fn a_bare_cr_in_the_text_is_kept_for_the_data_stream() {
        let m = message("bot@example.com", "support@mixdog.ai", "", "s", "line1\r\nline2\rline3", vec![]);
        assert!(wire(&m).ends_with("\n\nline1\nline2\rline3"));
    }

    #[test]
    fn a_quoted_printable_body_wraps_at_76_with_soft_breaks() {
        let m = message("bot@example.com", "support@mixdog.ai", "", "[Mixdog feedback] bug 1", "Héllo wörld ünïcode with mostly latin letters, quite a long line to force wrapping beyond seventy six characters for soft breaks é\nsecond line  \nthird é   ", vec![]);
        let expected = [
            "From: bot@example.com",
            "To: support@mixdog.ai",
            "Subject: [Mixdog feedback] bug 1",
            "Message-ID: <abc@feedback.mixdog>",
            "Content-Transfer-Encoding: quoted-printable",
            "Date: Sun, 15 Nov 2026 04:00:42 +0000",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "H=C3=A9llo w=C3=B6rld =C3=BCn=C3=AFcode with mostly latin letters, quite a =",
            "long line to force wrapping beyond seventy six characters for soft breaks =",
            "=C3=A9",
            "second line =20",
            "third =C3=A9  =20",
        ]
        .join("\n");
        assert_eq!(wire(&m).trim_end_matches('\n'), expected);
    }

    #[test]
    fn a_long_line_of_digits_goes_out_as_base64() {
        let m = message("bot@example.com", "support@mixdog.ai", "", "s", "123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890", vec![]);
        let expected = [
            "From: bot@example.com",
            "To: support@mixdog.ai",
            "Subject: s",
            "Message-ID: <abc@feedback.mixdog>",
            "Content-Transfer-Encoding: base64",
            "Date: Sun, 15 Nov 2026 04:00:42 +0000",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3",
            "ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0",
            "NTY3ODkw",
        ]
        .join("\n");
        assert_eq!(wire(&m).trim_end_matches('\n'), expected);
    }

    #[test]
    fn a_long_ascii_subject_is_folded_not_encoded() {
        let m = message("bot@example.com", "support@mixdog.ai", "", "A very long subject line that goes on and on and on and on and on and on and on and past seventy six", "t", vec![]);
        let expected = [
            "From: bot@example.com",
            "To: support@mixdog.ai",
            "Subject: A very long subject line that goes on and on and on and on and on",
            " and on and on and past seventy six",
            "Message-ID: <abc@feedback.mixdog>",
            "Content-Transfer-Encoding: 7bit",
            "Date: Sun, 15 Nov 2026 04:00:42 +0000",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "t",
        ]
        .join("\n");
        assert_eq!(wire(&m).trim_end_matches('\n'), expected);
    }

    #[test]
    fn a_non_ascii_subject_is_split_into_q_encoded_words() {
        let m = message("bot@example.com", "support@mixdog.ai", "", "이모지 😀 subject with émoji and more latin text to exceed the length of an encoded word chunk size ok", "t", vec![]);
        let expected = [
            "From: bot@example.com",
            "To: support@mixdog.ai",
            "Subject: =?UTF-8?Q?=EC=9D=B4=EB=AA=A8=EC=A7=80_=F0=9F=98=80?=",
            " =?UTF-8?Q?_subject_with_=C3=A9moji_and_more_latin_?=",
            " =?UTF-8?Q?text_to_exceed_the_length_of_an_encoded_?=",
            " =?UTF-8?Q?word_chunk_size_ok?=",
            "Message-ID: <abc@feedback.mixdog>",
            "Content-Transfer-Encoding: 7bit",
            "Date: Sun, 15 Nov 2026 04:00:42 +0000",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "t",
        ]
        .join("\n");
        assert_eq!(wire(&m).trim_end_matches('\n'), expected);
    }

    #[test]
    fn addresses_are_normalised_and_a_display_name_is_kept() {
        let m = message("bot@example.com", "support@mixdog.ai, \"Doe, John\" <j@d.e>", "Jane Q. Public <Jane@Example.ORG>", "s", "t", vec![]);
        let expected = [
            "From: bot@example.com",
            "To: support@mixdog.ai, \"Doe, John\" <j@d.e>",
            "Reply-To: \"Jane Q. Public\" <Jane@example.org>",
            "Subject: s",
            "Message-ID: <abc@feedback.mixdog>",
            "Content-Transfer-Encoding: 7bit",
            "Date: Sun, 15 Nov 2026 04:00:42 +0000",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "t",
        ]
        .join("\n");
        assert_eq!(wire(&m).trim_end_matches('\n'), expected);
    }

    #[test]
    fn attachment_names_are_encoded_as_words_and_rfc_2231_continuations() {
        let m = message("bot@example.com", "support@mixdog.ai", "", "s", "see", vec![attachment("스크린샷 😀 파일.png", "image/png", "89504e470d0a"), attachment("한글파일이름이매우길어서접속이필요한경우한글파일이름이매우길어서접속이필요한경우한글파일이름이매우길어서접속이필요한경우한글파일이름이매우길어서접속이필요한경우.png", "image/webp", "52494646"), attachment("plain-but-very-long-name-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.png", "image/png", "00")]);
        let expected = [
            "From: bot@example.com",
            "To: support@mixdog.ai",
            "Subject: s",
            "Message-ID: <abc@feedback.mixdog>",
            "Date: Sun, 15 Nov 2026 04:00:42 +0000",
            "MIME-Version: 1.0",
            "Content-Type: multipart/mixed; boundary=\"--_NmP-BASE-Part_1\"",
            "",
            "----_NmP-BASE-Part_1",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Transfer-Encoding: 7bit",
            "",
            "see",
            "----_NmP-BASE-Part_1",
            "Content-Type: image/png;",
            " name=\"=?UTF-8?B?7Iqk7YGs66aw7IO3IPCfmIAg7YyM7J28LnBuZw==?=\"",
            "Content-Transfer-Encoding: base64",
            "Content-Disposition: attachment;",
            " filename*0*=utf-8''%EC%8A%A4%ED%81%AC%EB%A6%B0%EC%83%B7%20;",
            " filename*1*=%F0%9F%98%80%20%ED%8C%8C%EC%9D%BC.png",
            "",
            "iVBORw0K",
            "----_NmP-BASE-Part_1",
            "Content-Type: image/webp;",
            " name=\"=?UTF-8?B?7ZWc6riA7YyM7J287J2066aE7J2066ek7Jqw6ri4?=",
            " =?UTF-8?B?7Ja07ISc7KCR7IaN7J207ZWE7JqU7ZWc6rK97Jqw?=",
            " =?UTF-8?B?7ZWc6riA7YyM7J287J2066aE7J2066ek7Jqw6ri4?=",
            " =?UTF-8?B?7Ja07ISc7KCR7IaN7J207ZWE7JqU7ZWc6rK97Jqw?=",
            " =?UTF-8?B?7ZWc6riA7YyM7J287J2066aE7J2066ek7Jqw6ri4?=",
            " =?UTF-8?B?7Ja07ISc7KCR7IaN7J207ZWE7JqU7ZWc6rK97Jqw?=",
            " =?UTF-8?B?7ZWc6riA7YyM7J287J2066aE7J2066ek7Jqw6ri4?=",
            " =?UTF-8?B?7Ja07ISc7KCR7IaN7J207ZWE7JqU7ZWc6rK97Jqw?= =?UTF-8?B?LnBuZw==?=\"",
            "Content-Transfer-Encoding: base64",
            "Content-Disposition: attachment;",
            " filename*0*=utf-8''%ED%95%9C%EA%B8%80%ED%8C%8C%EC%9D%BC;",
            " filename*1*=%EC%9D%B4%EB%A6%84%EC%9D%B4%EB%A7%A4%EC%9A%B0;",
            " filename*2*=%EA%B8%B8%EC%96%B4%EC%84%9C%EC%A0%91%EC%86%8D;",
            " filename*3*=%EC%9D%B4%ED%95%84%EC%9A%94%ED%95%9C%EA%B2%BD;",
            " filename*4*=%EC%9A%B0%ED%95%9C%EA%B8%80%ED%8C%8C%EC%9D%BC;",
            " filename*5*=%EC%9D%B4%EB%A6%84%EC%9D%B4%EB%A7%A4%EC%9A%B0;",
            " filename*6*=%EA%B8%B8%EC%96%B4%EC%84%9C%EC%A0%91%EC%86%8D;",
            " filename*7*=%EC%9D%B4%ED%95%84%EC%9A%94%ED%95%9C%EA%B2%BD;",
            " filename*8*=%EC%9A%B0%ED%95%9C%EA%B8%80%ED%8C%8C%EC%9D%BC;",
            " filename*9*=%EC%9D%B4%EB%A6%84%EC%9D%B4%EB%A7%A4%EC%9A%B0;",
            " filename*10*=%EA%B8%B8%EC%96%B4%EC%84%9C%EC%A0%91%EC%86%8D;",
            " filename*11*=%EC%9D%B4%ED%95%84%EC%9A%94%ED%95%9C%EA%B2%BD;",
            " filename*12*=%EC%9A%B0%ED%95%9C%EA%B8%80%ED%8C%8C%EC%9D%BC;",
            " filename*13*=%EC%9D%B4%EB%A6%84%EC%9D%B4%EB%A7%A4%EC%9A%B0;",
            " filename*14*=%EA%B8%B8%EC%96%B4%EC%84%9C%EC%A0%91%EC%86%8D;",
            " filename*15*=%EC%9D%B4%ED%95%84%EC%9A%94%ED%95%9C%EA%B2%BD;",
            " filename*16*=%EC%9A%B0.png",
            "",
            "UklGRg==",
            "----_NmP-BASE-Part_1",
            "Content-Type: image/png;",
            " name=plain-but-very-long-name-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.png",
            "Content-Transfer-Encoding: base64",
            "Content-Disposition: attachment;",
            " filename*0=plain-but-very-long-name-xxxxxxxxxxxxxxxxxxxxxxxxx;",
            " filename*1=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx;",
            " filename*2=xxxxx.png",
            "",
            "AA==",
            "----_NmP-BASE-Part_1--",
        ]
        .join("\n");
        assert_eq!(wire(&m).trim_end_matches('\n'), expected);
    }

    #[test]
    fn one_attachment_and_no_text_is_the_root_message() {
        let m = message("bot@example.com", "support@mixdog.ai", "", "s", "", vec![attachment("shot.png", "image/png", "89504e47")]);
        let expected = [
            "Content-Transfer-Encoding: base64",
            "Content-Disposition: attachment; filename=shot.png",
            "From: bot@example.com",
            "To: support@mixdog.ai",
            "Subject: s",
            "Message-ID: <abc@feedback.mixdog>",
            "Date: Sun, 15 Nov 2026 04:00:42 +0000",
            "MIME-Version: 1.0",
            "Content-Type: image/png; name=shot.png",
            "",
            "iVBORw==",
        ]
        .join("\n");
        assert_eq!(wire(&m).trim_end_matches('\n'), expected);
    }

    #[test]
    fn a_dot_at_the_start_of_a_line_is_left_for_the_data_stream() {
        let m = message("bot@example.com", "support@mixdog.ai", "", "", ".dot line\n..two\n\nend.", vec![]);
        let expected = [
            "From: bot@example.com",
            "To: support@mixdog.ai",
            "Message-ID: <abc@feedback.mixdog>",
            "Content-Transfer-Encoding: 7bit",
            "Date: Sun, 15 Nov 2026 04:00:42 +0000",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            ".dot line",
            "..two",
            "",
            "end.",
        ]
        .join("\n");
        assert_eq!(wire(&m).trim_end_matches('\n'), expected);
    }

    #[test]
    fn a_long_non_latin_text_is_base64() {
        let m = message("bot@example.com", "support@mixdog.ai", "", "s", "éééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééé", vec![]);
        let expected = [
            "From: bot@example.com",
            "To: support@mixdog.ai",
            "Subject: s",
            "Message-ID: <abc@feedback.mixdog>",
            "Content-Transfer-Encoding: base64",
            "Date: Sun, 15 Nov 2026 04:00:42 +0000",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "w6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nD",
            "qcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOp",
            "w6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nD",
            "qcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOp",
            "w6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nD",
            "qcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOp",
            "w6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nDqcOpw6nD",
            "qQ==",
        ]
        .join("\n");
        assert_eq!(wire(&m).trim_end_matches('\n'), expected);
    }
}
