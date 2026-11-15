//! Gmail with a Google app password instead of the Google sign-in, as `connectors/gmail-app-password.mjs` serves it: a
//! small MCP server answered in this process at a reserved address (`https://gmail-imap.mixdog.invalid/mcp`, RFC 2606:
//! no request can leave for it), like the built-in Google connectors ([`crate::google_mcp`]). It speaks IMAP
//! (imap.gmail.com:993) and SMTP (smtp.gmail.com:465), both over TLS, as the account named in the server's
//! `X-Mixdog-Gmail-Account` header, with the app password read from the keychain for each request. The password never
//! appears in an error or a tool result. The connection code is that of the password check ([`crate::gmail_verify`]).

mod compose;
mod mailbox;
mod parse;
#[cfg(test)]
mod tests;
mod text;

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::LazyLock;

use mixdog_secrets::SecretStore;
use regex::Regex;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::OnceCell;
use url::Url;

use crate::connector_model::GMAIL_APP_PASSWORD_URL;
use crate::connector_model::gmail_address;
use crate::gmail_verify::GmailAppPassword;
use crate::gmail_verify::describe;
use crate::gmail_verify::imap;
use crate::gmail_verify::imap::Session;
use crate::gmail_verify::sentence;
use crate::gmail_verify::smtp;
use crate::gmail_verify::wire::Failure;
use crate::google_mcp::Answer;
use crate::mcp_secrets::gmail_app_password_secret_account;

use mailbox::Mailbox;
use mailbox::trash_path;
use parse::Addr;
use parse::Node;

const PROTOCOL_VERSION: &str = "2025-06-18";
const SEARCH_DEFAULT: usize = 10;
const SEARCH_MAX: usize = 25;
const SNIPPET_BYTES: usize = 2048;
const SNIPPET_CHARS: usize = 200;
const LINE_CHARS: usize = 300;
const READ_BYTES: usize = 262_144;
const READ_CHARS: usize = 50_000;
const MANAGE_MAX: usize = 50;
const LABEL_MAX: usize = 225;
const SEARCH_ITEMS: &str = "(UID ENVELOPE INTERNALDATE BODYSTRUCTURE X-GM-THRID X-GM-MSGID)";

static HOST: LazyLock<String> =
    LazyLock::new(|| Url::parse(GMAIL_APP_PASSWORD_URL).ok().and_then(|url| url.host_str().map(str::to_owned)).unwrap_or_default());
static MESSAGE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^<[^<>\s]+>$").expect("a fixed pattern"));
static NUMERIC_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{1,20}$").expect("a fixed pattern"));

/// Whether `url` addresses the Gmail app-password server (`gmailAppPasswordService`).
pub fn is_service(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(HOST.as_str())
}

/// Why a tool call failed: its own refusal (shown as it is) or a Gmail failure (one fixed sentence per cause).
enum Fail {
    Input(String),
    Mail(Failure),
}

impl From<Failure> for Fail {
    fn from(failure: Failure) -> Self {
        Self::Mail(failure)
    }
}

impl Fail {
    fn text(&self, password: &str) -> String {
        match self {
            Self::Input(message) => message.clone(),
            Self::Mail(failure) => describe(failure, password),
        }
    }
}

fn input<T>(message: impl Into<String>) -> Result<T, Fail> {
    Err(Fail::Input(message.into()))
}

/// What a tool call runs with.
struct Ctx<'a> {
    mail: &'a GmailAppPassword,
    email: &'a str,
    password: &'a str,
}

impl Ctx<'_> {
    async fn imap(&self) -> Result<Session, Fail> {
        Ok(imap::open(&self.mail.imap_leg(), self.email, self.password).await?)
    }
}

fn text_arg(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|s| mixdog_js::js_trim(s).to_owned()).unwrap_or_default()
}

fn require_text(args: &Value, key: &str) -> Result<String, Fail> {
    let value = text_arg(args.get(key));
    if value.is_empty() { input(format!("{key} is required")) } else { Ok(value) }
}

fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

