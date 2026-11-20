//! IMAP response syntax (RFC 3501 9) as far as the mailbox tools read it: untagged responses as values, an ENVELOPE as
//! its addresses and text, and a BODYSTRUCTURE as the tree imapflow hands the tools (type, parameters, disposition,
//! encoding, size and part number of every node).

use super::text::{decode_words, merge_parameters};

#[derive(Debug, Clone, PartialEq)]
pub(super) enum V {
    Nil,
    Atom(String),
    Str(Vec<u8>),
    List(Vec<V>),
}

impl V {
    /// The text of a string or atom; `None` for NIL and lists.
    pub fn text(&self) -> Option<String> {
        match self {
            V::Atom(atom) => Some(atom.clone()),
            V::Str(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        }
    }

    pub fn bytes(&self) -> Option<&[u8]> {
        match self {
            V::Str(bytes) => Some(bytes),
            _ => None,
        }
    }

    pub fn list(&self) -> Option<&[V]> {
        match self {
            V::List(items) => Some(items),
            _ => None,
        }
    }
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn skip_blanks(&mut self) {
        while self.data.get(self.at).is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n')) {
            self.at += 1;
        }
    }

    fn value(&mut self) -> Option<V> {
        self.skip_blanks();
        match *self.data.get(self.at)? {
            b'(' => {
                self.at += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_blanks();
                    match self.data.get(self.at) {
                        None => break,
                        Some(b')') => {
                            self.at += 1;
                            break;
                        }
                        Some(_) => items.push(self.value()?),
                    }
                }
                Some(V::List(items))
            }
            b'"' => {
                self.at += 1;
                let mut out = Vec::new();
                while let Some(&byte) = self.data.get(self.at) {
                    self.at += 1;
                    match byte {
                        b'"' => break,
                        b'\\' => {
                            if let Some(&escaped) = self.data.get(self.at) {
                                out.push(escaped);
                                self.at += 1;
                            }
                        }
                        other => out.push(other),
                    }
                }
                Some(V::Str(out))
            }
            b'{' => {
                let close = self.data[self.at..].iter().position(|b| *b == b'}')? + self.at;
                let digits: String = String::from_utf8_lossy(&self.data[self.at + 1..close]).trim_end_matches('+').to_owned();
                let size: usize = digits.parse().ok()?;
                let mut start = close + 1;
                if self.data[start..].starts_with(b"\r\n") {
                    start += 2;
                }
                let end = (start + size).min(self.data.len());
                self.at = end;
                Some(V::Str(self.data[start..end].to_vec()))
            }
            b')' => {
                // A stray closing parenthesis ends nothing here: skip it.
                self.at += 1;
                self.value()
            }
            _ => {
                let start = self.at;
                let mut depth = 0usize;
                while let Some(&byte) = self.data.get(self.at) {
                    match byte {
                        b'[' => depth += 1,
                        b']' => depth = depth.saturating_sub(1),
                        b' ' | b'(' | b')' | b'\r' | b'\n' if depth == 0 => break,
                        _ => {}
                    }
                    self.at += 1;
                }
                let atom = String::from_utf8_lossy(&self.data[start..self.at]).into_owned();
                Some(if atom.eq_ignore_ascii_case("NIL") { V::Nil } else { V::Atom(atom) })
            }
        }
    }
}

/// The values of one untagged response (its leading `* ` already removed).
pub(super) fn response(data: &[u8]) -> Vec<V> {
    let mut reader = Reader { data, at: 0 };
    let mut out = Vec::new();
    while let Some(value) = reader.value() {
        out.push(value);
    }
    out
}

// ── Envelope ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct Addr {
    pub name: String,
    pub address: String,
}

#[derive(Debug, Clone, Default)]
pub(super) struct Envelope {
    pub date: String,
    pub subject: String,
    pub from: Vec<Addr>,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub message_id: String,
}

fn string(value: Option<&V>) -> String {
    value.and_then(V::text).unwrap_or_default()
}

/// The mailboxes of an address list as imapflow parses them: `mailbox@host`, the display name with its encoded words
/// read; a group shows as its name with no address and its members are not listed.
fn addresses(value: Option<&V>) -> Vec<Addr> {
    let mut out = Vec::new();
    let mut in_group = false;
    for entry in value.and_then(V::list).unwrap_or_default() {
        let Some(fields) = entry.list() else { continue };
        let name = fields.first().and_then(V::text);
        let mailbox = fields.get(2).and_then(V::text);
        let host = fields.get(3).and_then(V::text);
        match (mailbox, host) {
            (Some(group), None) => {
                in_group = true;
                out.push(Addr { name: decode_words(&group), address: String::new() });
            }
            (None, None) => in_group = false,
            (Some(mailbox), Some(host)) if !in_group => {
                out.push(Addr { name: decode_words(&name.unwrap_or_default()), address: format!("{mailbox}@{host}") });
            }
            _ => {}
        }
    }
    out
}

pub(super) fn envelope(value: &V) -> Envelope {
    let Some(fields) = value.list() else { return Envelope::default() };
    Envelope {
        date: string(fields.first()),
        subject: decode_words(&string(fields.get(1))),
        from: addresses(fields.get(2)),
        to: addresses(fields.get(5)),
        cc: addresses(fields.get(6)),
        message_id: string(fields.get(9)),
    }
}

// ── Body structure ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub(super) struct Node {
    /// `type/subtype`, lower case.
    pub kind: String,
    pub parameters: Vec<(String, String)>,
    pub disposition: Option<String>,
    pub disposition_parameters: Vec<(String, String)>,
    pub encoding: String,
    pub size: u64,
    /// The part number; `None` for the message's own top level.
    pub part: Option<String>,
    pub children: Vec<Node>,
}

