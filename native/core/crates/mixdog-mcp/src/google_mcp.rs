//! Mixdog's built-in Google connectors (Gmail, Google Calendar, Google Drive), as Node's `connectors/google-mcp.mjs`
//! answers them: a small MCP server answered in this process at a reserved address (`https://<service>.mixdog.invalid/mcp`,
//! RFC 2606: it never resolves, so no request or token can leave for it). To the client it is an ordinary remote MCP server,
//! so the MCP sign-in applies unchanged: the protected-resource metadata names Google as the authorization server, and each
//! request carries the access token, which this server spends on the Gmail, Calendar and Drive REST APIs through
//! [`GoogleFetch`].

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use url::Url;

use crate::connector_model::encode_uri_component;

const PROTOCOL_VERSION: &str = "2025-06-18";
const ORIGIN_SUFFIX: &str = ".mixdog.invalid";
const GOOGLE_ISSUER: &str = "https://accounts.google.com";
const READ_CAP: usize = 100_000;
const SERVICES: [&str; 3] = ["gmail", "calendar", "drive"];

/// One request of the REST calls the tools make with the user's token.
pub struct GoogleRequest {
    pub method: &'static str,
    pub url: String,
    pub authorization: Option<String>,
    pub content_type: Option<String>,
    pub body: Option<String>,
}

pub struct GoogleReply {
    pub status: u16,
    pub body: String,
}

/// Where the REST calls go: Google, or a stand-in of it.
#[async_trait]
pub trait GoogleFetch: Send + Sync {
    async fn fetch(&self, request: GoogleRequest) -> Result<GoogleReply, String>;
}

/// [`GoogleFetch`] over the network.
pub struct NetworkFetch(reqwest::Client);

impl NetworkFetch {
    pub fn new() -> Result<Self, String> {
        reqwest::Client::builder().build().map(Self).map_err(|e| e.without_url().to_string())
    }
}

#[async_trait]
impl GoogleFetch for NetworkFetch {
    async fn fetch(&self, request: GoogleRequest) -> Result<GoogleReply, String> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|e| e.to_string())?;
        let mut builder = self.0.request(method, &request.url);
        if let Some(token) = request.authorization {
            builder = builder.header(reqwest::header::AUTHORIZATION, token);
        }
        if let Some(kind) = request.content_type {
            builder = builder.header(reqwest::header::CONTENT_TYPE, kind);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let response = builder.send().await.map_err(|e| e.without_url().to_string())?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|e| e.without_url().to_string())?;
        Ok(GoogleReply { status, body })
    }
}

/// The reserved MCP address of built-in Google service `service`.
pub fn mcp_url(service: &str) -> String {
    format!("https://{service}{ORIGIN_SUFFIX}/mcp")
}

/// The built-in service a URL addresses (`gmail`, `calendar`, `drive`), if any.
pub fn service(url: &Url) -> Option<&'static str> {
    if url.scheme() != "https" {
        return None;
    }
    let label = url.host_str()?.strip_suffix(ORIGIN_SUFFIX)?;
    SERVICES.into_iter().find(|service| *service == label)
}

/// What the reserved address answers: the HTTP reply of a request to it.
#[derive(Debug, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub allow: Option<&'static str>,
    pub www_authenticate: Option<String>,
    pub body: Option<Value>,
}

impl Answer {
    fn json(status: u16, body: Value) -> Self {
        Self { status, allow: None, www_authenticate: None, body: Some(body) }
    }
}

struct Unauthorized;

enum Failure {
    /// Google refused the token: the client signs in again.
    Unauthorized,
    /// A tool's own refusal, answered as a tool error.
    Tool(String),
    /// The network failed: nothing can be answered.
    Fetch(String),
}

impl From<Unauthorized> for Failure {
    fn from(_: Unauthorized) -> Self {
        Self::Unauthorized
    }
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|s| mixdog_js::js_trim(s).to_owned()).unwrap_or_default()
}

