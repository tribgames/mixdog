//! `fixtures/provider-anthropic-server-fallback` (`record-anthropic-server-fallback.mjs`): `AnthropicProvider({ apiKey
//! }).send` of claude-opus-5 / claude-fable-5 / claude-opus-4-8 with and without `serverFallback: false`, a stream that
//! carries a `fallback` block, and a streaming 404 answered by the non-streaming re-issue; replayed through
//! `DefaultProviderBuilder::build("anthropic")` and the broker's send. Node's `opts.serverFallback` is the request's
//! `model_parameters.serverFallback` (body.rs `server_fallback`).

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_testkit::Exact;
use tokio_util::sync::CancellationToken;

use crate::provider_case::Case;
use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::within;
use crate::replay_anthropic;
use crate::replay_world;

/// One `AnthropicProvider#send` (the n-th of the case) against `endpoint`, as Node's `{ result, ... }`.
async fn send(endpoint: &Endpoint, case: &Case, n: usize) -> replay_anthropic::Send {
    let home = tempfile::tempdir().expect("a home");
    let builder = replay_world::builder(endpoint, home.path(), Vec::new()).await;
    let config = crate::provider_cases::plain(&case.args_of("AnthropicProvider", n)[0]);
    let adapter = replay_world::adapter(&builder, "anthropic", &config).await;
    let args = case.args_of("AnthropicProvider#send", n);
    let opts = crate::provider_cases::plain(&args[3]);
    let model_parameters = opts.get("serverFallback").map(|on| serde_json::json!({ "serverFallback": on }));
    assert!(opts.as_object().is_some_and(|o| o.keys().all(|k| k == "serverFallback")), "{}: opts {opts}", case.id);
    let request = ModelRequest {
        model: args[1].as_str().to_owned(),
        messages: args[0].as_array().iter().map(replay_world::message).collect(),
        tools: Vec::new(),
        options: RequestOptions { model_parameters, ..RequestOptions::default() },
    };
    let cancel = CancellationToken::new();
    let what = format!("{}: send {n}", case.id);
    let (outcome, events) = within(&what, replay_world::send_with(adapter.as_ref(), request, &cancel, Default::default())).await;
    assert_eq!(outcome.expect("the send completes"), 1, "{what}: one attempt");
    replay_anthropic::send(&events.events, args[1].as_str())
}

fn result_of(sent: &replay_anthropic::Send) -> Exact {
    sent.result.clone()
}

#[tokio::test(start_paused = true)]
async fn every_api_key_case_replays_as_nodes() {
    let set = CaseSet::load("anthropic-server-fallback");
    for id in [
        "eligible-families-default-fallback",
        "beta-header-gated-and-deduplicated",
        "fallback-block-parser",
        "sse-records-fallback-attributes-serving-model",
        "non-streaming-normalizer-excludes-fallback-blocks-and-preserves-metadata",
    ] {
        let mut case = set.case(id).clone();
        if id == "fallback-block-parser" {
            // The recording's first arrival is the previous case's OAuth catalog refresh (`_refreshModelCache`,
            // anthropic-oauth.mjs:994-995, fire-and-forget), which landed after that case ended; it is no request
            // of this case.
            assert_eq!(case.requests[0].get("path").as_str(), "/v1/models", "{id}: the earlier case's refresh");
            case.requests.remove(0);
        }
        let case = &case;
        let endpoint = Endpoint::start().await;
        endpoint.serve(case);
        let sends = case.calls.iter().filter(|c| c.entry.ends_with("AnthropicProvider#send")).count();
        let mut results = Vec::new();
        for n in 0..sends {
            results.push(send(&endpoint, case, n).await);
        }
        let recorded = case.result();
        let what = format!("{id}: result");
        let comparable = |r: &Exact| replay_anthropic::comparable(r);
        match id {
            "eligible-families-default-fallback" => {
                let want = recorded.get("sends").as_array();
                assert_eq!(want.len(), results.len(), "{what}: one per send");
                for (k, (want, got)) in want.iter().zip(&results).enumerate() {
                    let model = case.args_of("AnthropicProvider#send", k)[1].clone();
                    assert_eq!(want.get("model"), &model, "{what}: send {k} model");
                    let opts = &case.args_of("AnthropicProvider#send", k)[3];
                    if let Some(off) = want.try_get("serverFallback") {
                        assert_eq!(opts.try_get("serverFallback"), Some(off), "{what}: send {k} option");
                    }
                    crate::provider_case::assert_exact(&format!("{what} {k}"), &comparable(want.get("result")), &result_of(got));
                }
            }
            "beta-header-gated-and-deduplicated" => {
                crate::provider_case::assert_exact(&format!("{what}: on"), &comparable(recorded.get("on")), &result_of(&results[0]));
                crate::provider_case::assert_exact(&format!("{what}: off"), &comparable(recorded.get("off")), &result_of(&results[1]));
            }
            _ => {
                assert_eq!(results.len(), 1, "{what}: one send");
                crate::provider_case::assert_exact(&what, &comparable(recorded.get("result")), &result_of(&results[0]));
            }
        }
        set.assert_requests(case, &endpoint.arrivals(), None);
    }
}
