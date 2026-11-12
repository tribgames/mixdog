//! `fixtures/provider-anthropic-api-key-fetch-rest` (`record-anthropic-api-key-fetch-rest.mjs`): the API-key client's
//! `fetch` (`createAnthropicApiKeyFetch`, and `client.fetch` of the clients `AnthropicProvider` /
//! `GatewayMessagesEngine` build), called with the recorder's raw `fetch` arguments. The core's counterpart is
//! [`AnthropicAdapter::fetch`] over the production link: the compressing fetch of the built-in `anthropic` provider
//! (`registry/builder.rs` `build_anthropic`, at any base URL); a custom provider or gateway engine has none
//! (`custom_messages_engine` posts through the plain link), as Node's `custom ? {} : { fetch }` (`anthropic.mjs`).
//! Each request is compared as it arrived (headers in order and case, body bytes: the gzip body is Node's byte for
//! byte), each response as Node's `fetch` returned it (status, headers, text; `statusText` and `url` left out by the
//! manifest's exclusions), and the latch as Node read it.

use std::sync::Arc;
use std::sync::Mutex;
use std::io::Write;

use mixdog_ai::providers::anthropic::AnthropicAdapter;
use mixdog_ai::providers::anthropic::AnthropicConfig;
use mixdog_ai::providers::anthropic::ApiKeySource;
use mixdog_ai::providers::anthropic::Compressor;
use mixdog_ai::providers::anthropic::gzip_latched;
use mixdog_ai::providers::anthropic::reset_gzip_latch;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_ai::transport::KeepaliveSchedule;
use mixdog_ai::transport::ReqwestLink;
use mixdog_ai::transport::TransportKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_testkit::Exact;
use tokio::sync::Notify;

use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::within;

struct NoKey;

#[async_trait::async_trait]
impl ApiKeySource for NoKey {
    async fn key(&self) -> Result<String, ProviderError> {
        panic!("the client's fetch reads no key")
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        panic!("the client's fetch reads no key")
    }
}

/// The client a recorded `fetch` goes through.
enum Client {
    /// The compressing fetch of the built-in provider.
    Compressing(AnthropicAdapter),
    /// A custom provider's or gateway's client: the plain link.
    Plain,
}

/// The recorder's `fetch(url, init)` arguments as the request the client is handed.
fn request(args: &[Exact]) -> WireRequest {
    let init = &args[1];
    let headers = match init.get("headers").entries() {
        // A `Headers` instance: undici's lower-cased, name-sorted list.
        [(name, list)] if name == "headers" => {
            let mut pairs: Vec<(String, String)> =
                list.as_array().iter().map(|p| (p.as_array()[0].as_str().to_ascii_lowercase(), p.as_array()[1].as_str().to_owned())).collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            pairs
        }
        entries => entries.iter().map(|(k, v)| (k.clone(), v.as_str().to_owned())).collect(),
    };
    WireRequest {
        transport: TransportKind::Http1,
        method: init.get("method").as_str().to_owned(),
        url: args[0].as_str().to_owned(),
        headers,
        body: init.get("body").as_str().as_bytes().to_vec(),
    }
}

/// Node's `{ response: { status, statusText, url, headers }, text }` of one `fetch` from the core's response.
async fn response(response: HttpResponse) -> Exact {
    let read = response.read_all().await.expect("the body");
    // The recording iterates a `Headers`: lower-cased names, sorted, repeats joined with ", ".
    let mut sorted: Vec<(String, String)> = Vec::new();
    for (name, value) in &read.headers {
        let name = name.to_ascii_lowercase();
        match sorted.iter_mut().find(|(known, _)| *known == name) {
            Some((_, joined)) => *joined = format!("{joined}, {value}"),
            None => sorted.push((name, value.clone())),
        }
    }
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let headers = sorted.into_iter().map(|(k, v)| Exact::Array(vec![Exact::String(k), Exact::String(v)])).collect();
    Exact::Object(vec![
        (
            "response".into(),
            Exact::Object(vec![("status".into(), Exact::Number(f64::from(read.status.expect("a status")))), ("headers".into(), Exact::Array(headers))]),
        ),
        ("text".into(), Exact::String(String::from_utf8(read.body).expect("utf-8"))),
    ])
}

/// Node's `gzipSync(raw)`, for the case's gated compressor.
fn gzip_sync(raw: &[u8]) -> Vec<u8> {
    let os = if cfg!(windows) { 10 } else if cfg!(target_os = "macos") { 19 } else { 3 };
    let mut encoder = flate2::GzBuilder::new().operating_system(os).write(Vec::new(), flate2::Compression::default());
    encoder.write_all(raw).expect("gzip");
    encoder.finish().expect("gzip")
}

pub const REPLAYS: &[crate::provider_case::Replay] = &[crate::provider_case::Replay { set: "anthropic-api-key-fetch-rest", run: every_case_replays_as_nodes }];