fn require_text(args: &Value, key: &str) -> Result<String, Failure> {
    let value = text(args.get(key));
    if value.is_empty() { Err(Failure::Tool(format!("{key} is required"))) } else { Ok(value) }
}

struct Calls<'a> {
    token: &'a str,
    fetch: &'a dyn GoogleFetch,
    now_ms: i64,
}

struct Call {
    method: &'static str,
    body: Option<String>,
    content_type: Option<String>,
}

impl Call {
    fn get() -> Self {
        Self { method: "GET", body: None, content_type: None }
    }

    fn with(method: &'static str, body: Value) -> Self {
        Self { method, body: Some(body.to_string()), content_type: Some("application/json".to_owned()) }
    }
}

impl Calls<'_> {
    /// One Google REST call with the user's access token: the reply and, unless it was a 204, its text.
    async fn send(&self, url: &str, call: Call) -> Result<GoogleReply, Failure> {
        let reply = self
            .fetch
            .fetch(GoogleRequest { method: call.method, url: url.to_owned(), authorization: Some(format!("Bearer {}", self.token)), content_type: call.content_type, body: call.body })
            .await
            .map_err(Failure::Fetch)?;
        if reply.status == 401 {
            return Err(Failure::Unauthorized);
        }
        if !(200..300).contains(&reply.status) {
            let detail = serde_json::from_str::<Value>(&reply.body).ok().and_then(|d| d.pointer("/error/message").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_owned));
            return Err(Failure::Tool(detail.unwrap_or_else(|| format!("Google answered {}", reply.status))));
        }
        Ok(reply)
    }

    /// The JSON of the reply; `null` for no content.
    async fn json(&self, url: &str, call: Call) -> Result<Value, Failure> {
        let reply = self.send(url, call).await?;
        if reply.status == 204 {
            return Ok(Value::Null);
        }
        serde_json::from_str(&reply.body).map_err(|e| Failure::Tool(e.to_string()))
    }
}

fn form(pairs: &[(&str, String)]) -> String {
    let mut out = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        out.append_pair(key, value);
    }
    out.finish()
}

/// `Math.min(100, Math.max(1, Number(value) || 25))`, as the text of the number.
fn page_size(value: Option<&Value>) -> String {
    let number = match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => mixdog_js::string_to_number(s),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    };
    let number = if number.is_nan() || number == 0.0 { 25.0 } else { number };
    mixdog_js::json_number(number.clamp(1.0, 100.0)).to_string()
}

/// `new Date(ms).toISOString()`.
fn iso(ms: i64) -> String {
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Civil date from the day number (proleptic Gregorian).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000)
}

// ── Gmail (gmail.send) ──────────────────────────────────────────────────────

fn encoded_word(value: &str) -> String {
    format!("=?UTF-8?B?{}?=", STANDARD.encode(value))
}

fn mime_message(to: &str, cc: &str, bcc: &str, subject: &str, body: &str) -> Result<String, Failure> {
    for (key, value) in [("to", to), ("cc", cc), ("bcc", bcc), ("subject", subject)] {
        if value.contains(['\r', '\n']) {
            return Err(Failure::Tool(format!("{key} must be one line")));
        }
    }
    let mut lines = vec![format!("To: {to}")];
    if !cc.is_empty() {
        lines.push(format!("Cc: {cc}"));
    }
    if !bcc.is_empty() {
        lines.push(format!("Bcc: {bcc}"));
    }
    lines.extend([
        format!("Subject: {}", encoded_word(subject)),
        "MIME-Version: 1.0".to_owned(),
        "Content-Type: text/plain; charset=\"UTF-8\"".to_owned(),
        "Content-Transfer-Encoding: base64".to_owned(),
    ]);
    Ok(format!("{}\r\n\r\n{}", lines.join("\r\n"), STANDARD.encode(body)))
}

// ── Google Calendar (calendar.events) ───────────────────────────────────────

