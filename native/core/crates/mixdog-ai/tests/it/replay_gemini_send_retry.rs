//! `fixtures/provider-gemini-send-retry` (`record-gemini-send-retry.mjs`): `GeminiProvider({ apiKey, preconnect: false })
//! .send` under its two ladders, replayed through `DefaultProviderBuilder::build("gemini")` and `ModelBroker::send` on the
//! paused clock, one case per way an attempt fails. Before the response opened - a refused connection, a reset TLS
//! handshake (the endpoint's connection faults, [`Endpoint::connect_fault`]), a 503, a 429 with server advice - the
//! connection ladder (10 attempts, its jittered waits drawn from the recorders' `Math.random`); a 400 is not retried.
//! After it opened - the first-chunk window, the idle window after a payload, a reset after a quiet payload, an in-band
//! error event - the stream ladder (4 attempts, 1/2/4 s), then the non-streaming re-issue; a reset after shown text
//! surfaces at once, the text kept.
//!
//! Compared whole: every request as it arrived (the re-issue's `:generateContent` included), the recorded clock steps,
//! the error through `ERROR_FIELDS`, the stages the send raised (`onStageChange`), the text it relayed (`onTextDelta`)
//! and the lines it wrote to stderr.

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_rt::node_log::Channel;
use mixdog_testkit::Exact;
use tokio_util::sync::CancellationToken;

use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::RecorderDraws;
use crate::provider_case::Replay;
use crate::provider_case::T0_MS;
use crate::provider_case::within;
use crate::provider_cases::plain;
use crate::provider_case::ErrorSide;
use crate::replay_errors::Left;
use crate::replay_world;

pub const REPLAYS: &[Replay] = &[Replay { set: "gemini-send-retry", run: every_case_replays_as_nodes }];

/// On the paused clock; every draw of the replay runs on the test's thread, whose scope holds its scripts.
#[tokio::test(start_paused = true)]
async fn every_case_replays_as_nodes() {
    let set = CaseSet::load("gemini-send-retry");
    assert_eq!(set.cases.len(), 10, "the recorded cases");
    // The recording process's `Math.random`: one draw at module load (`PERIODIC_SNAPSHOT_INTERVAL_MS`,
    // shared/memory-snapshot.mjs:16), then per connection-ladder retry one for the step's jitter and, under server advice,
    // one more for the advice's (`retryDelayFor`, retry-executor.mjs:320-324; `jitterDelayMs`, retry-backoff.mjs:93-104).
    // The stream ladder draws none.
    let mut draws = RecorderDraws::default();
    draws.math_random();
    for case in &set.cases {
        let what = format!("gemini-send-retry {}", case.id);
        let input = &case.input;
        let endpoint = Endpoint::start().await;
        endpoint.serve(case);
        if let Some(fault) = input.try_get("fault") {
            endpoint.connect_fault(fault.as_str()).await;
        }
        let home = tempfile::tempdir().expect("a home");
        let env: Vec<(String, String)> = input
            .try_get("env")
            .map(|env| env.entries().iter().map(|(k, v)| (k.clone(), v.as_str().to_owned())).collect())
            .unwrap_or_default();
        let builder = replay_world::builder(&endpoint, home.path(), env).await;
        let config = plain(&case.args_of("GeminiProvider", 0)[0]);
        let adapter = replay_world::adapter(&builder, "gemini", &config).await;
        let args = case.args_of("GeminiProvider#send", 0);
        // The options hold the stage and text callbacks, which the sink's stages and text answer.
        assert_eq!(args[3].entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["onStageChange", "onTextDelta"], "{what}: send options");
        assert!(args[2].as_array().is_empty(), "{what}: no tools");
        let request = ModelRequest {
            model: args[1].as_str().to_owned(),
            messages: args[0].as_array().iter().map(replay_world::message).collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        };
        let window = input.get("ladder").as_str() == "window";
        // The connection ladder's waits (the cases whose attempts fail before the response opened): each retry's draws,
        // then the samples of the verdict that ends the ladder, which the core draws before it knows the ladder is spent
        // and Node never draws (a NaN, which any wait it entered would fail).
        let connection_retries = case.clock.len();
        let connection = !window && input.try_get("fault").is_some() || case.requests.first().is_some_and(|r| r.get("reply").get("status").as_f64() != 200.0);
        if connection && connection_retries > 0 {
            // A connection fault never reaches the endpoint: no request, no advice.
            let advice = case.requests.first().is_some_and(|r| r.get("reply").try_get("headers").is_some_and(|h| h.try_get("retry-after").is_some()));
            let mut samples: Vec<(f64, f64)> = (0..connection_retries)
                .map(|_| {
                    let step = draws.math_random();
                    (step, if advice { draws.math_random() } else { step })
                })
                .collect();
            samples.push((f64::NAN, f64::NAN));
            mixdog_ai::random::script_jitter(samples);
        }
        mixdog_ai::wall::follow(Some(T0_MS + endpoint.now_ms()));
        let (lines, guard) = mixdog_rt::node_log::capture();
        let cancel = CancellationToken::new();
        let send = replay_world::send_with(adapter.as_ref(), request, &cancel, Default::default());
        // Each recorded step runs once the product waits where the recorder's did (its gate on the pending timers): a
        // window once the attempt's body is being read (past its payload, for the idle window), a retry wait once the
        // attempt failed (its body dropped, or its connection fault reported).
        let reads = if input.try_get("afterPayload").is_some_and(|a| a.as_bool()) { 2 } else { 1 };
        let faulted = input.try_get("fault").is_some();
        let clock = async {
            for (i, step) in case.clock.iter().enumerate() {
                let (k, in_window) = if window { (i / 2, i % 2 == 0) } else { (i, false) };
                let gate = format!("{what}: step {i} (attempt {k} {})", if in_window { "read" } else { "failed" });
                endpoint
                    .until(&gate, |e| {
                        if in_window {
                            e.body(k).reads >= reads
                        } else if faulted {
                            e.failed() > k
                        } else {
                            e.body(k).dropped
                        }
                    })
                    .await;
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
        recorded.get("stages").assert_eq(&format!("{what}: stages"), &stages);
        let text = Exact::Array(
            events.events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(Exact::String(t.clone())) } else { None }).collect(),
        );
        recorded.get("text").assert_eq(&format!("{what}: text"), &text);
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
