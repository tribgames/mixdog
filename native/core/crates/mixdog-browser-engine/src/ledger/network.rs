//! Owner: s4-engine-ledgers
//! The network ledger of one page (`network.ts`): every request the page made, in order, capped at 250 (the oldest finished one
//! goes first), with the reasons the host's request policy refused URLs, so a refusal reads as the policy's and not as a fault of
//! the page. Events are applied by [`super::ingest`]; `now` is the host's event time in epoch milliseconds.

use std::collections::VecDeque;

use serde_json::Value;

use super::console_format::js_finite_number;
use super::console_format::js_number_string;
use super::console_format::js_string;
use super::console_format::js_string_or;
use super::console_format::truthy;
use super::console_format::utf16_len;
use super::console_format::utf16_prefix;

/// This guest runs no extensions, so the only client that refuses a request is the partition's own request policy (private or
/// internal addresses, DNS answers that point there, the domain allowlist). Chromium names that refusal with a bare code that
/// reads like a fault of the page.
const POLICY_BLOCK: &str = "net::ERR_BLOCKED_BY_CLIENT";
const POLICY_BLOCK_NOTE: &str = "net::ERR_BLOCKED_BY_CLIENT (Browser Use network policy";

const LEDGER_URL_CHARS: usize = 16_384;
const LEDGER_BODY_CHARS: usize = 64_000;
const LEDGER_HEADER_COUNT: usize = 128;
const LEDGER_HEADER_NAME_CHARS: usize = 256;
const LEDGER_HEADER_VALUE_CHARS: usize = 8_192;
const LEDGER_WEBSOCKET_FRAMES: usize = 100;
const LEDGER_WEBSOCKET_FRAME_CHARS: usize = 16_000;
const LEDGER_WEBSOCKET_TOTAL_CHARS: usize = 256_000;
const DEFAULT_MAX_REQUESTS: usize = 250;
/// Refusal reasons kept (one per URL, the oldest dropped first) and the characters of one.
const MAX_REFUSED_URLS: usize = 50;
const MAX_REFUSAL_REASON_CHARS: usize = 300;

/// The failure text with the refusal named, and the rule's reason when the partition recorded one for this URL.
pub fn explain_network_failure(text: &str, reason: &str) -> String {
    let note = if reason.is_empty() { format!("{POLICY_BLOCK_NOTE})") } else { format!("{POLICY_BLOCK_NOTE}: {reason})") };
    text.replace(POLICY_BLOCK, &note)
}

/// At most `limit` of these report lines, in their original order, choosing the newest faults of the page before the host's own
/// refusals: a tracker the policy blocked on every load must not crowd out the error that matters.
pub fn page_faults_first(lines: &[String], limit: usize) -> Vec<String> {
    let mut picked = vec![false; lines.len()];
    let mut count = 0;
    for refused in [false, true] {
        for index in (0..lines.len()).rev() {
            if count >= limit {
                break;
            }
            if !picked[index] && lines[index].contains(POLICY_BLOCK_NOTE) == refused {
                picked[index] = true;
                count += 1;
            }
        }
    }
    lines.iter().zip(picked).filter_map(|(line, keep)| keep.then(|| line.clone())).collect()
}

/// A text cut to at most `max_chars` UTF-16 code units (`retainedNetworkText`: the ledger owns the bounded prefix, never the whole
/// payload it came from).
pub fn retained_network_text(text: &str, max_chars: usize) -> String {
    utf16_prefix(text, max_chars).to_owned()
}

