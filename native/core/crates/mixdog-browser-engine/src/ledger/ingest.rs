//! Owner: s4-engine-ledgers
//! The ledgers of every page, fed by the host's ordered notifications (`cdp-events-console.ts` recording part and the ledger
//! routes of `cdp-event-router.ts`). `host/browser/events` batches and `page/facts` carry one per-page `seq`; a batch is applied
//! only when it is the next one, and a gap is reported so the lane can call `host/browser/page/sync` and [`Ingest::resync`].
//!
//! The host already left out the diagnostics of Chromium's own components (their execution contexts) and forwards only the
//! allowlisted CDP events plus the synthetic `Mixdog.internalConsole {level, text}` and `Mixdog.requestRefused {url, reason}`.
//! `Ingest` is a plain value: the lane that owns it serialises its calls (the sink is synchronous and ordered).
//!
//! Not carried over: the console replay filter of `freshEntry` (it only rejects entries a re-enabled CDP domain replays while the
//! core's own drive command holds the floor; the host re-enables domains and never forwards a replay).

use std::collections::HashMap;
use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use mixdog_app_protocol::v2::browser_engine::BrowserEngineEvent;
use mixdog_app_protocol::v2::browser_engine::HostBrowserEventsParams;
use mixdog_app_protocol::v2::browser_engine::PageFacts;
use mixdog_browser_policy::redaction::redact_browser_text;
use mixdog_browser_policy::redaction::redact_url;
use serde_json::Value;
use serde_json::json;

use super::console::ConsoleLedger;
use super::console_format::format_console_arguments;
use super::console_format::format_console_source;
use super::console_format::js_finite_number;
use super::console_format::js_string_or;
use super::console_format::truthy;
use super::console_format::utf16_prefix;
use super::network::FrameDirection;
use super::network::NetworkLedger;

/// Entries of a page's failure list and the characters of one.
const MAX_FAILURES: usize = 30;
const MAX_FAILURE_CHARS: usize = 4_000;

/// The next batch the page expected was not the one that arrived: events or facts were lost in between.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeqGap {
    pub expected: u64,
    pub got: u64,
}

impl fmt::Display for SeqGap {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "browser page notifications skipped from {} to {}", self.expected, self.got)
    }
}

impl std::error::Error for SeqGap {}

/// What redacts a console entry before it is kept (the page's known secrets belong to whoever owns them).
pub type Sanitizer = Arc<dyn Fn(&str) -> String + Send + Sync>;

/// Whether a URL or origin belongs to one of Chromium's own bundled components (its PDF viewer and the shared WebUI resources it
/// imports) rather than to the page.
pub fn is_browser_component_address(address: &str) -> bool {
    let trimmed = address.trim_start();
    ["chrome:", "chrome-extension:"].iter().any(|scheme| trimmed.get(..scheme.len()).is_some_and(|head| head.eq_ignore_ascii_case(scheme)))
}

/// Everything the engine remembers of one page's diagnostics.
pub struct PageLedgers {
    pub console: ConsoleLedger,
    pub network: NetworkLedger,
    /// Failures a reply volunteers (failed requests, blocked popups and navigations), newest last, redacted and capped.
    pub failures: Vec<String>,
    /// The failures a reply already said, so each is said once.
    pub reported_failures: HashSet<String>,
    document_id: Option<String>,
    main_frame_loading: bool,
}

impl PageLedgers {
    pub fn new(sanitize: Sanitizer) -> Self {
        Self {
            console: ConsoleLedger::with_sanitizer(move |text| sanitize(text)),
            network: NetworkLedger::default(),
            failures: Vec::new(),
            reported_failures: HashSet::new(),
            document_id: None,
            main_frame_loading: false,
        }
    }

    /// Append to the capped failure list, redacting and trimming the entry (`pushBounded`).
    pub fn push_failure(&mut self, text: &str) {
        self.failures.push(redact_browser_text(utf16_prefix(text, MAX_FAILURE_CHARS)));
        if self.failures.len() > MAX_FAILURES {
            let excess = self.failures.len() - MAX_FAILURES;
            self.failures.drain(..excess);
        }
    }

