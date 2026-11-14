//! The text side of a message as `gmail-app-password.mjs` reads it: transfer and charset decoding, an HTML part as
//! text, the link targets of a message, Gmail's authentication verdict and the dates of the listings.

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use mixdog_js::time::Tz;
use regex::Regex;
use serde_json::Value;
use serde_json::json;

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern")
}

/// `bytes` read in the charset a message names; an unknown label reads as UTF-8.
pub(super) fn charset_text(label: &str, bytes: &[u8]) -> String {
    let encoding = encoding_rs::Encoding::for_label(label.trim().as_bytes()).unwrap_or(encoding_rs::UTF_8);
    encoding.decode_without_bom_handling(bytes).0.into_owned()
}

fn percent_bytes(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = |byte: u8| char::from(byte).to_digit(16);
        if bytes[at] == b'%'
            && let (Some(high), Some(low)) = (bytes.get(at + 1).and_then(|b| hex(*b)), bytes.get(at + 2).and_then(|b| hex(*b)))
        {
            out.push((high * 16 + low) as u8);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    out
}

fn quoted_printable_word(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'_' => out.push(b' '),
            b'=' => {
                let hex = |index: usize| bytes.get(index).and_then(|b| char::from(*b).to_digit(16));
                if let (Some(high), Some(low)) = (hex(at + 1), hex(at + 2)) {
                    out.push((high * 16 + low) as u8);
                    at += 2;
                } else {
                    out.push(b'=');
                }
            }
            other => out.push(other),
        }
        at += 1;
    }
    out
}

/// Base64 as mail carries it: padding present or not, a cut in the middle of a group keeps what came before it.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
);