/// `addresses(list)`: `Name <address>`, or the address alone, comma-separated.
fn addresses(list: &[Addr]) -> String {
    list.iter()
        .map(|entry| if entry.name.is_empty() { entry.address.clone() } else { format!("{} <{}>", entry.name, entry.address) })
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The date of a message: its Date header, else the time the server received it.
fn message_date(envelope_date: &str, internal_date: &str) -> String {
    let date = text::iso_date(envelope_date);
    if date.is_empty() { text::iso_date(internal_date) } else { date }
}

// ── Reading a message ───────────────────────────────────────────────────────

fn is_attachment(node: &Node) -> bool {
    node.disposition.as_deref() == Some("attachment")
        || node.kind.starts_with("message/")
        || node.disposition_parameter("filename").is_some()
        || node.parameter("name").is_some()
}

/// The first text/plain and the first text/html part of the message that are not attachments.
fn text_parts(root: &Node) -> (Option<&Node>, Option<&Node>) {
    fn walk<'a>(node: &'a Node, plain: &mut Option<&'a Node>, html: &mut Option<&'a Node>) {
        if node.kind.starts_with("message/") {
            return;
        }
        if !node.children.is_empty() {
            for child in &node.children {
                walk(child, plain, html);
            }
            return;
        }
        if node.disposition.as_deref() == Some("attachment") {
            return;
        }
        if node.kind == "text/plain" && plain.is_none() {
            *plain = Some(node);
        }
        if node.kind == "text/html" && html.is_none() {
            *html = Some(node);
        }
    }
    let (mut plain, mut html) = (None, None);
    walk(root, &mut plain, &mut html);
    (plain, html)
}

#[derive(Serialize)]
struct Attachment {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    size: u64,
}

/// Attachments by name, type and (decoded, approximate) size only.
fn attachments_of(node: &Node, out: &mut Vec<Attachment>) {
    if !node.children.is_empty() && !node.kind.starts_with("message/") {
        for child in &node.children {
            attachments_of(child, out);
        }
        return;
    }
    if is_attachment(node) {
        let name = node.disposition_parameter("filename").or_else(|| node.parameter("name")).unwrap_or("(unnamed)").to_owned();
        let size = if node.encoding == "base64" { node.size * 3 / 4 } else { node.size };
        out.push(Attachment { name, kind: node.kind.clone(), size });
    }
}

/// Up to `max` bytes of a part, undone by its transfer encoding and read in its charset (imapflow's `download` converts
/// a text part that names a charset other than ASCII or UTF-8), as UTF-8 cut at `max` bytes.
fn decoded_part(node: &Node, raw: &[u8], max: usize) -> String {
    let mut decoded = text::transfer_decode(&node.encoding, raw);
    decoded.truncate(max);
    let label = node.parameter("charset").unwrap_or_default();
    let key: String = label.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase();
    let mut out = if matches!(key.as_str(), "" | "ascii" | "usascii" | "utf8") {
        String::from_utf8_lossy(&decoded).into_owned()
    } else {
        text::charset_text(label, &decoded)
    };
    if out.len() > max {
        let mut end = max;
        while !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
    }
    out
}

/// Up to `max` bytes of a part as text ([`decoded_part`]); `complete` is false when the part may go on past them.
async fn part_text(mailbox: &mut Mailbox<'_>, uid: u32, node: &Node, max: usize) -> Result<(String, bool), Fail> {
    let part = node.part.as_deref().unwrap_or("1");
    let raw = mailbox.part_bytes(uid, part, max).await?;
    let complete = raw.len() < max;
    Ok((decoded_part(node, &raw, max), complete))
}

/// Up to `max` bytes of the body text (the text/plain part, else the text/html part), decoded to UTF-8.
async fn body_text(mailbox: &mut Mailbox<'_>, uid: u32, root: &Node, max: usize) -> Result<String, Fail> {
    let (plain, html) = text_parts(root);
    if let Some(node) = plain {
        return Ok(mixdog_js::js_trim(&part_text(mailbox, uid, node, max).await?.0).to_owned());
    }
    match html {
        Some(node) => Ok(text::html_text(&part_text(mailbox, uid, node, max).await?.0)),
        None => Ok(String::new()),
    }
}

#[derive(Serialize)]
struct SearchLine {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    from: String,
    subject: String,
    date: String,
    snippet: String,
}

