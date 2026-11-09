//! Conformance of the explicit-cache port against `golden.json`, recorded from
//! Node's `GeminiProvider._ensureGeminiCache` (`record_goldens.mjs`).

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use futures::future::BoxFuture;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

use super::layer::Ask;
use super::layer::CacheRuntime;
use super::layer::ExplicitCache;
use super::policy;
use super::policy::CacheRequest;
use super::policy::Tuning;
use super::registry::Registry;
use mixdog_core_api::domain::provider::GeminiCacheState;
use mixdog_core_api::domain::provider::ProviderState;
use crate::transport::BodyStream;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;

const GOLDEN: &str = include_str!("../../../../../../fixtures/providers/gemini-explicit-cache/cases.json");

struct Once(Option<Bytes>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// Answers a cache create with `cachedContents/created-<n>`; `n` is the golden case.
struct FakeHttp {
    case: u64,
    sent: Mutex<Vec<WireRequest>>,
}

#[async_trait]
impl HttpSend for FakeHttp {
    async fn send(
        &self,
        request: WireRequest,
        _exchange: crate::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().unwrap().push(request);
        // A create takes time on the wire; callers race while it is in flight.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let body = serde_json::json!({"name": format!("cachedContents/created-{}", self.case), "usageMetadata": {"totalTokenCount": 5000 + self.case}});
        Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(Once(Some(Bytes::from(body.to_string())))) })
    }
}

struct FakeRuntime {
    now: u64,
    delayed: Mutex<Vec<u64>>,
}

impl CacheRuntime for FakeRuntime {
    fn now_ms(&self) -> u64 {
        self.now
    }
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        tokio::spawn(task);
    }
    fn spawn_after(&self, delay_ms: u64, _task: BoxFuture<'static, ()>) {
        self.delayed.lock().unwrap().push(delay_ms);
    }
    fn deadline(&self, _ms: u64) -> BoxFuture<'static, ()> {
        Box::pin(futures::future::pending())
    }
}

/// A manual clock: each `deadline` waits until the test fires it.
struct ManualRuntime {
    now: u64,
    fired: Mutex<Vec<(u64, futures::channel::oneshot::Sender<()>)>>,
}

impl CacheRuntime for ManualRuntime {
    fn now_ms(&self) -> u64 {
        self.now
    }
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        tokio::spawn(task);
    }
    fn spawn_after(&self, _delay_ms: u64, _task: BoxFuture<'static, ()>) {}
    fn deadline(&self, ms: u64) -> BoxFuture<'static, ()> {
        let (tx, rx) = futures::channel::oneshot::channel();
        self.fired.lock().unwrap().push((ms, tx));
        Box::pin(async move {
            let _ = rx.await;
        })
    }
}

/// Never answers a create.
struct StallHttp {
    sent: Mutex<usize>,
}

#[async_trait]
impl HttpSend for StallHttp {
    async fn send(
        &self,
        _request: WireRequest,
        _exchange: crate::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        *self.sent.lock().unwrap() += 1;
        futures::future::pending().await
    }
}

fn golden() -> Value {
    serde_json::from_str(GOLDEN).unwrap()
}

fn system(case: u64) -> String {
    format!("{}case-{case}", "You are the Lead. ".repeat(1000))
}

fn parts(g: &Value) -> (Vec<Value>, Option<Value>, Vec<Value>) {
    (
        g["tools"].as_array().unwrap().clone(),
        Some(g["toolConfig"].clone()),
        g["contents"].as_array().unwrap().clone(),
    )
}