const EVENTS: &str = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

fn is_date_only(at: &str) -> bool {
    let bytes = at.as_bytes();
    bytes.len() == 10 && bytes.iter().enumerate().all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() })
}

fn when(value: Option<&Value>, time_zone: &str) -> Option<Value> {
    let at = text(value);
    if at.is_empty() {
        return None;
    }
    if is_date_only(&at) {
        return Some(json!({ "date": at }));
    }
    let mut out = Map::from_iter([("dateTime".to_owned(), json!(at))]);
    if !time_zone.is_empty() {
        out.insert("timeZone".to_owned(), json!(time_zone));
    }
    Some(Value::Object(out))
}

fn event_body(args: &Value) -> Value {
    let time_zone = text(args.get("timeZone"));
    let mut body = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            body.insert(key.to_owned(), value);
        }
    };
    let summary = text(args.get("summary"));
    put("summary", (!summary.is_empty()).then(|| json!(summary)));
    put("description", args.get("description").filter(|d| d.is_string()).cloned());
    let location = text(args.get("location"));
    put("location", (!location.is_empty()).then(|| json!(location)));
    put("start", when(args.get("start"), &time_zone));
    put("end", when(args.get("end"), &time_zone));
    put(
        "attendees",
        args.get("attendees").and_then(Value::as_array).map(|list| Value::Array(list.iter().map(|email| text(Some(email))).filter(|email| !email.is_empty()).map(|email| json!({ "email": email })).collect())),
    );
    Value::Object(body)
}

fn event_line(event: &Value) -> String {
    let moment = |key: &str| event.get(key).and_then(|m| m.get("dateTime").filter(|v| truthy(v)).or_else(|| m.get("date"))).cloned();
    let mut out = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    };
    put("id", event.get("id").cloned());
    put("summary", event.get("summary").cloned());
    put("start", moment("start"));
    put("end", moment("end"));
    put("location", event.get("location").cloned());
    put("attendees", event.get("attendees").and_then(Value::as_array).map(|rows| Value::Array(rows.iter().map(|row| row.get("email").cloned().unwrap_or(Value::Null)).collect())));
    put("link", event.get("htmlLink").cloned());
    Value::Object(out).to_string()
}

// ── Google Drive (drive.file) ────────────────────────────────────────────────

const DRIVE: &str = "https://www.googleapis.com/drive/v3/files";
const FILE_FIELDS: &str = "id,name,mimeType,modifiedTime,webViewLink";

fn export_as(mime: &str) -> Option<&'static str> {
    match mime {
        "application/vnd.google-apps.document" | "application/vnd.google-apps.presentation" => Some("text/plain"),
        "application/vnd.google-apps.spreadsheet" => Some("text/csv"),
        _ => None,
    }
}

/// `/^text\/|^application\/(?:json|xml|javascript|x-yaml|csv)/`.
fn is_text_like(mime: &str) -> bool {
    mime.starts_with("text/") || ["json", "xml", "javascript", "x-yaml", "csv"].iter().any(|kind| mime.strip_prefix("application/").is_some_and(|rest| rest.starts_with(kind)))
}

