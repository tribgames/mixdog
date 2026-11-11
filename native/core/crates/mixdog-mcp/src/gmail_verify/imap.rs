//! The IMAP half of the check, as imapflow 2.5.7 runs it for `new ImapFlow({host, port, secure,
//! auth, disableAutoIdle}).connect()` and `logout()`: greeting, CAPABILITY, ID, the login,
//! CAPABILITY again when the login reply did not carry one, ID again when the first answer was
//! thin, NAMESPACE, COMPRESS, ENABLE, LOGOUT. Only a refused login (and a session that ends or
//! stalls before it is set up) fails the check; ID, NAMESPACE, COMPRESS and ENABLE are
//! best-effort there too.

use std::collections::HashSet;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_rt::time::{Instant, timeout};

use super::Leg;
use super::wire::{Failure, Wire, connect};

const LOGOUT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PENDING: usize = 8 * 1024 * 1024;
/// imapflow's `clientInfo` (package name, version, vendor and support URL).
const CLIENT_INFO: [(&str, &str); 4] = [
    ("name", "imapflow"),
    ("version", "2.5.7"),
    ("vendor", "Postal Systems"),
    ("support-url", "https://github.com/postalsys/imapflow/issues"),
];

/// A connection that ended before the session was set up.
fn closed() -> Failure {
    Failure::new("ClosedAfterConnectTLS", "Unexpected close")
}

fn quote(value: &str) -> Result<String, Failure> {
    if value.contains(['\r', '\n', '\0']) {
        return Err(Failure::new("InvalidStringValue", "Unquotable character in IMAP string value"));
    }
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    Ok(out)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Ok,
    No,
    Bad,
}

struct Reply {
    status: Status,
    /// The tagged line, as imapflow reports it in `err.response`.
    line: String,
    /// The human text after the status and any response code (`err.responseText`).
    text: String,
    untagged: Vec<String>,
}

impl Reply {
    fn refusal(&self, authentication: bool) -> Failure {
        Failure {
            code: String::new(),
            response: Some(self.line.clone()),
            response_text: Some(self.text.clone()),
            message: "Command failed".into(),
            response_code: None,
            authentication_failed: authentication && self.status != Status::Ok,
        }
    }
}

/// `[CAPABILITY …]` response code of an OK line.
fn capability_section(text: &str) -> Option<&str> {
    let upper = text.to_ascii_uppercase();
    let start = upper.find("[CAPABILITY ")? + "[CAPABILITY ".len();
    let end = text[start..].find(']')? + start;
    Some(&text[start..end])
}

/// The text of a response without its leading `[code]`.
fn text_of(rest: &str) -> String {
    let rest = rest.trim();
    match rest.strip_prefix('[').and_then(|tail| tail.split_once(']')) {
        Some((_, text)) => text.trim().to_owned(),
        None => rest.to_owned(),
    }
}

/// `{n}` ending a line: an IMAP literal follows.
fn literal_size(line: &str) -> Option<(usize, usize)> {
    let body = line.strip_suffix('}')?;
    let open = body.rfind('{')?;
    let digits = body[open + 1..].trim_end_matches('+');
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((digits.parse().ok()?, line.len() - open))
}

/// The strings of the first parenthesized list of an untagged `ID` response, `NIL` as `None`.
fn id_list(rest: &str) -> Vec<Option<String>> {
    let Some(open) = rest.find('(') else { return Vec::new() };
    let mut items = Vec::new();
    let mut chars = rest[open + 1..].chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ')' => break,
            '"' => {
                let mut value = String::new();
                while let Some(next) = chars.next() {
                    match next {
                        '\\' => value.extend(chars.next()),
                        '"' => break,
                        other => value.push(other),
                    }
                }
                items.push(Some(value));
            }
            c if c.is_whitespace() => {}
            first => {
                let mut atom = String::from(first);
                while let Some(next) = chars.peek().copied().filter(|n| !n.is_whitespace() && *n != ')') {
                    atom.push(next);
                    chars.next();
                }
                items.push(if atom.eq_ignore_ascii_case("NIL") { None } else { Some(atom) });
            }
        }
    }
    items
}

struct IdInfo {
    keys: usize,
    name: Option<String>,
}

struct Session {
    wire: Wire,
    caps: HashSet<String>,
    next_tag: u32,
    expect_capability_update: bool,
    authenticated: bool,
    server_name: Option<String>,
}

impl Session {
    fn has(&self, capability: &str) -> bool {
        self.caps.contains(&capability.to_ascii_uppercase())
    }

    fn set_capabilities(&mut self, list: &str) {
        self.caps = list.split_whitespace().map(str::to_ascii_uppercase).collect();
        self.expect_capability_update = false;
    }

