//! The server against the fake IMAP and SMTP servers of the password check (loopback TLS). Expected command lines and
//! texts come from reading `gmail-app-password.mjs`, imapflow 2.5.7 and nodemailer 10.1.7, not from this code's output.

use std::sync::Arc;

use mixdog_secrets::MemoryStore;
use mixdog_secrets::SecretStore;
use serde_json::Value;
use serde_json::json;
use url::Url;

use super::GmailMcp;
use super::is_service;
use crate::connector_model::GMAIL_APP_PASSWORD_URL;
use crate::gmail_verify::tests::EMAIL;
use crate::gmail_verify::tests::Extra;
use crate::gmail_verify::tests::Imap;
use crate::gmail_verify::tests::Log;
use crate::gmail_verify::tests::SECRET;
use crate::gmail_verify::tests::Smtp;
use crate::gmail_verify::tests::lines;
use crate::gmail_verify::tests::quick;
use crate::gmail_verify::tests::rig;
use crate::mcp_secrets::gmail_app_password_secret_account;

fn untagged(text: &str) -> Vec<u8> {
    format!("{text}\r\n").into_bytes()
}

/// `* n FETCH (…{size}` and the literal, then the rest of the line.
fn with_literal(head: &str, literal: &[u8], tail: &str) -> Vec<u8> {
    let mut out = format!("{head} {{{}}}\r\n", literal.len()).into_bytes();
    out.extend_from_slice(literal);
    out.extend_from_slice(format!("{tail}\r\n").as_bytes());
    out
}

const ENVELOPE_9: &str = "(\"Mon, 7 Feb 2022 21:52:25 -0800\" \"=?UTF-8?B?7ZmN6ri4?= hello\" ((\"Ann\" NIL \"ann\" \"x.org\")) NIL NIL ((\"Me\" NIL \"me\" \"gmail.com\")) ((\"Cc\" NIL \"cc\" \"y.org\")) NIL NIL \"<m9@x.org>\")";
const STRUCTURE_9: &str = "((\"text\" \"plain\" (\"charset\" \"utf-8\") NIL NIL \"7bit\" 40 2)(\"application\" \"pdf\" (\"name\" \"r.pdf\") NIL NIL \"base64\" 400 NIL (\"attachment\" (\"filename\" \"r.pdf\")) NIL) \"mixed\" (\"boundary\" \"z\") NIL NIL)";
const ENVELOPE_7: &str = "(NIL \"Plain\" ((NIL NIL \"bob\" \"z.org\")) NIL NIL NIL NIL NIL NIL \"<m7@z.org>\")";
const STRUCTURE_7: &str = "(\"text\" \"html\" (\"charset\" \"utf-8\") NIL NIL \"quoted-printable\" 90 3)";
const BODY_9: &str = "Hello world\r\nsee https://example.com/a";
const BODY_7: &str = "<p>Hi=20there</p><a href=3D\"https://q.example/x\">x</a>";
const AUTH_9: &str = "Authentication-Results: mx.google.com;\r\n       dkim=pass header.d=x.org header.s=s1;\r\n       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=x.org\r\n\r\n";