fn quote_query(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

// ── Tools ────────────────────────────────────────────────────────────────────

fn tool_defs(service: &str) -> Value {
    let event_fields = json!({
        "summary": { "type": "string" },
        "start": { "type": "string", "description": "RFC 3339 date-time, or YYYY-MM-DD for all day." },
        "end": { "type": "string", "description": "RFC 3339 date-time, or YYYY-MM-DD (exclusive) for all day." },
        "timeZone": { "type": "string", "description": "IANA zone, e.g. Asia/Seoul." },
        "description": { "type": "string" },
        "location": { "type": "string" },
        "attendees": { "type": "array", "items": { "type": "string" }, "description": "Guest emails." },
    });
    let mut update_fields = Map::from_iter([("eventId".to_owned(), json!({ "type": "string" }))]);
    update_fields.extend(event_fields.as_object().cloned().unwrap_or_default());
    match service {
        "gmail" => json!([{
            "name": "send_email",
            "description": "Send a plain-text email from the signed-in Gmail account.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "Recipients, comma-separated." },
                    "subject": { "type": "string" },
                    "body": { "type": "string" },
                    "cc": { "type": "string" },
                    "bcc": { "type": "string" },
                },
                "required": ["to", "subject", "body"],
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true },
        }]),
        "calendar" => json!([
            {
                "name": "list_events",
                "description": "List or search events on the primary calendar.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "timeMin": { "type": "string", "description": "RFC 3339; default now." },
                        "timeMax": { "type": "string", "description": "RFC 3339." },
                        "query": { "type": "string", "description": "Free-text search." },
                        "maxResults": { "type": "number", "description": "1-100, default 25." },
                    },
                },
                "annotations": { "readOnlyHint": true, "openWorldHint": true },
            },
            {
                "name": "create_event",
                "description": "Create an event on the primary calendar.",
                "inputSchema": { "type": "object", "properties": event_fields, "required": ["summary", "start", "end"] },
                "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true },
            },
            {
                "name": "update_event",
                "description": "Change fields of an event on the primary calendar.",
                "inputSchema": { "type": "object", "properties": update_fields, "required": ["eventId"] },
                "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true },
            },
            {
                "name": "delete_event",
                "description": "Delete an event from the primary calendar.",
                "inputSchema": { "type": "object", "properties": { "eventId": { "type": "string" } }, "required": ["eventId"] },
                "annotations": { "readOnlyHint": false, "destructiveHint": true, "openWorldHint": true },
            },
        ]),
        _ => json!([
            {
                "name": "search_files",
                "description": "List or search Drive files Mixdog can see (ones it created or you opened with it).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Words in the file name." },
                        "pageSize": { "type": "number", "description": "1-100, default 25." },
                    },
                },
                "annotations": { "readOnlyHint": true, "openWorldHint": true },
            },
            {
                "name": "read_file",
                "description": "Read a Drive file as text (Docs, Sheets as CSV, Slides, text files).",
                "inputSchema": { "type": "object", "properties": { "fileId": { "type": "string" } }, "required": ["fileId"] },
                "annotations": { "readOnlyHint": true, "openWorldHint": true },
            },
            {
                "name": "create_file",
                "description": "Create a text file (or a Google Doc) in Drive.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "content": { "type": "string" },
                        "mimeType": { "type": "string", "description": "Default text/plain." },
                        "asGoogleDoc": { "type": "boolean", "description": "Convert to a Google Doc." },
                        "folderId": { "type": "string" },
                    },
                    "required": ["name", "content"],
                },
                "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true },
            },
        ]),
    }
}

async fn run_tool(service: &str, name: &str, args: &Value, calls: &Calls<'_>) -> Option<Result<String, Failure>> {
    Some(match (service, name) {
        ("gmail", "send_email") => send_email(args, calls).await,
        ("calendar", "list_events") => list_events(args, calls).await,
        ("calendar", "create_event") => create_event(args, calls).await,
        ("calendar", "update_event") => update_event(args, calls).await,
        ("calendar", "delete_event") => delete_event(args, calls).await,
        ("drive", "search_files") => search_files(args, calls).await,
        ("drive", "read_file") => read_file(args, calls).await,
        ("drive", "create_file") => create_file(args, calls).await,
        _ => return None,
    })
}

async fn send_email(args: &Value, calls: &Calls<'_>) -> Result<String, Failure> {
    let to = require_text(args, "to")?;
    let (cc, bcc, subject) = (text(args.get("cc")), text(args.get("bcc")), text(args.get("subject")));
    let body = args.get("body").map(|b| if b.is_null() { String::new() } else { mixdog_js::value_to_string(b) }).unwrap_or_default();
    let raw = URL_SAFE_NO_PAD.encode(mime_message(&to, &cc, &bcc, &subject, &body)?);
    let sent = calls.json("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", Call::with("POST", json!({ "raw": raw }))).await?;
    Ok(format!("Sent (message {}).", sent.get("id").map_or_else(|| "undefined".to_owned(), mixdog_js::value_to_string)))
}

