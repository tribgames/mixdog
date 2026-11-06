//! Extraction corpus gate (D4) and web tool behaviour against local fake servers.

use std::path::PathBuf;

use serde_json::Value;
use url::Url;

use super::extract::extract_document;
use super::ssrf::AddressPolicy;

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/web/corpus/cases")
}

struct Case {
    name: String,
    url: Url,
    content_type: String,
    body: String,
    expected: Value,
}

fn corpus() -> Vec<Case> {
    let mut names: Vec<String> = std::fs::read_dir(corpus_dir())
        .expect("corpus directory")
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().into_string().ok()?;
            name.strip_suffix(".json").map(str::to_string)
        })
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let meta: Value =
                serde_json::from_str(&std::fs::read_to_string(corpus_dir().join(format!("{name}.json"))).unwrap()).unwrap();
            let body = std::fs::read_to_string(corpus_dir().join(format!("{name}.body"))).unwrap();
            Case {
                url: Url::parse(meta["url"].as_str().unwrap()).unwrap(),
                content_type: meta["contentType"].as_str().unwrap().to_string(),
                expected: meta["expected"].clone(),
                name,
                body,
            }
        })
        .collect()
}

/// Multiset F1 over whitespace-separated words.
fn word_f1(got: &str, want: &str) -> f64 {
    use std::collections::HashMap;
    let count = |text: &str| {
        let mut map: HashMap<String, usize> = HashMap::new();
        for word in text.split_whitespace() {
            *map.entry(word.to_string()).or_default() += 1;
        }
        map
    };
    let (a, b) = (count(got), count(want));
    let shared: usize = a.iter().map(|(word, n)| (*n).min(*b.get(word).unwrap_or(&0))).sum();
    let (na, nb) = (a.values().sum::<usize>(), b.values().sum::<usize>());
    if na + nb == 0 {
        return 1.0;
    }
    2.0 * shared as f64 / (na + nb) as f64
}

