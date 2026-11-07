//! The browser stage against a scripted DevTools server and a local origin,
//! and the hosted search against a scripted sender. No real browser, provider
//! or network.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use futures::SinkExt;
use futures::StreamExt;
use serde_json::Value;
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
use url::Url;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;

use super::hosted_search::*;
use super::pipeline::PageRenderer;
use super::render::BrowserEndpoint;
use super::render::BrowserRenderer;
use mixdog_core_api::domain::ext::BrowserHold;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use mixdog_core_api::ids::ThreadId;
use super::search::NativeSearchRequest;
use super::search::NativeWebSearch;
use super::ssrf::AddressPolicy;
use super::FetchKind;

struct Endpoint(String);

#[async_trait]
impl BrowserEndpoint for Endpoint {
    async fn lease(&self) -> Result<(String, BrowserHold), String> {
        Ok((self.0.clone(), Box::new(())))
    }
}

/// An endpoint that counts the holds that are alive.
struct Counting {
    url: String,
    live: Arc<AtomicUsize>,
}

struct CountedHold(Arc<AtomicUsize>);

impl Drop for CountedHold {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl BrowserEndpoint for Counting {
    async fn lease(&self) -> Result<(String, BrowserHold), String> {
        self.live.fetch_add(1, Ordering::SeqCst);
        Ok((self.url.clone(), Box::new(CountedHold(self.live.clone()))))
    }
}

/// What the scripted browser saw the client do.
#[derive(Default)]
struct Seen {
    methods: Vec<String>,
    fulfilled_status: Option<u64>,
    fulfilled_body: String,
}

/// A DevTools server that "loads" the page by pausing its document request
/// and waiting for the client to answer it, as Chromium does.
async fn fake_browser(page_url: Url) -> (String, Arc<Mutex<Seen>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/devtools/browser/x", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Seen::default()));
    let record = seen.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut navigate_id = 0;
        while let Some(Ok(Message::Text(text))) = socket.next().await {
            let frame: Value = serde_json::from_str(text.as_str()).unwrap();
            let id = frame["id"].as_u64().unwrap();
            let name = frame["method"].as_str().unwrap().to_string();
            record.lock().unwrap().methods.push(name.clone());
            let reply = |result: Value| Message::text(json!({ "id": id, "result": result }).to_string());
            let event = |method: &str, params: Value| {
                Message::text(json!({ "method": method, "params": params, "sessionId": "s1" }).to_string())
            };
            match name.as_str() {
                "Target.createBrowserContext" => socket.send(reply(json!({ "browserContextId": "c1" }))).await.unwrap(),
                "Target.createTarget" => socket.send(reply(json!({ "targetId": "t1" }))).await.unwrap(),
                "Target.attachToTarget" => socket.send(reply(json!({ "sessionId": "s1" }))).await.unwrap(),
                "Page.getFrameTree" => socket
                    .send(reply(json!({ "frameTree": { "frame": { "id": "f1", "url": page_url.as_str() } } })))
                    .await
                    .unwrap(),
                "Page.navigate" => {
                    navigate_id = id;
                    socket
                        .send(event(
                            "Fetch.requestPaused",
                            json!({
                                "requestId": "r1",
                                "resourceType": "Document",
                                "frameId": "f1",
                                "request": { "url": frame["params"]["url"], "method": "GET", "headers": {} },
                            }),
                        ))
                        .await
                        .unwrap();
                }
                "Fetch.fulfillRequest" => {
                    let body = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        frame["params"]["body"].as_str().unwrap(),
                    )
                    .unwrap();
                    {
                        let mut seen = record.lock().unwrap();
                        seen.fulfilled_status = frame["params"]["responseCode"].as_u64();
                        seen.fulfilled_body = String::from_utf8(body).unwrap();
                    }
                    socket.send(reply(json!({}))).await.unwrap();
                    let done = json!({ "id": navigate_id, "result": { "frameId": "f1", "loaderId": "L1" } });
                    socket.send(Message::text(done.to_string())).await.unwrap();
                    socket
                        .send(event("Page.lifecycleEvent", json!({ "name": "DOMContentLoaded", "frameId": "f1", "loaderId": "L1" })))
                        .await
                        .unwrap();
                }
                "Fetch.failRequest" => {
                    socket.send(reply(json!({}))).await.unwrap();
                    let failed = json!({ "id": navigate_id, "result": { "frameId": "f1", "errorText": "net::ERR_FAILED" } });
                    socket.send(Message::text(failed.to_string())).await.unwrap();
                }
                "Runtime.evaluate" => {
                    let expression = frame["params"]["expression"].as_str().unwrap();
                    let value = if expression.contains("innerText") {
                        json!(true)
                    } else {
                        json!(record.lock().unwrap().fulfilled_body.clone())
                    };
                    socket.send(reply(json!({ "result": { "type": "string", "value": value } }))).await.unwrap();
                }
                _ => socket.send(reply(json!({}))).await.unwrap(),
            }
        }
    });
    (endpoint, seen)
}