async fn search_work(session: &mut Session, query: &str, limit: usize) -> Result<String, Fail> {
    let mut mailbox = Mailbox::new(session);
    mailbox.open_all_mail(true).await?;
    let found = mailbox.search_raw(query).await?;
    let mut uids = found.clone();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.truncate(limit);
    if uids.is_empty() {
        return Ok("No emails.".to_owned());
    }
    let range = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let mut messages = mailbox.fetch(&range, SEARCH_ITEMS).await?;
    messages.sort_by(|a, b| b.uid.cmp(&a.uid));
    let mut lines = Vec::new();
    for message in &messages {
        let snippet = match &message.structure {
            Some(root) => body_text(&mut mailbox, message.uid, root, SNIPPET_BYTES).await?,
            None => String::new(),
        };
        let snippet = text::squash_space(&snippet);
        let envelope = message.envelope.clone().unwrap_or_default();
        let line = SearchLine {
            id: message.email_id.clone(),
            thread_id: message.thread_id.clone(),
            from: text::clip(&addresses(&envelope.from), LINE_CHARS),
            subject: text::clip(mixdog_js::js_trim(&envelope.subject), LINE_CHARS),
            date: message_date(&envelope.date, &message.internal_date),
            snippet: text::clip(mixdog_js::js_trim(&snippet), SNIPPET_CHARS),
        };
        lines.push(serde_json::to_string(&line).map_err(|e| Fail::Input(e.to_string()))?);
    }
    if found.len() > uids.len() {
        lines.push(format!("({} of {} shown; narrow the query for others)", uids.len(), found.len()));
    }
    Ok(lines.join("\n"))
}

async fn search_emails(ctx: &Ctx<'_>, args: &Value) -> Result<String, Fail> {
    let query = Some(text_arg(args.get("query"))).filter(|q| !q.is_empty()).unwrap_or_else(|| "in:inbox".to_owned());
    // `Math.min(25, Math.max(1, Math.trunc(Number(maxResults)) || 10))`.
    let number = mixdog_js::to_number_of(args.get("maxResults")).trunc();
    let number = if number.is_nan() || number == 0.0 { SEARCH_DEFAULT as f64 } else { number };
    let limit = number.clamp(1.0, SEARCH_MAX as f64) as usize;
    let mut session = ctx.imap().await?;
    let out = search_work(&mut session, &query, limit).await;
    session.logout().await;
    out
}

#[derive(Serialize)]
struct Sender {
    name: String,
    address: String,
}

#[derive(Serialize)]
struct Head {
    id: String,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    from: String,
    #[serde(rename = "fromAddresses")]
    from_addresses: Vec<Sender>,
    authentication: Value,
    to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cc: Option<String>,
    date: String,
    subject: String,
    links: Vec<String>,
    attachments: Vec<Attachment>,
}