/// What Gmail answers for the mailbox of the tests: message 9 (id 111, multipart with an attachment) and message 7 (id
/// 333, quoted-printable HTML). `UID SEARCH X-GM-RAW` finds both.
fn gmail(tag: &str, command: &str) -> Option<Vec<Vec<u8>>> {
    let ok = |text: &str| untagged(&format!("{tag} OK {text}"));
    let reply = |mut chunks: Vec<Vec<u8>>| {
        chunks.push(ok("Success"));
        Some(chunks)
    };
    match command {
        "LIST \"\" \"*\"" => reply(vec![
            untagged("* LIST (\\HasNoChildren) \"/\" \"INBOX\""),
            untagged("* LIST (\\All \\HasNoChildren) \"/\" \"[Gmail]/All Mail\""),
            untagged("* LIST (\\Trash \\HasNoChildren) \"/\" \"[Gmail]/Trash\""),
        ]),
        "EXAMINE \"[Gmail]/All Mail\"" | "SELECT \"[Gmail]/All Mail\"" => reply(vec![untagged("* 2 EXISTS")]),
        c if c.starts_with("UID SEARCH X-GM-RAW") => reply(vec![untagged("* SEARCH 7 9")]),
        "UID SEARCH X-GM-MSGID 111" => reply(vec![untagged("* SEARCH 9")]),
        "UID SEARCH X-GM-MSGID 333" => reply(vec![untagged("* SEARCH 7")]),
        c if c.starts_with("UID SEARCH X-GM-MSGID") => reply(vec![untagged("* SEARCH")]),
        "UID FETCH 9,7 (UID ENVELOPE INTERNALDATE BODYSTRUCTURE X-GM-THRID X-GM-MSGID)" => reply(vec![
            untagged(&format!(
                "* 1 FETCH (UID 7 INTERNALDATE \"17-Jul-2022 02:44:25 -0700\" ENVELOPE {ENVELOPE_7} BODYSTRUCTURE {STRUCTURE_7} X-GM-THRID 444 X-GM-MSGID 333)"
            )),
            untagged(&format!(
                "* 2 FETCH (UID 9 INTERNALDATE \"08-Feb-2022 05:52:25 +0000\" ENVELOPE {ENVELOPE_9} BODYSTRUCTURE {STRUCTURE_9} X-GM-THRID 222 X-GM-MSGID 111)"
            )),
        ]),
        "UID FETCH 9 (UID ENVELOPE INTERNALDATE BODYSTRUCTURE X-GM-THRID X-GM-MSGID)" => reply(vec![untagged(&format!(
            "* 2 FETCH (UID 9 INTERNALDATE \"08-Feb-2022 05:52:25 +0000\" ENVELOPE {ENVELOPE_9} BODYSTRUCTURE {STRUCTURE_9} X-GM-THRID 222 X-GM-MSGID 111)"
        ))]),
        "UID FETCH 9 (UID ENVELOPE INTERNALDATE BODYSTRUCTURE X-GM-THRID X-GM-MSGID BODY.PEEK[HEADER.FIELDS (AUTHENTICATION-RESULTS)])" => {
            reply(vec![with_literal(
                &format!(
                    "* 2 FETCH (UID 9 INTERNALDATE \"08-Feb-2022 05:52:25 +0000\" ENVELOPE {ENVELOPE_9} BODYSTRUCTURE {STRUCTURE_9} X-GM-THRID 222 X-GM-MSGID 111 BODY[HEADER.FIELDS (AUTHENTICATION-RESULTS)]"
                ),
                AUTH_9.as_bytes(),
                ")",
            )])
        }
        c if c.starts_with("UID FETCH 9 (UID BODY.PEEK[1]<0.") => reply(vec![with_literal("* 2 FETCH (UID 9 BODY[1]<0>", BODY_9.as_bytes(), ")")]),
        "UID FETCH 7 (UID BODY.PEEK[1]<0.2048>)" => reply(vec![with_literal("* 1 FETCH (UID 7 BODY[1]<0>", BODY_7.as_bytes(), ")")]),
        "UID FETCH 9 (UID ENVELOPE INTERNALDATE)" => {
            reply(vec![untagged(&format!("* 2 FETCH (UID 9 INTERNALDATE \"08-Feb-2022 05:52:25 +0000\" ENVELOPE {ENVELOPE_9})"))])
        }
        "UID FETCH 9 (UID ENVELOPE BODY.PEEK[HEADER.FIELDS (REFERENCES)])" => reply(vec![with_literal(
            &format!("* 2 FETCH (UID 9 ENVELOPE {ENVELOPE_9} BODY[HEADER.FIELDS (REFERENCES)]"),
            b"References: <root@x.org>\r\n <m9@x.org>\r\n\r\n",
            ")",
        )]),
        c if c.starts_with("UID STORE ") || c.starts_with("UID MOVE ") => reply(Vec::new()),
        _ => None,
    }
}

struct Server {
    mcp: GmailMcp,
    imap_log: Log,
    smtp_log: Log,
    url: Url,
}

async fn server(store: Arc<dyn SecretStore>) -> Server {
    let mut imap = Imap::gmail();
    imap.extra = Some(Arc::new(gmail) as Extra);
    let rig = rig(imap, Smtp::gmail(), quick()).await;
    Server {
        mcp: GmailMcp::new(Arc::new(rig.verifier), store),
        imap_log: rig.imap_log,
        smtp_log: rig.smtp_log,
        url: Url::parse(GMAIL_APP_PASSWORD_URL).unwrap(),
    }
}