#[tokio::test]
async fn render_reads_the_page_through_the_request_gate() {
    let origin = MockServer::start().await;
    let body = "<title>Rendered</title><main><h1>Hi</h1><p>Script made this.</p></main>";
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(body.as_bytes().to_vec(), "text/html; charset=utf-8"))
        .mount(&origin)
        .await;
    let url = Url::parse(&format!("{}/p", origin.uri())).unwrap();
    let (endpoint, seen) = fake_browser(url.clone()).await;
    let renderer =
        BrowserRenderer::with_policy(Arc::new(Endpoint(endpoint)), AddressPolicy::AnyForTest, "test", super::lanes::WebLanes { extract: mixdog_rt::testing::tokens().cpu_interactive, dns: mixdog_rt::testing::tokens().interactive_io }).unwrap();
    let page = renderer.render(&url, Duration::from_secs(10)).await.unwrap();
    assert_eq!(page.title, "Rendered");
    assert_eq!(page.content, "# Hi\n\nScript made this.");
    assert_eq!(page.extractor, "puppeteer");
    let seen = seen.lock().unwrap();
    assert_eq!(seen.fulfilled_status, Some(200));
    assert_eq!(seen.fulfilled_body, body);
    assert!(seen.methods.contains(&"Target.disposeBrowserContext".to_string()));
}

#[tokio::test]
async fn render_holds_the_shared_browser_for_the_whole_render_and_lets_go_after() {
    let origin = MockServer::start().await;
    let body = "<title>Slow</title><main><p>Late.</p></main>";
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(body.as_bytes().to_vec(), "text/html; charset=utf-8")
                .set_delay(Duration::from_millis(300)),
        )
        .mount(&origin)
        .await;
    let url = Url::parse(&format!("{}/p", origin.uri())).unwrap();
    let (endpoint, _seen) = fake_browser(url.clone()).await;
    let live = Arc::new(AtomicUsize::new(0));
    let renderer = BrowserRenderer::with_policy(
        Arc::new(Counting { url: endpoint, live: live.clone() }),
        AddressPolicy::AnyForTest,
        "test",
        super::lanes::WebLanes { extract: mixdog_rt::testing::tokens().cpu_interactive, dns: mixdog_rt::testing::tokens().interactive_io },
    )
    .unwrap();
    let render = tokio::spawn({
        let url = url.clone();
        async move { renderer.render(&url, Duration::from_secs(10)).await }
    });
    // The page is being fetched for the browser: the render is under way.
    while origin.received_requests().await.unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    assert_eq!(live.load(Ordering::SeqCst), 1, "held while the render runs");
    render.await.unwrap().unwrap();
    assert_eq!(live.load(Ordering::SeqCst), 0, "released when the render ends");
}