async fn read_work(session: &mut Session, id: &str) -> Result<String, Fail> {
    let mut mailbox = Mailbox::new(session);
    mailbox.open_all_mail(true).await?;
    let uid = uid_of(&mut mailbox, id).await?;
    let items = "(UID ENVELOPE INTERNALDATE BODYSTRUCTURE X-GM-THRID X-GM-MSGID BODY.PEEK[HEADER.FIELDS (AUTHENTICATION-RESULTS)])";
    let found = match uid {
        Some(uid) => mailbox.fetch(&uid.to_string(), items).await?,
        None => Vec::new(),
    };
    let Some(message) = found.into_iter().next() else { return input(format!("No email with id {id}.")) };
    let envelope = message.envelope.clone().unwrap_or_default();
    let structure = message.structure.clone().unwrap_or_default();
    let (plain_node, html_node) = text_parts(&structure);
    let plain = match plain_node {
        Some(node) => Some(part_text(&mut mailbox, message.uid, node, READ_BYTES).await?),
        None => None,
    };
    let html = match html_node {
        Some(node) => Some(part_text(&mut mailbox, message.uid, node, READ_BYTES).await?),
        None => None,
    };
    let body = match (&plain, &html) {
        (Some((value, _)), _) => mixdog_js::js_trim(value).to_owned(),
        (None, Some((value, _))) => text::html_text(value),
        (None, None) => String::new(),
    };
    let hrefs = html.as_ref().map(|(value, _)| text::html_links(value)).unwrap_or_default();
    let links = text::message_links(plain.as_ref().map(|(value, complete)| (value.as_str(), *complete)), hrefs);
    let mut attachments = Vec::new();
    attachments_of(&structure, &mut attachments);
    let authentication = text::gmail_authentication(&String::from_utf8_lossy(&message.headers));
    let non_empty = |value: String| Some(value).filter(|v| !v.is_empty());
    let head = Head {
        id: message.email_id.clone().unwrap_or_else(|| id.to_owned()),
        thread_id: message.thread_id.clone(),
        message_id: non_empty(envelope.message_id.clone()),
        from: addresses(&envelope.from),
        from_addresses: envelope.from.iter().map(|a| Sender { name: a.name.clone(), address: a.address.clone() }).collect(),
        authentication,
        to: addresses(&envelope.to),
        cc: non_empty(addresses(&envelope.cc)),
        date: message_date(&envelope.date, &message.internal_date),
        subject: mixdog_js::js_trim(&envelope.subject).to_owned(),
        links,
        attachments,
    };
    let clipped = if mixdog_js::utf16_len(&body) > READ_CHARS { format!("{}\n[truncated]", mixdog_js::slice_utf16(&body, READ_CHARS)) } else { body };
    let json = serde_json::to_string(&head).map_err(|e| Fail::Input(e.to_string()))?;
    Ok(format!("{json}\n\n{}", if clipped.is_empty() { "(no text body)" } else { clipped.as_str() }))
}

async fn read_email(ctx: &Ctx<'_>, args: &Value) -> Result<String, Fail> {
    let id = require_text(args, "id")?;
    let mut session = ctx.imap().await?;
    let out = read_work(&mut session, &id).await;
    session.logout().await;
    out
}

// ── Describing and managing messages ────────────────────────────────────────

/// The distinct message ids of `args.ids` (an array, or one id).
fn message_ids(args: &Value) -> Result<Vec<String>, Fail> {
    let raw: Vec<&Value> = match args.get("ids") {
        Some(Value::Array(list)) => list.iter().collect(),
        Some(other) if !other.is_null() => vec![other],
        _ => Vec::new(),
    };
    let mut seen = HashSet::new();
    let ids: Vec<String> = raw.into_iter().map(|id| text_arg(Some(id))).filter(|id| seen.insert(id.clone()) || id.is_empty()).collect();
    if ids.is_empty() || ids.iter().any(String::is_empty) {
        return input("ids must list ids from search_emails");
    }
    if ids.len() > MANAGE_MAX {
        return input(format!("At most {MANAGE_MAX} emails per call; got {}.", ids.len()));
    }
    Ok(ids)
}

fn checked_id(id: &str) -> Result<(), Fail> {
    if NUMERIC_ID.is_match(id) { Ok(()) } else { input("id must be an id from search_emails") }
}

async fn uid_of(mailbox: &mut Mailbox<'_>, id: &str) -> Result<Option<u32>, Fail> {
    checked_id(id)?;
    Ok(mailbox.uid_of(id).await?)
}

#[derive(Serialize)]
struct Described {
    id: String,
    from: String,
    subject: String,
    date: String,
}

async fn describe_work(session: &mut Session, ids: &[String]) -> Result<Vec<Described>, Fail> {
    let mut mailbox = Mailbox::new(session);
    mailbox.open_all_mail(true).await?;
    let mut emails = Vec::new();
    for id in ids {
        let found = match uid_of(&mut mailbox, id).await? {
            Some(uid) => mailbox.fetch(&uid.to_string(), "(UID ENVELOPE INTERNALDATE)").await?,
            None => Vec::new(),
        };
        let Some(message) = found.into_iter().next() else { continue };
        let envelope = message.envelope.clone().unwrap_or_default();
        emails.push(Described {
            id: id.clone(),
            from: text::clip(&addresses(&envelope.from), LINE_CHARS),
            subject: text::clip(mixdog_js::js_trim(&envelope.subject), LINE_CHARS),
            date: message_date(&envelope.date, &message.internal_date),
        });
    }
    Ok(emails)
}