async fn stored() -> Arc<dyn SecretStore> {
    let store = MemoryStore::default();
    store.set(&gmail_app_password_secret_account(EMAIL), SECRET).await.unwrap();
    Arc::new(store)
}

impl Server {
    async fn post(&self, account: Option<&str>, message: Value) -> Value {
        let body = serde_json::to_vec(&message).unwrap();
        self.mcp.answer(&self.url, "POST", account, &body).await.unwrap().body.unwrap()
    }

    /// The `result` of `tools/call`.
    async fn call(&self, name: &str, arguments: Value) -> Value {
        let reply =
            self.post(Some(EMAIL), json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": arguments } })).await;
        reply["result"].clone()
    }

    async fn text(&self, name: &str, arguments: Value) -> String {
        let result = self.call(name, arguments).await;
        assert!(result["isError"].is_null(), "{result}");
        result["content"][0]["text"].as_str().unwrap().to_owned()
    }

    async fn error(&self, name: &str, arguments: Value) -> String {
        let result = self.call(name, arguments).await;
        assert_eq!(result["isError"], true, "{result}");
        result["content"][0]["text"].as_str().unwrap().to_owned()
    }

    /// What the IMAP server was sent, without the tags.
    fn imap(&self) -> Vec<String> {
        lines(&self.imap_log).into_iter().map(|line| line.split_once(' ').map_or(line.clone(), |(_, command)| command.to_owned())).collect()
    }

    /// The commands of the first session after its set-up.
    fn commands(&self) -> Vec<String> {
        self.imap().into_iter().skip(6).filter(|line| !line.contains("LOGOUT")).collect()
    }
}

#[tokio::test]
async fn the_reserved_address_is_recognised_and_other_paths_and_methods_are_refused() {
    assert!(is_service(&Url::parse("https://gmail-imap.mixdog.invalid/mcp").unwrap()));
    assert!(!is_service(&Url::parse("https://gmail.mixdog.invalid/mcp").unwrap()));
    assert!(!is_service(&Url::parse("http://gmail-imap.mixdog.invalid/mcp").unwrap()));
    let server = server(stored().await).await;
    let other = Url::parse("https://gmail-imap.mixdog.invalid/other").unwrap();
    assert_eq!(server.mcp.answer(&other, "POST", Some(EMAIL), b"{}").await.unwrap().status, 404);
    let answer = server.mcp.answer(&server.url, "GET", Some(EMAIL), b"").await.unwrap();
    assert_eq!((answer.status, answer.allow), (405, Some("POST")));
    let answer = server.mcp.answer(&server.url, "POST", Some(EMAIL), b"{").await.unwrap();
    assert_eq!(answer.status, 400);
    assert_eq!(answer.body.unwrap()["error"]["code"], -32700);
}

#[tokio::test]
async fn initialize_names_the_account_and_needs_a_saved_password() {
    let server = server(stored().await).await;
    let reply =
        server.post(Some("User@Gmail.com"), json!({ "jsonrpc": "2.0", "id": 5, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).await;
    assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(reply["result"]["serverInfo"]["name"], "mixdog-gmail-app-password");
    assert_eq!(reply["result"]["instructions"], "Accounts: user@gmail.com. `account` may be left out.");

    let empty = self::server(Arc::new(MemoryStore::default())).await;
    let reply = empty.post(Some(EMAIL), json!({ "jsonrpc": "2.0", "id": 5, "method": "initialize" })).await;
    assert_eq!(reply["error"]["code"], -32001);
    assert_eq!(
        reply["error"]["message"],
        "GMAIL_APP_PASSWORD_MISSING: No Gmail app password is saved on this computer. Connect Gmail again with an app password."
    );
    let result = empty.call("search_emails", json!({})).await;
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"].as_str().unwrap().starts_with("GMAIL_APP_PASSWORD_MISSING"));
    assert!(lines(&empty.imap_log).is_empty(), "no connection is made without a password");
}

#[tokio::test]
async fn the_tool_list_leaves_out_the_tool_only_the_approval_gate_calls() {
    let server = server(stored().await).await;
    let reply = server.post(Some(EMAIL), json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    let names: Vec<&str> = reply["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        [
            "send_email",
            "search_emails",
            "read_email",
            "archive_emails",
            "trash_emails",
            "add_email_label",
            "remove_email_label",
            "mark_emails_read",
            "mark_emails_unread",
            "star_emails",
            "unstar_emails"
        ]
    );
    let trash = &reply["result"]["tools"][4];
    assert_eq!(trash["annotations"]["destructiveHint"], true);
    assert_eq!(reply["result"]["tools"][5]["inputSchema"]["required"], json!(["ids", "label"]));
    let unknown = server.post(Some(EMAIL), json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "nope" } })).await;
    assert_eq!(unknown["error"], json!({ "code": -32602, "message": "Unknown tool: nope" }));
    let method = server.post(Some(EMAIL), json!({ "jsonrpc": "2.0", "id": 4, "method": "x/y" })).await;
    assert_eq!(method["error"]["code"], -32601);
}

