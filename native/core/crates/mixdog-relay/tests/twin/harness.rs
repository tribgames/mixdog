//! Runs one scenario against one relay runtime and records every event: the steps' answers, the frames received, the
//! lines the relay printed, the calls its fakes recorded, and the files it left in DATA_DIR. Nothing is judged here
//! except the explicit expectations of a step (`expect_status`, `close_code`): the comparison is the normaliser's.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use mixdog_fsio::Unlaned;
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::normalise::{Masks, Transcript};
use crate::proc::{Lines, Relay, Runtime};
use crate::scenario::{
    Capture, CaptureFrom, Content, DataOp, ExpectStep, FrameSpec, HttpStep, Scenario, SendStep, Step, WsOpenStep,
};
use crate::transcript::{
    Answer, Conn, HANDSHAKE_KEY, Head, Response, WsEvent, WsPeer, body_value, close_payload, encode_frame,
    headers_value, read_answer, read_body, read_head, tls,
};

/// What a `crossover` step does: start the other runtime on the data left by the first, or restart the same one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Crossover {
    Switch,
    Stay,
}

/// Placed files carry this modification time, so Last-Modified is the same on both sides.
const PLACED_MTIME_SECS: u64 = 1_700_000_000;
const DRAIN: Duration = Duration::from_millis(150);
const MAX_OVERSIZE_SEND: u64 = 64 << 20;
const MAX_SNAPSHOT_TEXT: usize = 256 << 10;

struct Run<'a> {
    // Fields drop in this order: the relay is killed before its scratch directory is removed.
    relay: Option<Relay>,
    ws: BTreeMap<String, WsPeer>,
    root: tempfile::TempDir,
    scenario: &'a Scenario,
    mode: Crossover,
    runtime: Runtime,
    knobs: Value,
    vars: BTreeMap<String, String>,
    events: Vec<Value>,
    masks: Masks,
    step: usize,
}

/// Runs the scenario with its relay started as `start`.
pub fn run(scenario: &Scenario, start: Runtime, mode: Crossover) -> Result<Transcript, String> {
    let t0_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as i64;
    let root = tempfile::tempdir().map_err(|e| format!("scratch directory: {e}"))?;
    let mut run = Run {
        scenario,
        mode,
        runtime: start,
        root,
        knobs: Value::Null,
        relay: None,
        ws: BTreeMap::new(),
        vars: BTreeMap::new(),
        events: Vec::new(),
        masks: Masks { t0_ms, ..Masks::default() },
        step: 0,
    };
    run.execute().map_err(|e| format!("scenario {} on {}: {e}", scenario.id, run.runtime.name()))?;
    Ok(Transcript { events: run.events, masks: run.masks })
}

fn has_header(headers: &[(String, String)], name: &str) -> bool {
    headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(name))
}

fn walk_path<'v>(value: &'v Value, path: &str) -> Option<&'v Value> {
    path.split('.').filter(|part| !part.is_empty()).try_fold(value, |current, part| match part.parse::<usize>() {
        Ok(index) if current.is_array() => current.get(index),
        _ => current.get(part),
    })
}

fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(_) | Value::Bool(_) => Some(value.to_string()),
        _ => None,
    }
}

fn request_path(request: &[u8]) -> String {
    let line = request.split(|&b| b == b'\r').next().unwrap_or(&[]);
    String::from_utf8_lossy(line).split(' ').nth(1).unwrap_or("").to_owned()
}

fn digest_hex(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    format!("{:x}", hasher.finalize())
}

fn frame_kind(spec: &FrameSpec) -> &'static str {
    match spec {
        FrameSpec::Text { .. } => "text",
        FrameSpec::Binary { .. } => "binary",
        FrameSpec::Ping { .. } => "ping",
        FrameSpec::Pong { .. } => "pong",
        FrameSpec::Close { .. } => "close",
        FrameSpec::Raw { .. } => "raw",
        FrameSpec::Oversize { .. } => "oversize",
        FrameSpec::Fragmented { .. } => "fragmented",
        FrameSpec::Coalesced { .. } => "coalesced",
    }
}