/// `describe_emails`: the account and the sender, subject and date of emails by id (what an approval card shows).
async fn describe_emails(ctx: &Ctx<'_>, args: &Value) -> Result<String, Fail> {
    let ids = if present(args.get("ids")).is_none() { Vec::new() } else { message_ids(args)? };
    let mut emails = Vec::new();
    if !ids.is_empty() {
        let mut session = ctx.imap().await?;
        let out = describe_work(&mut session, &ids).await;
        session.logout().await;
        emails = out?;
    }
    serde_json::to_string(&json!({ "account": ctx.email, "emails": emails })).map_err(|e| Fail::Input(e.to_string()))
}

#[derive(Clone, Copy, PartialEq)]
enum Action {
    Archive,
    Trash,
    AddLabel,
    RemoveLabel,
    MarkRead,
    MarkUnread,
    Star,
    Unstar,
}

struct Manage {
    name: &'static str,
    description: &'static str,
    verb: &'static str,
    action: Action,
    label: bool,
    destructive: bool,
}

const MANAGE_TOOLS: [Manage; 8] = [
    Manage {
        name: "archive_emails",
        description: "Archive emails (remove them from the Inbox; they stay in All Mail).",
        verb: "Archived",
        action: Action::Archive,
        label: false,
        destructive: false,
    },
    Manage {
        name: "trash_emails",
        description: "Move emails to Gmail Trash (recoverable for 30 days; never a permanent delete).",
        verb: "Moved to Trash:",
        action: Action::Trash,
        label: false,
        destructive: true,
    },
    Manage { name: "add_email_label", description: "Add a Gmail label to emails.", verb: "Labeled", action: Action::AddLabel, label: true, destructive: false },
    Manage {
        name: "remove_email_label",
        description: "Remove a Gmail label from emails.",
        verb: "Unlabeled",
        action: Action::RemoveLabel,
        label: true,
        destructive: false,
    },
    Manage { name: "mark_emails_read", description: "Mark emails as read.", verb: "Marked read:", action: Action::MarkRead, label: false, destructive: false },
    Manage { name: "mark_emails_unread", description: "Mark emails as unread.", verb: "Marked unread:", action: Action::MarkUnread, label: false, destructive: false },
    Manage { name: "star_emails", description: "Star emails.", verb: "Starred", action: Action::Star, label: false, destructive: false },
    Manage { name: "unstar_emails", description: "Remove the star from emails.", verb: "Unstarred", action: Action::Unstar, label: false, destructive: false },
];

/// A user label name: one line, not a system label (`\Inbox`, ...).
fn label_name(args: &Value) -> Result<String, Fail> {
    let label = require_text(args, "label")?;
    if mixdog_js::utf16_len(&label) > LABEL_MAX || label.chars().any(|c| (c as u32) < 32 || c as u32 == 127) || label.starts_with('\\') {
        return input("label must be a plain label name");
    }
    Ok(label)
}

async fn manage_work(session: &mut Session, tool: &Manage, ids: &[String], label: Option<&str>) -> Result<String, Fail> {
    let mut mailbox = Mailbox::new(session);
    let boxes = mailbox.open_all_mail(false).await?;
    let mut uids = Vec::new();
    let mut missing = Vec::new();
    for id in ids {
        match uid_of(&mut mailbox, id).await? {
            Some(uid) => uids.push(uid),
            None => missing.push(id.as_str()),
        }
    }
    if uids.is_empty() {
        return input(format!("No email with id {}.", missing.join(", ")));
    }
    let range = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let label = [label.unwrap_or_default()];
    match tool.action {
        Action::Archive => mailbox.store(&range, false, true, &["\\Inbox"]).await?,
        Action::Trash => mailbox.move_to(&range, &trash_path(&boxes)).await?,
        Action::AddLabel => mailbox.store(&range, true, true, &label).await?,
        Action::RemoveLabel => mailbox.store(&range, false, true, &label).await?,
        Action::MarkRead => mailbox.store(&range, true, false, &["\\Seen"]).await?,
        Action::MarkUnread => mailbox.store(&range, false, false, &["\\Seen"]).await?,
        Action::Star => mailbox.store(&range, true, false, &["\\Flagged"]).await?,
        Action::Unstar => mailbox.store(&range, false, false, &["\\Flagged"]).await?,
    }
    let done = format!("{} {} email{}.", tool.verb, uids.len(), if uids.len() == 1 { "" } else { "s" });
    Ok(if missing.is_empty() { done } else { format!("{done} Not found: {}.", missing.join(", ")) })
}