#[test]
fn hashes_bodies_and_floors_equal_node() {
    let g = golden();
    let h = &g["hashes"];
    let (tools, tool_config, contents) = parts(&g);
    let model = g["model"].as_str().unwrap();
    let request = CacheRequest { system_instruction: &system(0), tools: &tools, tool_config: tool_config.as_ref(), contents: &contents };
    assert_eq!(policy::prefix_hash(model, &request, 3), h["prefixHash3"].as_str().unwrap());
    assert_eq!(policy::prefix_hash(model, &request, 0), h["prefixHash0"].as_str().unwrap());
    assert_eq!(policy::credential_fingerprint(g["apiKey"].as_str().unwrap()), h["credential"].as_str().unwrap());
    assert_eq!(policy::global_cache_key(h["credential"].as_str().unwrap(), model, "abc", 3), h["globalKey"].as_str().unwrap());
    assert_eq!(policy::estimate_tokens(&request), h["estimate"].as_u64().unwrap());
    for (name, floor) in h["minTokens"].as_object().unwrap() {
        assert_eq!(policy::explicit_cache_min_tokens(name), floor.as_u64(), "{name}");
    }
    let tuning = Tuning::default();
    let prefixed = format!("models/{model}");
    assert_eq!(policy::create_body(&prefixed, &tuning, &request, 3), h["createBody"]);
    assert_eq!(policy::create_body(&prefixed, &tuning, &request, 3).to_string(), h["createBody"].to_string());
    let state: GeminiCacheState = serde_json::from_value(g["cases"][1]["state"]["gemini"].clone()).unwrap();
    let generation = serde_json::json!({"maxOutputTokens": 100});
    assert_eq!(policy::cached_body("cachedContents/session", &state, &contents, Some(&generation)), h["cachedBody"]);
    let all_cached = GeminiCacheState { cache_prefix_content_count: 9, ..state };
    assert_eq!(policy::cached_body("cachedContents/session", &all_cached, &contents, None), h["cachedBodyAllCached"]);
}

#[tokio::test]
async fn the_six_recorded_cases_equal_node() {
    let g = golden();
    let (tools, tool_config, contents) = parts(&g);
    let model = g["model"].as_str().unwrap();
    for case in g["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let n = case["systemCase"].as_u64().unwrap();
        let system = system(n);
        let state: Option<ProviderState> = case["state"].is_null().then_some(None).unwrap_or_else(|| Some(serde_json::from_value(case["state"].clone()).unwrap()));
        let http = Arc::new(FakeHttp { case: n, sent: Mutex::default() });
        let runtime = Arc::new(FakeRuntime { now: g["now"].as_u64().unwrap(), delayed: Mutex::default() });
        let cache = ExplicitCache::new(
            g["apiKey"].as_str().unwrap(),
            "https://generativelanguage.googleapis.com",
            http.clone(),
            runtime.clone(),
            Arc::new(Registry::default()),
            Tuning::default(),
        );
        let answer = cache
            .ensure(Ask {
                model,
                request: CacheRequest { system_instruction: &system, tools: &tools, tool_config: tool_config.as_ref(), contents: &contents },
                state: state.as_ref(),
                iteration: case["iteration"].as_u64().unwrap() as u32,
                fork: case["fork"].as_bool().unwrap(),
            })
            .await;
        let expect = &case["expect"];
        assert_eq!(answer.cache_name.as_deref(), expect["cacheName"].as_str(), "{name}: name");
        // The state the response carries is the request's state unless the cache changed it.
        let carried = answer.state.or(state);
        let carried = carried.map(|s| serde_json::to_value(s).unwrap()).unwrap_or(Value::Null);
        assert_eq!(carried, expect["providerState"], "{name}: providerState");
        let sent = http.sent.lock().unwrap();
        let posts = expect["posts"].as_array().unwrap();
        assert_eq!(sent.len(), posts.len(), "{name}: creates");
        for (wire, post) in sent.iter().zip(posts) {
            assert_eq!(wire.method, "POST");
            assert_eq!(wire.url, post["url"].as_str().unwrap(), "{name}: url");
            assert_eq!(String::from_utf8(wire.body.clone()).unwrap(), post["body"].as_str().unwrap(), "{name}: create body bytes");
            assert!(wire.headers.contains(&("x-goog-api-key".into(), g["apiKey"].as_str().unwrap().into())));
        }
        // Node schedules the superseded cache's delete after a two-minute grace.
        let superseded = state_name(case).is_some() && !posts.is_empty();
        assert_eq!(*runtime.delayed.lock().unwrap(), if superseded { vec![120_000] } else { vec![] }, "{name}: delete");
    }
}

