//! The mailbox commands the tools run over a logged-in IMAP session, as imapflow's `list`, `mailboxOpen`, `search`,
//! `fetchAll`, `download`, `messageFlagsAdd`/`Remove` and `messageMove` send them to Gmail.

use crate::gmail_verify::imap::{Session, Status, quote};
use crate::gmail_verify::wire::Failure;

use super::parse::{Envelope, Node, V, envelope, response, structure};

const FALLBACK_ALL_MAIL: &str = "[Gmail]/All Mail";
const FALLBACK_TRASH: &str = "[Gmail]/Trash";

/// One command under construction: its text, with the strings that cannot be quoted sent as literals.
pub(super) struct Cmd {
    parts: Vec<Vec<u8>>,
}

impl Cmd {
    pub fn new(text: &str) -> Self {
        Self { parts: vec![text.as_bytes().to_vec()] }
    }

    pub fn text(mut self, text: &str) -> Self {
        self.parts.last_mut().expect("a part").extend_from_slice(text.as_bytes());
        self
    }

    /// A string argument: quoted, or a literal when it is not plain single-line ASCII.
    pub fn string(mut self, value: &str) -> Self {
        match quote(value) {
            Ok(quoted) if value.is_ascii() => self.text(&quoted),
            _ => {
                let bytes = value.as_bytes();
                self.parts.last_mut().expect("a part").extend_from_slice(format!("{{{}}}\r\n", bytes.len()).as_bytes());
                self.parts.push(bytes.to_vec());
                self
            }
        }
    }

    fn finish(mut self) -> Vec<Vec<u8>> {
        self.parts.last_mut().expect("a part").extend_from_slice(b"\r\n");
        self.parts
    }
}

/// A mailbox of the LIST reply.
pub(super) struct Folder {
    pub attributes: Vec<String>,
    pub path: String,
}

impl Folder {
    fn has(&self, attribute: &str) -> bool {
        self.attributes.iter().any(|a| a.eq_ignore_ascii_case(attribute))
    }
}

/// What a FETCH told about one message.
#[derive(Default)]
pub(super) struct Message {
    pub uid: u32,
    pub email_id: Option<String>,
    pub thread_id: Option<String>,
    pub envelope: Option<Envelope>,
    pub internal_date: String,
    pub structure: Option<Node>,
    /// The raw header fields asked for, when any were.
    pub headers: Vec<u8>,
    /// The body section asked for, when one was.
    pub section: Option<Vec<u8>>,
}

pub(super) struct Mailbox<'a> {
    session: &'a mut Session,
}

impl<'a> Mailbox<'a> {
    pub fn new(session: &'a mut Session) -> Self {
        Self { session }
    }

    /// Runs `cmd`; a refusal is the failure imapflow throws (`Command failed`, the reply as `response`).
    async fn run(&mut self, cmd: Cmd) -> Result<Vec<Vec<u8>>, Failure> {
        let (reply, untagged) = self.session.run_raw(cmd.finish()).await?;
        if reply.status == Status::Ok { Ok(untagged) } else { Err(reply.refusal(false)) }
    }

    /// `client.list()`: every mailbox with its attributes.
    pub async fn list(&mut self) -> Result<Vec<Folder>, Failure> {
        let untagged = self.run(Cmd::new("LIST \"\" \"*\"")).await?;
        let mut boxes = Vec::new();
        for data in untagged {
            let values = response(&data);
            if !values.first().and_then(V::text).is_some_and(|word| word.eq_ignore_ascii_case("LIST")) {
                continue;
            }
            let attributes = values.get(1).and_then(V::list).unwrap_or_default().iter().filter_map(V::text).collect();
            if let Some(path) = values.get(3).and_then(V::text) {
                boxes.push(Folder { attributes, path });
            }
        }
        Ok(boxes)
    }

    /// `openAllMail`: All Mail (every label; Spam and Trash are not in it), read-only unless `read_only` is false.
    /// Returns the mailbox list.
    pub async fn open_all_mail(&mut self, read_only: bool) -> Result<Vec<Folder>, Failure> {
        let boxes = self.list().await?;
        let path = boxes.iter().find(|b| b.has("\\All")).map_or(FALLBACK_ALL_MAIL, |b| b.path.as_str()).to_owned();
        self.run(Cmd::new(if read_only { "EXAMINE " } else { "SELECT " }).string(&path)).await?;
        Ok(boxes)
    }

    /// `client.search({ gmraw })`: the UIDs Gmail's search syntax matches.
    pub async fn search_raw(&mut self, query: &str) -> Result<Vec<u32>, Failure> {
        self.search(Cmd::new("UID SEARCH X-GM-RAW ").string(query)).await
    }

    /// The UID in All Mail of Gmail message id `id` (X-GM-MSGID), when there is one.
    pub async fn uid_of(&mut self, id: &str) -> Result<Option<u32>, Failure> {
        Ok(self.search(Cmd::new(&format!("UID SEARCH X-GM-MSGID {id}"))).await?.into_iter().min())
    }

    async fn search(&mut self, cmd: Cmd) -> Result<Vec<u32>, Failure> {
        let mut found = Vec::new();
        for data in self.run(cmd).await? {
            let values = response(&data);
            if values.first().and_then(V::text).is_some_and(|word| word.eq_ignore_ascii_case("SEARCH")) {
                found.extend(values[1..].iter().filter_map(V::text).filter_map(|n| n.parse::<u32>().ok()));
            }
        }
        Ok(found)
    }