/// Header names and values in the order the browser listed them.
pub type Headers = Vec<(String, String)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameDirection {
    Sent,
    Received,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebSocketFrame {
    pub direction: FrameDirection,
    pub opcode: i64,
    pub data: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NetworkRequest {
    /// `r1`, `r2`, ...: rising for the life of the ledger.
    pub id: String,
    pub cdp_request_id: String,
    /// The child target the request belongs to; `None` for the page's own.
    pub session_id: Option<String>,
    pub method: String,
    pub url: String,
    pub resource_type: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub request_headers: Headers,
    pub request_body: Option<String>,
    pub has_post_data: bool,
    pub status: Option<f64>,
    pub status_text: Option<String>,
    pub response_headers: Headers,
    pub mime_type: Option<String>,
    pub protocol: Option<String>,
    pub remote_address: Option<String>,
    pub encoded_data_length: Option<f64>,
    pub from_disk_cache: bool,
    pub from_service_worker: bool,
    pub failure: Option<String>,
    pub canceled: bool,
    pub redirected_to: Option<String>,
    pub web_socket_frames: Vec<WebSocketFrame>,
}

/// The HTTP answer behind a document (`documentStatus`).
#[derive(Debug, Clone, PartialEq)]
pub struct DocumentStatus {
    pub status: f64,
    pub status_text: Option<String>,
    pub mime_type: Option<String>,
}

/// What `list` was asked for.
#[derive(Debug, Clone, Default)]
pub struct NetworkQuery {
    pub query: String,
    pub resource_types: Vec<String>,
    pub limit: Option<i64>,
}

fn headers_of(value: Option<&Value>) -> Headers {
    let Some(Value::Object(map)) = value else { return Vec::new() };
    map.iter()
        .take(LEDGER_HEADER_COUNT)
        .map(|(name, entry)| (retained_network_text(name, LEDGER_HEADER_NAME_CHARS), retained_network_text(&js_string(entry), LEDGER_HEADER_VALUE_CHARS)))
        .collect()
}

/// Header names are case-insensitive, and the two CDP events spell them differently: the provisional set says "User-Agent", the
/// sent set says "user-agent". A raw merge would list one header twice and read as if the request carried it twice, so the sent
/// spelling and value take its place.
fn merge_sent_headers(provisional: &Headers, sent: Headers) -> Headers {
    let mut merged: Headers = Vec::new();
    for (name, value) in provisional.iter().cloned().chain(sent) {
        let lower = name.to_lowercase();
        match merged.iter().position(|(existing, _)| existing.to_lowercase() == lower) {
            Some(position) => merged[position] = (name, value),
            None => merged.push((name, value)),
        }
    }
    merged.truncate(LEDGER_HEADER_COUNT);
    merged
}

/// A document address as the ledger compares it: the fragment never reaches the server, so it names the same request.
fn without_fragment(url: &str) -> &str {
    url.split('#').next().unwrap_or_default()
}

fn scoped_request_id(session_id: Option<&str>, request_id: &str) -> String {
    format!("{}:{request_id}", session_id.unwrap_or("top"))
}

fn request_id_of(params: &Value) -> String {
    js_string_or(params.get("requestId"), "")
}

fn object_nonempty(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(map)) if !map.is_empty())
}

#[derive(Debug)]
pub struct NetworkLedger {
    requests: Vec<NetworkRequest>,
    /// Scoped CDP request id to the ledger id of the request it names, in the order the requests began.
    inflight: Vec<(String, String)>,
    sequence: u64,
    max_requests: usize,
    refused: VecDeque<(String, String)>,
}

impl Default for NetworkLedger {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_REQUESTS)
    }
}

impl NetworkLedger {
    pub fn new(max_requests: usize) -> Self {
        Self { requests: Vec::new(), inflight: Vec::new(), sequence: 0, max_requests: if max_requests == 0 { DEFAULT_MAX_REQUESTS } else { max_requests }, refused: VecDeque::new() }
    }

    /// The request policy's reason for refusing a URL this page asked for (`Mixdog.requestRefused`).
    pub fn record_refused(&mut self, url: &str, reason: &str) {
        self.refused.retain(|(known, _)| known != url);
        self.refused.push_back((url.to_owned(), utf16_prefix(reason, MAX_REFUSAL_REASON_CHARS).to_owned()));
        if self.refused.len() > MAX_REFUSED_URLS {
            self.refused.pop_front();
        }
    }

    pub fn refused_reason(&self, url: &str) -> Option<&str> {
        self.refused.iter().find(|(known, _)| known == url).map(|(_, reason)| reason.as_str())
    }

    /// `text` with the policy's refusal named, and its reason when one was recorded for `url`.
    pub fn explain_failure(&self, text: &str, url: &str) -> String {
        explain_network_failure(text, self.refused_reason(url).unwrap_or_default())
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.requests.iter().position(|request| request.id == id)
    }

    fn inflight_index(&self, scoped: &str) -> Option<usize> {
        let id = &self.inflight.iter().find(|(key, _)| key == scoped)?.1;
        self.position(id)
    }

    fn inflight_for(&self, params: &Value, session_id: Option<&str>) -> Option<usize> {
        self.inflight_index(&scoped_request_id(session_id, &request_id_of(params)))
    }

    fn end_inflight(&mut self, scoped: &str) {
        self.inflight.retain(|(key, _)| key != scoped);
    }