fn state_name(case: &Value) -> Option<&str> {
    case["state"]["gemini"]["cacheName"].as_str()
}

#[tokio::test]
async fn one_create_serves_concurrent_sessions_with_the_same_prefix() {
    let g = golden();
    let (tools, tool_config, contents) = parts(&g);
    let system = system(1);
    let http = Arc::new(FakeHttp { case: 1, sent: Mutex::default() });
    let runtime = Arc::new(FakeRuntime { now: g["now"].as_u64().unwrap(), delayed: Mutex::default() });
    let cache = Arc::new(ExplicitCache::new(
        g["apiKey"].as_str().unwrap(),
        "https://generativelanguage.googleapis.com",
        http.clone(),
        runtime,
        Arc::new(Registry::default()),
        Tuning::default(),
    ));
    let ask = || Ask {
        model: g["model"].as_str().unwrap(),
        request: CacheRequest { system_instruction: &system, tools: &tools, tool_config: tool_config.as_ref(), contents: &contents },
        state: None,
        iteration: 1,
        fork: false,
    };
    let (a, b, c) = tokio::join!(cache.ensure(ask()), cache.ensure(ask()), cache.ensure(ask()));
    for answer in [a, b, c] {
        assert_eq!(answer.cache_name.as_deref(), Some("cachedContents/created-1"));
    }
    assert_eq!(http.sent.lock().unwrap().len(), 1, "a single cachedContents.create");
}

/// A stalled create settles at Node's total deadline (180 s by default): the
/// owner and a joiner both proceed uncached, and the key is free again.
#[tokio::test(start_paused = true)]
async fn a_stalled_create_settles_at_the_deadline_and_releases_the_key() {
    let g = golden();
    let (tools, tool_config, contents) = parts(&g);
    let model = g["model"].as_str().unwrap().to_owned();
    let key = g["apiKey"].as_str().unwrap().to_owned();
    let system = system(1);
    let http = Arc::new(StallHttp { sent: Mutex::default() });
    let now = g["now"].as_u64().unwrap();
    let runtime = Arc::new(ManualRuntime { now, fired: Mutex::default() });
    let registry = Arc::new(Registry::default());
    let tuning = Tuning::default();
    assert_eq!(tuning.create_total_ms, 180_000.0);
    let cache = Arc::new(ExplicitCache::new(
        key.clone(),
        "https://generativelanguage.googleapis.com",
        http.clone(),
        runtime.clone(),
        registry.clone(),
        tuning,
    ));
    let ensure = |cache: Arc<ExplicitCache>| {
        let (model, system) = (model.clone(), system.clone());
        let (tools, tool_config, contents) = (tools.clone(), tool_config.clone(), contents.clone());
        tokio::spawn(async move {
            cache
                .ensure(Ask {
                    model: &model,
                    request: CacheRequest {
                        system_instruction: &system,
                        tools: &tools,
                        tool_config: tool_config.as_ref(),
                        contents: &contents,
                    },
                    state: None,
                    iteration: 1,
                    fork: false,
                })
                .await
        })
    };
    let owner = ensure(cache.clone());
    while *http.sent.lock().unwrap() == 0 {
        tokio::task::yield_now().await;
    }
    let joiner = ensure(cache.clone());
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert_eq!(*http.sent.lock().unwrap(), 1, "the joiner waits on the owner's create");
    {
        let mut fired = runtime.fired.lock().unwrap();
        assert_eq!(fired.iter().map(|(ms, _)| *ms).collect::<Vec<_>>(), [180_000, 120_000], "total, then attempt");
        // Only the total deadline: the attempt deadline stays unfired.
        let _ = fired.remove(0).1.send(());
    }
    let settle = std::time::Duration::from_secs(5);
    for task in [owner, joiner] {
        let answer = tokio::time::timeout(settle, task).await.expect("settles at the deadline").unwrap();
        assert_eq!(answer.cache_name, None);
        assert_eq!(answer.state, None);
    }
    let request = CacheRequest { system_instruction: &system, tools: &tools, tool_config: tool_config.as_ref(), contents: &contents };
    let count = policy::prefix_count(&contents);
    let hash = policy::prefix_hash(&model, &request, count);
    let flight = policy::global_cache_key(&policy::credential_fingerprint(&key), &model, &hash, count);
    assert!(matches!(registry.claim(&flight, now), super::registry::Claim::Own { .. }), "the key is free");
}