#[tokio::test]
async fn search_lists_newest_first_with_a_snippet() {
    let server = server(stored().await).await;
    let listing = server.text("search_emails", json!({ "query": "from:ann" })).await;
    let rows: Vec<Value> = listing.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(
        rows[0],
        json!({ "id": "111", "threadId": "222", "from": "Ann <ann@x.org>", "subject": "홍길 hello", "date": "2022-02-08T05:52:25.000Z", "snippet": "Hello world see https://example.com/a" })
    );
    // An HTML body is shown as text; with no Date header the time the server received it stands.
    assert_eq!(
        rows[1],
        json!({ "id": "333", "threadId": "444", "from": "bob@z.org", "subject": "Plain", "date": "2022-07-17T09:44:25.000Z", "snippet": "Hi there x" })
    );
    assert_eq!(server.commands()[..3], ["LIST \"\" \"*\"", "EXAMINE \"[Gmail]/All Mail\"", "UID SEARCH X-GM-RAW \"from:ann\""]);
}

#[tokio::test]
async fn a_search_that_cuts_the_list_says_so_and_defaults_to_the_inbox() {
    let server = server(stored().await).await;
    let one = server.text("search_emails", json!({ "maxResults": 1 })).await;
    assert!(one.ends_with("\n(1 of 2 shown; narrow the query for others)"));
    assert!(server.imap().iter().any(|line| line == "UID SEARCH X-GM-RAW \"in:inbox\""));
}

#[tokio::test]
async fn read_email_gives_the_headers_text_links_attachments_and_the_authentication_verdict() {
    let server = server(stored().await).await;
    let text = server.text("read_email", json!({ "id": "111" })).await;
    let (head, body) = text.split_once("\n\n").unwrap();
    assert_eq!(body, BODY_9);
    assert_eq!(
        serde_json::from_str::<Value>(head).unwrap(),
        json!({
            "id": "111",
            "threadId": "222",
            "messageId": "<m9@x.org>",
            "from": "Ann <ann@x.org>",
            "fromAddresses": [{ "name": "Ann", "address": "ann@x.org" }],
            "authentication": { "dmarc": { "result": "pass", "from": "x.org" }, "dkim": [{ "result": "pass", "domain": "x.org" }] },
            "to": "Me <me@gmail.com>",
            "cc": "Cc <cc@y.org>",
            "date": "2022-02-08T05:52:25.000Z",
            "subject": "홍길 hello",
            "links": ["https://example.com/a"],
            "attachments": [{ "name": "r.pdf", "type": "application/pdf", "size": 300 }],
        })
    );
    // The key order of the head is the order of the old server's.
    assert!(head.starts_with("{\"id\":\"111\",\"threadId\":\"222\",\"messageId\":\"<m9@x.org>\",\"from\":"));
    assert!(server.imap().iter().any(|line| line == "UID SEARCH X-GM-MSGID 111"));

    assert_eq!(server.error("read_email", json!({ "id": "999" })).await, "No email with id 999.");
    assert_eq!(server.error("read_email", json!({ "id": "abc" })).await, "id must be an id from search_emails");
    assert_eq!(server.error("read_email", json!({})).await, "id is required");
}