    pub fn request_will_be_sent(&mut self, params: &Value, session_id: Option<&str>, now: i64) -> Option<&NetworkRequest> {
        let cdp_request_id = request_id_of(params);
        let request = params.get("request");
        let url_value = request.and_then(|request| request.get("url"));
        if cdp_request_id.is_empty() || !truthy(url_value) {
            return None;
        }
        let request_url = retained_network_text(&js_string_or(url_value, ""), LEDGER_URL_CHARS);
        let scoped = scoped_request_id(session_id, &cdp_request_id);
        let redirect = params.get("redirectResponse");
        if object_nonempty(redirect)
            && let Some(previous) = self.inflight_index(&scoped)
        {
            if let Some(redirect) = redirect {
                apply_response(&mut self.requests[previous], redirect);
            }
            self.requests[previous].finished_at = Some(now);
            self.requests[previous].redirected_to = Some(request_url.clone());
            self.end_inflight(&scoped);
        }
        self.sequence += 1;
        let post_data = request.and_then(|request| request.get("postData")).and_then(Value::as_str);
        let entry = NetworkRequest {
            id: format!("r{}", self.sequence),
            cdp_request_id,
            session_id: session_id.map(str::to_owned),
            method: js_string_or(request.and_then(|request| request.get("method")), "GET"),
            url: request_url,
            resource_type: js_string_or(params.get("type"), "other").to_lowercase(),
            started_at: now,
            request_headers: headers_of(request.and_then(|request| request.get("headers"))),
            request_body: post_data.map(|data| retained_network_text(data, LEDGER_BODY_CHARS)),
            has_post_data: request.and_then(|request| request.get("hasPostData")).and_then(Value::as_bool) == Some(true) || post_data.is_some(),
            ..NetworkRequest::default()
        };
        let id = entry.id.clone();
        self.requests.push(entry);
        self.inflight.push((scoped, id.clone()));
        self.trim();
        self.position(&id).map(|index| &self.requests[index])
    }

    /// The headers in `requestWillBeSent` are provisional: language, encoding, client hints and cookies are added by the network
    /// stack afterwards. A report built from the provisional set alone reads as if the request never asked for them, so the sent
    /// headers are merged in when they arrive. Credentials are still named and never shown by the report.
    pub fn request_will_be_sent_extra_info(&mut self, params: &Value, session_id: Option<&str>) -> Option<&NetworkRequest> {
        let index = self.inflight_for(params, session_id)?;
        let entry = &mut self.requests[index];
        entry.request_headers = merge_sent_headers(&entry.request_headers, headers_of(params.get("headers")));
        Some(&self.requests[index])
    }

    pub fn response_received(&mut self, params: &Value, session_id: Option<&str>) -> Option<&NetworkRequest> {
        let index = self.inflight_for(params, session_id)?;
        let entry = &mut self.requests[index];
        apply_response(entry, params.get("response").unwrap_or(&Value::Null));
        if truthy(params.get("type")) {
            entry.resource_type = js_string_or(params.get("type"), "").to_lowercase();
        }
        Some(&self.requests[index])
    }

    pub fn loading_finished(&mut self, params: &Value, session_id: Option<&str>, now: i64) -> Option<&NetworkRequest> {
        let scoped = scoped_request_id(session_id, &request_id_of(params));
        let index = self.inflight_index(&scoped)?;
        let entry = &mut self.requests[index];
        entry.finished_at = Some(now);
        if let Some(length) = js_finite_number(params.get("encodedDataLength")) {
            entry.encoded_data_length = Some(length);
        }
        self.end_inflight(&scoped);
        Some(&self.requests[index])
    }

    /// A failed request. Its failure text names the policy's refusal when the partition recorded one for the URL.
    pub fn loading_failed(&mut self, params: &Value, session_id: Option<&str>, now: i64) -> Option<&NetworkRequest> {
        let scoped = scoped_request_id(session_id, &request_id_of(params));
        let index = self.inflight_index(&scoped)?;
        let failure = js_string_or(params.get("errorText"), "failed");
        let explained = self.explain_failure(&failure, &self.requests[index].url);
        let entry = &mut self.requests[index];
        entry.finished_at = Some(now);
        entry.failure = Some(explained);
        entry.canceled = params.get("canceled").and_then(Value::as_bool) == Some(true);
        self.end_inflight(&scoped);
        Some(&self.requests[index])
    }

    /// The document at `url` finished loading although CDP never said `loadingFinished` for it: its requests end now. Returns how many.
    pub fn finish_document(&mut self, url: &str, now: i64) -> usize {
        let wanted = without_fragment(url);
        let mut finished = Vec::new();
        for (scoped, id) in &self.inflight {
            let Some(index) = self.requests.iter().position(|request| &request.id == id) else { continue };
            let request = &self.requests[index];
            if request.resource_type == "document" && without_fragment(&request.url) == wanted {
                finished.push((scoped.clone(), index));
            }
        }
        for (scoped, index) in &finished {
            self.requests[*index].finished_at = Some(now);
            self.end_inflight(scoped);
        }
        finished.len()
    }