#[tokio::test]
async fn render_refuses_a_private_document_before_it_reaches_the_browser() {
    let origin = MockServer::start().await;
    let url = Url::parse(&format!("{}/p", origin.uri())).unwrap();
    let (endpoint, seen) = fake_browser(url.clone()).await;
    let renderer = BrowserRenderer::new(Arc::new(Endpoint(endpoint)), "test", super::lanes::WebLanes { extract: mixdog_rt::testing::tokens().cpu_interactive, dns: mixdog_rt::testing::tokens().interactive_io }).unwrap();
    let error = renderer.render(&url, Duration::from_secs(10)).await.unwrap_err();
    assert_eq!(error.kind, FetchKind::Policy);
    assert_eq!(seen.lock().unwrap().fulfilled_status, None);
    assert!(origin.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn render_reports_an_unreachable_browser() {
    let free = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/devtools/browser/x", free.local_addr().unwrap());
    drop(free);
    let renderer = BrowserRenderer::new(Arc::new(Endpoint(endpoint)), "test", super::lanes::WebLanes { extract: mixdog_rt::testing::tokens().cpu_interactive, dns: mixdog_rt::testing::tokens().interactive_io }).unwrap();
    let url = Url::parse("https://example.com/").unwrap();
    let error = renderer.render(&url, Duration::from_secs(5)).await.unwrap_err();
    assert!(error.message.starts_with("puppeteer launch failed:"), "{error}");
}

struct Routes(Vec<SearchCandidate>);

#[async_trait]
impl SearchRoutes for Routes {
    async fn candidates(&self, _thread: &ThreadId) -> Result<Vec<SearchCandidate>, String> {
        Ok(self.0.clone())
    }
    async fn no_candidate_message(&self, _thread: &ThreadId) -> String {
        "no route".to_string()
    }
}

struct Sender {
    calls: Mutex<Vec<HostedSearchCall>>,
    replies: Mutex<Vec<Result<HostedSearchReply, HostedSearchError>>>,
}

#[async_trait]
impl HostedSearchSender for Sender {
    async fn send(&self, call: HostedSearchCall, _cancel: &CancellationToken) -> Result<HostedSearchReply, HostedSearchError> {
        self.calls.lock().unwrap().push(call);
        self.replies.lock().unwrap().remove(0)
    }
}

fn candidate(provider: &str, family: SearchFamily) -> SearchCandidate {
    SearchCandidate {
        provider: provider.into(),
        family,
        model: "m".into(),
        effort: None,
        fast: false,
        model_parameters: json!({}),
        tool_type: None,
    }
}

fn request(site: Option<&str>) -> NativeSearchRequest {
    NativeSearchRequest {
        thread: ThreadId::from("t"),
        query: "q".into(),
        site: site.map(str::to_string),
        locale: None,
        context_size: "high".into(),
        max_results: 7,
        prompt: "the prompt".into(),
    }
}

fn refusal(capacity: bool) -> HostedSearchError {
    HostedSearchError { message: "busy".into(), capacity }
}

fn search_with(candidates: Vec<SearchCandidate>, replies: Vec<Result<HostedSearchReply, HostedSearchError>>) -> (Arc<HostedWebSearch>, Arc<Sender>) {
    let sender = Arc::new(Sender { calls: Mutex::default(), replies: Mutex::new(replies) });
    (HostedWebSearch::new(Arc::new(Routes(candidates)), sender.clone()), sender)
}

#[tokio::test]
async fn a_capacity_refusal_moves_to_the_next_candidate() {
    let reply = HostedSearchReply {
        content: "  answer \n".into(),
        model: Some("served-model".into()),
        usage: Some(json!({ "input_tokens": 11, "output_tokens": 5 })),
        citations: vec![
            json!({ "uri": " https://a.example/x ", "name": "A" }),
            json!({ "url": "https://a.example/x", "title": "dup" }),
            json!({ "title": "no url" }),
        ],
        web_search_calls: vec![json!({ "action": { "query": "q1", "url": "https://b.example/", "urls": ["https://c.example/"] } })],
    };
    let (search, sender) = search_with(
        vec![candidate("openai-oauth", SearchFamily::Openai), candidate("anthropic", SearchFamily::Anthropic)],
        vec![Err(refusal(true)), Ok(reply)],
    );
    let result = search.search(request(Some("a.com OR site:B.com, a.com")), CancellationToken::new()).await.unwrap();
    assert_eq!(result.provider, "anthropic");
    assert_eq!(result.answer, "answer");
    assert_eq!(result.model.as_deref(), Some("served-model"));
    assert_eq!(result.usage, Some(json!({ "input_tokens": 11, "output_tokens": 5 })));
    let urls: Vec<_> = result.citations.iter().map(|c| (c.url.as_str(), c.title.as_str())).collect();
    assert_eq!(urls, [("https://a.example/x", "A"), ("https://b.example/", "q1"), ("https://c.example/", "q1")]);
    assert_eq!(result.calls[0].urls, ["https://b.example/", "https://c.example/"]);
    let calls = sender.calls.lock().unwrap();
    assert_eq!(calls[0].tool, json!({ "type": "web_search", "search_context_size": "high", "filters": { "allowed_domains": ["a.com", "b.com"] } }));
    assert_eq!(calls[0].include, ["web_search_call.action.sources"]);
    assert_eq!(calls[0].tool_choice, "required");
    assert_eq!(
        calls[1].tool,
        json!({ "type": "web_search_20250305", "name": "web_search", "max_uses": 7, "allowed_domains": ["a.com", "b.com"] })
    );
    assert!(calls[1].include.is_empty());
    assert_eq!(calls[1].user, "the prompt");
}

#[tokio::test]
async fn an_unnamed_model_falls_back_to_the_candidates() {
    let (search, _) = search_with(vec![candidate("xai", SearchFamily::Xai)], vec![Ok(HostedSearchReply::default())]);
    let result = search.search(request(None), CancellationToken::new()).await.unwrap();
    assert_eq!(result.model.as_deref(), Some("m"));
    assert_eq!(result.usage, None);
}

#[tokio::test]
async fn any_other_refusal_surfaces_without_trying_the_next_candidate() {
    let (search, sender) = search_with(
        vec![candidate("gemini", SearchFamily::Gemini), candidate("xai", SearchFamily::Xai)],
        vec![Err(refusal(false))],
    );
    let error = search.search(request(None), CancellationToken::new()).await.unwrap_err();
    assert_eq!(error, "busy");
    let calls = sender.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].tool, json!({ "type": "google_search" }));
    assert_eq!(calls[0].tool_choice, "auto");
}

#[tokio::test]
async fn exhausted_candidates_and_missing_routes_say_why() {
    let (search, _) = search_with(vec![candidate("xai", SearchFamily::Xai)], vec![Err(refusal(true))]);
    let error = search.search(request(None), CancellationToken::new()).await.unwrap_err();
    assert_eq!(error, "native web search failed: xai/m/web_search: busy");
    let (none, _) = search_with(Vec::new(), Vec::new());
    assert_eq!(none.search(request(None), CancellationToken::new()).await.unwrap_err(), "no route");
}