    /// One logical response line, a literal folded in as a quoted string.
    async fn response(&mut self) -> Result<String, Failure> {
        let mut text = String::new();
        loop {
            let Some(line) = self.wire.line().await? else { return Err(closed()) };
            let line = String::from_utf8_lossy(&line).into_owned();
            let Some((size, marker)) = literal_size(&line) else {
                text.push_str(&line);
                return Ok(text);
            };
            text.push_str(&line[..line.len() - marker]);
            let Some(data) = self.wire.exact(size).await? else { return Err(closed()) };
            text.push_str(&quote(&String::from_utf8_lossy(&data).replace(['\r', '\n', '\0'], " "))?);
        }
    }

    /// Sends one tagged command; `plus` answers each continuation request.
    async fn run(&mut self, command: &str, mut plus: impl FnMut(&str) -> String) -> Result<Reply, Failure> {
        let tag = format!("{:X}", self.next_tag);
        self.next_tag += 1;
        self.wire.send(format!("{tag} {command}\r\n").as_bytes()).await?;
        let mut untagged = Vec::new();
        let prefix = format!("{tag} ");
        loop {
            let line = self.response().await?;
            if let Some(rest) = line.strip_prefix("* ") {
                if let Some(list) = rest.get(..11).filter(|head| head.eq_ignore_ascii_case("CAPABILITY ")).map(|_| &rest[11..]) {
                    self.set_capabilities(list);
                } else if let Some(list) = capability_section(rest).filter(|_| rest.get(..2).is_some_and(|head| head.eq_ignore_ascii_case("OK"))) {
                    self.set_capabilities(list);
                }
                untagged.push(rest.to_owned());
            } else if let Some(text) = line.strip_prefix('+') {
                let answer = plus(text.trim_start());
                self.wire.send(format!("{answer}\r\n").as_bytes()).await?;
            } else if let Some(rest) = line.strip_prefix(&prefix) {
                let (word, text) = rest.split_once(' ').unwrap_or((rest, ""));
                let status = match word.to_ascii_uppercase().as_str() {
                    "OK" => Status::Ok,
                    "NO" => Status::No,
                    "BAD" => Status::Bad,
                    _ => continue,
                };
                if status == Status::Ok
                    && let Some(list) = capability_section(text)
                {
                    self.set_capabilities(list);
                }
                return Ok(Reply { status, line: line.clone(), text: text_of(text), untagged });
            }
        }
    }

    async fn simple(&mut self, command: &str) -> Result<Reply, Failure> {
        self.run(command, |_| String::new()).await
    }

    /// The greeting: OK starts the session, PREAUTH starts it logged in, BYE ends it.
    async fn greeting(&mut self) -> Result<bool, Failure> {
        loop {
            let line = self.response().await?;
            let Some(rest) = line.strip_prefix("* ") else { continue };
            let word = rest.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
            match word.as_str() {
                "OK" | "PREAUTH" => {
                    if let Some(list) = capability_section(rest) {
                        self.set_capabilities(list);
                    }
                    return Ok(word == "PREAUTH");
                }
                "BYE" => return Err(closed()),
                _ => {}
            }
        }
    }

    async fn id(&mut self) -> Result<Option<IdInfo>, Failure> {
        let pairs: Vec<String> = CLIENT_INFO.iter().map(|(key, value)| Ok(format!("{} {}", quote(key)?, quote(value)?))).collect::<Result<_, Failure>>()?;
        let reply = self.simple(&format!("ID ({})", pairs.join(" "))).await?;
        if reply.status != Status::Ok {
            return Ok(None);
        }
        let mut info = IdInfo { keys: 0, name: None };
        for rest in reply.untagged.iter().filter(|rest| rest.get(..2).is_some_and(|head| head.eq_ignore_ascii_case("ID"))) {
            let items = id_list(rest);
            for pair in items.chunks(2) {
                if let [Some(key), Some(value)] = pair {
                    info.keys += 1;
                    if key.trim().eq_ignore_ascii_case("name") {
                        info.name = Some(value.clone());
                    }
                }
            }
        }
        Ok(Some(info))
    }

    async fn authenticate(&mut self, email: &str, password: &str) -> Result<(), Failure> {
        if self.authenticated {
            return Ok(());
        }
        self.expect_capability_update = true;
        if password.is_empty() {
            return Err(Failure { message: "No password configured".into(), authentication_failed: true, ..Failure::default() });
        }
        // A user name with a slash or backslash is a domain account: imapflow sends LOGIN.
        let plain_login = email.contains(['\\', '/']);
        let reply = if !plain_login && self.has("AUTH=PLAIN") {
            let secret = STANDARD.encode(format!("\0{email}\0{password}"));
            self.run("AUTHENTICATE PLAIN", |_| secret.clone()).await?
        } else if !plain_login && self.has("AUTH=LOGIN") {
            let mut username_sent = false;
            self.run("AUTHENTICATE LOGIN", |challenge| {
                let decoded = STANDARD.decode(challenge.trim()).map(|b| String::from_utf8_lossy(&b).to_lowercase()).unwrap_or_default();
                let question = decoded.trim_end_matches([':', '\0']);
                if question == "username" || question == "user name" || (question.is_empty() && !username_sent) {
                    username_sent = true;
                    STANDARD.encode(email)
                } else if question == "password" {
                    STANDARD.encode(password)
                } else {
                    "*".to_owned()
                }
            })
            .await?
        } else {
            if self.has("LOGINDISABLED") {
                return Err(Failure { message: "Login is disabled".into(), authentication_failed: true, ..Failure::default() });
            }
            self.simple(&format!("LOGIN {} {}", quote(email)?, quote(password)?)).await?
        };
        if reply.status != Status::Ok {
            return Err(reply.refusal(true));
        }
        self.authenticated = true;
        if self.expect_capability_update {
            self.simple("CAPABILITY").await?;
        }
        Ok(())
    }

