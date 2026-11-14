//! The message `send_email` hands to SMTP, as nodemailer would build it from `{ from, to, cc, bcc, subject, text,
//! inReplyTo, references }`: a plain-text message whose headers are encoded for any text, and the envelope recipients.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_js::time::Tz;

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/// The longest line a message may carry (RFC 5322 2.1.1).
const LINE_MAX: usize = 998;
/// Characters of one encoded word's text (its encoded form stays within 75).
const WORD_BYTES: usize = 36;
const FOLD_AT: usize = 76;

pub(super) struct Outgoing<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub cc: &'a str,
    pub bcc: &'a str,
    pub subject: &'a str,
    pub body: &'a str,
    pub in_reply_to: Option<&'a str>,
    pub references: &'a [String],
}

pub(super) struct Built {
    pub message_id: String,
    pub data: Vec<u8>,
    pub recipients: Vec<String>,
}

#[derive(Debug, PartialEq)]
struct Mailbox {
    name: String,
    address: String,
}

/// An address list as typed: `a@x.org, Name <b@y.org>, "Last, First" <c@z.org>`.
fn parse_list(list: &str) -> Vec<Mailbox> {
    let mut pieces = Vec::new();
    let (mut start, mut quoted, mut angle) = (0, false, false);
    let mut chars = list.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match c {
            '\\' if quoted => {
                chars.next();
            }
            '"' => quoted = !quoted,
            '<' if !quoted => angle = true,
            '>' if !quoted => angle = false,
            ',' | ';' if !quoted && !angle => {
                pieces.push(&list[start..at]);
                start = at + c.len_utf8();
            }
            _ => {}
        }
    }
    pieces.push(&list[start..]);
    pieces
        .into_iter()
        .map(mixdog_js::js_trim)
        .filter(|piece| !piece.is_empty())
        .map(|piece| match (piece.rfind('<'), piece.rfind('>')) {
            (Some(open), Some(close)) if open < close => {
                let name = mixdog_js::js_trim(&piece[..open]);
                let name = name.strip_prefix('"').and_then(|n| n.strip_suffix('"')).map_or_else(|| name.to_owned(), |n| n.replace("\\\"", "\"").replace("\\\\", "\\"));
                Mailbox { name, address: mixdog_js::js_trim(&piece[open + 1..close]).to_owned() }
            }
            _ => Mailbox { name: String::new(), address: piece.to_owned() },
        })
        .collect()
}

/// `text` as encoded words (RFC 2047) when it is not plain ASCII.
fn encoded_words(text: &str) -> String {
    if text.is_ascii() && !text.contains(['\r', '\n']) {
        return text.to_owned();
    }
    let mut words = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if current.len() + c.len_utf8() > WORD_BYTES {
            words.push(std::mem::take(&mut current));
        }
        current.push(c);
    }
    if !current.is_empty() {
        words.push(current);
    }
    words.iter().map(|word| format!("=?UTF-8?B?{}?=", STANDARD.encode(word))).collect::<Vec<_>>().join("\r\n ")
}