/// Answers the first create never, the next ones with a cache.
struct StallOnce {
    sent: Mutex<usize>,
}

#[async_trait]
impl HttpSend for StallOnce {
    async fn send(
        &self,
        _request: WireRequest,
        _exchange: crate::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        let n = {
            let mut sent = self.sent.lock().unwrap();
            *sent += 1;
            *sent
        };
        if n == 1 {
            futures::future::pending().await
        }
        let body = serde_json::json!({"name": "cachedContents/second", "usageMetadata": {"totalTokenCount": 4000}});
        Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(Once(Some(Bytes::from(body.to_string())))) })
    }
}

/// Runs only the backoff waits: the attempt and total limits never fire, so each failure the transport reports is the
/// attempt's own, and the retry ladder runs to its end.
struct LadderRuntime;

impl CacheRuntime for LadderRuntime {
    fn now_ms(&self) -> u64 {
        0
    }
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        tokio::spawn(task);
    }
    fn spawn_after(&self, _delay_ms: u64, _task: BoxFuture<'static, ()>) {}
    fn deadline(&self, ms: u64) -> BoxFuture<'static, ()> {
        if ms >= 120_000 { Box::pin(futures::future::pending()) } else { Box::pin(futures::future::ready(())) }
    }
}

/// The create's request is bounded by Node's total timer (`sites.geminiCacheCreate`: `armed` 180 s, the fetch rejected
/// with `Gemini cachedContents.create total timed out after 180000ms`); the timeouts are retried and, once the ladder is
/// spent, the create resolves no cache, as Node's catch does. Node also logs the failure on stderr; this port has no log.
#[tokio::test(start_paused = true)]
async fn a_create_the_transport_times_out_is_retried_then_resolves_no_cache() {
    use crate::transport::site_probe::TimingOut;
    use crate::transport::site_probe::assert_transport;

    let g = golden();
    let (tools, tool_config, contents) = parts(&g);
    let system = system(1);
    let transport = TimingOut::new();
    let cache = ExplicitCache::new(
        g["apiKey"].as_str().unwrap(),
        "https://generativelanguage.googleapis.com",
        transport.clone(),
        Arc::new(LadderRuntime),
        Arc::new(Registry::default()),
        Tuning::default(),
    );
    let ask = Ask {
        model: g["model"].as_str().unwrap(),
        request: CacheRequest { system_instruction: &system, tools: &tools, tool_config: tool_config.as_ref(), contents: &contents },
        state: None,
        iteration: 1,
        fork: false,
    };
    let answer = cache.ensure(ask).await;
    assert_eq!(answer.cache_name, None);
    assert!(transport.seen().len() > 1, "a timeout is retried");
    assert_transport("geminiCacheCreate", &transport);
}