    async fn namespace(&mut self) -> Result<(), Failure> {
        let reply = if self.has("NAMESPACE") { self.simple("NAMESPACE").await? } else { self.simple("LIST \"\" \"\"").await? };
        if reply.status == Status::Bad && reply.text.to_ascii_lowercase().contains("user is authenticated but not connected") {
            return Err(Failure {
                message: "Authentication failed".into(),
                response: Some(reply.text),
                authentication_failed: true,
                ..Failure::default()
            });
        }
        Ok(())
    }

    async fn compress(&mut self) -> Result<(), Failure> {
        if !self.has("COMPRESS=DEFLATE") {
            return Ok(());
        }
        if self.simple("COMPRESS DEFLATE").await?.status != Status::Ok {
            return Ok(());
        }
        if !self.wire.pending().is_empty() {
            return Err(Failure::new(
                "COMPRESS_TRAILING_DATA",
                "Server sent data between the COMPRESS response and the compression layer switch",
            ));
        }
        self.wire.start_compression();
        Ok(())
    }

    async fn enable(&mut self, skip_rev2: bool) -> Result<(), Failure> {
        if !self.has("ENABLE") || !self.authenticated {
            return Ok(());
        }
        let mut wanted = vec!["CONDSTORE", "UTF8=ACCEPT"];
        if !skip_rev2 {
            wanted.push("IMAP4rev2");
        }
        let asked: Vec<&str> = wanted.iter().copied().filter(|extension| self.has(extension)).collect();
        if asked.is_empty() {
            return Ok(());
        }
        let reply = self.simple(&format!("ENABLE {}", asked.iter().map(|e| e.to_ascii_uppercase()).collect::<Vec<_>>().join(" "))).await?;
        if reply.status != Status::Ok && asked.contains(&"IMAP4rev2") {
            // A server that rejects the whole command over IMAP4rev2 still gets the others.
            let rest: Vec<String> = asked.iter().filter(|e| **e != "IMAP4rev2").map(|e| e.to_ascii_uppercase()).collect();
            if !rest.is_empty() {
                self.simple(&format!("ENABLE {}", rest.join(" "))).await?;
            }
        }
        Ok(())
    }

    /// `startSession()`: everything between the greeting and the usable connection.
    async fn setup(&mut self, email: &str, password: &str) -> Result<(), Failure> {
        self.simple("CAPABILITY").await?;
        let mut id = if self.has("ID") { self.id().await? } else { None };
        if let Some(info) = &id {
            self.server_name = info.name.clone();
        }
        self.authenticate(email, password).await?;
        if id.as_ref().is_none_or(|info| info.keys < 2) && self.has("ID") {
            id = self.id().await?;
            if let Some(info) = &id {
                self.server_name = info.name.clone();
            }
        }
        // "rzimapd" answers SEARCH wrongly once IMAP4rev2 is enabled.
        let skip_rev2 = self.server_name.as_deref().is_some_and(|name| name.trim().eq_ignore_ascii_case("rzimapd"));
        self.namespace().await?;
        self.compress().await?;
        self.enable(skip_rev2).await
    }

    /// LOGOUT, then close; the server's answer, or the lack of one, is no failure.
    async fn logout(&mut self) {
        let _ = timeout(LOGOUT_TIMEOUT, self.simple("LOGOUT")).await;
    }
}

pub async fn verify(leg: &Leg<'_>, email: &str, password: &str) -> Result<(), Failure> {
    let deadline = Instant::now() + leg.timeouts.connection;
    let io = connect(leg.target, leg.tls, deadline, "CONNECT_TIMEOUT", "Failed to establish connection in required time").await?;
    let wire = Wire::new(io, leg.timeouts.socket, ("ETIMEOUT", "Socket timeout"), None, MAX_PENDING);
    let mut session = Session {
        wire,
        caps: HashSet::new(),
        next_tag: 1,
        expect_capability_update: false,
        authenticated: false,
        server_name: None,
    };
    let greeting_timeout = || Failure::new("GREETING_TIMEOUT", "Failed to receive greeting from server in required time");
    // The greeting timer runs from the connection until the greeting arrives; the session
    // setup after it is bounded by the socket timeout alone.
    let greeted = timeout(leg.timeouts.greeting, session.greeting()).await.map_err(|_| greeting_timeout())??;
    session.authenticated = greeted;
    session.setup(email, password).await?;
    session.logout().await;
    Ok(())
}
