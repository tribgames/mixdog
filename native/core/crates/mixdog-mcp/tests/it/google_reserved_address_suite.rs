//! The built-in Google connectors answer at a reserved address that never resolves (`https://<service>.mixdog.invalid/mcp`): which
//! URLs are theirs, and how transport, authentication and tool failures are reported.

use async_trait::async_trait;
use mixdog_mcp::google_mcp::GoogleFetch;
use mixdog_mcp::google_mcp::GoogleReply;
use mixdog_mcp::google_mcp::GoogleRequest;
use mixdog_mcp::google_mcp::answer;
use mixdog_mcp::google_mcp::mcp_url;
use mixdog_mcp::google_mcp::service;
use serde_json::json;
use url::Url;

/// Google is never reached by what these tests ask.
struct NoGoogle;

#[async_trait]
impl GoogleFetch for NoGoogle {
    async fn fetch(&self, request: GoogleRequest) -> Result<GoogleReply, String> {
        panic!("a request to Google was made: {}", request.url)
    }
}

const NOW_MS: i64 = 1_800_000_000_000;

async fn ask(url: &str, method: &str, authorization: Option<&str>, body: &str) -> mixdog_mcp::google_mcp::Answer {
    answer(&Url::parse(url).unwrap(), method, authorization, body.as_bytes(), &NoGoogle, NOW_MS).await.unwrap()
}

#[test]
fn only_https_addresses_of_the_three_reserved_hosts_are_the_connectors() {
    for (name, url) in
        [("gmail", "https://gmail.mixdog.invalid/mcp"), ("calendar", "https://calendar.mixdog.invalid/mcp"), ("drive", "https://drive.mixdog.invalid/anything")]
    {
        assert_eq!(service(&Url::parse(url).unwrap()), Some(name), "{url}");
    }
    assert_eq!(mcp_url("gmail"), "https://gmail.mixdog.invalid/mcp");
    for url in [
        "http://gmail.mixdog.invalid/mcp",
        "https://mail.mixdog.invalid/mcp",
        "https://gmail.example.com/mcp",
        "https://gmail.mixdog.invalid.evil.example/mcp",
        "https://xgmail.mixdog.invalid/mcp",
    ] {
        assert_eq!(service(&Url::parse(url).unwrap()), None, "{url}");
    }
}

#[tokio::test]
async fn an_address_that_is_no_connector_or_names_no_page_is_not_found() {
    let missing = ask("https://gmail.example.com/mcp", "POST", None, "{}").await;
    assert_eq!((missing.status, missing.body), (404, Some(json!({"error": "not_found"}))));
    let other_path = ask("https://gmail.mixdog.invalid/other", "POST", Some("Bearer t"), "{}").await;
    assert_eq!((other_path.status, other_path.body), (404, Some(json!({"error": "not_found"}))));
}

#[tokio::test]
async fn the_sign_in_metadata_names_google_as_the_authorization_server_for_any_method() {
    for method in ["GET", "POST"] {
        let metadata = ask("https://calendar.mixdog.invalid/.well-known/oauth-protected-resource/mcp", method, None, "").await;
        assert_eq!(metadata.status, 200);
        assert_eq!(
            metadata.body,
            Some(
                json!({"resource": "https://calendar.mixdog.invalid/mcp", "authorization_servers": ["https://accounts.google.com"], "bearer_methods_supported": ["header"]})
            )
        );
    }
}

#[tokio::test]
async fn only_post_reaches_the_server_and_without_a_bearer_token_it_is_told_where_to_sign_in() {
    let get = ask("https://gmail.mixdog.invalid/mcp", "GET", Some("Bearer t"), "").await;
    assert_eq!((get.status, get.allow, get.body), (405, Some("POST"), None));
    let challenge = "Bearer resource_metadata=\"https://gmail.mixdog.invalid/.well-known/oauth-protected-resource/mcp\"";
    for authorization in [None, Some("Basic abc"), Some("Bearer"), Some("Bearer two words")] {
        let refused = ask("https://gmail.mixdog.invalid/mcp", "post", authorization, "{}").await;
        assert_eq!(refused.status, 401, "{authorization:?}");
        assert_eq!(refused.www_authenticate.as_deref(), Some(challenge), "{authorization:?}");
        assert_eq!(refused.body, Some(json!({"error": "invalid_token"})));
    }
}