fn base64_lenient(text: &[u8]) -> Vec<u8> {
    let mut clean: Vec<u8> = text.iter().copied().filter(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/').collect();
    // A single leftover character carries no whole byte.
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    LENIENT.decode(&clean).unwrap_or_default()
}

static ENCODED_WORD: LazyLock<Regex> = LazyLock::new(|| regex(r"=\?([^?\s]+)\?([BbQq])\?([^?]*)\?="));

/// RFC 2047 encoded words in a header value as text; words that follow each other in one charset are decoded together
/// (a character may be split between them) and the white space between them is dropped.
pub(super) fn decode_words(value: &str) -> String {
    if !value.contains("=?") {
        return value.to_owned();
    }
    let mut out = String::with_capacity(value.len());
    let mut pending: Option<(String, Vec<u8>)> = None;
    let mut last_end = 0;
    let flush = |out: &mut String, pending: &mut Option<(String, Vec<u8>)>| {
        if let Some((charset, bytes)) = pending.take() {
            out.push_str(&charset_text(&charset, &bytes));
        }
    };
    for found in ENCODED_WORD.captures_iter(value) {
        let whole = found.get(0).expect("group 0");
        let gap = &value[last_end..whole.start()];
        if pending.is_none() || !gap.chars().all(char::is_whitespace) {
            flush(&mut out, &mut pending);
            out.push_str(gap);
        }
        // `charset*language` (RFC 2231) names the charset before the star.
        let charset = found[1].split('*').next().unwrap_or("").to_owned();
        let decoded = if found[2].eq_ignore_ascii_case("b") { base64_lenient(found[3].as_bytes()) } else { quoted_printable_word(&found[3]) };
        let joins = matches!(&pending, Some((same, _)) if same.eq_ignore_ascii_case(&charset));
        if let (true, Some((_, bytes))) = (joins, pending.as_mut()) {
            bytes.extend(decoded);
        } else {
            flush(&mut out, &mut pending);
            pending = Some((charset, decoded));
        }
        last_end = whole.end();
    }
    flush(&mut out, &mut pending);
    out.push_str(&value[last_end..]);
    out
}

/// The parameters of a header (`name`, `filename`, ...) with RFC 2231 continuations joined and extended values decoded.
pub(super) fn merge_parameters(pairs: Vec<(String, String)>) -> Vec<(String, String)> {
    struct Piece {
        index: usize,
        extended: bool,
        value: String,
    }
    let mut plain: Vec<(String, String)> = Vec::new();
    let mut split: Vec<(String, Vec<Piece>)> = Vec::new();
    for (key, value) in pairs {
        let Some(star) = key.find('*') else {
            plain.push((key, value));
            continue;
        };
        let base = key[..star].to_owned();
        let rest = &key[star + 1..];
        let (digits, extended) = match rest.strip_suffix('*') {
            Some(digits) => (digits, true),
            None => (rest, false),
        };
        // `name*=...` has no number and is encoded; `name*0=...` is a continuation.
        let (index, extended) = if digits.is_empty() { (0, true) } else { (digits.parse().unwrap_or(0), extended) };
        let piece = Piece { index, extended, value };
        match split.iter_mut().find(|(name, _)| *name == base) {
            Some((_, pieces)) => pieces.push(piece),
            None => split.push((base, vec![piece])),
        }
    }
    for (base, mut pieces) in split {
        pieces.sort_by_key(|piece| piece.index);
        let mut charset = String::new();
        let mut bytes: Vec<u8> = Vec::new();
        let mut text = String::new();
        for (position, piece) in pieces.into_iter().enumerate() {
            if !piece.extended {
                text.push_str(&charset_text(&charset, &bytes));
                bytes.clear();
                text.push_str(&piece.value);
                continue;
            }
            let mut value = piece.value.as_str();
            if position == 0
                && let Some((label, tail)) = value.split_once('\'')
                && let Some((_, data)) = tail.split_once('\'')
            {
                charset = label.to_owned();
                value = data;
            }
            bytes.extend(percent_bytes(value));
        }
        text.push_str(&charset_text(&charset, &bytes));
        plain.push((base, text));
    }
    plain
}

/// The part's bytes as the message stored them, undone by its Content-Transfer-Encoding. A cut in the middle of the
/// data leaves what came before it.
pub(super) fn transfer_decode(encoding: &str, data: &[u8]) -> Vec<u8> {
    match encoding {
        "base64" => base64_lenient(data),
        "quoted-printable" => {
            let mut out = Vec::with_capacity(data.len());
            let mut at = 0;
            while at < data.len() {
                if data[at] == b'=' {
                    let hex = |index: usize| data.get(index).and_then(|b| char::from(*b).to_digit(16));
                    if let (Some(high), Some(low)) = (hex(at + 1), hex(at + 2)) {
                        out.push((high * 16 + low) as u8);
                        at += 3;
                        continue;
                    }
                    // A soft line break.
                    if data[at + 1..].starts_with(b"\r\n") {
                        at += 3;
                        continue;
                    }
                    if data[at + 1..].starts_with(b"\n") {
                        at += 2;
                        continue;
                    }
                }
                out.push(data[at]);
                at += 1;
            }
            out
        }
        _ => data.to_vec(),
    }
}

// ── HTML as text and as links ───────────────────────────────────────────────

static SCRIPT: LazyLock<Regex> = LazyLock::new(|| regex(r"(?i)<script\b[\s\S]*?</script>"));
static STYLE: LazyLock<Regex> = LazyLock::new(|| regex(r"(?i)<style\b[\s\S]*?</style>"));
static BREAKS: LazyLock<Regex> = LazyLock::new(|| regex(r"(?i)<br\s*/?>|</(?:p|div|tr|li|h\d)>"));
static TAG: LazyLock<Regex> = LazyLock::new(|| regex(r"<[^>]*>"));
static ENTITY: LazyLock<Regex> = LazyLock::new(|| regex(r"&(nbsp|lt|gt|quot|apos|amp|#39);"));
static BLANKS: LazyLock<Regex> = LazyLock::new(|| regex(r"[ \t]+"));
static LINE_SPACE: LazyLock<Regex> = LazyLock::new(|| regex(r" *\n\s*"));

/// `htmlText`: tags dropped, block ends as line breaks, a few entities, runs of blanks as one.
pub(super) fn html_text(html: &str) -> String {
    let text = SCRIPT.replace_all(html, " ");
    let text = STYLE.replace_all(&text, " ");
    let text = BREAKS.replace_all(&text, "\n");
    let text = TAG.replace_all(&text, " ");
    let text = ENTITY.replace_all(&text, |caps: &regex::Captures<'_>| match &caps[1] {
        "nbsp" => " ",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "amp" => "&",
        _ => "'",
    });
    let text = BLANKS.replace_all(&text, " ");
    let text = LINE_SPACE.replace_all(&text, "\n");
    mixdog_js::js_trim(&text).to_owned()
}