    pub fn web_socket_created(&mut self, params: &Value, session_id: Option<&str>, now: i64) -> Option<&NetworkRequest> {
        let cdp_request_id = request_id_of(params);
        if cdp_request_id.is_empty() {
            return None;
        }
        if let Some(index) = self.inflight_index(&scoped_request_id(session_id, &cdp_request_id)) {
            self.requests[index].resource_type = "websocket".to_owned();
            return Some(&self.requests[index]);
        }
        let synthetic = serde_json::json!({
            "requestId": cdp_request_id,
            "type": "websocket",
            "request": {"method": "GET", "url": js_string_or(params.get("url"), ""), "headers": {}},
        });
        self.request_will_be_sent(&synthetic, session_id, now)
    }

    /// The upgrade request a socket actually sent. `web_socket_created` carries the address alone, so without this a WebSocket
    /// detail shows no request headers at all, and a refused upgrade is usually explained by one of them.
    pub fn web_socket_will_send_handshake_request(&mut self, params: &Value, session_id: Option<&str>) -> Option<&NetworkRequest> {
        let index = self.inflight_for(params, session_id)?;
        let sent = headers_of(params.get("request").and_then(|request| request.get("headers")));
        let entry = &mut self.requests[index];
        entry.request_headers = merge_sent_headers(&entry.request_headers, sent);
        Some(&self.requests[index])
    }

    pub fn web_socket_handshake_response(&mut self, params: &Value, session_id: Option<&str>) -> Option<&NetworkRequest> {
        let index = self.inflight_for(params, session_id)?;
        let entry = &mut self.requests[index];
        apply_response(entry, params.get("response").unwrap_or(&Value::Null));
        entry.resource_type = "websocket".to_owned();
        Some(&self.requests[index])
    }

    pub fn web_socket_frame(&mut self, params: &Value, direction: FrameDirection, session_id: Option<&str>, now: i64) -> Option<&NetworkRequest> {
        let index = self.inflight_for(params, session_id)?;
        let frame = params.get("response");
        let opcode = js_finite_number(frame.and_then(|frame| frame.get("opcode"))).map_or(0, |opcode| opcode as i64);
        let data = retained_network_text(&js_string_or(frame.and_then(|frame| frame.get("payloadData")), ""), LEDGER_WEBSOCKET_FRAME_CHARS);
        let entry = &mut self.requests[index];
        entry.web_socket_frames.push(WebSocketFrame { direction, opcode, data, at: now });
        let mut total_chars: usize = entry.web_socket_frames.iter().map(|item| utf16_len(&item.data)).sum();
        while !entry.web_socket_frames.is_empty() && (entry.web_socket_frames.len() > LEDGER_WEBSOCKET_FRAMES || total_chars > LEDGER_WEBSOCKET_TOTAL_CHARS) {
            total_chars -= utf16_len(&entry.web_socket_frames.remove(0).data);
        }
        Some(&self.requests[index])
    }

    pub fn web_socket_closed(&mut self, params: &Value, session_id: Option<&str>, now: i64) -> Option<&NetworkRequest> {
        self.loading_finished(params, session_id, now)
    }

    /// The HTTP answer behind the document at `url`: the newest document request for that address, so a 404 page reads as one.
    pub fn document_status(&self, url: &str) -> Option<DocumentStatus> {
        let wanted = without_fragment(url);
        if wanted.is_empty() {
            return None;
        }
        // Only the page's own target: a viewer frame in a child target loads the same address again as its own document.
        self.requests.iter().rev().find_map(|request| {
            let status = request.status?;
            (request.session_id.is_none() && request.resource_type == "document" && without_fragment(&request.url) == wanted)
                .then(|| DocumentStatus { status, status_text: request.status_text.clone(), mime_type: request.mime_type.clone() })
        })
    }

    pub fn get(&self, id: &str) -> Option<&NetworkRequest> {
        self.requests.iter().find(|request| request.id == id)
    }

    pub fn inflight_resource_type(&self, cdp_request_id: &str, session_id: Option<&str>) -> Option<&str> {
        let index = self.inflight_index(&scoped_request_id(session_id, cdp_request_id))?;
        Some(self.requests[index].resource_type.as_str())
    }