async fn manage_emails(ctx: &Ctx<'_>, tool: &Manage, args: &Value) -> Result<String, Fail> {
    let ids = message_ids(args)?;
    let label = if tool.label { Some(label_name(args)?) } else { None };
    let mut session = ctx.imap().await?;
    let out = manage_work(&mut session, tool, &ids, label.as_deref()).await;
    session.logout().await;
    out
}

// ── Sending ─────────────────────────────────────────────────────────────────

/// The Message-ID, References and subject a reply threads on.
struct Thread {
    message_id: String,
    references: Vec<String>,
    subject: String,
}

async fn thread_work(session: &mut Session, id: &str) -> Result<Thread, Fail> {
    let mut mailbox = Mailbox::new(session);
    mailbox.open_all_mail(true).await?;
    let found = match uid_of(&mut mailbox, id).await? {
        Some(uid) => mailbox.fetch(&uid.to_string(), "(UID ENVELOPE BODY.PEEK[HEADER.FIELDS (REFERENCES)])").await?,
        None => Vec::new(),
    };
    let message = found.into_iter().next();
    let envelope = message.as_ref().and_then(|m| m.envelope.clone()).unwrap_or_default();
    let message_id = mixdog_js::js_trim(&envelope.message_id).to_owned();
    let Some(message) = message.filter(|_| !message_id.is_empty()) else { return input(format!("No email with id {id}.")) };
    let mut references: Vec<String> = text::references(&String::from_utf8_lossy(&message.headers)).into_iter().filter(|r| *r != message_id).collect();
    references.push(message_id.clone());
    Ok(Thread { message_id, references, subject: mixdog_js::js_trim(&envelope.subject).to_owned() })
}

async fn thread_of(ctx: &Ctx<'_>, value: &str) -> Result<Thread, Fail> {
    if MESSAGE_ID.is_match(value) {
        return Ok(Thread { message_id: value.to_owned(), references: vec![value.to_owned()], subject: String::new() });
    }
    let mut session = ctx.imap().await?;
    let out = thread_work(&mut session, value).await;
    session.logout().await;
    out
}

async fn send_email(ctx: &Ctx<'_>, args: &Value) -> Result<String, Fail> {
    let to = require_text(args, "to")?;
    let cc = text_arg(args.get("cc"));
    let bcc = text_arg(args.get("bcc"));
    let mut subject = text_arg(args.get("subject"));
    for (key, value) in [("to", &to), ("cc", &cc), ("bcc", &bcc), ("subject", &subject)] {
        if !value.is_empty() && value.contains(['\r', '\n']) {
            return input(format!("{key} must be one line"));
        }
    }
    let body = present(args.get("body")).map(mixdog_js::value_to_string).unwrap_or_default();
    let reply_to = text_arg(args.get("inReplyTo"));
    let mut thread = None;
    if !reply_to.is_empty() {
        let original = thread_of(ctx, &reply_to).await?;
        if subject.is_empty() && !original.subject.is_empty() {
            let re = original.subject.get(..3).is_some_and(|head| head.eq_ignore_ascii_case("re:"));
            subject = if re { original.subject.clone() } else { format!("Re: {}", original.subject) };
        }
        thread = Some(original);
    }
    let outgoing = compose::Outgoing {
        from: ctx.email,
        to: &to,
        cc: &cc,
        bcc: &bcc,
        subject: &subject,
        body: &body,
        in_reply_to: thread.as_ref().map(|t| t.message_id.as_str()),
        references: thread.as_ref().map(|t| t.references.as_slice()).unwrap_or_default(),
    };
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64);
    let built = compose::build(&outgoing, now_ms, &uuid::Uuid::new_v4().to_string());
    let envelope = smtp::Envelope { from: ctx.email, recipients: &built.recipients };
    smtp::send(&ctx.mail.smtp_leg(), ctx.mail.hello_name(), ctx.email, ctx.password, &envelope, &built.data).await?;
    Ok(format!("Sent (message {}).", built.message_id))
}