async fn list_events(args: &Value, calls: &Calls<'_>) -> Result<String, Failure> {
    let time_min = Some(text(args.get("timeMin"))).filter(|t| !t.is_empty()).unwrap_or_else(|| iso(calls.now_ms));
    let mut pairs = vec![("singleEvents", "true".to_owned()), ("orderBy", "startTime".to_owned()), ("timeMin", time_min), ("maxResults", page_size(args.get("maxResults")))];
    for (key, param) in [("timeMax", "timeMax"), ("query", "q")] {
        let value = text(args.get(key));
        if !value.is_empty() {
            pairs.push((param, value));
        }
    }
    let list = calls.json(&format!("{EVENTS}?{}", form(&pairs)), Call::get()).await?;
    let items = list.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(if items.is_empty() { "No events.".to_owned() } else { items.iter().map(event_line).collect::<Vec<_>>().join("\n") })
}

async fn create_event(args: &Value, calls: &Calls<'_>) -> Result<String, Failure> {
    for key in ["summary", "start", "end"] {
        require_text(args, key)?;
    }
    Ok(event_line(&calls.json(EVENTS, Call::with("POST", event_body(args))).await?))
}

async fn update_event(args: &Value, calls: &Calls<'_>) -> Result<String, Failure> {
    let id = encode_uri_component(&require_text(args, "eventId")?);
    Ok(event_line(&calls.json(&format!("{EVENTS}/{id}"), Call::with("PATCH", event_body(args))).await?))
}

async fn delete_event(args: &Value, calls: &Calls<'_>) -> Result<String, Failure> {
    let id = encode_uri_component(&require_text(args, "eventId")?);
    calls.json(&format!("{EVENTS}/{id}"), Call { method: "DELETE", body: None, content_type: None }).await?;
    Ok("Deleted.".to_owned())
}