    /// A fresh document answers for its own requests only. Carrying the last page's failures forward reports them as faults of
    /// the page now loaded.
    fn begin_document(&mut self) {
        self.failures.clear();
        self.reported_failures.clear();
        self.console.clear_document();
    }

    /// The document changed under the page, or its main frame finished loading.
    fn apply_facts(&mut self, facts: &PageFacts, now: i64) {
        let load = facts.load_id.as_ref().unwrap_or(&facts.document_id);
        if let Some(previous) = &self.document_id
            && previous != load
        {
            self.begin_document();
        }
        self.document_id = Some(load.clone());
        if self.main_frame_loading && !facts.main_frame_loading {
            self.network.finish_document(&facts.url, now);
        }
        self.main_frame_loading = facts.main_frame_loading;
        for refused in facts.refused_requests.iter().flatten() {
            self.network.record_refused(&refused.url, &refused.reason);
        }
    }

    fn apply_event(&mut self, event: &BrowserEngineEvent) {
        let params = &event.params;
        let session = event.session_id.as_deref();
        let now = event.t;
        match event.method.as_str() {
            "Network.requestWillBeSent" => {
                self.network.request_will_be_sent(params, session, now);
            }
            "Network.requestWillBeSentExtraInfo" => {
                self.network.request_will_be_sent_extra_info(params, session);
            }
            "Network.responseReceived" => {
                self.network.response_received(params, session);
            }
            "Network.loadingFinished" => {
                self.network.loading_finished(params, session, now);
            }
            "Network.loadingFailed" => self.on_loading_failed(params, session, now),
            "Network.webSocketCreated" => {
                self.network.web_socket_created(params, session, now);
            }
            "Network.webSocketWillSendHandshakeRequest" => {
                self.network.web_socket_will_send_handshake_request(params, session);
            }
            "Network.webSocketHandshakeResponseReceived" => {
                self.network.web_socket_handshake_response(params, session);
            }
            "Network.webSocketFrameSent" => {
                self.network.web_socket_frame(params, FrameDirection::Sent, session, now);
            }
            "Network.webSocketFrameReceived" => {
                self.network.web_socket_frame(params, FrameDirection::Received, session, now);
            }
            "Network.webSocketClosed" => {
                self.network.web_socket_closed(params, session, now);
            }
            "Network.webSocketFrameError" => {
                let error_text = js_string_or(params.get("errorMessage"), "WebSocket frame error");
                let failed = json!({"requestId": params.get("requestId").cloned().unwrap_or(Value::Null), "errorText": error_text});
                self.network.loading_failed(&failed, session, now);
            }
            "Runtime.exceptionThrown" => self.on_exception_thrown(params),
            "Runtime.consoleAPICalled" => self.on_console_api_called(params),
            "Log.entryAdded" => self.on_log_entry_added(params),
            "Mixdog.internalConsole" => self.console.record_internal(&js_string_or(params.get("text"), "")),
            "Mixdog.requestRefused" => {
                self.network.record_refused(&js_string_or(params.get("url"), ""), &js_string_or(params.get("reason"), ""));
            }
            _ => {}
        }
    }

    fn on_loading_failed(&mut self, params: &Value, session: Option<&str>, now: i64) {
        let Some(request) = self.network.loading_failed(params, session, now) else { return };
        // Chromium cancels a request when the address turns into a download, when the page abandons a fetch, and when a
        // navigation replaces it. None of those is a fault of the page, so a cancelled request stays in the network ledger but
        // never joins the failures a reply volunteers: a saved file is not a failed request.
        if request.canceled || is_browser_component_address(&request.url) {
            return;
        }
        let failure = request.failure.as_deref().filter(|failure| !failure.is_empty()).unwrap_or("failed");
        let line = format!("{} {} — {failure}", request.method, redact_url(&request.url));
        self.push_failure(&line);
    }