#[tokio::test]
async fn a_body_that_is_not_json_is_a_parse_error_and_a_notification_is_accepted_with_no_answer() {
    let garbled = ask("https://gmail.mixdog.invalid/mcp", "POST", Some("Bearer t"), "{not json").await;
    assert_eq!(garbled.status, 400);
    assert_eq!(garbled.body, Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Parse error"}})));
    let notice = ask("https://gmail.mixdog.invalid/mcp", "POST", Some("Bearer t"), r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await;
    assert_eq!((notice.status, notice.body), (202, None));
}

#[tokio::test]
async fn a_failed_google_api_request_returns_a_tool_error() {
    struct Offline;

    #[async_trait]
    impl GoogleFetch for Offline {
        async fn fetch(&self, _: GoogleRequest) -> Result<GoogleReply, String> {
            Err("connection lost".to_owned())
        }
    }

    let reply = answer(
        &Url::parse(&mcp_url("calendar")).unwrap(),
        "POST",
        Some("Bearer t"),
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_events"}}"#,
        &Offline,
        NOW_MS,
    )
    .await
    .unwrap();
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.body,
        Some(json!({
            "jsonrpc": "2.0", "id": 1,
            "result": {"content": [{"type": "text", "text": "connection lost"}], "isError": true}
        }))
    );
}

#[tokio::test]
async fn google_dispatch_does_not_coerce_method_names_or_argument_types() {
    let reply = ask(
        &mcp_url("calendar"),
        "POST",
        Some("Bearer t"),
        r#"[
        {"id":1,"method":["tools/list"]},
        {"id":2,"method":"tools/call","params":{"name":["list_events"]}},
        {"id":3,"method":"tools/call","params":{"name":"list_events","arguments":false}},
        {"id":4,"method":"tools/call","params":{"name":"list_events","arguments":{"maxResults":"2"}}}
    ]"#,
    )
    .await
    .body
    .unwrap();
    assert_eq!(reply[0]["error"]["code"], -32600);
    assert_eq!(reply[1]["error"]["code"], -32602);
    assert_eq!(reply[2]["error"]["code"], -32602);
    assert_eq!(reply[3]["result"]["isError"], true);
}

#[tokio::test]
async fn malformed_google_collections_are_not_empty_successes() {
    struct Payload(&'static str);
    #[async_trait]
    impl GoogleFetch for Payload {
        async fn fetch(&self, _: GoogleRequest) -> Result<GoogleReply, String> {
            Ok(GoogleReply { status: 200, body: self.0.into() })
        }
    }
    for (service, tool, empty, malformed, no_rows) in [
        ("calendar", "list_events", r#"{"items":[]}"#, r#"{"items":{}}"#, "No events."),
        ("drive", "search_files", r#"{"files":[]}"#, r#"{"files":[null]}"#, "No files."),
    ] {
        let call = json!({"id": 1, "method": "tools/call", "params": {"name": tool}}).to_string();
        for (payload, is_error) in [(empty, false), ("{}", false), (malformed, true), ("null", true)] {
            let response = answer(&Url::parse(&mcp_url(service)).unwrap(), "POST", Some("Bearer t"), call.as_bytes(), &Payload(payload), NOW_MS).await.unwrap();
            let body = response.body.unwrap();
            assert_eq!(body["result"]["isError"] == true, is_error, "{body}");
            assert_eq!(body["result"]["content"][0]["text"] == no_rows, !is_error, "{body}");
        }
    }
}