fn format_mailbox(mailbox: &Mailbox) -> String {
    if mailbox.name.is_empty() {
        return mailbox.address.clone();
    }
    let name = if !mailbox.name.is_ascii() {
        encoded_words(&mailbox.name)
    } else if mailbox.name.chars().any(|c| "()<>[]:;@\\,.\"".contains(c)) {
        format!("\"{}\"", mailbox.name.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        mailbox.name.clone()
    };
    format!("{name} <{}>", mailbox.address)
}

fn format_list(mailboxes: &[Mailbox]) -> String {
    mailboxes.iter().map(format_mailbox).collect::<Vec<_>>().join(", ")
}

/// `Date:` as RFC 5322 spells it, in UTC.
fn date_header(now_ms: f64) -> String {
    let Some(f) = mixdog_js::time::local_fields_in(Tz::UTC, now_ms) else { return String::new() };
    format!(
        "{}, {} {} {:04} {:02}:{:02}:{:02} +0000",
        WEEKDAYS[f.weekday as usize % 7],
        f.day,
        MONTHS[(f.month as usize).saturating_sub(1) % 12],
        f.year,
        f.hour,
        f.minute,
        f.second
    )
}

/// A header line whose items go on continuation lines once it passes 76 characters.
fn folded(name: &str, items: &[String]) -> String {
    let mut out = format!("{name}:");
    let mut line = out.len();
    for item in items {
        if line + 1 + item.len() > FOLD_AT && line > name.len() + 1 {
            out.push_str("\r\n");
            line = 0;
        }
        out.push(' ');
        out.push_str(item);
        line += 1 + item.len();
    }
    out
}

fn body_lines(body: &str) -> String {
    body.replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n")
}

/// The body and the Content-Transfer-Encoding that carries it: as is when it is 7-bit with short lines, else base64.
fn body_part(body: &str) -> (&'static str, String) {
    let text = body_lines(body);
    let plain = text.is_ascii() && !text.contains('\0') && text.split("\r\n").all(|line| line.len() <= LINE_MAX);
    if plain {
        return ("7bit", text);
    }
    let encoded = STANDARD.encode(text.as_bytes());
    let lines: Vec<&str> = encoded.as_bytes().chunks(76).map(|chunk| std::str::from_utf8(chunk).unwrap_or("")).collect();
    ("base64", lines.join("\r\n"))
}

/// The message, its Message-ID (`unique` makes it, at the sender's domain) and the addresses it is sent to.
pub(super) fn build(message: &Outgoing<'_>, now_ms: f64, unique: &str) -> Built {
    let to = parse_list(message.to);
    let cc = parse_list(message.cc);
    let bcc = parse_list(message.bcc);
    let mut recipients: Vec<String> = Vec::new();
    for mailbox in to.iter().chain(&cc).chain(&bcc) {
        if !mailbox.address.is_empty() && !recipients.contains(&mailbox.address) {
            recipients.push(mailbox.address.clone());
        }
    }
    let domain = message.from.rsplit_once('@').map_or("localhost", |(_, domain)| domain);
    let message_id = format!("<{unique}@{domain}>");
    let mut headers = vec![
        format!("From: {}", message.from),
        format!("To: {}", format_list(&to)),
    ];
    if !cc.is_empty() {
        headers.push(format!("Cc: {}", format_list(&cc)));
    }
    headers.push(format!("Subject: {}", encoded_words(message.subject)));
    if let Some(parent) = message.in_reply_to {
        headers.push(format!("In-Reply-To: {parent}"));
        if !message.references.is_empty() {
            headers.push(folded("References", message.references));
        }
    }
    headers.push(format!("Message-ID: {message_id}"));
    headers.push(format!("Date: {}", date_header(now_ms)));
    let (encoding, body) = body_part(message.body);
    headers.push("MIME-Version: 1.0".to_owned());
    headers.push("Content-Type: text/plain; charset=utf-8".to_owned());
    headers.push(format!("Content-Transfer-Encoding: {encoding}"));
    let data = format!("{}\r\n\r\n{body}", headers.join("\r\n")).into_bytes();
    Built { message_id, data, recipients }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outgoing<'a>(to: &'a str, subject: &'a str, body: &'a str) -> Outgoing<'a> {
        Outgoing { from: "me@gmail.com", to, cc: "", bcc: "", subject, body, in_reply_to: None, references: &[] }
    }

    #[test]
    fn an_address_list_splits_outside_quotes_and_angles() {
        let list = parse_list("a@x.org, \"Last, First\" <b@y.org>;  Name <c@z.org>");
        assert_eq!(
            list,
            [
                Mailbox { name: String::new(), address: "a@x.org".into() },
                Mailbox { name: "Last, First".into(), address: "b@y.org".into() },
                Mailbox { name: "Name".into(), address: "c@z.org".into() },
            ]
        );
        assert_eq!(format_list(&list), "a@x.org, \"Last, First\" <b@y.org>, Name <c@z.org>");
    }

    #[test]
    fn the_envelope_lists_to_cc_and_bcc_once_each_and_bcc_is_not_a_header() {
        let mut message = outgoing("a@x.org, b@x.org", "Hi", "text");
        message.cc = "b@x.org, c@x.org";
        message.bcc = "d@x.org";
        let built = build(&message, 0.0, "u");
        assert_eq!(built.recipients, ["a@x.org", "b@x.org", "c@x.org", "d@x.org"]);
        let text = String::from_utf8(built.data).unwrap();
        assert!(text.contains("Cc: b@x.org, c@x.org\r\n"));
        assert!(!text.contains("d@x.org"));
        assert_eq!(built.message_id, "<u@gmail.com>");
        assert!(text.contains("Date: Thu, 1 Jan 1970 00:00:00 +0000\r\n"));
    }

    #[test]
    fn plain_text_goes_as_7bit_and_other_text_as_wrapped_base64_with_an_encoded_subject() {
        let plain = String::from_utf8(build(&outgoing("a@x.org", "Hi", "one\ntwo"), 0.0, "u").data).unwrap();
        assert!(plain.contains("Content-Transfer-Encoding: 7bit\r\n"));
        assert!(plain.ends_with("\r\n\r\none\r\ntwo"));

        let long = "한".repeat(60);
        let other = String::from_utf8(build(&outgoing("a@x.org", "안녕", &long), 0.0, "u").data).unwrap();
        assert!(other.contains(&format!("Subject: =?UTF-8?B?{}?=\r\n", STANDARD.encode("안녕"))));
        assert!(other.contains("Content-Transfer-Encoding: base64\r\n"));
        let body = other.split("\r\n\r\n").nth(1).unwrap();
        assert!(body.split("\r\n").all(|line| line.len() <= 76));
        assert_eq!(STANDARD.decode(body.replace("\r\n", "")).unwrap(), long.as_bytes());
    }

    #[test]
    fn a_reply_carries_in_reply_to_and_folded_references() {
        let references: Vec<String> = (0..8).map(|n| format!("<reference-number-{n}@mail.example.org>")).collect();
        let mut message = outgoing("a@x.org", "Re: Hi", "x");
        message.in_reply_to = Some("<parent@x>");
        message.references = &references;
        let text = String::from_utf8(build(&message, 0.0, "u").data).unwrap();
        assert!(text.contains("In-Reply-To: <parent@x>\r\n"));
        let block = text.split("References:").nth(1).unwrap().split("\r\nMessage-ID").next().unwrap();
        assert!(block.contains("\r\n "));
        assert_eq!(block.split_whitespace().count(), 8);
    }
}
