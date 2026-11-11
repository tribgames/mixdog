//! `fixtures/provider-retry-stages` (`record-provider-retry-stages.mjs`): each provider route's send whose first attempt
//! is refused as retryable and the second as not, so the send ends after one retry wait: the Anthropic API and xAI's
//! Responses and Chat Completions sends raise `reconnecting` before the wait and write their retry line; Vertex AI's
//! Gemini models retry their stream under the Gemini ladder by connection and raise neither. Replayed through
//! `DefaultProviderBuilder::build(<provider>)` and `ModelBroker::send` on the paused clock.
//!
//! Compared whole: the requests as they arrived, the clock steps, the error through `ERROR_FIELDS`, the `reconnecting`
//! stages with their payloads (the `requesting` / `streaming` stages are declared not compared: the core raises them
//! from its run loop) and the stderr lines.

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_rt::node_log::Channel;
use mixdog_testkit::Exact;
use tokio_util::sync::CancellationToken;

use crate::provider_case::Case;
use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::ErrorSide;
use crate::provider_case::RECORDER_PID;
use crate::provider_case::RecorderDraws;
use crate::provider_case::Replay;
use crate::provider_case::T0_MS;
use crate::provider_case::within;
use crate::provider_cases::plain;
use crate::replay_errors::Left;
use crate::replay_world;

pub const REPLAYS: &[Replay] = &[Replay { set: "retry-stages", run: every_case_replays_as_nodes }];

/// The manifest's line for the stages the core raises outside the provider send.
const OTHER_STAGES: &str = "requesting and streaming stages";

/// The builder's config of the case's recorded constructor call.
fn config(case: &Case, provider: &str) -> serde_json::Value {
    match provider {
        "anthropic" => plain(&case.args_of("AnthropicProvider", 0)[0]),
        "xai" => {
            let args = case.args_of("OpenAICompatProvider", 0);
            assert_eq!(args[0].as_str(), "xai", "{}: the compat preset", case.id);
            plain(&args[1])
        }
        "vertex-ai" => plain(&case.args_of("VertexAIProvider", 0)[0]),
        other => panic!("{}: a provider this set does not record: {other}", case.id),
    }
}

/// On the paused clock; every draw of the replay runs on the test's thread, whose scope holds its scripts.
#[tokio::test(start_paused = true)]
async fn every_case_replays_as_nodes() {
    let set = CaseSet::load("retry-stages");
    assert_eq!(set.cases.len(), 4, "the recorded cases");
    // The recording process's `Math.random`, in order: one draw at module load (`PERIODIC_SNAPSHOT_INTERVAL_MS`,
    // shared/memory-snapshot.mjs:16); then per request the Anthropic and OpenAI SDK clients make, one in `makeRequest`
    // (@anthropic-ai/sdk client.js:584, openai client.js:385); and per OpenAI-compatible retry the advice's jitter
    // (`shapeAdvice`, openai-compat-retry-profile.mjs:183). The Anthropic ladder waits the advice as sent, and Vertex AI's
    // stream ladder its fixed step: they draw none.
    let mut draws = RecorderDraws::default();
    draws.math_random();
    // xAI's Chat keys a sessionless send's conversation by the process (`ephemeral:${process.pid}`).
    mixdog_ai::pid::set(Some(RECORDER_PID));
    for case in &set.cases {
        let what = format!("retry-stages {}", case.id);
        let provider = case.input.get("provider").as_str();
        let sdk = matches!(provider, "anthropic" | "xai");
        if sdk {
            draws.math_random();
        }
        let advice = (provider == "xai").then(|| draws.math_random());
        if sdk {
            draws.math_random();
        }
        // One verdict per failed attempt, the retry's first; the core draws the samples of the last verdict too, which
        // Node never draws (a NaN, which any wait it entered would fail).
        let retry = advice.map_or((f64::NAN, f64::NAN), |sample| (sample, sample));
        mixdog_ai::random::script_jitter([retry, (f64::NAN, f64::NAN)]);

        let endpoint = Endpoint::start().await;
        endpoint.serve(case);
        let home = tempfile::tempdir().expect("a home");
        let builder = replay_world::builder(&endpoint, home.path(), Vec::new()).await;
        let adapter = replay_world::adapter(&builder, provider, &config(case, provider)).await;
        let args = case.args_of("#send", 0);
        assert_eq!(args[3].entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["onStageChange"], "{what}: send options");
        assert!(args[2].as_array().is_empty(), "{what}: no tools");
        let request = ModelRequest {
            model: args[1].as_str().to_owned(),
            messages: args[0].as_array().iter().map(replay_world::message).collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        };
        mixdog_ai::wall::follow(Some(T0_MS + endpoint.now_ms()));
        let (lines, guard) = mixdog_rt::node_log::capture();
        let cancel = CancellationToken::new();
        let send = replay_world::send_with(adapter.as_ref(), request, &cancel, Default::default());
        // Each retry wait is taken once the attempt before it failed (its response body dropped).
        let clock = async {
            for (k, step) in case.clock.iter().enumerate() {
                endpoint.until(&format!("{what}: attempt {k} failed"), |e| e.body(k).dropped).await;
                endpoint.advance(step).await;
            }
        };
        let ((sent, events), ()) = within(&format!("{what}: the send"), async { tokio::join!(send, clock) }).await;
        drop(guard);
        mixdog_ai::wall::follow(None);
        mixdog_ai::random::script_jitter(Vec::new());
        endpoint.assert_clock(case);
        set.assert_requests(case, &endpoint.arrivals(), None);

        let recorded = case.recorded();
        recorded.get("error").assert_error(&format!("{what} error"), ErrorSide::Send(&Left::of(&sent, &events)));
        let stages = Exact::Array(
            events
                .stages
                .iter()
                .map(|(stage, payload)| {
                    let mut entry = vec![("stage".to_owned(), Exact::String(stage.clone()))];
                    if let Some(payload) = payload {
                        entry.push(("payload".to_owned(), Exact::plain(payload)));
                    }
                    Exact::Object(entry)
                })
                .collect(),
        );
        let retry_stage = |entry: &Exact| entry.get("stage").as_str() == "reconnecting";
        recorded.get("stages").assert_filtered(&format!("{what}: stages"), OTHER_STAGES, retry_stage, &stages);
        let stderr = Exact::Array(
            lines
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, channel, _)| *channel == Channel::Stderr)
                .map(|(_, _, line)| Exact::String(format!("{line}\n")))
                .collect(),
        );
        recorded.get("stderr").assert_eq(&format!("{what}: stderr"), &stderr);
    }
}