    /// `client.fetchAll(range, items)` with UIDs: one entry per message the server answered. `items` is the
    /// parenthesized list of what to fetch.
    pub async fn fetch(&mut self, range: &str, items: &str) -> Result<Vec<Message>, Failure> {
        let mut messages = Vec::new();
        for data in self.run(Cmd::new(&format!("UID FETCH {range} {items}"))).await? {
            let values = response(&data);
            let is_fetch = values.get(1).and_then(V::text).is_some_and(|word| word.eq_ignore_ascii_case("FETCH"));
            let Some(fields) = values.get(2).and_then(V::list).filter(|_| is_fetch) else { continue };
            messages.push(message_of(fields));
        }
        Ok(messages)
    }

    /// `client.download(uid, part, { maxBytes })`: up to `max` bytes of the part as the server stores it.
    pub async fn part_bytes(&mut self, uid: u32, part: &str, max: usize) -> Result<Vec<u8>, Failure> {
        let items = format!("(UID BODY.PEEK[{part}]<0.{max}>)");
        let messages = self.fetch(&uid.to_string(), &items).await?;
        Ok(messages.into_iter().find_map(|m| m.section).unwrap_or_default())
    }

    /// `messageFlagsAdd` / `messageFlagsRemove` of flags (`useLabels` false) or Gmail labels (true) on `range`.
    pub async fn store(&mut self, range: &str, add: bool, labels: bool, values: &[&str]) -> Result<(), Failure> {
        let mut cmd = Cmd::new(&format!("UID STORE {range} {}{}.SILENT (", if add { '+' } else { '-' }, if labels { "X-GM-LABELS" } else { "FLAGS" }));
        for (index, value) in values.iter().enumerate() {
            if index > 0 {
                cmd = cmd.text(" ");
            }
            cmd = if labels && !value.starts_with('\\') { cmd.string(value) } else { cmd.text(value) };
        }
        self.run(cmd.text(")")).await.map(drop)
    }

    /// `messageMove`: MOVE where the server has it, else a copy followed by deleting and expunging the originals.
    pub async fn move_to(&mut self, range: &str, path: &str) -> Result<(), Failure> {
        if self.session.has("MOVE") {
            return self.run(Cmd::new(&format!("UID MOVE {range} ")).string(path)).await.map(drop);
        }
        self.run(Cmd::new(&format!("UID COPY {range} ")).string(path)).await?;
        self.store(range, true, false, &["\\Deleted"]).await?;
        let expunge = if self.session.has("UIDPLUS") { format!("UID EXPUNGE {range}") } else { "EXPUNGE".to_owned() };
        self.run(Cmd::new(&expunge)).await.map(drop)
    }
}

/// The path of the Trash mailbox among `boxes`.
pub(super) fn trash_path(boxes: &[Folder]) -> String {
    boxes.iter().find(|b| b.has("\\Trash")).map_or(FALLBACK_TRASH, |b| b.path.as_str()).to_owned()
}

fn message_of(fields: &[V]) -> Message {
    let mut message = Message::default();
    for pair in fields.chunks(2) {
        let (Some(key), Some(value)) = (pair.first().and_then(V::text), pair.get(1)) else { continue };
        let upper = key.to_ascii_uppercase();
        match upper.as_str() {
            "UID" => message.uid = value.text().and_then(|n| n.parse().ok()).unwrap_or(0),
            "X-GM-MSGID" => message.email_id = value.text(),
            "X-GM-THRID" => message.thread_id = value.text(),
            "INTERNALDATE" => message.internal_date = value.text().unwrap_or_default(),
            "ENVELOPE" => message.envelope = Some(envelope(value)),
            "BODYSTRUCTURE" => message.structure = structure(value, None),
            _ if upper.starts_with("BODY[HEADER") => message.headers = value.bytes().unwrap_or_default().to_vec(),
            _ if upper.starts_with("BODY[") => message.section = Some(value.bytes().unwrap_or_default().to_vec()),
            _ => {}
        }
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_non_ascii_string_goes_as_a_literal_and_an_ascii_one_quoted() {
        let parts = Cmd::new("UID STORE 1 +X-GM-LABELS (").string("Café \"x\"").text(")").finish();
        assert_eq!(parts[0], b"UID STORE 1 +X-GM-LABELS ({9}\r\n");
        assert_eq!(parts[1], "Café \"x\")\r\n".as_bytes());
        let quoted = Cmd::new("SELECT ").string("a \"b\"").finish();
        assert_eq!(quoted, [b"SELECT \"a \\\"b\\\"\"\r\n".to_vec()]);
    }

    #[test]
    fn fetch_fields_fill_the_message() {
        let data = response(b"2 FETCH (UID 9 X-GM-MSGID 55 X-GM-THRID 44 BODY[HEADER.FIELDS (REFERENCES)] \"R: <a@b>\\r\\n\" BODY[1]<0> \"hi\")");
        let message = message_of(data[2].list().unwrap());
        assert_eq!((message.uid, message.email_id.as_deref(), message.thread_id.as_deref()), (9, Some("55"), Some("44")));
        assert_eq!(message.section.as_deref(), Some(&b"hi"[..]));
        assert!(!message.headers.is_empty());
    }
}