    fn on_exception_thrown(&mut self, params: &Value) {
        let detail = params.get("exceptionDetails");
        let field = |name: &str| detail.and_then(|detail| detail.get(name));
        let described = [field("exception").and_then(|exception| exception.get("description")), field("text")]
            .into_iter()
            .find(|candidate| truthy(*candidate))
            .map_or_else(|| "page exception".to_owned(), |candidate| js_string_or(candidate, ""));
        let frame = first_script_frame(field("stackTrace"));
        let frame_url = frame.and_then(|frame| frame.get("url"));
        let thrown_url = js_string_or(if truthy(frame_url) { frame_url } else { field("url") }, "");
        // A thrown Error already prints its own stack; only a bare value, such as `throw 'boom'`, needs the script and line spelled out.
        let thrown_line = if truthy(frame_url) { frame.and_then(|frame| frame.get("lineNumber")) } else { field("lineNumber") };
        if !thrown_url.is_empty() && !described.contains(&thrown_url) {
            let text = format!("{described}{}", format_console_source(&redact_url(&thrown_url), js_finite_number(thrown_line)));
            self.console.record_error(&text);
        } else {
            self.console.record_error(&described);
        }
    }

    fn on_console_api_called(&mut self, params: &Value) {
        let kind = js_string_or(params.get("type"), "");
        let arguments: &[Value] = params.get("args").and_then(Value::as_array).map_or(&[][..], |items| items.as_slice());
        // The first frame that names a script is the line a reader opens.
        let frame = first_script_frame(params.get("stackTrace"));
        let source = frame
            .and_then(|frame| frame.get("url").and_then(Value::as_str).map(|url| format_console_source(&redact_url(url), js_finite_number(frame.get("lineNumber")))))
            .unwrap_or_default();
        self.console.record(&kind, &format!("{kind}: {}{source}", format_console_arguments(arguments)));
    }

    fn on_log_entry_added(&mut self, params: &Value) {
        let Some(entry) = params.get("entry").filter(|entry| entry.is_object()) else { return };
        let url = entry.get("url").and_then(Value::as_str).filter(|url| !url.is_empty());
        if url.is_some_and(is_browser_component_address) {
            return;
        }
        let level = entry.get("level").and_then(Value::as_str);
        let text = js_string_or(entry.get("text"), "");
        let explained = self.network.explain_failure(&text, url.unwrap_or_default());
        let source = url.map_or_else(String::new, |url| format_console_source(&redact_url(url), js_finite_number(entry.get("lineNumber"))));
        self.console.record(level.unwrap_or_default(), &format!("{}: {explained}{source}", level.unwrap_or("undefined")));
    }
}

fn first_script_frame(stack_trace: Option<&Value>) -> Option<&Value> {
    stack_trace?.get("callFrames")?.as_array()?.iter().find(|frame| truthy(frame.get("url")))
}

struct Page {
    ledgers: PageLedgers,
    /// The `seq` of the last batch applied; `None` until the page's first notification or resync.
    cursor: Option<u64>,
}

/// Applies the host's ordered notifications to each page's ledgers.
pub struct Ingest {
    pages: HashMap<String, Page>,
    sanitize: Sanitizer,
}

impl Default for Ingest {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for Ingest {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("Ingest").field("pages", &self.pages.len()).finish()
    }
}

/// Epoch milliseconds on the replay's clock when one runs the process.
fn wall_clock_ms() -> i64 {
    mixdog_rt::wall_clock!().duration_since(UNIX_EPOCH).map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
}

impl Ingest {
    /// Console entries are redacted with the same patterns the replies use.
    pub fn new() -> Self {
        Self::with_sanitizer(Arc::new(|text: &str| redact_browser_text(text)))
    }

    pub fn with_sanitizer(sanitize: Sanitizer) -> Self {
        Self { pages: HashMap::new(), sanitize }
    }

    fn page(&mut self, page_id: &str) -> &mut Page {
        let sanitize = &self.sanitize;
        self.pages.entry(page_id.to_owned()).or_insert_with(|| Page { ledgers: PageLedgers::new(Arc::clone(sanitize)), cursor: None })
    }