#[test]
fn a_text_part_is_read_in_the_charset_it_names() {
    use super::parse::Node;
    let node =
        |charset: &str| Node { kind: "text/plain".into(), parameters: vec![("charset".into(), charset.into())], encoding: "base64".into(), ..Node::default() };
    // "한글" in EUC-KR, as imapflow's download converts it.
    assert_eq!(super::decoded_part(&node("euc-kr"), b"x9Gx2w==", 1024), "한글");
    assert_eq!(super::decoded_part(&node("US-ASCII"), b"aGk=", 1024), "hi");
    assert_eq!(super::decoded_part(&node("utf-8"), "7ZWc6riA".as_bytes(), 1024), "한글");
    // The text is cut at the byte limit, on a character boundary.
    assert_eq!(super::decoded_part(&node("euc-kr"), b"x9Gx2w==", 4), "한");
}

#[tokio::test]
async fn describe_emails_names_the_account_and_each_email_it_finds() {
    let server = server(stored().await).await;
    assert_eq!(server.text("describe_emails", json!({})).await, json!({ "account": EMAIL, "emails": [] }).to_string());
    let text = server.text("describe_emails", json!({ "ids": ["111", "999"] })).await;
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        json!({ "account": EMAIL, "emails": [{ "id": "111", "from": "Ann <ann@x.org>", "subject": "홍길 hello", "date": "2022-02-08T05:52:25.000Z" }] })
    );
    assert_eq!(server.error("describe_emails", json!({ "ids": [] })).await, "ids must list ids from search_emails");
}

#[tokio::test]
async fn managing_emails_sends_the_stores_and_moves_imapflow_sends() {
    let server = server(stored().await).await;
    assert_eq!(server.text("archive_emails", json!({ "ids": ["111", "333", "111", "999"] })).await, "Archived 2 emails. Not found: 999.");
    assert_eq!(server.text("mark_emails_read", json!({ "ids": "111" })).await, "Marked read: 1 email.");
    assert_eq!(server.text("unstar_emails", json!({ "ids": ["111"] })).await, "Unstarred 1 email.");
    assert_eq!(server.text("add_email_label", json!({ "ids": ["111"], "label": "Work" })).await, "Labeled 1 email.");
    assert_eq!(server.text("trash_emails", json!({ "ids": ["111"] })).await, "Moved to Trash: 1 email.");
    let seen = server.imap();
    // Management opens All Mail for writing.
    assert!(seen.iter().any(|line| line == "SELECT \"[Gmail]/All Mail\""));
    assert!(seen.iter().any(|line| line == "UID STORE 9,7 -X-GM-LABELS.SILENT (\\Inbox)"));
    assert!(seen.iter().any(|line| line == "UID STORE 9 +FLAGS.SILENT (\\Seen)"));
    assert!(seen.iter().any(|line| line == "UID STORE 9 -FLAGS.SILENT (\\Flagged)"));
    assert!(seen.iter().any(|line| line == "UID STORE 9 +X-GM-LABELS.SILENT (\"Work\")"));
    assert!(seen.iter().any(|line| line == "UID MOVE 9 \"[Gmail]/Trash\""));

    assert_eq!(server.error("archive_emails", json!({ "ids": ["999"] })).await, "No email with id 999.");
    assert_eq!(server.error("archive_emails", json!({})).await, "ids must list ids from search_emails");
    let many: Vec<String> = (1..=51).map(|n| n.to_string()).collect();
    assert_eq!(server.error("archive_emails", json!({ "ids": many })).await, "At most 50 emails per call; got 51.");
    assert_eq!(server.error("add_email_label", json!({ "ids": ["111"], "label": "\\Inbox" })).await, "label must be a plain label name");
    assert_eq!(server.error("add_email_label", json!({ "ids": ["111"] })).await, "label is required");
}