    /// The newest requests matching the filter, newest first, and how many matched in all. The query is a literal case-insensitive
    /// substring of the id, method, url, type, MIME type or status.
    pub fn list(&self, options: &NetworkQuery) -> (Vec<&NetworkRequest>, usize) {
        let query = options.query.trim().to_lowercase();
        let types: Vec<String> = options.resource_types.iter().map(|kind| kind.to_lowercase()).collect();
        let matched: Vec<&NetworkRequest> = self
            .requests
            .iter()
            .rev()
            .filter(|request| {
                if !types.is_empty() && !types.contains(&request.resource_type) {
                    return false;
                }
                if query.is_empty() {
                    return true;
                }
                let status = match (&request.failure, request.status) {
                    (Some(failure), _) if !failure.is_empty() => failure.clone(),
                    (_, Some(status)) if status != 0.0 => js_number_string(status),
                    _ if request.finished_at.is_some() => "finished".to_owned(),
                    _ => "pending".to_owned(),
                };
                [request.id.as_str(), request.method.as_str(), request.url.as_str(), request.resource_type.as_str(), request.mime_type.as_deref().unwrap_or_default(), status.as_str()]
                    .iter()
                    .any(|value| value.to_lowercase().contains(&query))
            })
            .collect();
        let limit = match options.limit {
            Some(limit) if limit != 0 => limit.clamp(1, 200) as usize,
            _ => 50,
        };
        let total = matched.len();
        (matched.into_iter().take(limit).collect(), total)
    }

    /// Requests still in flight that began less than `max_age_ms` ago.
    pub fn recent_inflight(&self, now: i64, max_age_ms: i64) -> Vec<&NetworkRequest> {
        self.inflight.iter().filter_map(|(_, id)| self.get(id)).filter(|request| now - request.started_at < max_age_ms).collect()
    }

    pub fn pending_count(&self) -> usize {
        self.inflight.len()
    }

    fn trim(&mut self) {
        while self.requests.len() > self.max_requests {
            let removable = self.requests.iter().position(|request| request.finished_at.is_some()).unwrap_or(0);
            let removed = self.requests.remove(removable);
            self.inflight.retain(|(_, id)| *id != removed.id);
        }
    }
}