    /// Whether a notification with `seq` is the next one: `Ok(true)` apply it, `Ok(false)` it is old or repeated (ignore it), `Err`
    /// a gap. A page with no cursor yet takes whatever arrives first.
    fn admit(cursor: Option<u64>, seq: u64) -> Result<bool, SeqGap> {
        match cursor {
            None => Ok(true),
            Some(last) if seq <= last => Ok(false),
            Some(last) if seq == last + 1 => Ok(true),
            Some(last) => Err(SeqGap { expected: last + 1, got: seq }),
        }
    }

    /// One `host/browser/events` batch. Applied in order when it is the next one; a gap leaves the ledgers and the cursor as they
    /// were, for the lane to call `page/sync` and [`Self::resync`].
    pub fn apply_events(&mut self, params: HostBrowserEventsParams) -> Result<(), SeqGap> {
        let page = self.page(&params.page_id);
        if !Self::admit(page.cursor, params.seq)? {
            return Ok(());
        }
        for event in &params.events {
            page.ledgers.apply_event(event);
        }
        page.cursor = Some(params.seq);
        Ok(())
    }

    /// One `host/browser/page/facts` notification: the document the page now shows, and whether its main frame finished loading.
    /// Facts are complete, but a gap before them still means events were lost, so it is reported the same way.
    pub fn apply_facts(&mut self, facts: &PageFacts) -> Result<(), SeqGap> {
        self.apply_facts_at(facts, wall_clock_ms())
    }

    /// [`Self::apply_facts`] with the time the finished document's requests end at.
    pub fn apply_facts_at(&mut self, facts: &PageFacts, now: i64) -> Result<(), SeqGap> {
        let page = self.page(&facts.page_id);
        if !Self::admit(page.cursor, facts.seq)? {
            return Ok(());
        }
        page.ledgers.apply_facts(facts, now);
        page.cursor = Some(facts.seq);
        Ok(())
    }

    /// The page's facts as `page/sync` (or any result carrying them) answered after a gap: the cursor moves to their `seq`.
    pub fn resync(&mut self, facts: &PageFacts) {
        let page = self.page(&facts.page_id);
        page.ledgers.apply_facts(facts, wall_clock_ms());
        page.cursor = Some(facts.seq);
    }

    /// The `seq` of the last notification applied for the page.
    pub fn cursor(&self, page_id: &str) -> Option<u64> {
        self.pages.get(page_id)?.cursor
    }

    pub fn ledgers(&self, page_id: &str) -> Option<&PageLedgers> {
        self.pages.get(page_id).map(|page| &page.ledgers)
    }

    pub fn ledgers_mut(&mut self, page_id: &str) -> Option<&mut PageLedgers> {
        self.pages.get_mut(page_id).map(|page| &mut page.ledgers)
    }

    /// The ledgers of a page, made when the page has none yet.
    pub fn ledgers_or_default(&mut self, page_id: &str) -> &mut PageLedgers {
        &mut self.page(page_id).ledgers
    }

    /// The page is gone: its ledgers and cursor go with it.
    pub fn forget(&mut self, page_id: &str) {
        self.pages.remove(page_id);
    }