/// Node's `withRetry` around the create: an attempt stalled past the 120 s
/// attempt limit is retried after the backoff, inside the 180 s total.
#[tokio::test(start_paused = true)]
async fn a_create_attempt_stalled_past_its_limit_is_retried_inside_the_total() {
    let g = golden();
    let (tools, tool_config, contents) = parts(&g);
    let system = system(1);
    let http = Arc::new(StallOnce { sent: Mutex::default() });
    let runtime = Arc::new(ManualRuntime { now: g["now"].as_u64().unwrap(), fired: Mutex::default() });
    let cache = ExplicitCache::new(
        g["apiKey"].as_str().unwrap(),
        "https://generativelanguage.googleapis.com",
        http.clone(),
        runtime.clone(),
        Arc::new(Registry::default()),
        Tuning::default(),
    );
    let model = g["model"].as_str().unwrap();
    let ask = Ask {
        model,
        request: CacheRequest { system_instruction: &system, tools: &tools, tool_config: tool_config.as_ref(), contents: &contents },
        state: None,
        iteration: 1,
        fork: false,
    };
    let fire = |n: usize| {
        let (ms, tx) = runtime.fired.lock().unwrap().remove(n);
        let _ = tx.send(());
        ms
    };
    let work = cache.ensure(ask);
    let drive = async {
        let waiting = |len: usize| {
            let runtime = runtime.clone();
            async move {
                while runtime.fired.lock().unwrap().len() < len {
                    tokio::task::yield_now().await;
                }
            }
        };
        waiting(2).await; // total, attempt 1
        assert_eq!(fire(1), 120_000, "the first attempt stalls past its limit");
        waiting(2).await; // total, the backoff wait
        let wait = fire(1);
        assert!((800..=1200).contains(&wait), "the first backoff step is 1 s ±20 %: {wait}");
        // The second attempt answers at once; its attempt deadline is never fired.
    };
    let (answer, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async { tokio::join!(work, drive) })
        .await
        .expect("settles");
    assert_eq!(answer.cache_name.as_deref(), Some("cachedContents/second"));
    assert_eq!(*http.sent.lock().unwrap(), 2, "one stalled attempt, one retry");
}

#[test]
fn provider_state_round_trip_keeps_every_node_key() {
    let node = serde_json::json!({
        "gemini": {
            "cacheName": "cachedContents/a", "cacheCreatedAt": 1, "cacheCreatedAtIter": 2,
            "cacheExpiresAt": 3, "cacheModel": "gemini-2.5-pro", "cacheTokenSize": 4,
            "cachePrefixContentCount": 5, "cachePrefixHash": "h", "cacheCredentialFingerprint": "f"
        },
        "openaiContinuation": {"previousResponseId": "resp_1", "baseLen": 7},
        "xaiResponses": {"previousResponseId": "resp_x"},
        "providerAccountId": "acct-1"
    });
    let state: ProviderState = serde_json::from_value(node.clone()).unwrap();
    assert_eq!(state.rest.len(), 3);
    assert_eq!(serde_json::to_value(&state).unwrap(), node);
    let rest_only: ProviderState = serde_json::from_value(serde_json::json!({"providerAccountId": "a"})).unwrap();
    assert!(rest_only.gemini.is_none());
    assert_eq!(serde_json::to_value(&rest_only).unwrap(), serde_json::json!({"providerAccountId": "a"}));
}

/// Two adapter instances share the process registry: many parallel callers on
/// worker threads, one prefix, exactly one `cachedContents.create`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_callers_over_two_instances_make_one_create() {
    let g = golden();
    let (tools, tool_config, contents) = parts(&g);
    let model = g["model"].as_str().unwrap().to_owned();
    let key = g["apiKey"].as_str().unwrap().to_owned();
    let system = system(1);
    let http = Arc::new(FakeHttp { case: 1, sent: Mutex::default() });
    let runtime = Arc::new(FakeRuntime { now: g["now"].as_u64().unwrap(), delayed: Mutex::default() });
    let registry = Arc::new(Registry::default());
    let instance = || {
        Arc::new(ExplicitCache::new(
            key.clone(),
            "https://generativelanguage.googleapis.com",
            http.clone(),
            runtime.clone(),
            registry.clone(),
            Tuning::default(),
        ))
    };
    let caches = [instance(), instance()];
    let mut tasks = Vec::new();
    for n in 0..32 {
        let (cache, model, system) = (caches[n % 2].clone(), model.clone(), system.clone());
        let (tools, tool_config, contents) = (tools.clone(), tool_config.clone(), contents.clone());
        tasks.push(tokio::spawn(async move {
            let ask = Ask {
                model: &model,
                request: CacheRequest { system_instruction: &system, tools: &tools, tool_config: tool_config.as_ref(), contents: &contents },
                state: None,
                iteration: 1,
                fork: false,
            };
            cache.ensure(ask).await
        }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap().cache_name.as_deref(), Some("cachedContents/created-1"));
    }
    assert_eq!(http.sent.lock().unwrap().len(), 1, "one create for the prefix, across instances");
}