async fn search_files(args: &Value, calls: &Calls<'_>) -> Result<String, Failure> {
    let mut terms = vec!["trashed = false".to_owned()];
    let query = text(args.get("query"));
    if !query.is_empty() {
        terms.push(format!("name contains '{}'", quote_query(&query)));
    }
    let pairs = [("q", terms.join(" and ")), ("fields", format!("files({FILE_FIELDS})")), ("orderBy", "modifiedTime desc".to_owned()), ("pageSize", page_size(args.get("pageSize")))];
    let list = calls.json(&format!("{DRIVE}?{}", form(&pairs)), Call::get()).await?;
    let files = list.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(if files.is_empty() { "No files.".to_owned() } else { files.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") })
}

async fn read_file(args: &Value, calls: &Calls<'_>) -> Result<String, Failure> {
    let id = encode_uri_component(&require_text(args, "fileId")?);
    let meta = calls.json(&format!("{DRIVE}/{id}?fields={FILE_FIELDS}"), Call::get()).await?;
    let mime = meta.get("mimeType").and_then(Value::as_str).unwrap_or_default();
    let url = if let Some(kind) = export_as(mime) {
        format!("{DRIVE}/{id}/export?mimeType={}", encode_uri_component(kind))
    } else if is_text_like(mime) {
        format!("{DRIVE}/{id}?alt=media")
    } else {
        return Ok(format!("{meta}\n(Not a text file; open it at the link.)"));
    };
    let body = calls.send(&url, Call::get()).await?.body;
    let clipped = if utf16_len(&body) > READ_CAP { format!("{}\n[truncated]", slice_utf16(&body, READ_CAP)) } else { body };
    Ok(format!("{meta}\n\n{clipped}"))
}

/// `Date.now().toString(36)`.
fn base36(mut number: i64) -> String {
    if number == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while number > 0 {
        digits.push(char::from_digit((number % 36) as u32, 36).unwrap_or('0'));
        number /= 36;
    }
    digits.iter().rev().collect()
}

async fn create_file(args: &Value, calls: &Calls<'_>) -> Result<String, Failure> {
    let mut metadata = Map::from_iter([("name".to_owned(), json!(require_text(args, "name")?))]);
    if args.get("asGoogleDoc") == Some(&Value::Bool(true)) {
        metadata.insert("mimeType".to_owned(), json!("application/vnd.google-apps.document"));
    }
    let folder = text(args.get("folderId"));
    if !folder.is_empty() {
        metadata.insert("parents".to_owned(), json!([folder]));
    }
    let boundary = format!("mixdog-{}", base36(calls.now_ms));
    let kind = Some(text(args.get("mimeType"))).filter(|k| !k.is_empty()).unwrap_or_else(|| "text/plain".to_owned());
    let content = args.get("content").map(|c| if c.is_null() { String::new() } else { mixdog_js::value_to_string(c) }).unwrap_or_default();
    let body = [
        format!("--{boundary}"),
        "Content-Type: application/json; charset=UTF-8".to_owned(),
        String::new(),
        Value::Object(metadata).to_string(),
        format!("--{boundary}"),
        format!("Content-Type: {kind}; charset=UTF-8"),
        String::new(),
        content,
        format!("--{boundary}--"),
        String::new(),
    ]
    .join("\r\n");
    let call = Call { method: "POST", body: Some(body), content_type: Some(format!("multipart/related; boundary={boundary}")) };
    let file = calls.json(&format!("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields={FILE_FIELDS}"), call).await?;
    Ok(file.to_string())
}

// ── The MCP server ───────────────────────────────────────────────────────────

fn bearer_of(authorization: Option<&str>) -> Option<&str> {
    let rest = authorization?;
    let (scheme, token) = rest.split_once(|c: char| c.is_whitespace())?;
    let token = token.trim_start();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() && !token.contains(char::is_whitespace)).then_some(token)
}

/// Whether Google still accepts the token (an expired or revoked one is not), and the account it was issued for.
async fn token_info(calls: &Calls<'_>) -> Result<String, Failure> {
    let url = format!("https://oauth2.googleapis.com/tokeninfo?access_token={}", encode_uri_component(calls.token));
    let reply = calls.fetch.fetch(GoogleRequest { method: "GET", url, authorization: None, content_type: None, body: None }).await.map_err(Failure::Fetch)?;
    if !(200..300).contains(&reply.status) {
        return Err(Failure::Unauthorized);
    }
    Ok(serde_json::from_str::<Value>(&reply.body).ok().map(|info| text(info.get("email"))).unwrap_or_default())
}

async fn rpc(service: &str, calls: &Calls<'_>, message: &Value) -> Result<Value, Failure> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let reply = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let fail = |code: i64, message: String| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } });
    let method = message.get("method").map(mixdog_js::value_to_string).unwrap_or_else(|| "undefined".to_owned());
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    match method.as_str() {
        "initialize" => {
            let email = token_info(calls).await?;
            let version = Some(text(params.get("protocolVersion"))).filter(|v| !v.is_empty()).unwrap_or_else(|| PROTOCOL_VERSION.to_owned());
            let mut result = Map::new();
            result.insert("protocolVersion".to_owned(), json!(version));
            result.insert("capabilities".to_owned(), json!({ "tools": { "listChanged": false } }));
            result.insert("serverInfo".to_owned(), json!({ "name": format!("mixdog-{service}"), "version": "1.0.0" }));
            // The one account this sign-in is (the connector's accounts server reads it back).
            if !email.is_empty() {
                result.insert("instructions".to_owned(), json!(format!("Accounts: {email}. `account` may be left out.")));
            }
            Ok(reply(Value::Object(result)))
        }
        "ping" => Ok(reply(json!({}))),
        "tools/list" => Ok(reply(json!({ "tools": tool_defs(service) }))),
        "tools/call" => {
            let name = params.get("name").map(mixdog_js::value_to_string).unwrap_or_else(|| "undefined".to_owned());
            let args = params.get("arguments").filter(|a| truthy(a)).cloned().unwrap_or_else(|| json!({}));
            let known = tool_defs(service).as_array().is_some_and(|tools| tools.iter().any(|tool| tool["name"] == name.as_str()));
            if !known {
                return Ok(fail(-32602, format!("Unknown tool: {name}")));
            }
            match run_tool(service, &name, &args, calls).await {
                Some(Ok(output)) => Ok(reply(json!({ "content": [{ "type": "text", "text": output }] }))),
                Some(Err(Failure::Tool(message))) => Ok(reply(json!({ "content": [{ "type": "text", "text": message }], "isError": true }))),
                Some(Err(other)) => Err(other),
                None => Ok(fail(-32602, format!("Unknown tool: {name}"))),
            }
        }
        other => Ok(fail(-32601, format!("Method not found: {other}"))),
    }
}

/// The protected-resource metadata the reserved address serves (`/.well-known/oauth-protected-resource…`): it names Google as the
/// authorization server. `None` for any other URL.
pub fn protected_resource(url: &Url) -> Option<Value> {
    let service = service(url)?;
    url.path().starts_with("/.well-known/oauth-protected-resource").then(|| json!({ "resource": mcp_url(service), "authorization_servers": [GOOGLE_ISSUER], "bearer_methods_supported": ["header"] }))
}

/// Answers a request to a built-in Google service like a remote MCP server. `Err` when the network failed.
pub async fn answer(url: &Url, method: &str, authorization: Option<&str>, body: &[u8], fetch: &dyn GoogleFetch, now_ms: i64) -> Result<Answer, String> {
    let Some(service) = service(url) else { return Ok(Answer::json(404, json!({ "error": "not_found" }))) };
    let host = url.host_str().unwrap_or_default();
    if let Some(metadata) = protected_resource(url) {
        return Ok(Answer::json(200, metadata));
    }
    if url.path() != "/mcp" {
        return Ok(Answer::json(404, json!({ "error": "not_found" })));
    }
    if !method.eq_ignore_ascii_case("POST") {
        return Ok(Answer { status: 405, allow: Some("POST"), www_authenticate: None, body: None });
    }
    let unauthorized = || Answer { www_authenticate: Some(format!("Bearer resource_metadata=\"https://{host}/.well-known/oauth-protected-resource/mcp\"")), ..Answer::json(401, json!({ "error": "invalid_token" })) };
    let Some(token) = bearer_of(authorization) else { return Ok(unauthorized()) };
    let Ok(message) = serde_json::from_slice::<Value>(body) else {
        return Ok(Answer::json(400, json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })));
    };
    let calls = Calls { token, fetch, now_ms };
    let batch: Vec<&Value> = match &message {
        Value::Array(list) => list.iter().collect(),
        one => vec![one],
    };
    let mut replies = Vec::new();
    for one in batch {
        // A notification (no `id`) is answered with nothing.
        if one.get("id").is_none() {
            continue;
        }
        match rpc(service, &calls, one).await {
            Ok(reply) => replies.push(reply),
            Err(Failure::Unauthorized) => return Ok(unauthorized()),
            Err(Failure::Fetch(error)) => return Err(error),
            Err(Failure::Tool(message)) => return Err(message),
        }
    }
    if replies.is_empty() {
        return Ok(Answer { status: 202, allow: None, www_authenticate: None, body: None });
    }
    Ok(Answer::json(200, if message.is_array() { Value::Array(replies) } else { replies.swap_remove(0) }))
}
