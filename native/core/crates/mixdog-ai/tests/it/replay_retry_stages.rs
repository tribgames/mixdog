//! `fixtures/provider-retry-stages` (`record-provider-retry-stages.mjs`): each provider route's send whose first attempt
//! is refused as retryable and the second as not, so the send ends after one retry wait: the Anthropic API and xAI's
//! Responses and Chat Completions sends raise `reconnecting` before the wait and write their retry line; Vertex AI's
//! Gemini models retry their stream under the Gemini ladder by connection and raise neither. The OAuth, gateway and Vertex
//! routes (Anthropic OAuth, the Messages wire of OpenRouter, Grok OAuth, Antigravity, Vertex AI's Claude and open models)
//! run under the account files the case records; Devin runs no ladder and surfaces its first failure. Replayed through
//! `DefaultProviderBuilder::build(<provider>)` and `ModelBroker::send` on the paused clock.
//!
//! Compared whole: the requests as they arrived, the clock steps, the error through `ERROR_FIELDS`, the `reconnecting`
//! stages with their payloads (the `requesting` / `streaming` stages are declared not compared: the core raises them
//! from its run loop) and the stderr lines.

use futures::FutureExt as _;
use mixdog_ai::providers::openai::adapter::SessionContext;
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
    let class = match provider {
        "xai" => {
            let args = case.args_of("OpenAICompatProvider", 0);
            assert_eq!(args[0].as_str(), "xai", "{}: the compat preset", case.id);
            return plain(&args[1]);
        }
        "anthropic" => "AnthropicProvider",
        "anthropic-oauth" => "AnthropicOAuthProvider",
        "openrouter" => "OpenRouterProvider",
        "grok-oauth" => "GrokOAuthProvider",
        "antigravity-oauth" => "AntigravityOAuthProvider",
        "vertex-ai" => "VertexAIProvider",
        "devin-oauth" => "DevinOAuthProvider",
        // The registered OpenCode Go provider wraps the gateway engines the recorder drove (`OpenCodeGoProvider`).
        "opencode-go-oauth" => "OpenCodeGoProvider",
        other => panic!("{}: a provider this set does not record: {other}", case.id),
    };
    plain(&case.args_of(class, 0)[0])
}

/// What the recorder's `Math.random` stream held for the case's send, as the product's code draws it: how many draws
/// the send made (the OpenAI and Anthropic SDK clients draw one per request they make, the compat retry advice one
/// jitter sample) and which of them is the retry jitter sample, if any. The count is checked against the recorded one,
/// so a provider that draws another number fails here rather than shifting the sample.
fn draw_shape(id: &str) -> (u32, Option<(u32, u32)>) {
    match id {
        "anthropic-api-key-raises-the-stage" | "gateway-messages-raises-the-stage" | "vertex-maas-raises-the-stage" => (2, None),
        "xai-responses-raises-the-stage" | "xai-chat-raises-the-stage" | "grok-oauth-raises-the-stage" => (3, Some((1, 1))),
        // Antigravity's capacity ladder draws the one jitter sample (antigravity-retry-policy.mjs:144).
        "antigravity-raises-the-stage" => (1, Some((0, 0))),
        // The Gemini ladder by connection draws the step's sample and, the refusal advising a wait, the advice's
        // (`retryDelayFor`, retry-executor.mjs:320-324; `jitterDelayMs`, retry-backoff.mjs:93-104).
        "opencode-go-gemini-raises-the-ladder-stage" => (2, Some((0, 1))),
        "vertex-gemini-retries-its-stream-without-the-stage"
        | "anthropic-oauth-raises-the-stage"
        | "anthropic-oauth-redacts-an-echoed-credential"
        | "anthropic-oauth-redacts-an-echoed-credential-in-a-429"
        | "vertex-claude-raises-the-stage"
        | "devin-surfaces-the-first-failure" => (0, None),
        other => panic!("{other}: no draw shape for this case"),
    }
}