/// D4 gate: pages whose text sits in a semantic container, raw documents and
/// empty shells must match today's Node extraction exactly. The article
/// extractor (no container holds text) is a different implementation of the
/// same algorithm, so it is held to an exact-match share and word-level F1.
#[test]
fn corpus_gate() {
    let mut article_cases = 0usize;
    let mut article_exact = 0usize;
    let mut article_f1 = 0.0;
    let mut failures = Vec::new();
    let cases = corpus();
    assert!(cases.len() >= 60, "corpus is recorded");
    for case in &cases {
        let got = extract_document(&case.url, &case.body, &case.content_type);
        let want = &case.expected;
        if !want["ok"].as_bool().unwrap() {
            match got {
                Err(error) => assert_eq!(error.code(), "EMPTY_CONTENT", "{}", case.name),
                Ok(_) => failures.push(format!("{}: expected an empty-content error", case.name)),
            }
            continue;
        }
        let page = match got {
            Ok(page) => page,
            Err(error) => {
                failures.push(format!("{}: unexpected error {error}", case.name));
                continue;
            }
        };
        let (content, title) = (want["content"].as_str().unwrap(), want["title"].as_str().unwrap());
        if want["extractor"] == "readability" {
            article_cases += 1;
            article_f1 += word_f1(&page.content, content);
            if page.extractor == "readability" && page.content == content && page.title == title {
                article_exact += 1;
            }
        } else if page.extractor != want["extractor"].as_str().unwrap() || page.content != content || page.title != title {
            failures.push(format!("{}: differs from the Node extraction", case.name));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
    assert!(article_cases >= 20);
    assert!(article_exact * 100 >= article_cases * 55, "article exact {article_exact}/{article_cases}");
    assert!(article_f1 / article_cases as f64 >= 0.94, "article mean F1 {}", article_f1 / article_cases as f64);
}

fn url(text: &str) -> Url {
    Url::parse(text).unwrap()
}

#[test]
fn missing_href_and_src_make_no_link() {
    let body = "<main><p><a>plain</a> <img alt=\"x\"></p></main>";
    let page = extract_document(&url("https://e.com/d/p"), body, "text/html").unwrap();
    assert_eq!(page.content, "plain");
}

#[test]
fn public_policy_blocks_non_global_addresses() {
    let public = AddressPolicy::PublicOnly;
    for blocked in [
        "http://127.0.0.1/", "http://localhost/", "http://10.1.2.3/", "http://172.16.0.1/", "http://192.168.1.1/",
        "http://169.254.169.254/", "http://100.64.0.1/", "http://0.0.0.0/", "http://224.0.0.1/", "http://[::1]/",
        "http://[::]/", "http://[fe80::1]/", "http://[fc00::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
        "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/", "http://[2001:db8::1]/", "http://0x7f.1/",
        "http://2130706433/", "ftp://example.com/", "http://user:pw@example.com/",
    ] {
        assert!(public.check_url(&url(blocked)).is_err(), "{blocked}");
    }
    for allowed in ["http://93.184.216.34/", "https://example.com/x", "http://[2606:2800:220:1::1]/"] {
        assert!(public.check_url(&url(allowed)).is_ok(), "{allowed}");
    }
}

#[test]
fn loopback_policy_allows_only_loopback() {
    let local = AddressPolicy::LoopbackOnly;
    for allowed in ["http://127.0.0.1:8080/", "http://localhost/", "http://[::1]/"] {
        assert!(local.check_url(&url(allowed)).is_ok(), "{allowed}");
    }
    for blocked in ["http://example.com/", "http://10.0.0.1/", "http://127.0.0.1@evil.com/"] {
        assert!(local.check_url(&url(blocked)).is_err(), "{blocked}");
    }
}

mod pagination {
    use super::super::format::continuation;
    use super::super::format::paginate;

    #[test]
    fn windows_are_utf16_and_never_split_a_pair() {
        let text = "a\u{1F600}b";
        let first = paginate(text, 0, Some(2));
        assert_eq!((first.content.as_str(), first.end, first.next_start), ("a", 1, Some(1)));
        let rest = paginate(text, 1, Some(0));
        assert_eq!((rest.content.as_str(), rest.total_length, rest.has_more), ("\u{1F600}b", 4, false));
    }

    #[test]
    fn default_window_is_capped_and_marked() {
        let text = "x".repeat(25_000);
        let window = paginate(&text, 0, None);
        assert_eq!((window.end, window.capped), (20_000, true));
        assert!(continuation(&window).contains("startIndex:20000 for more"));
        let asked = paginate(&text, 0, Some(100));
        assert!(!asked.capped);
        assert!(continuation(&asked).starts_with("\n\n[chars 0-100 of 25000;"));
    }

    #[test]
    fn start_past_end_is_empty() {
        let window = paginate("abc", 9, None);
        assert_eq!((window.content.as_str(), window.has_more, window.next_start), ("", false, None));
    }
}

mod tools {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use async_trait::async_trait;
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::mock::MockApprovalGate;
    use mixdog_core_api::domain::mock::MockFileService;
    use mixdog_core_api::domain::mock::MockProcessManager;
    use mixdog_core_api::domain::mock::MockProgress;
    use mixdog_core_api::domain::tool::*;
    use mixdog_protocol::ThreadId;
    use mixdog_protocol::ToolCallId;
    use mixdog_protocol::TurnId;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;
    use url::Url;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;
    use wiremock::matchers::header;
    use wiremock::matchers::method;
    use wiremock::matchers::path;

    use super::super::*;
    use super::AddressPolicy;

    fn ctx(tool: &str, cancel: CancellationToken) -> ToolContext {
        let tokens = mixdog_rt::testing::tokens();
        ToolContext {
            call_id: ToolCallId::from("c"),
            thread_id: ThreadId::from("t"),
            turn_id: TurnId::from("r"),
            tool: tool.into(),
            cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
            surface: SurfaceKind::Lead,
            cancel,
            deadline: None,
            progress: Arc::new(MockProgress::default()),
            io: ToolIo {
                interactive: tokens.interactive_io,
                durability: tokens.durability_io,
                maintenance: tokens.maintenance_io,
            },
            approvals: Arc::new(MockApprovalGate::default()),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(MockProcessManager::default()),
            options: Default::default(),
        }
    }

    fn service(configure: impl FnOnce(&mut WebConfig)) -> Arc<WebService> {
        let mut config = WebConfig::new("test");
        config.public_policy = AddressPolicy::AnyForTest;
        configure(&mut config);
        WebService::new(config).unwrap()
    }

    async fn call(service: &Arc<WebService>, name: &str, args: serde_json::Value) -> ToolOutcome {
        let tool = service.tools().into_iter().find(|t| t.spec().name == name).unwrap();
        tool.call(&ctx(name, CancellationToken::new()), args).await
    }

    fn text(outcome: &ToolOutcome) -> String {
        match outcome {
            Ok(output) => output
                .parts
                .iter()
                .filter_map(|part| if let ToolPart::Text(t) = part { Some(t.as_str()) } else { None })
                .collect::<Vec<_>>()
                .join("\n"),
            Err(error) => error.message_for_model.clone(),
        }
    }

    fn html(body: &str) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_raw(body.as_bytes().to_vec(), "text/html; charset=utf-8")
    }

    async fn page(server: &MockServer, route: &str, body: &str) {
        Mock::given(method("GET")).and(path(route)).respond_with(html(body)).mount(server).await;
    }

    #[tokio::test]
    async fn web_fetch_extracts_titles_and_windows() {
        let server = MockServer::start().await;
        page(&server, "/p", "<title>Hello</title><main><h1>Hi</h1><p>Body text here.</p></main>").await;
        let web = service(|_| {});
        let out = call(&web, "web_fetch", json!({"url": format!("{}/p", server.uri())})).await;
        let shown = text(&out);
        assert!(shown.contains("title: Hello"), "{shown}");
        assert!(shown.ends_with("# Hi\n\nBody text here."), "{shown}");
        assert!(shown.contains("range=0.."), "{shown}");
        let windowed = call(&web, "web_fetch", json!({"url": format!("{}/p", server.uri()), "maxLength": 4})).await;
        assert!(text(&windowed).contains("startIndex:4 for more"), "{}", text(&windowed));
    }

    #[tokio::test]
    async fn identical_fetches_hit_the_cache() {
        let server = MockServer::start().await;
        Mock::given(path("/c")).respond_with(html("<main>cached</main>")).expect(1).mount(&server).await;
        let web = service(|_| {});
        let args = json!({"url": format!("{}/c", server.uri())});
        assert!(call(&web, "web_fetch", args.clone()).await.is_ok());
        assert!(call(&web, "web_fetch", args).await.is_ok());
    }

    #[tokio::test]
    async fn public_policy_refuses_loopback_before_connecting() {
        let server = MockServer::start().await;
        Mock::given(path("/x")).respond_with(html("<main>secret</main>")).expect(0).mount(&server).await;
        let web = WebService::new(WebConfig::new("test")).unwrap();
        let out = call(&web, "web_fetch", json!({"url": format!("{}/x", server.uri())})).await;
        let shown = text(&out);
        assert!(out.is_err());
        assert!(shown.contains("Blocked request to private address: 127.0.0.1"), "{shown}");
        assert!(shown.contains("errorCode: Error"), "{shown}");
    }

    /// Node 22: `formatResponse('fetch', …)` of the item `handleToolCall` builds when `assertPublicUrl`
    /// throws: the message, `errorCode: 'Error'` (the error's name) and no diagnostics.
    #[tokio::test]
    async fn address_policy_block_is_nodes_plain_error_item() {
        let web = WebService::new(WebConfig::new("test")).unwrap();
        let private = text(&call(&web, "web_fetch", json!({"url": "http://127.0.0.1:9/x"})).await);
        assert_eq!(
            private,
            "[http://127.0.0.1:9/x]\n(error: Blocked request to private address: 127.0.0.1)\nerrorCode: Error"
        );
        let userinfo = text(&call(&web, "web_fetch", json!({"url": "http://user:p@example.com/"})).await);
        assert_eq!(
            userinfo,
            "[http://user:p@example.com/]\n(error: Blocked URL with userinfo credentials: example.com)\nerrorCode: Error"
        );
    }

    #[tokio::test]
    async fn redirects_are_followed_and_bounded() {
        let server = MockServer::start().await;
        Mock::given(path("/a")).respond_with(ResponseTemplate::new(302).insert_header("location", "/b")).mount(&server).await;
        page(&server, "/b", "<main>landed</main>").await;
        Mock::given(path("/loop")).respond_with(ResponseTemplate::new(302).insert_header("location", "/loop")).mount(&server).await;
        let web = service(|_| {});
        let ok = text(&call(&web, "web_fetch", json!({"url": format!("{}/a", server.uri())})).await);
        assert!(ok.starts_with(&format!("{}/b", server.uri())), "{ok}");
        let bad = text(&call(&web, "web_fetch", json!({"url": format!("{}/loop", server.uri())})).await);
        assert!(bad.contains("Too many redirects (max 5)"), "{bad}");
    }

    #[tokio::test]
    async fn cookies_live_for_one_fetch_chain() {
        let server = MockServer::start().await;
        Mock::given(path("/set"))
            .respond_with(ResponseTemplate::new(302).insert_header("set-cookie", "k=v; Path=/").insert_header("location", "/need"))
            .mount(&server)
            .await;
        Mock::given(path("/need")).and(header("cookie", "k=v")).respond_with(html("<main>has cookie</main>")).mount(&server).await;
        Mock::given(path("/need")).respond_with(ResponseTemplate::new(401)).mount(&server).await;
        let web = service(|_| {});
        let ok = text(&call(&web, "web_fetch", json!({"url": format!("{}/set", server.uri())})).await);
        assert!(ok.ends_with("has cookie"), "{ok}");
        let fresh = text(&call(&web, "web_fetch", json!({"url": format!("{}/need", server.uri())})).await);
        assert!(fresh.contains("LOGIN_REQUIRED"), "{fresh}");
    }

    #[tokio::test]
    async fn body_policies() {
        let server = MockServer::start().await;
        Mock::given(path("/img")).respond_with(ResponseTemplate::new(200).set_body_raw(vec![1u8, 2], "image/png")).mount(&server).await;
        Mock::given(path("/big"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(vec![b'a'; 10 * 1024 * 1024 + 1], "text/plain"))
            .mount(&server)
            .await;
        let web = service(|_| {});
        let img = text(&call(&web, "web_fetch", json!({"url": format!("{}/img", server.uri())})).await);
        assert!(img.contains("Blocked non-text content-type: image/png"), "{img}");
        let big = text(&call(&web, "web_fetch", json!({"url": format!("{}/big", server.uri())})).await);
        assert!(big.contains("response body too large"), "{big}");
    }

    #[tokio::test]
    async fn declared_charset_is_decoded() {
        let server = MockServer::start().await;
        let (bytes, _, _) = encoding_rs::EUC_KR.encode("<main><p>한국어 문서</p></main>");
        Mock::given(path("/k"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(bytes.into_owned(), "text/html; charset=euc-kr"))
            .mount(&server)
            .await;
        let web = service(|_| {});
        let out = text(&call(&web, "web_fetch", json!({"url": format!("{}/k", server.uri())})).await);
        assert!(out.ends_with("한국어 문서"), "{out}");
    }

    #[tokio::test]
    async fn meta_refresh_is_followed() {
        let server = MockServer::start().await;
        page(&server, "/stub", "<head><meta http-equiv=\"refresh\" content=\"0; url=/real\"></head><body>stub</body>").await;
        page(&server, "/real", "<main>the real page</main>").await;
        let web = service(|_| {});
        let out = text(&call(&web, "web_fetch", json!({"url": format!("{}/stub", server.uri())})).await);
        assert!(out.ends_with("the real page"), "{out}");
    }

    #[tokio::test]
    async fn transient_status_is_retried_once_and_traced() {
        let server = MockServer::start().await;
        Mock::given(path("/flaky")).respond_with(ResponseTemplate::new(503)).up_to_n_times(1).mount(&server).await;
        page(&server, "/flaky", "<main>second try</main>").await;
        let web = service(|_| {});
        let out = text(&call(&web, "web_fetch", json!({"url": format!("{}/flaky", server.uri())})).await);
        assert!(out.contains("attempts: http=HTTP_ERROR"), "{out}");
        assert!(out.contains("-> http=success"), "{out}");
        assert!(out.contains("failure: http [HTTP_ERROR] HTTP 503: HTTP 503"), "{out}");
        assert!(out.ends_with("second try"), "{out}");
    }

    #[tokio::test]
    async fn permanent_status_fails_without_retry() {
        let server = MockServer::start().await;
        Mock::given(path("/gone")).respond_with(ResponseTemplate::new(404)).expect(1).mount(&server).await;
        let web = service(|_| {});
        let out = call(&web, "web_fetch", json!({"url": format!("{}/gone", server.uri())})).await;
        let shown = text(&out);
        assert!(out.is_err());
        assert!(shown.contains("(error: HTTP 404)") && shown.contains("errorCode: HTTP_ERROR"), "{shown}");
    }

    struct FakeRenderer;

    #[async_trait]
    impl PageRenderer for FakeRenderer {
        async fn render(&self, url: &Url, _budget: Duration) -> Result<StagePage, FetchError> {
            Ok(StagePage { url: url.to_string(), title: "Rendered".into(), content: "rendered body".into(), extractor: "puppeteer".into(), excerpt_json_len: 2, ..StagePage::default() })
        }
    }

    #[tokio::test]
    async fn blocked_page_falls_through_to_the_render_stage() {
        let server = MockServer::start().await;
        Mock::given(path("/wall")).respond_with(ResponseTemplate::new(403)).mount(&server).await;
        Mock::given(path("/limited")).respond_with(ResponseTemplate::new(404)).mount(&server).await;
        let web = service(|c| c.renderer = Some(Arc::new(FakeRenderer)));
        let out = text(&call(&web, "web_fetch", json!({"url": format!("{}/wall", server.uri())})).await);
        assert!(out.contains("title: Rendered") && out.ends_with("rendered body"), "{out}");
        assert!(out.contains("failure: http [HTTP_BLOCKED] HTTP 403"), "{out}");
        let missing = call(&web, "web_fetch", json!({"url": format!("{}/limited", server.uri())})).await;
        assert!(missing.is_err(), "a 404 is not rendered");
    }

    #[tokio::test]
    async fn invalid_urls_are_argument_errors() {
        let web = service(|_| {});
        for args in [json!({"url": "not a url"}), json!({"url": ["  "]}), json!({})] {
            let error = call(&web, "web_fetch", args).await.unwrap_err();
            assert!(matches!(error.code, ToolErrorCode::InvalidArgs { .. }));
        }
    }

    #[tokio::test]
    async fn local_fetch_reaches_loopback_only() {
        let server = MockServer::start().await;
        Mock::given(path("/t")).respond_with(ResponseTemplate::new(200).set_body_raw("local text", "text/plain")).mount(&server).await;
        let web = WebService::new(WebConfig::new("test")).unwrap();
        let out = text(&call(&web, "local_fetch", json!({"url": format!("{}/t", server.uri())})).await);
        assert_eq!(out, format!("{}/t\n\nlocal text", server.uri()));
        let remote = text(&call(&web, "local_fetch", json!({"url": "http://example.com/"})).await);
        assert!(remote.contains("Blocked non-loopback local_fetch target: example.com"), "{remote}");
        let many: Vec<String> = (0..9).map(|i| format!("http://127.0.0.1:1/{i}")).collect();
        let batch = text(&call(&web, "local_fetch", json!({"url": many})).await);
        assert!(batch.contains("fetch batch exceeds maximum of 8 URLs"), "{batch}");
    }

    #[tokio::test]
    async fn image_fetch_returns_bytes_and_stays_on_one_host() {
        let server = MockServer::start().await;
        Mock::given(path("/i.png")).respond_with(ResponseTemplate::new(200).set_body_raw(vec![7u8; 5], "image/png")).mount(&server).await;
        page(&server, "/not-image", "<main>x</main>").await;
        let hop = format!("http://localhost:{}/i.png", server.address().port());
        Mock::given(path("/away")).respond_with(ResponseTemplate::new(302).insert_header("location", hop.as_str())).mount(&server).await;
        let web = service(|_| {});
        let out = call(&web, "image_fetch", json!({"url": format!("{}/i.png", server.uri())})).await.unwrap();
        assert!(matches!(&out.parts[0], ToolPart::Text(t) if t.ends_with("(image/png, 5 bytes)")));
        assert!(matches!(&out.parts[1], ToolPart::Image { mime, data: ImageData::Bytes(b) } if mime == "image/png" && b.len() == 5));
        let wrong = text(&call(&web, "image_fetch", json!({"url": format!("{}/not-image", server.uri())})).await);
        assert!(wrong.contains("Blocked unsupported image content-type: text/html"), "{wrong}");
        let away = text(&call(&web, "image_fetch", json!({"url": format!("{}/away", server.uri())})).await);
        assert!(away.contains("cross-host redirect blocked"), "{away}");
    }

    struct FakeSearch {
        calls: AtomicUsize,
        cancelled: AtomicUsize,
    }

    #[async_trait]
    impl NativeWebSearch for FakeSearch {
        async fn search(&self, request: NativeSearchRequest, cancel: CancellationToken) -> Result<NativeSearchResult, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if request.query == "boom" {
                return Err("provider exploded".into());
            }
            let delay = if request.query == "slow" { 60_000 } else { 80 };
            tokio::select! {
                () = cancel.cancelled() => {
                    self.cancelled.fetch_add(1, Ordering::SeqCst);
                    Err("cancelled".into())
                }
                () = tokio::time::sleep(Duration::from_millis(delay)) => Ok(NativeSearchResult {
                    provider: "fake".into(),
                    answer: format!("answer for {}", request.query),
                    citations: vec![
                        NativeSource { url: "https://a.example/1".into(), title: "First".into(), snippet: " snip  one ".into(), published_date: None },
                        NativeSource { url: "https://a.example/1".into(), title: "Dup".into(), ..NativeSource::default() },
                    ],
                    calls: vec![SearchCall { query: request.query.clone(), sources: vec![], urls: vec!["https://b.example/2".into()] }],
                    model: Some("fake-model".into()),
                    usage: Some(json!({ "input_tokens": 3 })),
                }),
            }
        }
    }

    fn searcher() -> (Arc<FakeSearch>, Arc<WebService>) {
        let fake = Arc::new(FakeSearch { calls: AtomicUsize::new(0), cancelled: AtomicUsize::new(0) });
        let web = service(|c| c.search = Some(fake.clone()));
        (fake, web)
    }

    #[tokio::test]
    async fn identical_searches_share_one_provider_call_and_cache() {
        let (fake, web) = searcher();
        let (a, b) = tokio::join!(
            call(&web, "web_search", json!({"query": "rust"})),
            call(&web, "web_search", json!({"query": " rust "})),
        );
        let first = text(&a);
        assert_eq!(first, text(&b));
        assert_eq!(first, "answer for rust\n\n1. First\n   https://a.example/1\n   snip one\n\n2. https://b.example/2");
        call(&web, "web_search", json!({"query": "rust"})).await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn last_waiter_leaving_cancels_the_provider_call() {
        let (fake, web) = searcher();
        let token = CancellationToken::new();
        let tool = web.tools().into_iter().find(|t| t.spec().name == "web_search").unwrap();
        let running = tokio::spawn({
            let token = token.clone();
            async move { tool.call(&ctx("web_search", token), json!({"query": "slow"})).await }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        token.cancel();
        assert!(running.await.unwrap().is_err());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(fake.cancelled.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn batch_search_keeps_successes_and_reports_failures() {
        let (_, web) = searcher();
        let error = call(&web, "web_search", json!({"query": ["rust", "boom", "rust"]})).await.unwrap_err();
        assert!(error.message_for_model.starts_with("[web_search] 1/2 queries failed; successful results are retained.\n\n### Query: rust"));
        assert!(error.message_for_model.contains("### Query: boom\n\nWeb search failed: provider exploded"));
        assert!(error.partial.is_some());
    }

    #[tokio::test]
    async fn search_without_a_provider_is_unavailable() {
        let web = service(|_| {});
        let error = call(&web, "web_search", json!({"query": "x"})).await.unwrap_err();
        assert_eq!(
            error.message_for_model,
            "Web search failed: web search provider unavailable: open /websearch to choose a web search provider/model"
        );
        assert!(matches!(error.code, ToolErrorCode::Unavailable { .. }));
        let bad = call(&web, "web_search", json!({"query": "x", "maxResults": 99})).await.unwrap_err();
        assert!(matches!(bad.code, ToolErrorCode::InvalidArgs { .. }));
    }

    #[test]
    fn tool_specs_match_the_published_surface() {
        let web = service(|_| {});
        let names: Vec<String> = web.tools().iter().map(|t| t.spec().name.clone()).collect();
        assert_eq!(names, ["web_search", "web_fetch", "local_fetch", "image_fetch"]);
        let local = web.tools().into_iter().find(|t| t.spec().name == "local_fetch").unwrap();
        assert_eq!(local.spec().annotations.open_world_hint, Some(false));
    }

    #[test]
    fn runtime_only_targets_are_hidden_from_the_agent() {
        let web = service(|_| {});
        let hidden: Vec<(String, bool)> =
            web.tools().iter().map(|t| (t.spec().name.clone(), t.spec().annotations.agent_hidden)).collect();
        assert_eq!(
            hidden,
            [
                ("web_search".to_string(), false),
                ("web_fetch".to_string(), false),
                ("local_fetch".to_string(), true),
                ("image_fetch".to_string(), true),
            ]
        );
    }

    /// Every expected text is `JSON.stringify({ error: 'Invalid arguments', details: error.issues })`
    /// printed by Node 22 with zod 4.6 for the schema in `index.mjs`.
    #[tokio::test]
    async fn invalid_arguments_match_nodes_zod_payload() {
        let union_missing = |key: &str, other: &str| {
            format!(
                r#"{{"error":"Invalid arguments","details":[{{"code":"invalid_union","errors":[[{{"expected":"string","code":"invalid_type","path":[],"message":"Invalid input: expected string, received {other}"}}],[{{"expected":"array","code":"invalid_type","path":[],"message":"Invalid input: expected array, received {other}"}}]],"path":["{key}"],"message":"Invalid input"}}]}}"#
            )
        };
        let web = service(|_| {});
        let fetch: Vec<(serde_json::Value, String)> = vec![
            (json!({}), union_missing("url", "undefined")),
            (json!({"url": []}), union_missing("url", "undefined")),
            (json!({"url": 5}), union_missing("url", "number")),
            (json!({"url": null}), union_missing("url", "null")),
            (json!({"url": {"a": 1}}), union_missing("url", "object")),
            (json!({"url": "not a url"}), r#"{"error":"Invalid arguments","details":[{"code":"invalid_format","format":"url","path":["url"],"message":"Invalid URL"}]}"#.into()),
            (json!({"url": ["x", "https://a.b"]}), r#"{"error":"Invalid arguments","details":[{"code":"invalid_format","format":"url","path":["url",0],"message":"Invalid URL"}]}"#.into()),
            (json!({"url": ["x", "y"]}), r#"{"error":"Invalid arguments","details":[{"code":"invalid_format","format":"url","path":["url",0],"message":"Invalid URL"},{"code":"invalid_format","format":"url","path":["url",1],"message":"Invalid URL"}]}"#.into()),
            (json!({"url": ["x", 3]}), r#"{"error":"Invalid arguments","details":[{"code":"invalid_union","errors":[[{"expected":"string","code":"invalid_type","path":[],"message":"Invalid input: expected string, received array"}],[{"code":"invalid_format","format":"url","path":[0],"message":"Invalid URL"},{"expected":"string","code":"invalid_type","path":[1],"message":"Invalid input: expected string, received number"}]],"path":["url"],"message":"Invalid input"}]}"#.into()),
            (json!({"url": [3]}), r#"{"error":"Invalid arguments","details":[{"code":"invalid_union","errors":[[{"expected":"string","code":"invalid_type","path":[],"message":"Invalid input: expected string, received array"}],[{"expected":"string","code":"invalid_type","path":[0],"message":"Invalid input: expected string, received number"}]],"path":["url"],"message":"Invalid input"}]}"#.into()),
            (json!({"url": "https://a.b", "startIndex": -1}), r#"{"error":"Invalid arguments","details":[{"origin":"number","code":"too_small","minimum":0,"inclusive":true,"path":["startIndex"],"message":"Too small: expected number to be >=0"}]}"#.into()),
            (json!({"url": "https://a.b", "startIndex": 1.5}), r#"{"error":"Invalid arguments","details":[{"expected":"int","format":"safeint","code":"invalid_type","path":["startIndex"],"message":"Invalid input: expected int, received number"}]}"#.into()),
            (json!({"url": "https://a.b", "startIndex": -1.5}), r#"{"error":"Invalid arguments","details":[{"expected":"int","format":"safeint","code":"invalid_type","path":["startIndex"],"message":"Invalid input: expected int, received number"}]}"#.into()),
            (json!({"url": "https://a.b", "startIndex": 1e300}), r#"{"error":"Invalid arguments","details":[{"code":"too_big","maximum":9007199254740991,"note":"Integers must be within the safe integer range.","origin":"int","inclusive":true,"path":["startIndex"],"message":"Too big: expected int to be <=9007199254740991"}]}"#.into()),
            (json!({"url": "https://a.b", "startIndex": -1e300}), r#"{"error":"Invalid arguments","details":[{"code":"too_small","minimum":-9007199254740991,"note":"Integers must be within the safe integer range.","origin":"int","inclusive":true,"path":["startIndex"],"message":"Too small: expected int to be >=-9007199254740991"},{"origin":"number","code":"too_small","minimum":0,"inclusive":true,"path":["startIndex"],"message":"Too small: expected number to be >=0"}]}"#.into()),
            (json!({"url": "https://a.b", "startIndex": null}), r#"{"error":"Invalid arguments","details":[{"expected":"number","code":"invalid_type","path":["startIndex"],"message":"Invalid input: expected number, received null"}]}"#.into()),
            (json!({"url": "https://a.b", "startIndex": true}), r#"{"error":"Invalid arguments","details":[{"expected":"number","code":"invalid_type","path":["startIndex"],"message":"Invalid input: expected number, received boolean"}]}"#.into()),
            (json!({"url": "https://a.b", "maxLength": "x"}), r#"{"error":"Invalid arguments","details":[{"expected":"number","code":"invalid_type","path":["maxLength"],"message":"Invalid input: expected number, received string"}]}"#.into()),
            (json!({"url": "https://a.b", "cwd": 3}), r#"{"error":"Invalid arguments","details":[{"expected":"string","code":"invalid_type","path":["cwd"],"message":"Invalid input: expected string, received number"}]}"#.into()),
            (json!([1]), r#"{"error":"Invalid arguments","details":[{"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received array"}]}"#.into()),
            (json!("x"), r#"{"error":"Invalid arguments","details":[{"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received string"}]}"#.into()),
        ];
        for (args, want) in fetch {
            for tool in ["web_fetch", "local_fetch", "image_fetch"] {
                let error = call(&web, tool, args.clone()).await.unwrap_err();
                assert_eq!(error.message_for_model, want, "{tool} {args}");
                assert!(matches!(error.code, ToolErrorCode::InvalidArgs { .. }));
            }
        }
        let search: Vec<(serde_json::Value, String)> = vec![
            (json!({}), union_missing("keywords", "undefined")),
            (json!({"keywords": "  "}), union_missing("keywords", "undefined")),
            (json!({"keywords": 7}), union_missing("keywords", "number")),
            (json!({"keywords": []}), r#"{"error":"Invalid arguments","details":[{"origin":"array","code":"too_small","minimum":1,"inclusive":true,"path":["keywords"],"message":"Too small: expected array to have >=1 items"}]}"#.into()),
            (json!({"query": ["a", ""]}), r#"{"error":"Invalid arguments","details":[{"origin":"string","code":"too_small","minimum":1,"inclusive":true,"path":["keywords",1],"message":"Too small: expected string to have >=1 characters"}]}"#.into()),
            (json!({"keywords": [1, ""]}), r#"{"error":"Invalid arguments","details":[{"code":"invalid_union","errors":[[{"expected":"string","code":"invalid_type","path":[],"message":"Invalid input: expected string, received array"}],[{"expected":"string","code":"invalid_type","path":[0],"message":"Invalid input: expected string, received number"},{"origin":"string","code":"too_small","minimum":1,"inclusive":true,"path":[1],"message":"Too small: expected string to have >=1 characters"}]],"path":["keywords"],"message":"Invalid input"}]}"#.into()),
            (json!({"keywords": [[]]}), r#"{"error":"Invalid arguments","details":[{"code":"invalid_union","errors":[[{"expected":"string","code":"invalid_type","path":[],"message":"Invalid input: expected string, received array"}],[{"expected":"string","code":"invalid_type","path":[0],"message":"Invalid input: expected string, received array"},{"origin":"array","code":"too_small","minimum":1,"inclusive":true,"path":[0],"message":"Too small: expected array to have >=1 items"}]],"path":["keywords"],"message":"Invalid input"}]}"#.into()),
            (json!({"keywords": "a", "maxResults": 0}), r#"{"error":"Invalid arguments","details":[{"origin":"number","code":"too_small","minimum":1,"inclusive":true,"path":["maxResults"],"message":"Too small: expected number to be >=1"}]}"#.into()),
            (json!({"keywords": "a", "maxResults": 21}), r#"{"error":"Invalid arguments","details":[{"origin":"number","code":"too_big","maximum":20,"inclusive":true,"path":["maxResults"],"message":"Too big: expected number to be <=20"}]}"#.into()),
            (json!({"keywords": "a", "maxResults": 1e300}), r#"{"error":"Invalid arguments","details":[{"code":"too_big","maximum":9007199254740991,"note":"Integers must be within the safe integer range.","origin":"int","inclusive":true,"path":["maxResults"],"message":"Too big: expected int to be <=9007199254740991"},{"origin":"number","code":"too_big","maximum":20,"inclusive":true,"path":["maxResults"],"message":"Too big: expected number to be <=20"}]}"#.into()),
            (json!({"keywords": "a", "contextSize": "x"}), r#"{"error":"Invalid arguments","details":[{"code":"invalid_value","values":["low","medium","high"],"path":["contextSize"],"message":"Invalid option: expected one of \"low\"|\"medium\"|\"high\""}]}"#.into()),
            (json!({"keywords": "a", "site": 3}), r#"{"error":"Invalid arguments","details":[{"expected":"string","code":"invalid_type","path":["site"],"message":"Invalid input: expected string, received number"}]}"#.into()),
            (json!({"keywords": "a", "locale": 3}), r#"{"error":"Invalid arguments","details":[{"code":"invalid_union","errors":[[{"expected":"string","code":"invalid_type","path":[],"message":"Invalid input: expected string, received number"}],[{"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received number"}]],"path":["locale"],"message":"Invalid input"}]}"#.into()),
            (json!({"keywords": "a", "locale": {"country": 3}}), r#"{"error":"Invalid arguments","details":[{"code":"invalid_union","errors":[[{"expected":"string","code":"invalid_type","path":[],"message":"Invalid input: expected string, received object"}],[{"expected":"string","code":"invalid_type","path":["country"],"message":"Invalid input: expected string, received number"}]],"path":["locale"],"message":"Invalid input"}]}"#.into()),
            (json!({"keywords": "a", "site": 3, "maxResults": 0}), r#"{"error":"Invalid arguments","details":[{"expected":"string","code":"invalid_type","path":["site"],"message":"Invalid input: expected string, received number"},{"origin":"number","code":"too_small","minimum":1,"inclusive":true,"path":["maxResults"],"message":"Too small: expected number to be >=1"}]}"#.into()),
        ];
        for (args, want) in search {
            let error = call(&web, "web_search", args.clone()).await.unwrap_err();
            assert_eq!(error.message_for_model, want, "{args}");
        }
        let pattern = call(&web, "web_search", json!({"pattern": "*.rs"})).await.unwrap_err();
        assert_eq!(pattern.message_for_model, "Error: web search requires query; use glob(pattern=...) for file paths.");
    }

    fn cache_file(dir: &std::path::Path) -> crate::web::cache::CacheFile {
        crate::web::cache::CacheFile {
            path: dir.join("cache.local.json"),
            lane: mixdog_rt::testing::tokens().maintenance_io,
        }
    }

    #[tokio::test]
    async fn caches_persist_in_nodes_file_shape_and_load_at_start() {
        let dir = tempfile::tempdir().unwrap();
        let server = MockServer::start().await;
        Mock::given(path("/p")).respond_with(html("<main>persisted body</main>")).expect(1).mount(&server).await;
        let url = format!("{}/p", server.uri());
        let first = service(|c| c.cache_file = Some(cache_file(dir.path())));
        assert!(call(&first, "web_fetch", json!({"url": url})).await.is_ok());
        // `web_fetch` writes the file before it answers, as Node's `flushCacheState` does.
        let stored: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("cache.local.json")).unwrap()).unwrap();
        let key = super::super::cache::node_cache_key("fetch:url", &json!({"url": url, "version": "document-pipeline-v3"}));
        let entry = &stored["entries"][key.as_str()];
        assert_eq!(entry["payload"]["tool"], "web_fetch");
        assert_eq!(entry["payload"]["content"], "persisted body");
        assert_eq!(entry["expiresAt"].as_u64().unwrap() - entry["cachedAt"].as_u64().unwrap(), 3_600_000);
        assert_eq!(stored["entries"].as_object().unwrap().len(), 1);
        assert!(stored["__approxBytes"].as_i64().unwrap() > 0);
        // A new service reads the file: the origin is not contacted again (`expect(1)` above).
        let second = service(|c| c.cache_file = Some(cache_file(dir.path())));
        let shown = text(&call(&second, "web_fetch", json!({"url": url})).await);
        assert!(shown.ends_with("persisted body"), "{shown}");
    }

    #[tokio::test]
    async fn expired_and_oversized_entries_are_dropped_at_load() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("cache.local.json");
        let entry = |at: u64, expires: u64| json!({"cachedAt": at, "expiresAt": expires, "payload": {"tool": "web_fetch"}});
        let mut entries = serde_json::Map::new();
        entries.insert("fetch:url:old".into(), entry(1, 2));
        for n in 0..502u64 {
            entries.insert(format!("fetch:url:k{n}"), entry(1000 + n, 99_999_999_999_999));
        }
        std::fs::write(&file, json!({"entries": entries}).to_string()).unwrap();
        let cache = Arc::new(super::super::cache::NodeCache::new(Some(cache_file(dir.path()))));
        assert!(cache.get("fetch:url:old").await.is_none());
        // 502 live entries exceed Node's 500; the two oldest `cachedAt` went.
        assert!(cache.get("fetch:url:k0").await.is_none() && cache.get("fetch:url:k1").await.is_none());
        assert!(cache.get("fetch:url:k2").await.is_some() && cache.get("fetch:url:k501").await.is_some());
    }

    #[test]
    fn name_lookup_failures_are_classified_as_nodes_resolver_codes() {
        use super::super::error::FetchKind;
        use super::super::gai::LookupError;
        use super::super::gai::classify;
        use super::super::ssrf::lookup_failure;
        let failure = |code: i32| lookup_failure("h.example", LookupError { kind: classify(code), code });
        // The `getaddrinfo` result codes of the platform: EAI_NONAME / EAI_NODATA are ENOTFOUND / ENODATA,
        // EAI_AGAIN is retried, anything else is a plain network error.
        #[cfg(unix)]
        let (not_found, again, other) = {
            #[allow(unused_mut)]
            let mut not_found = vec![libc::EAI_NONAME];
            #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
            not_found.push(libc::EAI_NODATA);
            (not_found, libc::EAI_AGAIN, libc::EAI_FAIL)
        };
        #[cfg(windows)]
        let (not_found, again, other) = (vec![11001, 11004], 11002, 11003);
        for code in not_found {
            let error = failure(code);
            assert_eq!((error.kind, error.message.as_str()), (FetchKind::Policy, "DNS returned no addresses for h.example"));
        }
        let again = failure(again);
        assert_eq!(again.kind, FetchKind::NetworkTransient);
        assert_eq!(again.message, "fetch failed: getaddrinfo EAI_AGAIN h.example");
        assert_eq!(failure(other).kind, FetchKind::Network);
    }

    #[test]
    fn lookup_resolves_literals_through_the_shared_resolver_path() {
        let ips = super::super::gai::lookup("127.0.0.1").unwrap();
        assert_eq!(ips, vec![std::net::IpAddr::from([127, 0, 0, 1])]);
    }
}

mod page_entry_parity {
    use url::Url;

    use super::super::extract::extract_document;
    use super::super::http::Redirect;
    use super::super::pipeline::Page;
    use super::super::cache::node_entry_size;
    use super::super::tools::excerpt_size_gap;
    use super::super::tools::page_payload;

    fn page_entry_size(page: &Page, requested_url: &str) -> usize {
        node_entry_size(&page_payload(page, requested_url), std::time::Duration::from_secs(3600)) + excerpt_size_gap(page)
    }

    fn page(excerpt_source: &str, redirects: Option<Vec<Redirect>>) -> Page {
        let url = Url::parse("https://a.example/doc.txt").unwrap();
        let extracted = extract_document(&url, excerpt_source, "text/plain").unwrap();
        Page {
            url: url.to_string(),
            title: String::new(),
            content: extracted.content,
            extractor: extracted.extractor.to_string(),
            format: extracted.format.to_string(),
            content_type: extracted.content_type,
            excerpt: extracted.excerpt,
            excerpt_json_len: extracted.excerpt_json_len,
            redirects,
            failures: Vec::new(),
            attempts: Vec::new(),
        }
    }

    #[test]
    fn redirects_are_carried_in_node_order_and_an_empty_list_too() {
        let hops = vec![
            Redirect { url: "https://a.example/".into(), status: Some(301), location: "https://b.example/".into() },
            Redirect { url: "https://b.example/".into(), status: None, location: "https://c.example/".into() },
        ];
        let with = mixdog_js::json_stringify(&page_payload(&page("hello", Some(hops)), "https://a.example/"));
        assert!(with.contains(r#""httpStatus":200,"redirects":[{"url":"https://a.example/","status":301,"location":"https://b.example/"},{"url":"https://b.example/","location":"https://c.example/","status":"meta-refresh"}],"requestedUrl""#), "{with}");
        let empty = mixdog_js::json_stringify(&page_payload(&page("hello", Some(Vec::new())), "https://a.example/"));
        assert!(empty.contains(r#""httpStatus":200,"redirects":[],"requestedUrl""#), "{empty}");
        let browser = mixdog_js::json_stringify(&page_payload(&page("hello", None), "https://a.example/"));
        assert!(!browser.contains("redirects"), "{browser}");
        assert!(page_entry_size(&page("hello", Some(Vec::new())), "https://a.example/") > page_entry_size(&page("hello", None), "https://a.example/"));
    }

    #[test]
    fn an_excerpt_cut_in_a_surrogate_pair_is_sized_like_node() {
        let source = format!("{}😀tail", "a".repeat(239));
        // Node: JSON.stringify({ excerpt: source.slice(0, 240) }).length === 259 (a lone \ud83d is 6 units).
        assert_eq!(mixdog_js::json_cut_utf16_len(&source, 240) + "{\"excerpt\":}".len(), 259);
        let cut = page(&source, Some(Vec::new()));
        assert_eq!(cut.excerpt_json_len, 247);
        // The visible excerpt still shows U+FFFD (1 unit): the size gains the five units.
        let whole = page(&format!("{}x", "a".repeat(239)), Some(Vec::new()));
        let gap = page_entry_size(&cut, "u") as i64 - page_entry_size(&whole, "u") as i64;
        // `whole`'s excerpt is 240 plain units (242 serialized); `cut`'s is 247: five more, plus the longer body.
        let body = |p: &Page| p.content.encode_utf16().count() as i64;
        assert_eq!(gap, body(&cut) - body(&whole) + 5);
    }
}

/// Values below were produced by Node 22 (`JSON.stringify`, `crypto`, `trim`, `/\s+/g`).
mod search_semantics {
    use std::time::Duration;

    use serde_json::json;

    use super::super::cache::node_entry_size;
    use super::super::search::NativeSearchResult;
    use super::super::search::SearchArgs;
    use super::super::search::SearchHit;
    use super::super::search::SearchPayload;
    use super::super::search::cache_key;
    use super::super::search::collapse;
    use super::super::search::format_results;
    use super::super::search::node_payload;
    use super::super::search::normalize;

    fn args(query: &str, site: Option<&str>) -> SearchArgs {
        SearchArgs {
            query: query.into(),
            listed: false,
            site: site.map(str::to_string),
            locale: None,
            context_size: "low".into(),
            max_results: 10,
        }
    }

    #[test]
    fn whitespace_follows_javascript_not_rust() {
        // U+0085 is not JS whitespace; U+00A0 and U+FEFF are.
        assert_eq!(collapse("a\u{85}b\u{a0}c\u{feff}d  e"), "a\u{85}b c d e");
        let found = NativeSearchResult { answer: "\u{85}x\u{feff}\u{a0}".into(), ..NativeSearchResult::default() };
        assert_eq!(normalize(found, 5).answer, "\u{85}x");
    }

    #[test]
    fn cache_keys_cannot_collide_across_fields() {
        let a = cache_key(&args("q\0s", Some("t")));
        let b = cache_key(&args("q", Some("s\0t")));
        assert_ne!(a, b);
        assert_eq!(a, "web_search:c35b8ddb6061776b27a7a925cabe6cf12c723919f1306c073ab679b0149d5670");
        assert_eq!(b, "web_search:256be9b82ed1c531cec5a9a717e332beecd4978d2030cacc4ebad3ffbfc3ffe4");
    }

    #[test]
    fn entry_size_counts_dates_warnings_and_usage_like_node() {
        let payload = SearchPayload {
            provider: "fake".into(),
            answer: "ans".into(),
            results: vec![SearchHit {
                title: "T".into(),
                url: "https://a.example/1".into(),
                snippet: "s".into(),
                from_call: false,
                published_date: Some("2024-01-02".into()),
            }],
            warnings: vec!["w".into()],
            model: Some("m".into()),
            usage: Some(json!({ "a": 1 })),
        };
        let node = node_payload(&payload, &args("rust", None), 7);
        assert_eq!(
            mixdog_js::json_stringify(&node),
            r#"{"tool":"web_search","provider":"fake","response":{"usedProvider":"fake","query":"rust","rawQuery":"rust","answer":"ans","model":"m","durationMs":7,"usage":{"a":1},"results":[{"title":"T","url":"https://a.example/1","snippet":"s","source":"citation","provider":"native-web-search","publishedDate":"2024-01-02"}],"warnings":["w"],"site":null,"locale":null}}"#
        );
        // Node: JSON.stringify({ cachedAt, expiresAt, payload }).length with 13-digit stamps.
        assert_eq!(node_entry_size(&node, Duration::from_secs(30 * 60)), 419);
    }

    #[test]
    fn a_not_found_title_is_kept() {
        let payload = SearchPayload {
            provider: "fake".into(),
            answer: String::new(),
            results: vec![SearchHit {
                title: "Page not found".into(),
                url: "https://a.example/1".into(),
                snippet: "gone".into(),
                from_call: false,
                published_date: None,
            }],
            warnings: Vec::new(),
            model: None,
            usage: None,
        };
        assert_eq!(format_results(&payload), "1. Page not found\n   https://a.example/1\n   gone");
    }
}