    /// The host's claim ended: every page it held is gone.
    pub fn clear(&mut self) {
        self.pages.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::page_facts;

    fn events(page: &str, seq: u64, list: Value) -> HostBrowserEventsParams {
        serde_json::from_value(json!({"pageId": page, "seq": seq, "events": list})).expect("events")
    }

    fn facts(page: &str, seq: u64, patch: Value) -> PageFacts {
        let mut value = page_facts(page, seq);
        if let (Some(target), Some(extra)) = (value.as_object_mut(), patch.as_object()) {
            target.extend(extra.clone());
        }
        serde_json::from_value(value).expect("facts")
    }

    fn event(method: &str, params: Value, t: i64) -> Value {
        json!({"method": method, "params": params, "t": t})
    }

    #[test]
    fn batches_apply_in_order_and_a_gap_is_reported_without_applying() {
        let mut ingest = Ingest::new();
        let log = |text: &str| event("Mixdog.internalConsole", json!({"level": "error", "text": text}), 1);
        assert_eq!(ingest.apply_events(events("p", 4, json!([log("a")]))), Ok(()));
        assert_eq!(ingest.cursor("p"), Some(4));
        assert_eq!(ingest.apply_events(events("p", 6, json!([log("lost")]))), Err(SeqGap { expected: 5, got: 6 }));
        assert_eq!(ingest.cursor("p"), Some(4));
        assert_eq!(ingest.ledgers("p").unwrap().console.entries().count(), 1);
        // A repeated or old batch is ignored.
        assert_eq!(ingest.apply_events(events("p", 4, json!([log("again")]))), Ok(()));
        assert_eq!(ingest.apply_events(events("p", 5, json!([log("b")]))), Ok(()));
        assert_eq!(ingest.ledgers("p").unwrap().console.entries().count(), 2);
        // Facts share the page's counter; a resync closes a gap.
        assert_eq!(ingest.apply_facts_at(&facts("p", 9, json!({})), 0), Err(SeqGap { expected: 6, got: 9 }));
        ingest.resync(&facts("p", 9, json!({})));
        assert_eq!((ingest.cursor("p"), ingest.cursor("other")), (Some(9), None));
        assert_eq!(ingest.apply_facts_at(&facts("p", 10, json!({})), 0), Ok(()));
        ingest.forget("p");
        assert!(ingest.ledgers("p").is_none());
    }

    #[test]
    fn network_events_feed_the_ledger_with_the_events_own_time() {
        let mut ingest = Ingest::new();
        let batch = json!([
            event("Network.requestWillBeSent", json!({"requestId": "1", "type": "Fetch", "request": {"method": "GET", "url": "https://a.test/api", "headers": {}}}), 1_000),
            event("Network.responseReceived", json!({"requestId": "1", "response": {"status": 200}}), 1_020),
            event("Network.loadingFinished", json!({"requestId": "1", "encodedDataLength": 10}), 1_050),
            event("Network.requestServedFromCache", json!({"requestId": "1"}), 1_060),
        ]);
        ingest.apply_events(events("p", 1, batch)).unwrap();
        let request = ingest.ledgers("p").unwrap().network.get("r1").unwrap();
        assert_eq!((request.started_at, request.finished_at, request.status), (1_000, Some(1_050), Some(200.0)));
    }

    #[test]
    fn a_failed_request_joins_the_failures_unless_it_was_cancelled() {
        let mut ingest = Ingest::new();
        let send = |id: &str, url: &str| event("Network.requestWillBeSent", json!({"requestId": id, "type": "Fetch", "request": {"method": "GET", "url": url}}), 1);
        let batch = json!([
            send("1", "https://a.test/broken?token=abcdef1234567890abcdef"),
            event("Network.loadingFailed", json!({"requestId": "1", "errorText": "net::ERR_CONNECTION_RESET"}), 2),
            send("2", "https://a.test/download"),
            event("Network.loadingFailed", json!({"requestId": "2", "errorText": "net::ERR_ABORTED", "canceled": true}), 3),
            send("3", "chrome-extension://abc/viewer.js"),
            event("Network.loadingFailed", json!({"requestId": "3", "errorText": "net::ERR_FAILED"}), 4),
        ]);
        ingest.apply_events(events("p", 1, batch)).unwrap();
        let ledgers = ingest.ledgers("p").unwrap();
        assert_eq!(ledgers.failures.len(), 1, "{:?}", ledgers.failures);
        assert!(ledgers.failures[0].starts_with("GET https://a.test/broken?token=") && ledgers.failures[0].ends_with(" — net::ERR_CONNECTION_RESET"));
        assert!(!ledgers.failures[0].contains("abcdef1234567890abcdef"));
        assert!(ledgers.network.get("r2").unwrap().canceled);
    }

    #[test]
    fn a_policy_refusal_is_named_in_the_failure_and_in_the_log_entry() {
        let mut ingest = Ingest::new();
        let batch = json!([
            event("Mixdog.requestRefused", json!({"url": "https://t.test/px", "reason": "private address"}), 1),
            event("Network.requestWillBeSent", json!({"requestId": "1", "type": "Image", "request": {"method": "GET", "url": "https://t.test/px"}}), 2),
            event("Network.loadingFailed", json!({"requestId": "1", "errorText": "net::ERR_BLOCKED_BY_CLIENT"}), 3),
            event("Log.entryAdded", json!({"entry": {"level": "error", "text": "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT", "url": "https://t.test/px", "lineNumber": 0}}), 4),
        ]);
        ingest.apply_events(events("p", 1, batch)).unwrap();
        let ledgers = ingest.ledgers_mut("p").unwrap();
        let note = "net::ERR_BLOCKED_BY_CLIENT (Browser Use network policy: private address)";
        assert_eq!(ledgers.failures, [format!("GET https://t.test/px — {note}")]);
        assert_eq!(ledgers.console.since_last_report(3), [format!("error: Failed to load resource: {note} (https://t.test/px:1)")]);
        assert_eq!(ledgers.network.explain_failure("net::ERR_BLOCKED_BY_CLIENT", "https://t.test/px"), note.to_owned());
    }

    #[test]
    fn console_calls_exceptions_and_the_browsers_own_notes_are_recorded() {
        let mut ingest = Ingest::new();
        let batch = json!([
            event("Runtime.consoleAPICalled", json!({"type": "warning", "args": [{"type": "string", "value": "careful"}, {"type": "number", "value": 3}],
                "stackTrace": {"callFrames": [{"url": "", "lineNumber": 1}, {"url": "https://a.test/app.js", "lineNumber": 11}]}}), 1),
            event("Runtime.consoleAPICalled", json!({"type": "log", "args": [{"type": "string", "value": "hello"}]}), 2),
            event("Runtime.exceptionThrown", json!({"exceptionDetails": {"text": "Uncaught", "exception": {"description": "Error: boom\n    at x"}, "url": "https://a.test/app.js", "lineNumber": 4}}), 3),
            event("Runtime.exceptionThrown", json!({"exceptionDetails": {"text": "Uncaught", "stackTrace": {"callFrames": [{"url": "https://a.test/b.js", "lineNumber": 2}]}}}), 4),
            event("Runtime.exceptionThrown", json!({"exceptionDetails": {}}), 5),
            event("Mixdog.internalConsole", json!({"level": "error", "text": "CDP Runtime.evaluate timed out"}), 6),
            event("Log.entryAdded", json!({"entry": {"level": "info", "text": "from the network stack", "url": "chrome://resources/x.js"}}), 7),
        ]);
        ingest.apply_events(events("p", 1, batch)).unwrap();
        let ledgers = ingest.ledgers("p").unwrap();
        let entries: Vec<(&str, &str, bool)> = ledgers.console.entries().map(|entry| (entry.level.name(), entry.text.as_str(), entry.internal)).collect();
        assert_eq!(
            entries,
            [
                ("warning", "warning: careful 3 (https://a.test/app.js:12)", false),
                ("info", "log: hello", false),
                ("error", "Error: boom\n    at x (https://a.test/app.js:5)", false),
                ("error", "Uncaught (https://a.test/b.js:3)", false),
                ("error", "page exception", false),
                ("error", "CDP Runtime.evaluate timed out", true),
            ]
        );
        assert_eq!(ledgers.console.error_count(), 3, "the browser's own fault is not the page's");
    }

    #[test]
    fn web_socket_events_are_recorded_and_a_frame_error_fails_the_socket() {
        let mut ingest = Ingest::new();
        let batch = json!([
            event("Network.webSocketCreated", json!({"requestId": "s", "url": "wss://a.test/s"}), 10),
            event("Network.webSocketFrameSent", json!({"requestId": "s", "response": {"opcode": 1, "payloadData": "ping"}}), 20),
            event("Network.webSocketFrameReceived", json!({"requestId": "s", "response": {"opcode": 1, "payloadData": "pong"}}), 30),
            event("Network.webSocketFrameError", json!({"requestId": "s", "errorMessage": "bad frame"}), 40),
        ]);
        ingest.apply_events(events("p", 1, batch)).unwrap();
        let socket = ingest.ledgers("p").unwrap().network.get("r1").unwrap();
        assert_eq!(socket.web_socket_frames.iter().map(|frame| (frame.direction, frame.data.as_str(), frame.at)).collect::<Vec<_>>(), [(FrameDirection::Sent, "ping", 20), (FrameDirection::Received, "pong", 30)]);
        assert_eq!((socket.failure.as_deref(), socket.finished_at), (Some("bad frame"), Some(40)));
    }

    #[test]
    fn a_new_document_clears_the_log_and_failures_and_a_finished_load_ends_its_document_request() {
        let mut ingest = Ingest::new();
        ingest.apply_facts_at(&facts("p", 1, json!({"mainFrameLoading": true, "url": "https://a.test/page"})), 0).unwrap();
        let batch = json!([
            event("Network.requestWillBeSent", json!({"requestId": "1", "type": "Document", "request": {"method": "GET", "url": "https://a.test/page"}}), 5),
            event("Runtime.consoleAPICalled", json!({"type": "error", "args": [{"value": "old"}]}), 6),
        ]);
        ingest.apply_events(events("p", 2, batch)).unwrap();
        ingest.ledgers_or_default("p").push_failure("Blocked popup creation: nope");
        assert_eq!(ingest.ledgers("p").unwrap().network.pending_count(), 1);
        ingest.apply_facts_at(&facts("p", 3, json!({"mainFrameLoading": false, "url": "https://a.test/page#x"})), 99).unwrap();
        let ledgers = ingest.ledgers("p").unwrap();
        assert_eq!((ledgers.network.pending_count(), ledgers.network.get("r1").unwrap().finished_at), (0, Some(99)));
        assert_eq!((ledgers.console.error_count(), ledgers.failures.len()), (1, 1), "the same document keeps its log");
        ingest.apply_facts_at(&facts("p", 4, json!({"documentId": "p:2"})), 100).unwrap();
        let ledgers = ingest.ledgers("p").unwrap();
        assert_eq!((ledgers.console.error_count(), ledgers.failures.len(), ledgers.network.get("r1").is_some()), (0, 0, true));
    }

    #[test]
    fn an_in_document_navigation_keeps_the_log_and_failures() {
        let mut ingest = Ingest::new();
        ingest.apply_facts_at(&facts("p", 1, json!({"loadId": "p:1"})), 0).unwrap();
        let batch = json!([event("Runtime.consoleAPICalled", json!({"type": "error", "args": [{"value": "kept"}]}), 5)]);
        ingest.apply_events(events("p", 2, batch)).unwrap();
        ingest.apply_facts_at(&facts("p", 3, json!({"documentId": "p:2", "loadId": "p:1"})), 6).unwrap();
        assert_eq!(ingest.ledgers("p").unwrap().console.error_count(), 1);
        ingest.apply_facts_at(&facts("p", 4, json!({"documentId": "p:3", "loadId": "p:2"})), 7).unwrap();
        assert_eq!(ingest.ledgers("p").unwrap().console.error_count(), 0);
    }

    #[test]
    fn facts_carry_the_refused_requests_of_a_resync() {
        let mut ingest = Ingest::new();
        ingest.resync(&facts("p", 7, json!({"refusedRequests": [{"url": "https://t.test/a", "reason": "blocked host"}]})));
        assert_eq!(ingest.ledgers("p").unwrap().network.refused_reason("https://t.test/a"), Some("blocked host"));
    }

    #[test]
    fn the_failure_list_keeps_the_newest_thirty_redacted() {
        let mut ledgers = PageLedgers::new(Arc::new(|text: &str| text.to_owned()));
        for index in 0..40 {
            ledgers.push_failure(&format!("failure {index} Authorization: Bearer abcdefghijklmnop"));
        }
        assert_eq!(ledgers.failures.len(), 30);
        assert!(ledgers.failures[0].starts_with("failure 10 "));
        assert!(!ledgers.failures[0].contains("abcdefghijklmnop"), "{}", ledgers.failures[0]);
    }

    #[test]
    fn component_addresses_are_the_pdf_viewers_schemes() {
        assert!(is_browser_component_address("chrome-extension://abc/main.js"));
        assert!(is_browser_component_address("CHROME://resources/x"));
        assert!(!is_browser_component_address("https://a.test/chrome:"));
        assert!(!is_browser_component_address(""));
    }
}