#[tokio::test]
async fn send_email_talks_smtp_stuffs_dots_and_reports_the_message_id() {
    let server = server(stored().await).await;
    let text =
        server.text("send_email", json!({ "to": "a@x.org, Bee <b@y.org>", "cc": "c@x.org", "bcc": "d@x.org", "subject": "Hi", "body": "one\n.dot" })).await;
    assert!(text.starts_with("Sent (message <") && text.ends_with("@gmail.com>)."), "{text}");
    let seen = lines(&server.smtp_log);
    let from = seen.iter().position(|line| line == "MAIL FROM:<user@gmail.com>").unwrap();
    assert_eq!(seen[from + 1..from + 6], ["RCPT TO:<a@x.org>", "RCPT TO:<b@y.org>", "RCPT TO:<c@x.org>", "RCPT TO:<d@x.org>", "DATA"]);
    assert!(seen.contains(&"To: a@x.org, Bee <b@y.org>".to_owned()));
    assert!(seen.contains(&"Subject: Hi".to_owned()));
    assert!(seen.contains(&"..dot".to_owned()), "a line starting with a dot is doubled");
    assert!(!seen.iter().any(|line| line.contains("Bcc") || line.contains("d@x.org") && line.starts_with("To")));
    assert!(lines(&server.imap_log).len() <= 6, "a plain send does not open a mailbox");

    assert_eq!(server.error("send_email", json!({ "subject": "x", "body": "y" })).await, "to is required");
    assert_eq!(server.error("send_email", json!({ "to": "a@x.org\nb@x.org", "subject": "x", "body": "y" })).await, "to must be one line");
    assert_eq!(server.error("send_email", json!({ "to": "a@x.org", "subject": "x\ny", "body": "y" })).await, "subject must be one line");
}

#[tokio::test]
async fn a_reply_threads_on_the_message_it_names() {
    let server = server(stored().await).await;
    server.text("send_email", json!({ "to": "ann@x.org", "subject": "", "body": "ok", "inReplyTo": "111" })).await;
    let seen = lines(&server.smtp_log);
    assert!(seen.contains(&"In-Reply-To: <m9@x.org>".to_owned()));
    // References: the ones the message had, then its own id once.
    let at = seen.iter().position(|line| line.starts_with("References:")).unwrap();
    assert_eq!(seen[at], "References: <root@x.org> <m9@x.org>");
    assert!(seen.iter().any(|line| line.starts_with("Subject: =?UTF-8?B?")), "an empty subject is Re: and the original, encoded");

    // A Message-ID needs no lookup.
    let before = lines(&server.imap_log).len();
    server.text("send_email", json!({ "to": "ann@x.org", "subject": "S", "body": "ok", "inReplyTo": "<given@x.org>" })).await;
    assert_eq!(lines(&server.imap_log).len(), before);
    assert!(lines(&server.smtp_log).contains(&"References: <given@x.org>".to_owned()));
    assert_eq!(server.error("send_email", json!({ "to": "a@x.org", "subject": "S", "body": "b", "inReplyTo": "999" })).await, "No email with id 999.");
}

#[tokio::test]
async fn a_refused_login_is_the_fixed_sentence_and_the_password_never_appears() {
    let mut imap = Imap::gmail();
    imap.login = "NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)".into();
    let rig = rig(imap, Smtp::gmail(), quick()).await;
    let mail = Arc::new(rig.verifier);
    let server = GmailMcp::new(mail, stored().await);
    let url = Url::parse(GMAIL_APP_PASSWORD_URL).unwrap();
    let body =
        serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "search_emails", "arguments": {} } })).unwrap();
    let answer = server.answer(&url, "POST", Some(EMAIL), &body).await.unwrap().body.unwrap();
    assert_eq!(answer["result"]["isError"], true);
    let text = answer["result"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(text, "GMAIL_APP_PASSWORD_REJECTED: Google did not accept this address and app password.");
    assert!(!text.contains(SECRET));
}

#[tokio::test]
async fn a_batch_is_answered_in_order_and_notifications_are_not_answered() {
    let server = server(stored().await).await;
    let batch = json!([
        { "jsonrpc": "2.0", "method": "notifications/initialized" },
        { "jsonrpc": "2.0", "id": 1, "method": "ping" },
        { "jsonrpc": "2.0", "id": 2, "method": "ping" },
    ]);
    let reply = server.post(Some(EMAIL), batch).await;
    assert_eq!(reply, json!([{ "jsonrpc": "2.0", "id": 1, "result": {} }, { "jsonrpc": "2.0", "id": 2, "result": {} }]));
    let answer = server.mcp.answer(&server.url, "POST", Some(EMAIL), br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await.unwrap();
    assert_eq!(answer.status, 202);
}