impl Node {
    pub fn parameter(&self, name: &str) -> Option<&str> {
        self.parameters.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str()).filter(|value| !value.is_empty())
    }

    pub fn disposition_parameter(&self, name: &str) -> Option<&str> {
        self.disposition_parameters.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str()).filter(|value| !value.is_empty())
    }
}

fn parameters(value: Option<&V>) -> Vec<(String, String)> {
    let pairs =
        value.and_then(V::list).unwrap_or_default().chunks(2).filter_map(|pair| Some((pair.first()?.text()?.to_lowercase(), pair.get(1)?.text()?))).collect();
    merge_parameters(pairs).into_iter().map(|(key, value)| (key, decode_words(&value))).collect()
}

fn disposition(value: Option<&V>, node: &mut Node) {
    let Some(fields) = value.and_then(V::list) else { return };
    node.disposition = fields.first().and_then(V::text).map(|d| d.to_lowercase());
    node.disposition_parameters = parameters(fields.get(1));
}

/// The node of a BODYSTRUCTURE value; `part` is its number (imapflow numbers the children of a multipart `1`, `2`, ...
/// and theirs `1.1`, ...; a message that is no multipart has no number).
pub(super) fn structure(value: &V, part: Option<String>) -> Option<Node> {
    let items = value.list()?;
    let mut node = Node { part: part.clone(), ..Node::default() };
    if matches!(items.first(), Some(V::List(_))) {
        let count = items.iter().take_while(|item| matches!(item, V::List(_))).count();
        for (index, child) in items[..count].iter().enumerate() {
            let number = match &part {
                Some(parent) => format!("{parent}.{}", index + 1),
                None => (index + 1).to_string(),
            };
            node.children.extend(structure(child, Some(number)));
        }
        node.kind = format!("multipart/{}", string(items.get(count)).to_lowercase());
        node.parameters = parameters(items.get(count + 1));
        disposition(items.get(count + 2), &mut node);
        return Some(node);
    }
    node.kind = format!("{}/{}", string(items.first()).to_lowercase(), string(items.get(1)).to_lowercase());
    node.parameters = parameters(items.get(2));
    node.encoding = string(items.get(5)).to_lowercase();
    node.size = string(items.get(6)).parse().unwrap_or(0);
    // Extension data starts after the size, the line count of a text part, or the envelope, body and line count of a
    // message part; it opens with the MD5, then the disposition.
    let disposition_at = if node.kind.starts_with("text/") {
        9
    } else if node.kind == "message/rfc822" {
        11
    } else {
        8
    };
    disposition(items.get(disposition_at), &mut node);
    Some(node)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals_quoted_strings_and_nil_parse_as_values() {
        let data = b"3 FETCH (UID 5 BODY[1]<0> {5}\r\nhe\"lo X-GM-MSGID 77 ENVELOPE (NIL \"a \\\"b\\\"\" NIL))";
        let values = response(data);
        assert_eq!(values[0], V::Atom("3".into()));
        let list = values[2].list().unwrap();
        assert_eq!(list[2], V::Atom("BODY[1]<0>".into()));
        assert_eq!(list[3].bytes().unwrap(), b"he\"lo");
        assert_eq!(list[5], V::Atom("77".into()));
        let envelope = list[7].list().unwrap();
        assert_eq!(envelope[0], V::Nil);
        assert_eq!(envelope[1].text().unwrap(), "a \"b\"");
    }

    #[test]
    fn a_header_fields_key_with_spaces_and_parentheses_is_one_atom() {
        let values = response(b"1 FETCH (BODY[HEADER.FIELDS (REFERENCES)] \"x\")");
        let list = values[2].list().unwrap();
        assert_eq!(list[0], V::Atom("BODY[HEADER.FIELDS (REFERENCES)]".into()));
        assert_eq!(list[1].text().unwrap(), "x");
    }

    #[test]
    fn addresses_join_mailbox_and_host_and_a_group_shows_as_its_name() {
        let values = response(
            b"(NIL \"S\" ((\"=?UTF-8?B?7ZmN6ri4?=\" NIL \"a\" \"x.org\") (NIL NIL \"team\" NIL) (NIL NIL \"m\" \"y.org\") (NIL NIL NIL NIL)) NIL NIL NIL NIL NIL NIL \"<id@x>\")",
        );
        let envelope = envelope(&values[0]);
        assert_eq!(envelope.subject, "S");
        assert_eq!(envelope.message_id, "<id@x>");
        assert_eq!(envelope.from, [Addr { name: "홍길".into(), address: "a@x.org".into() }, Addr { name: "team".into(), address: String::new() }]);
    }

    #[test]
    fn a_multipart_numbers_its_children_and_reads_attachment_names() {
        let values = response(
            b"((\"text\" \"plain\" (\"charset\" \"utf-8\") NIL NIL \"7bit\" 10 1)(\"application\" \"pdf\" (\"name\" \"r.pdf\") NIL NIL \"base64\" 400 NIL (\"attachment\" (\"filename*\" \"utf-8''a%20b.pdf\")) NIL) \"mixed\" (\"boundary\" \"z\"))",
        );
        let root = structure(&values[0], None).unwrap();
        assert_eq!(root.kind, "multipart/mixed");
        assert_eq!(root.part, None);
        assert_eq!(root.children[0].part.as_deref(), Some("1"));
        assert_eq!(root.children[0].kind, "text/plain");
        assert_eq!(root.children[1].part.as_deref(), Some("2"));
        assert_eq!(root.children[1].encoding, "base64");
        assert_eq!(root.children[1].size, 400);
        assert_eq!(root.children[1].disposition.as_deref(), Some("attachment"));
        assert_eq!(root.children[1].disposition_parameter("filename"), Some("a b.pdf"));
    }
}