#[tokio::test(start_paused = true)]
async fn every_case_replays_as_nodes() {
    let set = CaseSet::load("anthropic-api-key-fetch-rest");
    for case in &set.cases {
        reset_gzip_latch();
        let endpoint = Endpoint::start().await;
        endpoint.serve(case);
        let link: Arc<dyn HttpSend> = Arc::new(endpoint.link(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the production link")));
        let env = Arc::new(Mutex::new(None::<String>));
        let adapter = |base: Option<&str>, compressor: Option<Compressor>| {
            let mut config = AnthropicConfig::new(Arc::new(|_| None));
            if let Some(base) = base {
                config.base_url = base.trim_end_matches('/').to_owned();
            }
            let env = env.clone();
            let adapter = AnthropicAdapter::api_key(config, link.clone(), Arc::new(NoKey), mixdog_rt::testing::tokens().cpu_bulk)
                .with_settings(Arc::new(move |name| (name == "MIXDOG_ANTHROPIC_REQ_GZIP").then(|| env.lock().unwrap().clone()).flatten()));
            match compressor {
                Some(compressor) => adapter.with_compressor(compressor),
                None => adapter,
            }
        };
        let entered = Arc::new(Notify::new());
        let gate = Arc::new(Notify::new());
        let mut client = Client::Plain;
        let mut responses = Vec::new();
        let mut extra = Vec::new();
        let mut fetches = 0;
        for call in &case.calls {
            let entry = call.entry.as_str();
            if entry.ends_with("createAnthropicApiKeyFetch") {
                let compressor: Option<Compressor> = match case.id.as_str() {
                    "compression-that-throws-fails-open-to-the-plain-body" => Some(Arc::new(|_| Box::pin(async { Err("boom".to_owned()) }))),
                    "async-compress-is-awaited-request-waits-for-it" => {
                        let (entered, gate) = (entered.clone(), gate.clone());
                        Some(Arc::new(move |raw: Vec<u8>| {
                            let (entered, gate) = (entered.clone(), gate.clone());
                            Box::pin(async move {
                                entered.notify_one();
                                gate.notified().await;
                                Ok(gzip_sync(&raw))
                            })
                        }))
                    }
                    _ => None,
                };
                assert_eq!(call.args[0].entries().is_empty(), compressor.is_none(), "{}: the compress option", case.id);
                client = Client::Compressing(adapter(None, compressor));
            } else if entry.ends_with("AnthropicProvider") && call.entry.starts_with("new ") {
                let config = &call.args[0];
                let name = config.try_get("name").map(|n| n.as_str().to_owned());
                client = if name.as_deref().is_none_or(|n| n == "anthropic") {
                    Client::Compressing(adapter(config.try_get("baseURL").map(Exact::as_str), None))
                } else {
                    Client::Plain
                };
            } else if entry.ends_with("GatewayMessagesEngine") {
                client = Client::Plain;
            } else if entry == "fetchFn" || entry.ends_with(".client.fetch") {
                fetches += 1;
                if case.id == "small-body-count-tokens-and-kill-switch-not-compressed" && fetches == 3 {
                    *env.lock().unwrap() = Some("0".into());
                }
                let wire = request(&call.args);
                let what = format!("{}: fetch {fetches}", case.id);
                let got = match &client {
                    Client::Compressing(adapter) if case.id == "async-compress-is-awaited-request-waits-for-it" => {
                        let send = adapter.fetch(wire);
                        tokio::pin!(send);
                        tokio::select! {
                            biased;
                            _ = &mut send => panic!("{what}: sent before the compressor finished"),
                            () = entered.notified() => {}
                        }
                        assert!(endpoint.arrivals().is_empty(), "{what}: nothing arrives while the compressor runs");
                        gate.notify_one();
                        within(&what, send).await
                    }
                    Client::Compressing(adapter) => within(&what, adapter.fetch(wire)).await,
                    Client::Plain => within(&what, link.send(wire, mixdog_ai::transport::deadlines::MODEL_STREAM)).await,
                };
                responses.push(response(got.expect("the fetch resolves")).await);
                if fetches == 1 && case.recorded().raw().try_get("requestsAfterFirstSend").is_some() {
                    extra.push(("requestsAfterFirstSend", Exact::Number(endpoint.arrivals().len() as f64)));
                    if case.recorded().raw().try_get("latchDisabledAfterFirst").is_some() {
                        extra.push(("latchDisabledAfterFirst", Exact::Bool(gzip_latched())));
                    }
                }
            }
        }
        // The core's answers in the recorded result's shape, in its key order: its response(s) (`{ response, text }`) and
        // each latch reading taken where the recorder took it.
        let recorded = case.recorded();
        let mut got = Vec::new();
        for (key, _) in recorded.entries() {
            let mine = match key {
                "response" => {
                    assert_eq!(responses.len(), 1, "{}: one fetch", case.id);
                    responses.remove(0)
                }
                "responses" => Exact::Array(std::mem::take(&mut responses)),
                "requestsAfterFirstSend" | "latchDisabledAfterFirst" => {
                    extra.iter().find(|(k, _)| *k == key).unwrap_or_else(|| panic!("{}: {key}", case.id)).1.clone()
                }
                "latchDisabled" | "latchDisabledAfterSecond" => Exact::Bool(gzip_latched()),
                other => panic!("{}: result field {other} not replayed", case.id),
            };
            got.push((key.to_owned(), mine));
        }
        recorded.assert_eq(&format!("{}: result", case.id), &Exact::Object(got));
        set.assert_requests(case, &endpoint.arrivals(), None);
    }
    reset_gzip_latch();
}