fn step_kind(step: &Step) -> &'static str {
    match step {
        Step::Http(_) => "http",
        Step::WsOpen(_) => "ws_open",
        Step::Send(_) => "send",
        Step::Expect(_) => "expect",
        Step::Wait { .. } => "wait",
        Step::Restart => "restart",
        Step::Crossover => "crossover",
    }
}

fn file_value(bytes: &[u8]) -> Value {
    match std::str::from_utf8(bytes) {
        Ok(text) if bytes.len() <= MAX_SNAPSHOT_TEXT => json!({ "text": text }),
        _ => json!({ "size": bytes.len(), "sha256": digest_hex(&[bytes]) }),
    }
}

fn snapshot_tree(dir: &Path, prefix: &str, out: &mut Map<String, Value>) -> Result<(), String> {
    let mut entries = Vec::new();
    for entry in mixdog_fsio::read_dir(&Unlaned, dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        entries.push(entry.map_err(|e| e.to_string())?);
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let kind = entry.file_type(&Unlaned).map_err(|e| e.to_string())?;
        if kind.is_dir() {
            snapshot_tree(&entry.path(), &relative, out)?;
        } else if kind.is_file() {
            let bytes = mixdog_fsio::read(&Unlaned, entry.path()).map_err(|e| format!("{relative}: {e}"))?;
            out.insert(relative, file_value(&bytes));
        }
    }
    Ok(())
}