// ── The tools and the MCP server ────────────────────────────────────────────

fn ids_schema() -> Value {
    json!({
        "type": "array",
        "items": { "type": "string" },
        "minItems": 1,
        "maxItems": MANAGE_MAX,
        "description": format!("Email ids from search_emails (at most {MANAGE_MAX})."),
    })
}

/// The tool definitions the server lists: never the one only the approval gate calls (`describe_emails`).
fn tool_list() -> Vec<Value> {
    let mut tools = vec![
        json!({
            "name": "send_email",
            "description": "Send a plain-text email from the connected Gmail account.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "Recipients, comma-separated." },
                    "subject": { "type": "string", "description": "Empty in a reply: \"Re: \" and the original subject." },
                    "body": { "type": "string" },
                    "cc": { "type": "string" },
                    "bcc": { "type": "string" },
                    "inReplyTo": {
                        "type": "string",
                        "description": "Reply in the thread of this email: an id from search_emails, or a Message-ID like <…>.",
                    },
                },
                "required": ["to", "subject", "body"],
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true },
        }),
        json!({
            "name": "search_emails",
            "description": "Search the Gmail account with Gmail search syntax (from:, subject:, newer_than:7d, has:attachment, label:…), newest first. Spam and Trash are not searched.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Gmail search; default in:inbox." },
                    "maxResults": { "type": "number", "description": format!("1-{SEARCH_MAX}, default {SEARCH_DEFAULT}.") },
                },
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": true },
        }),
        json!({
            "name": "read_email",
            "description": "Read one email by its id from search_emails: headers, text body, link targets, and attachment names and sizes.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
            "annotations": { "readOnlyHint": true, "openWorldHint": true },
        }),
    ];
    for tool in &MANAGE_TOOLS {
        let mut properties = Map::new();
        properties.insert("ids".to_owned(), ids_schema());
        let mut required = vec![json!("ids")];
        if tool.label {
            properties.insert("label".to_owned(), json!({ "type": "string", "description": "A label name; created when new." }));
            required.push(json!("label"));
        }
        tools.push(json!({
            "name": tool.name,
            "description": tool.description,
            "inputSchema": { "type": "object", "properties": properties, "required": required },
            "annotations": { "readOnlyHint": false, "destructiveHint": tool.destructive, "idempotentHint": true, "openWorldHint": true },
        }));
    }
    tools
}

/// Whether the server has a tool called `name` (listed or not).
fn is_tool(name: &str) -> bool {
    matches!(name, "send_email" | "search_emails" | "read_email" | "describe_emails") || MANAGE_TOOLS.iter().any(|tool| tool.name == name)
}

async fn run_tool(ctx: &Ctx<'_>, name: &str, args: &Value) -> Result<String, Fail> {
    match name {
        "send_email" => send_email(ctx, args).await,
        "search_emails" => search_emails(ctx, args).await,
        "read_email" => read_email(ctx, args).await,
        "describe_emails" => describe_emails(ctx, args).await,
        other => match MANAGE_TOOLS.iter().find(|tool| tool.name == other) {
            Some(tool) => manage_emails(ctx, tool, args).await,
            None => input(format!("Unknown tool: {other}")),
        },
    }
}

fn redact(value: &str, password: &str) -> String {
    if password.is_empty() { value.to_owned() } else { value.replace(password, "[redacted]") }
}

fn tool_result(value: String, is_error: bool) -> Value {
    let mut result = json!({ "content": [{ "type": "text", "text": value }] });
    if is_error {
        result["isError"] = Value::Bool(true);
    }
    result
}

/// What one request knows: the account of its header and the password, read from the keychain at most once.
struct Request<'a> {
    email: String,
    store: &'a dyn SecretStore,
    password: OnceCell<Result<String, String>>,
}