/// On the paused clock; every draw of the replay runs on the test's thread, whose scope holds its scripts.
#[tokio::test(start_paused = true)]
async fn every_case_replays_as_nodes() {
    let set = CaseSet::load("retry-stages");
    assert_eq!(set.cases.len(), 14,"the recorded cases");
    // The recording process's `Math.random`, in order (a draw at module load, `PERIODIC_SNAPSHOT_INTERVAL_MS`,
    // shared/memory-snapshot.mjs:16; per request the Anthropic and OpenAI SDK clients make, one in `makeRequest`,
    // @anthropic-ai/sdk client.js:584, openai client.js:385; per OpenAI-compatible retry the advice's jitter,
    // `shapeAdvice`, openai-compat-retry-profile.mjs:183): each case records where its draws began and how many it made.
    // The Anthropic ladders wait the advice as sent, and Vertex AI's stream ladder its fixed step: they draw none.
    let mut draws = RecorderDraws::default();
    let mut consumed = 0_u32;
    // xAI's Chat keys a sessionless send's conversation by the process (`ephemeral:${process.pid}`).
    mixdog_ai::pid::set(Some(RECORDER_PID));
    // Every case replays, and a failed one is reported with the rest.
    let mut failures = Vec::new();
    let mut uuids_consumed = 0_u32;
    for case in &set.cases {
      let replay = async {
        let what = format!("retry-stages {}", case.id);
        let provider = case.input.get("provider").as_str();
        let recorded_draws = case.recorded().get("draws").raw();
        let (first, count) = (recorded_draws.get("first").as_f64() as u32, recorded_draws.get("count").as_f64() as u32);
        let (shape_count, jitter_at) = draw_shape(&case.id);
        assert_eq!(count, shape_count, "{what}: the draws the recorded send made");
        while consumed < first {
            draws.math_random();
            consumed += 1;
        }
        let drawn: Vec<f64> = (0..count).map(|_| draws.math_random()).collect();
        consumed += count;
        // One verdict per failed attempt, the retry's first; the core draws the samples of the last verdict too, which
        // Node never draws (a NaN, which any wait it entered would fail).
        let retry = jitter_at.map_or((f64::NAN, f64::NAN), |(step, advice)| (drawn[step as usize], drawn[advice as usize]));
        mixdog_ai::random::script_jitter([retry, (f64::NAN, f64::NAN)]);
        // The world's `crypto.randomUUID`, a stream of its own: the ids the send drew.
        let (uuid_first, uuid_count) = (recorded_draws.get("uuidFirst").as_f64() as u32, recorded_draws.get("uuidCount").as_f64() as u32);
        while uuids_consumed < uuid_first {
            draws.uuid_bytes();
            uuids_consumed += 1;
        }
        mixdog_ai::random::script((0..uuid_count).map(|_| draws.uuid_bytes()).collect::<Vec<_>>());
        uuids_consumed += uuid_count;

        let endpoint = Endpoint::start().await;
        endpoint.serve(case);
        let home = tempfile::tempdir().expect("a home");
        // The account the recorded case ran under: the credential files of its data directory, and the one `gcloud` names.
        for (file, document) in case.input.try_get("credentials").map_or(&[][..], Exact::entries) {
            let text = serde_json::to_string(&plain(document)).expect("a credentials document");
            std::fs::write(home.path().join(file), text).expect("a credentials file");
        }
        let env = case
            .input
            .try_get("adcFile")
            .map(|file| vec![("GOOGLE_APPLICATION_CREDENTIALS".to_owned(), home.path().join(file.as_str()).display().to_string())])
            .unwrap_or_default();
        // The models.dev catalog the case routes by, its recorded input as the disk copy the product warms from.
        if let Some(catalog) = case.input.try_get("modelsDev") {
            let text = serde_json::json!({ "fetchedAt": 1, "data": plain(catalog) }).to_string();
            std::fs::create_dir_all(home.path().join("catalog")).expect("a catalog directory");
            std::fs::write(home.path().join("catalog").join("modelsdev-catalog.json"), text).expect("the models.dev disk copy");
        }
        // Antigravity reads the updater's manifest before its first send, which the recording holds as its first arrival.
        let builder = replay_world::builder_versioned(&endpoint, home.path(), env, SessionContext::new(), provider == "antigravity-oauth").await;
        let adapter = replay_world::adapter(&builder, provider, &config(case, provider)).await;
        let args = case.args_of("#send", 0);
        // The options the send was called with: the stage callback (the sink's) and the gateway case's output ceiling.
        let mut options = RequestOptions::default();
        for (key, value) in args[3].entries() {
            match key.as_str() {
                "onStageChange" => {}
                "modelMaxOutputTokens" => options.model_max_output_tokens = Some(value.as_f64() as u32),
                "sessionId" => options.session_id = Some(value.as_str().to_owned()),
                other => panic!("{what}: a send option this replay does not read: {other}"),
            }
        }
        assert!(args[2].as_array().is_empty(), "{what}: no tools");
        let request = ModelRequest {
            model: args[1].as_str().to_owned(),
            messages: args[0].as_array().iter().map(replay_world::message).collect(),
            tools: Vec::new(),
            options,
        };
        mixdog_ai::wall::follow(Some(T0_MS + endpoint.now_ms()));
        let (lines, guard) = mixdog_rt::node_log::capture();
        let cancel = CancellationToken::new();
        let send = replay_world::send_with(adapter.as_ref(), request, &cancel, Default::default());
        // Each retry wait is taken once the attempt before it failed (its response body dropped): the arrivals that are
        // attempts are the ones the recording lists (the others are token grants and the like).
        let attempt_requests: Vec<usize> = case.recorded().get("attemptRequests").raw().as_array().iter().map(|at| at.as_f64() as usize).collect();
        let clock = async {
            for (k, step) in case.clock.iter().enumerate() {
                let at = attempt_requests[k];
                endpoint.until(&format!("{what}: attempt {k} failed"), |e| e.body(at).dropped).await;
                endpoint.advance(step).await;
            }
        };
        let ((sent, events), ()) = within(&format!("{what}: the send"), async { tokio::join!(send, clock) }).await;
        drop(guard);
        mixdog_ai::wall::follow(None);
        mixdog_ai::random::script_jitter(Vec::new());
        mixdog_ai::random::script(Vec::new());
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
        if provider == "opencode-go-oauth" {
            // The Gemini engine raises its own `requesting` stages (GeminiProvider's send), so none is the run loop's to
            // leave out: the stages are compared whole.
            recorded.get("stages").assert_eq(&format!("{what}: stages"), &stages);
        } else {
            recorded.get("stages").assert_filtered(&format!("{what}: stages"), OTHER_STAGES, &stages);
        }
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
      };
      if let Err(panic) = std::panic::AssertUnwindSafe(replay).catch_unwind().await {
          let text = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned()));
          failures.push(format!("{}: {}", case.id, text.unwrap_or_else(|| "a panic".into())));
      }
    }
    assert!(failures.is_empty(), "{} of {} cases differ from Node:\n{}", failures.len(), set.cases.len(), failures.join("\n"));
}