impl Run<'_> {
    fn push(&mut self, mut event: Value) {
        event["step"] = json!(self.step);
        self.events.push(event);
    }

    fn execute(&mut self) -> Result<(), String> {
        self.place_files()?;
        self.start_relay()?;
        let scenario = self.scenario;
        for (index, step) in scenario.steps.iter().enumerate() {
            self.step = index;
            let done = match step {
                Step::Http(step) => self.http_step(step),
                Step::WsOpen(step) => self.ws_open_step(step),
                Step::Send(step) => self.send_step(step),
                Step::Expect(step) => self.expect_step(step),
                Step::Wait { ms } => {
                    mixdog_fsio::sleep(&Unlaned, Duration::from_millis(*ms));
                    Ok(())
                }
                Step::Restart => self.cycle(false),
                Step::Crossover => self.cycle(true),
            };
            done.map_err(|e| format!("step {index} ({}): {e}", step_kind(step)))?;
        }
        self.step = scenario.steps.len();
        self.finish_segment()
    }

    // ---- files and the relay process ----

    fn write_tree(&mut self, base: &Path, files: &BTreeMap<String, Content>) -> Result<(), String> {
        for (relative, content) in files {
            if relative.is_empty() || relative.starts_with('/') || relative.split(['/', '\\']).any(|part| part == "..")
            {
                return Err(format!("file path {relative:?} leaves its directory"));
            }
            let bytes = content.literal_bytes()?;
            let path = base.join(relative);
            if let Some(parent) = path.parent() {
                mixdog_fsio::create_dir_all(&Unlaned, parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            mixdog_fsio::write(&Unlaned, &path, &bytes).map_err(|e| format!("{}: {e}", path.display()))?;
            mixdog_fsio::File::options()
                .write(true)
                .open(&Unlaned, &path)
                .and_then(|file| file.set_modified(&Unlaned, UNIX_EPOCH + Duration::from_secs(PLACED_MTIME_SECS)))
                .map_err(|e| format!("{}: {e}", path.display()))?;
            for prefix in ["", "identity", "gzip", "br", "deflate"] {
                self.masks.known_digests.insert(digest_hex(&[prefix.as_bytes(), &bytes]));
            }
        }
        Ok(())
    }

    /// Places the scenario's files under the scratch directory and writes the knobs both hosts are started with.
    fn place_files(&mut self) -> Result<(), String> {
        let scenario = self.scenario;
        let root = self.root.path().to_path_buf();
        let text = root.to_string_lossy().into_owned();
        self.masks.roots = vec![text.clone(), text.replace('\\', "/")];
        self.masks.roots.dedup();
        let (data, renderer, releases) = (root.join("data"), root.join("renderer"), root.join("releases"));
        mixdog_fsio::create_dir_all(&Unlaned, &data).map_err(|e| e.to_string())?;
        self.write_tree(&data, &scenario.files.data)?;
        self.write_tree(&renderer, &scenario.files.renderer)?;
        self.write_tree(&releases, &scenario.files.releases)?;
        let path_text = |path: &Path| Value::String(path.to_string_lossy().into_owned());
        let mut knobs = scenario.knobs.clone();
        knobs.insert("dataDir".to_owned(), path_text(&data));
        if !scenario.files.renderer.is_empty() {
            knobs.insert("rendererDir".to_owned(), path_text(&renderer));
        }
        if !scenario.files.releases.is_empty() {
            knobs.insert("rendererReleasesDir".to_owned(), path_text(&releases));
        }
        if scenario.files.tls {
            let (cert, key) = (root.join("tls-cert.pem"), root.join("tls-key.pem"));
            mixdog_fsio::write(&Unlaned, &cert, &tls().cert_pem).map_err(|e| e.to_string())?;
            mixdog_fsio::write(&Unlaned, &key, &tls().key_pem).map_err(|e| e.to_string())?;
            knobs.insert("tlsCert".to_owned(), path_text(&cert));
            knobs.insert("tlsKey".to_owned(), path_text(&key));
        }
        if let Some(release) = &scenario.files.mobile_release {
            knobs.insert("mobileRelease".to_owned(), release.clone());
        }
        if !scenario.fakes.is_null() {
            knobs.insert("fakes".to_owned(), scenario.fakes.clone());
        }
        self.knobs = Value::Object(knobs);
        Ok(())
    }

    fn start_relay(&mut self) -> Result<(), String> {
        let relay = Relay::start(self.runtime, &self.knobs)?;
        let host = format!("127.0.0.1:{}", relay.port);
        self.vars.insert("port".to_owned(), relay.port.to_string());
        self.vars.insert("origin".to_owned(), format!("{}://{host}", relay.scheme));
        self.vars.insert("scheme".to_owned(), relay.scheme.to_owned());
        self.vars.insert("host".to_owned(), host);
        self.masks.ports.push(relay.port);
        self.relay = Some(relay);
        Ok(())
    }

    fn connect(&self) -> Result<Conn, String> {
        let relay = self.relay.as_ref().ok_or("no relay is running")?;
        Conn::open(relay.port, relay.scheme == "https")
    }

    /// Reads what the open sockets still hold, stops the relay, and records its lines, its fakes and its data.
    fn finish_segment(&mut self) -> Result<(), String> {
        let names: Vec<String> = self.ws.keys().cloned().collect();
        for name in names {
            let mut unread = Vec::new();
            if let Some(peer) = self.ws.get_mut(&name) {
                let deadline = Instant::now() + DRAIN;
                while let Some(event) = peer.next(deadline)? {
                    // The relay's own liveness ping is on a ten second timer of its start: whether one lands before the
                    // last read of a scenario is a race of the Node relay itself, and it says nothing a scenario fixes.
                    if matches!(event, WsEvent::Ping(_)) {
                        continue;
                    }
                    unread.push(json!({ "ev": "unread", "conn": name, "event": event.to_value() }));
                }
            }
            for event in unread {
                self.push(event);
            }
        }
        self.ws.clear();
        let relay = self.relay.take().ok_or("no relay is running")?;
        let lines = relay.stop()?;
        self.record_lines(lines);
        let mut files = Map::new();
        let data = self.root.path().join("data");
        snapshot_tree(&data, "", &mut files)?;
        self.push(json!({ "ev": "data_dir", "files": Value::Object(files) }));
        Ok(())
    }

    fn record_lines(&mut self, lines: Lines) {
        for (n, call) in lines.fakes.into_iter().enumerate() {
            self.push(json!({ "ev": "fake", "n": n, "call": call }));
        }
        for (stream, list) in [("stdout", lines.out), ("stderr", lines.err)] {
            for (n, line) in list.into_iter().enumerate() {
                self.push(json!({ "ev": "log", "stream": stream, "n": n, "line": line }));
            }
        }
    }

    fn cycle(&mut self, crossover: bool) -> Result<(), String> {
        self.finish_segment()?;
        self.push(json!({ "ev": "restart" }));
        if crossover && self.mode == Crossover::Switch {
            self.runtime = self.runtime.other();
        }
        self.start_relay()
    }

    // ---- substitution and captures ----

    fn subst(&self, text: &str) -> Result<String, String> {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(at) = rest.find("${") {
            out.push_str(&rest[..at]);
            let after = &rest[at + 2..];
            let end = after.find('}').ok_or_else(|| format!("unterminated ${{ in {text:?}"))?;
            let name = &after[..end];
            out.push_str(self.vars.get(name).ok_or_else(|| format!("unknown variable ${{{name}}}"))?);
            rest = &after[end + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    fn headers(&self, headers: &[(String, String)]) -> Result<Vec<(String, String)>, String> {
        headers.iter().map(|(k, v)| Ok((self.subst(k)?, self.subst(v)?))).collect()
    }

    fn capture(
        &mut self,
        captures: &[Capture],
        head: Option<&Head>,
        body: &[u8],
        frames: &[Vec<u8>],
    ) -> Result<(), String> {
        for capture in captures {
            let text = match capture.from {
                CaptureFrom::BodyJson => {
                    let value: Value = serde_json::from_slice(body)
                        .map_err(|e| format!("capture {}: body is not JSON: {e}", capture.var))?;
                    let path = capture.path.as_deref().ok_or("capture: body_json needs a path")?;
                    walk_path(&value, path).and_then(scalar_text)
                }
                CaptureFrom::BodyRegex => {
                    let pattern = capture.regex.as_deref().ok_or("capture: body_regex needs a regex")?;
                    Self::group_one(pattern, &String::from_utf8_lossy(body))?
                }
                CaptureFrom::Header => {
                    let name = capture.name.as_deref().ok_or("capture: header needs a name")?;
                    let values: Vec<&str> = head
                        .map(|h| {
                            h.headers
                                .iter()
                                .filter(|(k, _)| k.eq_ignore_ascii_case(name))
                                .map(|(_, v)| v.as_str())
                                .collect()
                        })
                        .unwrap_or_default();
                    match capture.regex.as_deref() {
                        Some(pattern) => values.iter().find_map(|value| Self::group_one(pattern, value).ok().flatten()),
                        None => values.first().map(|v| (*v).to_owned()),
                    }
                }
                CaptureFrom::FrameJson => {
                    let index = capture.index.unwrap_or(frames.len().saturating_sub(1));
                    let frame =
                        frames.get(index).ok_or_else(|| format!("capture {}: no frame {index}", capture.var))?;
                    let value: Value = serde_json::from_slice(frame)
                        .map_err(|e| format!("capture {}: frame is not JSON: {e}", capture.var))?;
                    let path = capture.path.as_deref().ok_or("capture: frame_json needs a path")?;
                    walk_path(&value, path).and_then(scalar_text)
                }
            };
            let text = text.ok_or_else(|| format!("capture {} found nothing", capture.var))?;
            self.vars.insert(capture.var.clone(), text.clone());
            self.masks.captured.push((capture.var.clone(), text));
        }
        Ok(())
    }

    fn group_one(pattern: &str, text: &str) -> Result<Option<String>, String> {
        let regex = Regex::new(pattern).map_err(|e| format!("capture regex: {e}"))?;
        Ok(regex.captures(text).and_then(|c| c.get(1)).map(|m| m.as_str().to_owned()))
    }

    // ---- HTTP ----

    fn build_request(&self, step: &HttpStep) -> Result<Vec<u8>, String> {
        let path = self.subst(&step.path)?;
        let mut headers = self.headers(&step.headers)?;
        let body = step.body.as_ref().map(|b| b.bytes(&|t| self.subst(t))).transpose()?;
        if !has_header(&headers, "host") {
            headers.insert(0, ("Host".to_owned(), self.subst("${host}")?));
        }
        if !has_header(&headers, "connection") {
            headers.push(("Connection".to_owned(), "close".to_owned()));
        }
        if let Some(body) = &body {
            if !has_header(&headers, "content-length") && !has_header(&headers, "transfer-encoding") {
                headers.push(("Content-Length".to_owned(), body.len().to_string()));
            }
        }
        let mut request = format!("{} {path} HTTP/1.1\r\n", step.method).into_bytes();
        for (name, value) in &headers {
            request.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        request.extend_from_slice(b"\r\n");
        request.extend_from_slice(&body.unwrap_or_default());
        Ok(request)
    }

    /// Whether a staged `.gz` sibling of the file the path names was placed (then the relay serves it unchanged).
    fn staged_gzip(&self, path: &str) -> bool {
        let trimmed = path.split(['?', '#']).next().unwrap_or("").trim_start_matches('/');
        let relative = if trimmed.is_empty() { "index.html" } else { trimmed };
        let sibling = format!("{relative}.gz");
        let files = &self.scenario.files;
        files.renderer.contains_key(&sibling)
            || files.releases.keys().any(|key| key == &sibling || key.ends_with(&format!("/{sibling}")))
    }

    /// The body as it is compared: a body the relay gzips live is decoded (the zlib streams of the two relays differ
    /// while the decoded bytes, headers and ETag do not); a staged sibling is compared byte for byte.
    fn visible_body(&mut self, path: &str, response: &Response) -> (Vec<u8>, Option<&'static str>) {
        let gzip = response.head.header("content-encoding").is_some_and(|v| v.trim().eq_ignore_ascii_case("gzip"));
        let (body, decoded) = if gzip && !self.staged_gzip(path) {
            let mut out = Vec::new();
            match flate2::read::GzDecoder::new(&response.body[..]).read_to_end(&mut out) {
                Ok(_) => (out, Some("gzip")),
                Err(_) => (response.body.clone(), Some("gzip-invalid")),
            }
        } else {
            (response.body.clone(), None)
        };
        let encoding = response.head.header("content-encoding").unwrap_or("").trim().to_ascii_lowercase();
        for prefix in ["", "identity", encoding.as_str()] {
            self.masks.known_digests.insert(digest_hex(&[prefix.as_bytes(), &body]));
        }
        (body, decoded)
    }

    fn response_event(
        &mut self,
        ev: &str,
        label: Option<&str>,
        path: &str,
        response: &Response,
        tcp: &str,
        trailing: &[u8],
    ) -> (Value, Vec<u8>) {
        let (body, decoded) = self.visible_body(path, response);
        let mut event = json!({
            "ev": ev,
            "status": response.head.status_line,
            "headers": headers_value(&response.head.headers),
            "body": body_value(&body),
            "tcp": tcp,
        });
        if let Some(label) = label {
            event["label"] = json!(label);
        }
        if let Some(decoded) = decoded {
            event["decoded"] = json!(decoded);
        }
        if !response.trailers.is_empty() {
            event["trailers"] = headers_value(&response.trailers);
        }
        if response.truncated {
            event["truncated"] = json!(true);
        }
        if !trailing.is_empty() {
            event["trailing"] = body_value(trailing);
        }
        (event, body)
    }

    fn check_status(expected: Option<u16>, seen: Option<u16>) -> Result<(), String> {
        match (expected, seen) {
            (Some(want), Some(got)) if want == got => Ok(()),
            (Some(want), Some(got)) => Err(format!("expected status {want}, the relay answered {got}")),
            (Some(want), None) => Err(format!("expected status {want}, the relay closed without an answer")),
            (None, _) => Ok(()),
        }
    }

    fn http_step(&mut self, step: &HttpStep) -> Result<(), String> {
        let request = match &step.raw {
            Some(raw) => raw.bytes(&|t| self.subst(t))?,
            None => self.build_request(step)?,
        };
        let path = request_path(&request);
        let head_request = request.starts_with(b"HEAD ");
        let mut conn = self.connect()?;
        conn.write(request);
        let deadline = Instant::now() + Duration::from_millis(step.timeout_ms);
        // While the answer is awaited the open WebSocket legs keep answering the relay's pings.
        while !conn.closed && conn.buf.is_empty() && Instant::now() < deadline {
            conn.pull((Instant::now() + Duration::from_millis(500)).min(deadline));
            for peer in self.ws.values_mut() {
                peer.keepalive();
            }
        }
        match read_answer(&mut conn, head_request, deadline)? {
            Answer::NoAnswer(seen) => {
                Self::check_status(step.expect_status, None)?;
                self.push(
                    json!({ "ev": "http_no_answer", "label": step.label, "seen": body_value(&seen), "tcp": "closed" }),
                );
            }
            Answer::Response(response) => {
                Self::check_status(step.expect_status, Some(response.head.status))?;
                let closed = conn.closes_within(Duration::from_millis(step.close_probe_ms));
                let trailing = std::mem::take(&mut conn.buf);
                let tcp = if closed { "closed" } else { "open" };
                let (event, body) =
                    self.response_event("http", step.label.as_deref(), &path, &response, tcp, &trailing);
                self.push(event);
                self.capture(&step.capture, Some(&response.head), &body, &[])?;
            }
        }
        Ok(())
    }

    // ---- WebSocket ----

    fn ws_open_step(&mut self, step: &WsOpenStep) -> Result<(), String> {
        if self.ws.contains_key(&step.conn) {
            return Err(format!("connection {} is already open", step.conn));
        }
        let path = self.subst(&step.path)?;
        let mut headers = self.headers(&step.headers)?;
        if let Some((user, password)) = &step.basic {
            let pair = format!("{}:{}", self.subst(user)?, self.subst(password)?);
            let encoded = base64::engine::general_purpose::STANDARD.encode(pair);
            headers.push(("Authorization".to_owned(), format!("Basic {encoded}")));
        }
        let mut request = format!("GET {path} HTTP/1.1\r\n");
        for (name, value) in [
            ("Host", self.subst("${host}")?),
            ("Upgrade", "websocket".to_owned()),
            ("Connection", "Upgrade".to_owned()),
            ("Sec-WebSocket-Key", HANDSHAKE_KEY.to_owned()),
            ("Sec-WebSocket-Version", "13".to_owned()),
        ] {
            if !has_header(&headers, name) {
                request.push_str(&format!("{name}: {value}\r\n"));
            }
        }
        for (name, value) in &headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        let mut conn = self.connect()?;
        conn.write(request.into_bytes());
        let deadline = Instant::now() + Duration::from_millis(step.timeout_ms);
        let role = step.role.name();
        match read_head(&mut conn, deadline)? {
            Err(seen) => {
                Self::check_status(step.expect_status, None)?;
                self.push(json!({ "ev": "ws_no_answer", "conn": step.conn, "role": role, "seen": body_value(&seen), "tcp": "closed" }));
            }
            Ok(head) if head.status == 101 => {
                Self::check_status(step.expect_status, Some(101))?;
                let event = json!({
                    "ev": "ws_open",
                    "conn": step.conn,
                    "role": role,
                    "status": head.status_line,
                    "headers": headers_value(&head.headers),
                });
                // Frames that came in the same read as the head stay in the connection and are read as frames by the
                // peer: whether the relay's first frame shares a segment with its head is a matter of the transport.
                self.push(event);
                self.capture(&step.capture, Some(&head), &[], &[])?;
                self.ws.insert(step.conn.clone(), WsPeer::new(conn));
            }
            Ok(head) => {
                let response = read_body(&mut conn, head, false, deadline)?;
                Self::check_status(step.expect_status, Some(response.head.status))?;
                let closed = conn.closes_within(Duration::from_millis(step.close_probe_ms));
                let trailing = std::mem::take(&mut conn.buf);
                let tcp = if closed { "closed" } else { "open" };
                let (mut event, body) = self.response_event("ws_refused", None, &path, &response, tcp, &trailing);
                event["conn"] = json!(step.conn);
                event["role"] = json!(role);
                self.push(event);
                self.capture(&step.capture, Some(&response.head), &body, &[])?;
            }
        }
        Ok(())
    }

    fn frame_bytes(&self, spec: &FrameSpec) -> Result<Vec<u8>, String> {
        let subst = |text: &str| self.subst(text);
        let optional = |data: &Option<Content>| -> Result<Vec<u8>, String> {
            data.as_ref().map_or(Ok(Vec::new()), |content| content.bytes(&subst))
        };
        let opcode = |op: DataOp| if op == DataOp::Text { 1 } else { 2 };
        match spec {
            FrameSpec::Text { text } => Ok(encode_frame(true, 1, self.subst(text)?.as_bytes(), None)),
            FrameSpec::Binary { data } => Ok(encode_frame(true, 2, &data.bytes(&subst)?, None)),
            FrameSpec::Ping { data } => Ok(encode_frame(true, 9, &optional(data)?, None)),
            FrameSpec::Pong { data } => Ok(encode_frame(true, 10, &optional(data)?, None)),
            FrameSpec::Close { code, reason } => {
                let reason = reason.as_deref().map(subst).transpose()?.unwrap_or_default();
                Ok(encode_frame(true, 8, &close_payload(*code, &reason), None))
            }
            FrameSpec::Raw { data } => data.bytes(&subst),
            FrameSpec::Oversize { op, declared, send } => {
                if *send > MAX_OVERSIZE_SEND {
                    return Err(format!("an oversize frame may send at most {MAX_OVERSIZE_SEND} bytes"));
                }
                Ok(encode_frame(true, opcode(*op), &vec![b'a'; *send as usize], Some(*declared)))
            }
            FrameSpec::Fragmented { op, parts } => {
                let mut bytes = Vec::new();
                for (index, part) in parts.iter().enumerate() {
                    let first = if index == 0 { opcode(*op) } else { 0 };
                    bytes.extend(encode_frame(index + 1 == parts.len(), first, &part.bytes(&subst)?, None));
                }
                Ok(bytes)
            }
            FrameSpec::Coalesced { frames } => {
                let mut bytes = Vec::new();
                for frame in frames {
                    bytes.extend(self.frame_bytes(frame)?);
                }
                Ok(bytes)
            }
        }
    }

    fn send_step(&mut self, step: &SendStep) -> Result<(), String> {
        let bytes = self.frame_bytes(&step.frame)?;
        let length = bytes.len();
        let peer = self.ws.get(&step.conn).ok_or_else(|| format!("connection {} is not open", step.conn))?;
        peer.write(bytes);
        self.push(json!({ "ev": "send", "conn": step.conn, "kind": frame_kind(&step.frame), "bytes": length }));
        Ok(())
    }

    fn expect_step(&mut self, step: &ExpectStep) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_millis(step.timeout_ms);
        let (mut messages, mut closed, mut first_close) = (0usize, false, None);
        let mut recorded = Vec::new();
        let mut payloads = Vec::new();
        while messages < step.frames || (step.close && !closed) {
            let peer = self.ws.get_mut(&step.conn).ok_or_else(|| format!("connection {} is not open", step.conn))?;
            let Some(event) = peer.next(deadline)? else {
                return Err(format!(
                    "timed out after {} ms: {messages} of {} messages, closed {closed}; seen {}",
                    step.timeout_ms,
                    step.frames,
                    Value::Array(recorded).to_string().chars().take(600).collect::<String>()
                ));
            };
            match &event {
                WsEvent::Message { data, .. } => {
                    messages += 1;
                    payloads.push(data.clone());
                }
                WsEvent::Close { code, .. } if first_close.is_none() => first_close = Some(*code),
                WsEvent::TcpClosed => closed = true,
                _ => {}
            }
            recorded.push(json!({ "ev": "recv", "conn": step.conn, "event": event.to_value() }));
        }
        for event in recorded {
            self.push(event);
        }
        if let Some(want) = step.close_code {
            match first_close {
                Some(Some(got)) if got == want => {}
                other => return Err(format!("expected close code {want}, got {other:?}")),
            }
        }
        self.capture(&step.capture, None, &[], &payloads)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_paths_walk_objects_and_arrays() {
        let value = json!({"a": {"b": [10, {"c": "x"}]}});
        assert_eq!(walk_path(&value, "a.b.0").and_then(scalar_text).as_deref(), Some("10"));
        assert_eq!(walk_path(&value, "a.b.1.c").and_then(scalar_text).as_deref(), Some("x"));
        assert!(walk_path(&value, "a.z").is_none());
        assert!(walk_path(&value, "a").and_then(scalar_text).is_none());
    }

    #[test]
    fn the_request_path_is_the_second_word_of_the_first_line() {
        assert_eq!(request_path(b"GET /x?y=1 HTTP/1.1\r\nHost: h\r\n\r\n"), "/x?y=1");
        assert_eq!(request_path(b"junk"), "");
    }

    #[test]
    fn digests_cover_their_parts_in_order() {
        assert_eq!(digest_hex(&[b"ab", b"c"]), digest_hex(&[b"abc"]));
        assert_eq!(digest_hex(&[b""]), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