/// Character references in an attribute value (HTML Standard, 13.2.5.72): numeric ones, and the five named ones a
/// link carries in practice; one without its semicolon only before a character that cannot continue the name.
fn character_references(value: &str) -> String {
    if !value.contains('&') {
        return value.to_owned();
    }
    const NAMED: [(&str, char); 6] = [("amp", '&'), ("lt", '<'), ("gt", '>'), ("quot", '"'), ("apos", '\''), ("nbsp", '\u{a0}')];
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let tail = &rest[1..];
        let mut taken = None;
        if let Some(number) = tail.strip_prefix('#') {
            let (hex, digits) = match number.strip_prefix(['x', 'X']) {
                Some(digits) => (true, digits),
                None => (false, number),
            };
            let length = digits.chars().take_while(|c| if hex { c.is_ascii_hexdigit() } else { c.is_ascii_digit() }).count();
            if length > 0 {
                let code = u32::from_str_radix(&digits[..length], if hex { 16 } else { 10 }).unwrap_or(0xFFFD);
                let ch = char::from_u32(code).filter(|c| *c != '\0').unwrap_or('\u{FFFD}');
                let used = 2 + usize::from(hex) + length;
                taken = Some((ch, used + usize::from(rest[used..].starts_with(';'))));
            }
        } else {
            for (name, ch) in NAMED {
                if let Some(after) = tail.strip_prefix(name) {
                    if after.starts_with(';') {
                        taken = Some((ch, 1 + name.len() + 1));
                    } else if !after.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '=') {
                        taken = Some((ch, 1 + name.len()));
                    }
                    break;
                }
            }
        }
        match taken {
            Some((ch, used)) => {
                out.push(ch);
                rest = &rest[used..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Elements whose content is text, not markup: a tag inside them is no tag.
const RAW_TEXT: [&str; 8] = ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"];

/// The targets of an HTML part's hyperlinks (`a` and `area` with `href`, HTML Standard 4.6) as the HTML parser reads the
/// attribute, character references decoded. A tag the text ends inside is no element (the eof-in-tag error emits none).
pub(super) fn html_links(html: &str) -> Vec<String> {
    let bytes = html.as_bytes();
    let lower = html.to_ascii_lowercase();
    let mut links = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'<' {
            at += 1;
            continue;
        }
        let rest = &html[at..];
        if let Some(inner) = rest.strip_prefix("<!--") {
            match inner.find("-->") {
                Some(end) => at += 4 + end + 3,
                None => return links,
            }
            continue;
        }
        let next = bytes.get(at + 1).copied().unwrap_or(0);
        if next == b'!' || next == b'?' || next == b'/' {
            match rest.find('>') {
                Some(end) => at += end + 1,
                None => return links,
            }
            continue;
        }
        if !next.is_ascii_alphabetic() {
            at += 1;
            continue;
        }
        let name_start = at + 1;
        let mut at_tag = name_start;
        while at_tag < bytes.len() && !bytes[at_tag].is_ascii_whitespace() && bytes[at_tag] != b'/' && bytes[at_tag] != b'>' {
            at_tag += 1;
        }
        let name = &lower[name_start..at_tag];
        let mut href: Option<String> = None;
        let mut closed = false;
        while at_tag < bytes.len() {
            while at_tag < bytes.len() && (bytes[at_tag].is_ascii_whitespace() || bytes[at_tag] == b'/') {
                at_tag += 1;
            }
            if at_tag >= bytes.len() {
                break;
            }
            if bytes[at_tag] == b'>' {
                at_tag += 1;
                closed = true;
                break;
            }
            let key_start = at_tag;
            // An `=` that starts an attribute name belongs to the name.
            at_tag += 1;
            while at_tag < bytes.len() && !bytes[at_tag].is_ascii_whitespace() && bytes[at_tag] != b'/' && bytes[at_tag] != b'>' && bytes[at_tag] != b'=' {
                at_tag += 1;
            }
            let key = &lower[key_start..at_tag];
            while at_tag < bytes.len() && bytes[at_tag].is_ascii_whitespace() {
                at_tag += 1;
            }
            let mut value = "";
            if bytes.get(at_tag) == Some(&b'=') {
                at_tag += 1;
                while at_tag < bytes.len() && bytes[at_tag].is_ascii_whitespace() {
                    at_tag += 1;
                }
                match bytes.get(at_tag) {
                    Some(&quote) if quote == b'"' || quote == b'\'' => {
                        let start = at_tag + 1;
                        let Some(end) = html[start..].find(char::from(quote)) else { return links };
                        value = &html[start..start + end];
                        at_tag = start + end + 1;
                    }
                    _ => {
                        let start = at_tag;
                        while at_tag < bytes.len() && !bytes[at_tag].is_ascii_whitespace() && bytes[at_tag] != b'>' {
                            at_tag += 1;
                        }
                        value = &html[start..at_tag];
                    }
                }
            }
            if key == "href" && href.is_none() {
                href = Some(character_references(value));
            }
        }
        if !closed {
            return links;
        }
        at = at_tag;
        if (name == "a" || name == "area")
            && let Some(target) = href
        {
            links.push(target);
        }
        if name == "plaintext" {
            return links;
        }
        if RAW_TEXT.contains(&name) {
            match lower[at..].find(&format!("</{name}")) {
                Some(end) => at += end,
                None => return links,
            }
        }
    }
    links
}

/// An absolute http(s) URI in plain text as RFC 3986 spells one: the scheme, then a run of URI characters.
static TEXT_URI: LazyLock<Regex> = LazyLock::new(|| regex(r"(?i)https?://(?:[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})+"));

fn is_web_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https"))
}

/// The message's link targets, exactly as written: the hyperlinks of its HTML part, then the URIs of its text part (one
/// the download cut off is left out). Absolute http(s) only, each once.
pub(super) fn message_links(plain: Option<(&str, bool)>, hrefs: Vec<String>) -> Vec<String> {
    let mut links = hrefs;
    if let Some((text, complete)) = plain {
        for found in TEXT_URI.find_iter(text) {
            if !complete && found.end() == text.len() {
                continue;
            }
            links.push(found.as_str().to_owned());
        }
    }
    let mut seen = std::collections::HashSet::new();
    links.retain(|link| is_web_url(link) && seen.insert(link.clone()));
    links
}

// ── Headers ─────────────────────────────────────────────────────────────────

static UNFOLD: LazyLock<Regex> = LazyLock::new(|| regex(r"\r?\n[ \t]+"));
static AUTH_RESULTS: LazyLock<Regex> = LazyLock::new(|| regex(r"(?im)^authentication-results:(.*)$"));
static COMMENT: LazyLock<Regex> = LazyLock::new(|| regex(r"\([^()]*\)"));
static METHOD: LazyLock<Regex> = LazyLock::new(|| regex(r"(?i)^\s*([a-z0-9-]+)\s*=\s*([a-z]+)"));
static PROPERTY: LazyLock<Regex> = LazyLock::new(|| regex(r#"(?i)([a-z]+\.[a-z]+)\s*=\s*("[^"]*"|[^\s;]+)"#));
static REFERENCE: LazyLock<Regex> = LazyLock::new(|| regex(r"<[^<>\s]+>"));

/// The header block with its folded lines joined and its line breaks single.
fn unfolded(headers: &str) -> String {
    UNFOLD.replace_all(headers, " ").replace("\r\n", "\n")
}

fn strip_comments(text: &str) -> String {
    let mut out = text.to_owned();
    loop {
        let next = COMMENT.replace_all(&out, " ").into_owned();
        if next == out {
            return out;
        }
        out = next;
    }
}

/// Gmail's own verdict on the sender, read from the topmost Authentication-Results only, and only when its authserv-id is
/// Gmail's (mx.google.com): the receiving MTA prepends the field (RFC 8601 4, 4.1) and deletes any copy that arrives
/// bearing its own id (RFC 8601 5), so a sender cannot pass one off as Gmail's. A message no MTA delivered has only the
/// headers its author wrote and no verdict. `{ dmarc: { result, from }, dkim: [{ result, domain }] }`, or null.
pub(super) fn gmail_authentication(headers: &str) -> Value {
    let unfolded = unfolded(headers);
    let Some(first) = AUTH_RESULTS.captures(&unfolded).and_then(|c| c.get(1)).map(|m| m.as_str().to_owned()) else { return Value::Null };
    let stripped = strip_comments(&first);
    let mut parts = stripped.split(';');
    let server = parts.next().unwrap_or("");
    if server.split_whitespace().next().unwrap_or("").to_lowercase() != "mx.google.com" {
        return Value::Null;
    }
    let mut dmarc = Value::Null;
    let mut dkim = Vec::new();
    for entry in parts {
        let Some(method) = METHOD.captures(entry) else { continue };
        let property = |name: &str| -> Option<String> {
            PROPERTY.captures_iter(entry).filter(|c| c[1].eq_ignore_ascii_case(name)).last().map(|c| c[2].trim_matches('"').to_lowercase())
        };
        let result = method[2].to_lowercase();
        let kind = method[1].to_lowercase();
        if kind == "dmarc" && dmarc.is_null() {
            dmarc = json!({ "result": result, "from": property("header.from").unwrap_or_default() });
        }
        // Only the signing domain d= counts toward the From domain (RFC 7489 3.1.1).
        if kind == "dkim"
            && let Some(domain) = property("header.d").filter(|d| !d.is_empty())
        {
            dkim.push(json!({ "result": result, "domain": domain }));
        }
    }
    json!({ "dmarc": dmarc, "dkim": dkim })
}

/// The Message-IDs of a References header, in order.
pub(super) fn references(headers: &str) -> Vec<String> {
    REFERENCE.find_iter(&unfolded(headers)).map(|m| m.as_str().to_owned()).collect()
}

// ── Dates ───────────────────────────────────────────────────────────────────

/// `isoDate`: `new Date(value).toISOString()`, empty for no date or one that is none.
pub(super) fn iso_date(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    iso_from_ms(mixdog_js::time::date_parse(value))
}

/// `Date.prototype.toISOString` of a time value; empty for NaN.
pub(super) fn iso_from_ms(ms: f64) -> String {
    let Some(f) = mixdog_js::time::local_fields_in(Tz::UTC, ms) else { return String::new() };
    let year = if (0..=9999).contains(&f.year) { format!("{:04}", f.year) } else { format!("{}{:06}", if f.year < 0 { '-' } else { '+' }, f.year.abs()) };
    format!("{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", f.month, f.day, f.hour, f.minute, f.second, f.millisecond)
}

/// `.replace(/\s+/g, ' ')`.
pub(super) fn squash_space(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if mixdog_js::is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            in_space = false;
            out.push(c);
        }
    }
    out
}

/// `clip(value, max)`: the first `max` UTF-16 units and an ellipsis when it is longer.
pub(super) fn clip(value: &str, max: usize) -> String {
    if mixdog_js::utf16_len(value) > max { format!("{}…", mixdog_js::slice_utf16(value, max)) } else { value.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_words_in_one_charset_are_decoded_together_and_their_gap_is_dropped() {
        assert_eq!(decode_words("=?UTF-8?B?7ZWc?= =?UTF-8?B?6riA?= plain"), "한글 plain");
        // One character split between two words.
        assert_eq!(decode_words("=?UTF-8?B?7Zw=?= =?UTF-8?B?oA==?="), "휠");
        assert_eq!(decode_words("a =?ISO-8859-1?Q?caf=E9_au_lait?= b"), "a café au lait b");
        assert_eq!(decode_words("=?euc-kr?B?x9Gx2w==?="), "한글");
        assert_eq!(decode_words("no words"), "no words");
    }

    #[test]
    fn parameter_continuations_and_extended_values_are_joined() {
        let pairs = vec![
            ("filename*0*".to_owned(), "utf-8''a%20".to_owned()),
            ("filename*1*".to_owned(), "b%E2%82%AC".to_owned()),
            ("name".to_owned(), "x".to_owned()),
            ("title*0".to_owned(), "one".to_owned()),
            ("title*1".to_owned(), "two".to_owned()),
        ];
        let merged = merge_parameters(pairs);
        assert!(merged.contains(&("name".to_owned(), "x".to_owned())));
        assert!(merged.contains(&("filename".to_owned(), "a b€".to_owned())));
        assert!(merged.contains(&("title".to_owned(), "onetwo".to_owned())));
    }

    #[test]
    fn transfer_encodings_are_undone_and_a_cut_keeps_what_came_before_it() {
        assert_eq!(transfer_decode("base64", b"aGVsbG8g\r\nd29ybGQ="), b"hello world");
        assert_eq!(transfer_decode("base64", b"aGVsbG8gd29y"), b"hello wor");
        assert_eq!(transfer_decode("base64", b"aGVsbG8gd2"), b"hello w");
        assert_eq!(transfer_decode("quoted-printable", b"a=3Db =\r\nc=E2=82"), b"a=b c\xE2\x82");
        assert_eq!(transfer_decode("7bit", b"x"), b"x");
    }

    #[test]
    fn html_becomes_text_with_its_block_ends_as_line_breaks() {
        let html = "<style>p{}</style><p>Fish&nbsp;&amp;&nbsp;chips</p><div>two<br>lines</div><script>x()</script>";
        assert_eq!(html_text(html), "Fish & chips\ntwo\nlines");
    }

    #[test]
    fn links_are_the_hrefs_the_html_parser_reads() {
        let html = concat!(
            "<a href=\"https://a.example/?x=1&amp;y=2\">a</a>",
            "<A HREF='https://b.example/' href='https://ignored.example/'>b</A>",
            "<area href=https://c.example/ >",
            "<!-- <a href=\"https://comment.example/\"> -->",
            "<script>var s = '<a href=\"https://script.example/\">';</script>",
            "<a name=x>no href</a>",
            "<a href=\"mailto:x@y.org\">m</a>",
            "<a href=\"https://cut.example/\"",
        );
        assert_eq!(
            html_links(html),
            ["https://a.example/?x=1&y=2", "https://b.example/", "https://c.example/", "mailto:x@y.org"]
        );
    }

    #[test]
    fn message_links_are_web_urls_once_and_a_cut_uri_is_left_out() {
        let hrefs = vec!["https://a.example/".to_owned(), "mailto:x@y.org".to_owned(), "/relative".to_owned()];
        let plain = "see https://a.example/ and https://t.example/path?q=1, then https://cu";
        assert_eq!(message_links(Some((plain, true)), hrefs.clone()), ["https://a.example/", "https://t.example/path?q=1,", "https://cu"]);
        assert_eq!(message_links(Some((plain, false)), hrefs), ["https://a.example/", "https://t.example/path?q=1,"]);
    }

    #[test]
    fn only_gmails_topmost_authentication_results_count() {
        let google = "Authentication-Results: mx.google.com;\r\n dkim=pass header.d=Example.org header.s=k;\r\n dkim=fail header.d=other.org;\r\n spf=pass smtp.mailfrom=x@y.org;\r\n dmarc=fail (p=REJECT) header.from=example.org\r\nAuthentication-Results: mx.google.com; dmarc=pass header.from=second.org\r\n";
        assert_eq!(
            gmail_authentication(google),
            json!({ "dmarc": { "result": "fail", "from": "example.org" }, "dkim": [{ "result": "pass", "domain": "example.org" }, { "result": "fail", "domain": "other.org" }] })
        );
        assert_eq!(gmail_authentication("Authentication-Results: mail.evil.example; dmarc=pass header.from=bank.com\r\n"), Value::Null);
        assert_eq!(gmail_authentication("Subject: x\r\n"), Value::Null);
        assert_eq!(gmail_authentication(""), Value::Null);
        // A verdict with a comment holding the id of another server.
        assert_eq!(gmail_authentication("Authentication-Results: (mx.google.com) mail.evil.example; dmarc=pass"), Value::Null);
    }

    #[test]
    fn references_are_the_ids_in_order_across_folded_lines() {
        assert_eq!(references("References: <a@x> <b@x>\r\n <c@x>\r\n"), ["<a@x>", "<b@x>", "<c@x>"]);
    }

    #[test]
    fn dates_are_iso_in_utc_and_empty_when_they_are_none() {
        assert_eq!(iso_date("Mon, 7 Feb 2022 21:52:25 -0800"), "2022-02-08T05:52:25.000Z");
        assert_eq!(iso_date("not a date"), "");
        assert_eq!(iso_date(""), "");
        assert_eq!(iso_from_ms(0.0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn white_space_runs_and_long_text_are_shortened_as_the_old_server_does() {
        assert_eq!(squash_space(" a \n\t b  "), " a b ");
        assert_eq!(clip("abcdef", 3), "abc…");
        assert_eq!(clip("abc", 3), "abc");
    }
}
