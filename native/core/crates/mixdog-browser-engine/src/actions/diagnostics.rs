//! Owner: s4-engine-actions-observe-nav
//! What the page has been doing (`actions/diagnostics.ts`): its health `status`, the `console` ledger, and the `network` ledger with
//! one request's detail. The ledgers and their reports are `ledger::*` and `reply::dialog_text`; what this module adds is the
//! command's arguments and, for one request's detail, the bodies Chromium still holds, which it asks the host for through CDP
//! (`Network.getRequestPostData`, `Network.getResponseBody`).

use mixdog_app_protocol::v2::browser_engine::HostBrowserCdpSendParams;
use mixdog_app_protocol::v2::browser_engine::PageFacts;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Value;
use serde_json::json;

use super::observe::ActionError;
use super::observe::PageCall;
use super::observe::number_arg;
use super::observe::string_arg;
use crate::error::HostCallError;
use crate::ledger::ingest::PageLedgers;
use crate::ledger::network::NetworkQuery;
use crate::ledger::network::NetworkRequest;
use crate::ledger::network_report::DetailOptions;
use crate::ledger::network_report::FetchedBodies;
use crate::ledger::network_report::ResponseBody;
use crate::ledger::network_report::list_report;
use crate::ledger::network_report::needs_post_data;
use crate::ledger::network_report::request_detail;
use crate::ledger::network_report::wants_response_body;
use crate::limits::CDP_REQUEST_TIMEOUT;
use crate::limits::READ_MAX_CHARS;
use crate::reply::dialog_text::status_text;
use crate::reply::reply::ToolReply;

/// `status`: the page, its state, the requests in flight, a blocking dialog, and the recent faults. It answers while a dialog blocks
/// the page.
pub fn status(facts: &PageFacts, ledgers: &PageLedgers) -> ToolReply {
    ToolReply::text(status_text(facts, ledgers))
}

/// `console`: the page's console entries at or above `level` (`error` by default), narrowed by `query`, at most `limit`.
pub fn console(ledgers: &PageLedgers, command: &Value) -> Result<ToolReply, ActionError> {
    let level = string_arg(command, "level");
    let query = string_arg(command, "query");
    ledgers.console.format(&level, &query, number_arg(command, "limit")).map(ToolReply::text).map_err(|error| ActionError::failed(error.to_string()))
}

/// One CDP read of what Chromium keeps of a request, in the request's own target. A failed read is `None` (the report says the body
/// is gone); only the command's cancellation ends the action.
async fn request_read(page: &PageCall<'_>, request: &NetworkRequest, method: &str) -> Result<Option<Value>, ActionError> {
    let params = HostBrowserCdpSendParams {
        page_id: page.page_id.to_owned(),
        session_id: request.session_id.clone(),
        method: method.to_owned(),
        params: Some(json!({"requestId": request.cdp_request_id})),
        timeout_ms: u32::try_from(CDP_REQUEST_TIMEOUT.as_millis()).ok(),
        expect: None,
    };
    match page.host.cdp_send(params, page.cancel.token()).await {
        Ok(answer) => Ok(Some(answer.result)),
        Err(HostCallError::Cancelled) => Err(ActionError::Host(HostCallError::Cancelled)),
        Err(_) if page.cancel.is_cancelled() => Err(ActionError::Host(HostCallError::Cancelled)),
        Err(_) => Ok(None),
    }
}

async fn fetch_bodies(page: &PageCall<'_>, request: &NetworkRequest) -> Result<FetchedBodies, ActionError> {
    let mut fetched = FetchedBodies::default();
    if needs_post_data(request) {
        fetched.post_data = request_read(page, request, "Network.getRequestPostData")
            .await?
            .map(|result| result.get("postData").and_then(Value::as_str).unwrap_or_default().to_owned());
    }
    if wants_response_body(request) {
        fetched.response = request_read(page, request, "Network.getResponseBody").await?.map(|result| ResponseBody {
            body: result.get("body").and_then(Value::as_str).unwrap_or_default().to_owned(),
            base64_encoded: result.get("base64Encoded").and_then(Value::as_bool).unwrap_or(false),
        });
    }
    Ok(fetched)
}