fn apply_response(entry: &mut NetworkRequest, response: &Value) {
    if let Some(status) = js_finite_number(response.get("status")) {
        entry.status = Some(status);
    }
    if let Some(status_text) = response.get("statusText") {
        entry.status_text = Some(js_string(status_text));
    }
    entry.response_headers = headers_of(response.get("headers"));
    if let Some(mime_type) = response.get("mimeType") {
        entry.mime_type = Some(js_string(mime_type));
    }
    if let Some(protocol) = response.get("protocol") {
        entry.protocol = Some(js_string(protocol));
    }
    if truthy(response.get("remoteIPAddress")) {
        let address = js_string_or(response.get("remoteIPAddress"), "");
        entry.remote_address = Some(match js_finite_number(response.get("remotePort")).filter(|port| *port > 0.0) {
            Some(port) => format!("{address}:{}", js_number_string(port)),
            None => address,
        });
    }
    entry.from_disk_cache = response.get("fromDiskCache").and_then(Value::as_bool) == Some(true);
    entry.from_service_worker = response.get("fromServiceWorker").and_then(Value::as_bool) == Some(true);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn send(ledger: &mut NetworkLedger, id: &str, kind: &str, url: &str, now: i64) {
        ledger.request_will_be_sent(&json!({"requestId": id, "type": kind, "request": {"method": "GET", "url": url, "headers": {}}}), None, now);
    }

    fn header<'a>(headers: &'a Headers, name: &str) -> Option<&'a str> {
        headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    #[test]
    fn records_request_response_timing_and_filters() {
        let mut ledger = NetworkLedger::default();
        let request = ledger
            .request_will_be_sent(
                &json!({"requestId": "10.1", "type": "Fetch", "request": {"method": "POST", "url": "https://example.test/api/items",
                    "headers": {"content-type": "application/json"}, "postData": "{\"name\":\"demo\"}", "hasPostData": true}}),
                None,
                1_000,
            )
            .unwrap();
        assert_eq!(request.id, "r1");
        ledger.response_received(
            &json!({"requestId": "10.1", "type": "Fetch", "response": {"status": 201, "statusText": "Created",
                "headers": {"content-type": "application/json"}, "mimeType": "application/json", "protocol": "h2"}}),
            None,
        );
        ledger.loading_finished(&json!({"requestId": "10.1", "encodedDataLength": 123}), None, 1_075);
        assert_eq!(ledger.pending_count(), 0);
        let stored = ledger.get("r1").unwrap();
        assert_eq!((stored.status, stored.finished_at, stored.encoded_data_length), (Some(201.0), Some(1_075), Some(123.0)));
        let (found, total) = ledger.list(&NetworkQuery { query: "items".into(), resource_types: vec!["fetch".into()], limit: None });
        assert_eq!((found.iter().map(|request| request.id.as_str()).collect::<Vec<_>>(), total), (vec!["r1"], 1));
        assert_eq!(ledger.list(&NetworkQuery { resource_types: vec!["image".into()], ..NetworkQuery::default() }).1, 0);
    }

    #[test]
    fn a_request_reports_the_headers_actually_sent_not_only_the_provisional_ones() {
        let mut ledger = NetworkLedger::default();
        ledger.request_will_be_sent(&json!({"requestId": "11.1", "type": "Document", "request": {"method": "GET", "url": "https://example.test/", "headers": {"User-Agent": "probe"}}}), None, 1_000);
        ledger.request_will_be_sent_extra_info(&json!({"requestId": "11.1", "headers": {"Accept-Language": "ko-KR,ko;q=0.9", "Cookie": "session=secret-value"}}), None);
        let entry = ledger.get("r1").unwrap();
        assert_eq!(header(&entry.request_headers, "Accept-Language"), Some("ko-KR,ko;q=0.9"));
        assert_eq!(header(&entry.request_headers, "User-Agent"), Some("probe"));
    }

    #[test]
    fn a_header_both_events_report_is_listed_once_spelled_as_it_went_on_the_wire() {
        let mut ledger = NetworkLedger::default();
        ledger.request_will_be_sent(
            &json!({"requestId": "12.1", "type": "Document", "request": {"method": "GET", "url": "https://example.test/",
                "headers": {"User-Agent": "provisional", "Upgrade-Insecure-Requests": "1"}}}),
            None,
            1_000,
        );
        ledger.request_will_be_sent_extra_info(&json!({"requestId": "12.1", "headers": {"user-agent": "sent", "upgrade-insecure-requests": "1", "accept-language": "ko"}}), None);
        let entry = ledger.get("r1").unwrap();
        let mut names: Vec<&str> = entry.request_headers.iter().map(|(name, _)| name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["accept-language", "upgrade-insecure-requests", "user-agent"]);
        assert_eq!(header(&entry.request_headers, "user-agent"), Some("sent"), "the value that went on the wire wins");
    }

    #[test]
    fn a_web_socket_reports_the_upgrade_it_sent_handshake_and_frames() {
        let mut ledger = NetworkLedger::default();
        ledger.web_socket_created(&json!({"requestId": "30.1", "url": "wss://example.test/socket"}), None, 3_000);
        ledger.web_socket_will_send_handshake_request(&json!({"requestId": "30.1", "request": {"headers": {"Origin": "https://example.test", "Cookie": "session=secret-value"}}}), None);
        ledger.web_socket_handshake_response(&json!({"requestId": "30.1", "response": {"status": 101, "statusText": "Switching Protocols", "headers": {}}}), None);
        ledger.web_socket_frame(&json!({"requestId": "30.1", "response": {"opcode": 1, "payloadData": "hello"}}), FrameDirection::Sent, None, 3_010);
        ledger.web_socket_frame(&json!({"requestId": "30.1", "response": {"opcode": 2, "payloadData": "AAEC"}}), FrameDirection::Received, None, 3_020);
        ledger.web_socket_closed(&json!({"requestId": "30.1"}), None, 3_030);
        let socket = ledger.get("r1").unwrap();
        assert_eq!((socket.resource_type.as_str(), socket.status, socket.finished_at), ("websocket", Some(101.0), Some(3_030)));
        assert_eq!(header(&socket.request_headers, "Origin"), Some("https://example.test"));
        assert_eq!(socket.web_socket_frames.iter().map(|frame| (frame.direction, frame.opcode, frame.data.as_str())).collect::<Vec<_>>(), vec![(FrameDirection::Sent, 1, "hello"), (FrameDirection::Received, 2, "AAEC")]);
        assert_eq!(ledger.pending_count(), 0);
    }

    #[test]
    fn bounded_records_keep_exact_utf16_prefixes() {
        let mut ledger = NetworkLedger::default();
        let body = format!("{}🙂\0tail", "b".repeat(63_999));
        let name = format!("{}🙂tail", "h".repeat(255));
        let value = format!("{}🙂\0tail", "v".repeat(8_191));
        let url = format!("https://example.test/{}🙂tail", "u".repeat(16_363));
        let request = ledger
            .request_will_be_sent(&json!({"requestId": "unicode", "type": "Fetch", "request": {"method": "POST", "url": url, "headers": {name.clone(): value.clone()}, "postData": body}}), None, 0)
            .unwrap();
        // The pair that straddles a limit is dropped whole: a Rust string cannot hold its lone half.
        assert_eq!(request.url, format!("https://example.test/{}", "u".repeat(16_363)));
        assert_eq!(request.request_body.as_deref(), Some("b".repeat(63_999).as_str()));
        assert_eq!(request.request_headers, vec![("h".repeat(255), "v".repeat(8_191))]);
        ledger.response_received(&json!({"requestId": "unicode", "response": {"status": 200, "headers": {name: value}}}), None);
        let stored = ledger.get("r1").unwrap();
        assert_eq!(stored.response_headers, stored.request_headers);
    }

    #[test]
    fn redirect_hops_stay_distinct_and_failures_are_recorded() {
        let mut ledger = NetworkLedger::default();
        send(&mut ledger, "20.1", "Document", "https://example.test/old", 2_000);
        ledger.request_will_be_sent(
            &json!({"requestId": "20.1", "type": "Document", "request": {"method": "GET", "url": "https://example.test/new", "headers": {}},
                "redirectResponse": {"status": 302, "headers": {"location": "/new"}}}),
            None,
            2_010,
        );
        ledger.loading_failed(&json!({"requestId": "20.1", "errorText": "net::ERR_FAILED"}), None, 2_020);
        let first = ledger.get("r1").unwrap();
        assert_eq!((first.status, first.redirected_to.as_deref(), first.finished_at), (Some(302.0), Some("https://example.test/new"), Some(2_010)));
        assert_eq!(ledger.get("r2").unwrap().failure.as_deref(), Some("net::ERR_FAILED"));
        assert_eq!(ledger.list(&NetworkQuery::default()).0.iter().map(|request| request.id.as_str()).collect::<Vec<_>>(), ["r2", "r1"]);
    }

    #[test]
    fn a_completed_main_document_is_reconciled_when_loading_finished_never_came() {
        let mut ledger = NetworkLedger::default();
        send(&mut ledger, "21.1", "Document", "https://example.test/page", 2_500);
        send(&mut ledger, "21.2", "Fetch", "https://example.test/page", 2_500);
        ledger.response_received(&json!({"requestId": "21.1", "type": "Document", "response": {"status": 200}}), None);
        assert_eq!(ledger.pending_count(), 2);
        assert_eq!(ledger.finish_document("https://example.test/page#new", 2_550), 1);
        assert_eq!(ledger.pending_count(), 1);
        assert_eq!(ledger.get("r1").unwrap().finished_at, Some(2_550));
    }

    #[test]
    fn the_newest_document_status_for_a_url_names_a_404_page_as_one() {
        let mut ledger = NetworkLedger::default();
        for (id, status) in [("22.1", 200), ("22.2", 404)] {
            send(&mut ledger, id, "Document", "https://example.test/missing", 1_000);
            ledger.response_received(&json!({"requestId": id, "type": "Document", "response": {"status": status, "statusText": "x", "mimeType": "text/html"}}), None);
            ledger.loading_finished(&json!({"requestId": id}), None, 1_100);
        }
        let status = ledger.document_status("https://example.test/missing#section").unwrap();
        assert_eq!((status.status, status.mime_type.as_deref()), (404.0, Some("text/html")));
        assert_eq!(ledger.document_status("https://example.test/other"), None);
        assert_eq!(ledger.document_status(""), None);
        // A child target's document of the same address is not the page's.
        ledger.request_will_be_sent(&json!({"requestId": "9", "type": "Document", "request": {"url": "https://example.test/child"}}), Some("viewer"), 1_200);
        ledger.response_received(&json!({"requestId": "9", "response": {"status": 500}}), Some("viewer"));
        assert_eq!(ledger.document_status("https://example.test/child"), None);
    }

    #[test]
    fn the_ledger_bounds_requests_and_untrusted_payload_memory() {
        let mut ledger = NetworkLedger::new(2);
        let oversized = "x".repeat(100_000);
        for index in 1..=3 {
            let headers: serde_json::Map<String, Value> = (0..140).map(|header| (format!("x-{header}"), json!(oversized))).collect();
            ledger.request_will_be_sent(
                &json!({"requestId": index.to_string(), "type": "Fetch", "request": {"method": "POST", "url": format!("https://example.test/{index}{oversized}"), "headers": headers, "postData": oversized}}),
                None,
                0,
            );
        }
        assert!(ledger.get("r1").is_none());
        assert_eq!(ledger.pending_count(), 2);
        let newest = ledger.get("r3").unwrap();
        assert!(utf16_len(&newest.url) <= 16_384 && utf16_len(newest.request_body.as_deref().unwrap_or_default()) <= 64_000);
        assert_eq!(newest.request_headers.len(), 128);
        assert!(newest.request_headers.iter().all(|(_, value)| utf16_len(value) <= 8_192));
        ledger.web_socket_created(&json!({"requestId": "socket", "url": "wss://example.test/socket"}), None, 0);
        for _ in 0..120 {
            ledger.web_socket_frame(&json!({"requestId": "socket", "response": {"opcode": 1, "payloadData": oversized}}), FrameDirection::Received, None, 0);
        }
        let socket = ledger.requests.iter().find(|request| request.resource_type == "websocket").unwrap();
        assert!(socket.web_socket_frames.len() <= 100);
        assert!(socket.web_socket_frames.iter().map(|frame| utf16_len(&frame.data)).sum::<usize>() <= 256_000);
    }

    #[test]
    fn a_finished_request_leaves_the_capped_ledger_before_one_still_pending() {
        let mut ledger = NetworkLedger::new(2);
        send(&mut ledger, "1", "Fetch", "https://a.test/1", 0);
        send(&mut ledger, "2", "Fetch", "https://a.test/2", 0);
        ledger.loading_finished(&json!({"requestId": "2"}), None, 5);
        send(&mut ledger, "3", "Fetch", "https://a.test/3", 0);
        assert!(ledger.get("r2").is_none());
        assert!(ledger.get("r1").is_some() && ledger.get("r3").is_some());
        assert_eq!(ledger.pending_count(), 2);
    }

    #[test]
    fn queries_are_literal_case_insensitive_substrings_not_or_or_regex() {
        let mut ledger = NetworkLedger::default();
        send(&mut ledger, "1", "Fetch", "https://example.test/ALPHA", 0);
        assert_eq!(ledger.list(&NetworkQuery { query: " alpha ".into(), ..NetworkQuery::default() }).1, 1);
        for query in ["alpha beta", "alpha|beta", "/alpha/i"] {
            assert_eq!(ledger.list(&NetworkQuery { query: query.into(), ..NetworkQuery::default() }).1, 0);
        }
        assert_eq!(ledger.list(&NetworkQuery { query: "PENDING".into(), ..NetworkQuery::default() }).1, 1);
    }

    #[test]
    fn a_network_policy_reason_is_written_into_the_failure_text_verbatim() {
        let reason = "blocked host $& ($$, $', $`, $1)";
        assert_eq!(
            explain_network_failure("GET https://a.test failed: net::ERR_BLOCKED_BY_CLIENT", reason),
            format!("GET https://a.test failed: net::ERR_BLOCKED_BY_CLIENT (Browser Use network policy: {reason})")
        );
        assert_eq!(explain_network_failure("net::ERR_BLOCKED_BY_CLIENT", ""), "net::ERR_BLOCKED_BY_CLIENT (Browser Use network policy)");
        assert_eq!(explain_network_failure("net::ERR_FAILED", "unused"), "net::ERR_FAILED");
    }

    #[test]
    fn a_refused_request_fails_with_the_policys_reason() {
        let mut ledger = NetworkLedger::default();
        ledger.record_refused("https://t.test/x", "private address");
        send(&mut ledger, "1", "Image", "https://t.test/x", 0);
        let failed = ledger.loading_failed(&json!({"requestId": "1", "errorText": "net::ERR_BLOCKED_BY_CLIENT", "canceled": false}), None, 9).unwrap();
        assert_eq!(failed.failure.as_deref(), Some("net::ERR_BLOCKED_BY_CLIENT (Browser Use network policy: private address)"));
        assert_eq!(ledger.explain_failure("net::ERR_BLOCKED_BY_CLIENT", "https://other.test/"), "net::ERR_BLOCKED_BY_CLIENT (Browser Use network policy)");
    }

    #[test]
    fn refusal_reasons_keep_the_newest_fifty_and_300_characters_each() {
        let mut ledger = NetworkLedger::default();
        for index in 0..60 {
            ledger.record_refused(&format!("https://t.test/{index}"), &"r".repeat(400));
        }
        assert_eq!(ledger.refused_reason("https://t.test/0"), None);
        assert_eq!(ledger.refused_reason("https://t.test/59").map(str::len), Some(300));
        ledger.record_refused("https://t.test/10", "again");
        assert_eq!(ledger.refused_reason("https://t.test/10"), Some("again"));
    }

    #[test]
    fn page_faults_come_before_the_hosts_refusals_in_original_order() {
        let refused = |name: &str| format!("x net::ERR_BLOCKED_BY_CLIENT (Browser Use network policy) {name}");
        let lines = vec!["fault 1".to_owned(), refused("a"), "fault 2".to_owned(), refused("b")];
        assert_eq!(page_faults_first(&lines, 3), vec!["fault 1".to_owned(), "fault 2".to_owned(), refused("b")]);
        assert_eq!(page_faults_first(&lines, 1), vec!["fault 2".to_owned()]);
        assert_eq!(page_faults_first(&lines, 10), lines);
    }

    #[test]
    fn recent_inflight_names_requests_younger_than_the_age() {
        let mut ledger = NetworkLedger::default();
        send(&mut ledger, "1", "Fetch", "https://a.test/old", 0);
        send(&mut ledger, "2", "Fetch", "https://a.test/new", 20_000);
        assert_eq!(ledger.recent_inflight(21_000, 15_000).iter().map(|request| request.id.as_str()).collect::<Vec<_>>(), ["r2"]);
        assert_eq!(ledger.inflight_resource_type("1", None), Some("fetch"));
    }
}