impl Request<'_> {
    async fn password(&self) -> Result<&str, String> {
        let stored = self
            .password
            .get_or_init(|| async {
                if self.email.is_empty() {
                    return Ok(String::new());
                }
                self.store.get(&gmail_app_password_secret_account(&self.email)).await.map(Option::unwrap_or_default).map_err(|e| e.to_string())
            })
            .await;
        stored.as_deref().map_err(Clone::clone)
    }
}

/// The Gmail app-password MCP server: answers the requests of an HTTP MCP client addressed to the reserved address.
pub struct GmailMcp {
    mail: Arc<GmailAppPassword>,
    store: Arc<dyn SecretStore>,
}

impl GmailMcp {
    pub fn new(mail: Arc<GmailAppPassword>, store: Arc<dyn SecretStore>) -> Self {
        Self { mail, store }
    }

    async fn rpc(&self, request: &Request<'_>, message: &Value) -> Result<Value, String> {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params");
        let reply = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
        let error = |code: i64, message: String| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } });
        let missing = || format!("GMAIL_APP_PASSWORD_MISSING: {}", sentence("MISSING"));
        Ok(match method {
            "initialize" => {
                if request.password().await?.is_empty() {
                    return Ok(error(-32001, missing()));
                }
                let version = Some(text_arg(params.and_then(|p| p.get("protocolVersion")))).filter(|v| !v.is_empty()).unwrap_or_else(|| PROTOCOL_VERSION.to_owned());
                reply(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "mixdog-gmail-app-password", "version": "1.0.0" },
                    "instructions": format!("Accounts: {}. `account` may be left out.", request.email),
                }))
            }
            "ping" => reply(json!({})),
            "tools/list" => reply(json!({ "tools": tool_list() })),
            "tools/call" => {
                let name = params.and_then(|p| p.get("name")).map_or_else(|| "undefined".to_owned(), mixdog_js::value_to_string);
                if !is_tool(&name) {
                    return Ok(error(-32602, format!("Unknown tool: {name}")));
                }
                let password = request.password().await?;
                if password.is_empty() {
                    return Ok(reply(tool_result(missing(), true)));
                }
                let args = params.and_then(|p| p.get("arguments")).filter(|a| a.is_object()).cloned().unwrap_or_else(|| json!({}));
                let ctx = Ctx { mail: &self.mail, email: &request.email, password };
                match run_tool(&ctx, &name, &args).await {
                    Ok(value) => reply(tool_result(redact(&value, password), false)),
                    Err(failure) => reply(tool_result(redact(&failure.text(password), password), true)),
                }
            }
            other => error(-32601, format!("Method not found: {other}")),
        })
    }

    /// The HTTP answer to a request to the reserved address; `account` is the value of the `X-Mixdog-Gmail-Account`
    /// header the server's config carries. `Err` only when the keychain cannot be read.
    pub async fn answer(&self, url: &Url, method: &str, account: Option<&str>, body: &[u8]) -> Result<Answer, String> {
        let json_answer = |status: u16, body: Value| Answer { status, allow: None, www_authenticate: None, body: Some(body) };
        if url.path() != "/mcp" {
            return Ok(json_answer(404, json!({ "error": "not_found" })));
        }
        if !method.eq_ignore_ascii_case("POST") {
            return Ok(Answer { status: 405, allow: Some("POST"), www_authenticate: None, body: None });
        }
        let Ok(message) = serde_json::from_slice::<Value>(body) else {
            return Ok(json_answer(400, json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })));
        };
        let email = gmail_address(&Value::String(account.unwrap_or_default().to_owned()));
        let request = Request { email, store: self.store.as_ref(), password: OnceCell::new() };
        let batch: Vec<&Value> = match &message {
            Value::Array(list) => list.iter().collect(),
            one => vec![one],
        };
        // A notification (no `id`) is answered with nothing.
        let calls = batch.into_iter().filter(|one| one.get("id").is_some()).map(|one| self.rpc(&request, one));
        let mut replies = Vec::new();
        for reply in futures::future::join_all(calls).await {
            replies.push(reply?);
        }
        if replies.is_empty() {
            return Ok(Answer { status: 202, allow: None, www_authenticate: None, body: None });
        }
        Ok(json_answer(200, if message.is_array() { Value::Array(replies) } else { replies.swap_remove(0) }))
    }
}