/// `network`: without `requestId`, the recorded requests (newest first, filtered by `query` and `resourceTypes`, at most `limit`);
/// with one, that request's headers, bodies and WebSocket frames. `now_ms` is the epoch time a request still in flight is measured
/// against.
pub async fn network(page: &PageCall<'_>, ledgers: &PageLedgers, command: &Value, now_ms: i64) -> Result<ToolReply, ActionError> {
    let request_id = js_trim(&string_arg(command, "requestId")).to_owned();
    if request_id.is_empty() {
        let query = NetworkQuery {
            query: string_arg(command, "query"),
            resource_types: command.get("resourceTypes").and_then(Value::as_array).map(|types| types.iter().map(value_to_string).collect()).unwrap_or_default(),
            limit: number_arg(command, "limit").map(|limit| limit.trunc() as i64),
        };
        return Ok(ToolReply::text(list_report(&ledgers.network, &query, now_ms)));
    }
    let Some(request) = ledgers.network.get(&request_id) else {
        return Err(ActionError::failed(format!("unknown network request \"{request_id}\"; call network without requestId to list requests")));
    };
    let fetched = fetch_bodies(page, request).await?;
    let options = DetailOptions {
        max_chars: number_arg(command, "maxChars"),
        frame_limit: number_arg(command, "frameLimit"),
        max_body_chars: READ_MAX_CHARS,
        now: now_ms,
    };
    Ok(ToolReply::text(request_detail(request, &fetched, &options)))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_rt::CancelSource;

    use super::*;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;

    fn ledgers() -> PageLedgers {
        PageLedgers::new(Arc::new(|text: &str| text.to_owned()))
    }

    /// A finished POST to `/api/items` (`10.1`), and a request still pending (`10.2`).
    fn with_requests(ledgers: &mut PageLedgers, has_post_data: bool) {
        let sent = json!({"requestId": "10.1", "type": "Fetch", "request": {"method": "POST", "url": "https://example.test/api/items",
            "headers": {"content-type": "application/json"}, "hasPostData": has_post_data}});
        ledgers.network.request_will_be_sent(&sent, None, 1_000);
        ledgers.network.response_received(
            &json!({"requestId": "10.1", "type": "Fetch", "response": {"status": 201, "statusText": "Created", "headers": {}, "mimeType": "application/json", "protocol": "h2"}}),
            None,
        );
        ledgers.network.loading_finished(&json!({"requestId": "10.1", "encodedDataLength": 123}), None, 1_075);
        ledgers.network.request_will_be_sent(&json!({"requestId": "10.2", "type": "Image", "request": {"method": "GET", "url": "https://example.test/a.png", "headers": {}}}), None, 1_080);
    }

    fn cdp(result: Value) -> Expect {
        Expect::ok("host/browser/cdp/send", json!({"result": result, "facts": page_facts("p1", 1)}))
    }

    async fn run(host: &FakeHost, ledgers: &PageLedgers, command: Value) -> Result<ToolReply, ActionError> {
        let source = CancelSource::new();
        let view = source.view();
        let page = PageCall { host, page_id: "p1", expect: None, cancel: &view };
        network(&page, ledgers, &command, 2_000).await
    }

    #[test]
    fn status_reports_the_page_and_its_pending_requests() {
        let mut ledgers = ledgers();
        with_requests(&mut ledgers, false);
        let facts: PageFacts = serde_json::from_value(page_facts("p1", 1)).expect("facts");
        let text = status(&facts, &ledgers).text;
        assert!(text.starts_with("Page: p1 — https://a.test/\nState: ready\nPending requests: 1"), "{text}");
    }

    #[test]
    fn console_lists_errors_by_default_and_refuses_an_unknown_level() {
        let mut ledgers = ledgers();
        ledgers.console.record("error", "boom");
        ledgers.console.record("info", "hello");
        let text = console(&ledgers, &json!({})).expect("lists").text;
        assert!(text.contains("- [error] boom") && !text.contains("hello"), "{text}");
        let all = console(&ledgers, &json!({"level": "ALL", "query": "HEL"})).expect("lists").text;
        assert!(all.contains("- [info] hello") && !all.contains("boom"), "{all}");
        assert_eq!(console(&ledgers, &json!({"query": "nothing"})).expect("says").text, "No console entries matched level=error and query=\"nothing\".");
        assert_eq!(console(&ledgers, &json!({"level": "loud"})), Err(ActionError::failed("console level must be all, debug, info, warning, or error")));
    }

    #[tokio::test]
    async fn the_network_list_names_every_request_and_says_when_a_filter_matches_none() {
        let host = FakeHost::scripted(Vec::new());
        let empty = run(&host, &ledgers(), json!({})).await.expect("answers").text;
        assert_eq!(empty, "No network requests have been recorded for this page.");
        let mut ledgers = ledgers();
        with_requests(&mut ledgers, false);
        let all = run(&host, &ledgers, json!({})).await.expect("lists").text;
        assert!(all.contains("[r1] POST fetch 201 Created 75ms https://example.test/api/items"), "{all}");
        assert!(all.contains("[r2] GET image pending 920ms https://example.test/a.png"), "{all}");
        let filtered = run(&host, &ledgers, json!({"resourceTypes": ["Fetch"], "query": "items"})).await.expect("lists").text;
        assert!(filtered.contains("[r1]") && !filtered.contains("[r2]"), "{filtered}");
        let none = run(&host, &ledgers, json!({"query": "zzz"})).await.expect("answers").text;
        assert_eq!(none, "No recorded network requests match the filter.");
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn one_request_is_shown_with_the_bodies_chromium_still_holds() {
        let mut ledgers = ledgers();
        with_requests(&mut ledgers, true);
        let host = FakeHost::scripted(vec![
            cdp(json!({"postData": "{\"name\":\"demo\"}"})).with_params(json!({"method": "Network.getRequestPostData", "params": {"requestId": "10.1"}})),
            cdp(json!({"body": "{\"ok\":true}", "base64Encoded": false})).with_params(json!({"method": "Network.getResponseBody", "params": {"requestId": "10.1"}})),
        ]);
        let text = run(&host, &ledgers, json!({"requestId": " r1 "})).await.expect("detail").text;
        assert!(text.starts_with("UNTRUSTED NETWORK DATA"), "{text}");
        assert!(text.contains("Request body:\n{\"name\":\"demo\"}") && text.contains("Response body:\n{\"ok\":true}"), "{text}");
        host.finish().expect("both bodies asked for");
    }

    #[tokio::test]
    async fn a_body_chromium_no_longer_has_is_said_so_and_a_pending_request_asks_for_nothing() {
        let mut ledgers = ledgers();
        with_requests(&mut ledgers, false);
        let host = FakeHost::scripted(vec![Expect::err("host/browser/cdp/send", HostCallError::Failed { message: "No resource with given identifier found".into() })]);
        let gone = run(&host, &ledgers, json!({"requestId": "r1"})).await.expect("detail").text;
        assert!(gone.contains("Response body is no longer available from Chromium."), "{gone}");
        let pending = run(&host, &ledgers, json!({"requestId": "r2"})).await.expect("detail").text;
        assert!(pending.contains("Response is still pending."), "{pending}");
        host.finish().expect("one read, for the finished request");
    }

    #[tokio::test]
    async fn an_unknown_request_id_says_how_to_list_them() {
        let host = FakeHost::scripted(Vec::new());
        let error = run(&host, &ledgers(), json!({"requestId": "r9"})).await.expect_err("unknown");
        assert_eq!(error, ActionError::failed("unknown network request \"r9\"; call network without requestId to list requests"));
    }

    #[tokio::test]
    async fn a_cancelled_command_does_not_turn_into_a_missing_body() {
        let mut ledgers = ledgers();
        with_requests(&mut ledgers, false);
        let host = FakeHost::scripted(Vec::new());
        let source = CancelSource::new();
        source.cancel("user takeover");
        let view = source.view();
        let page = PageCall { host: &host, page_id: "p1", expect: None, cancel: &view };
        let error = network(&page, &ledgers, &json!({"requestId": "r1"}), 2_000).await.expect_err("cancelled");
        assert_eq!(error, ActionError::Host(HostCallError::Cancelled));
    }
}
