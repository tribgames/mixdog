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

use mixdog_ai::broker::SendError;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use mixdog_rt::node_log::Channel;
use mixdog_testkit::Exact;
use tokio_util::sync::CancellationToken;

use crate::provider_case::Case;
use crate::provider_case::CaseSet;
use crate::provider_case::ClockStep;
use crate::provider_case::Endpoint;
use crate::provider_case::RecorderDraws;
use crate::provider_case::Replay;
use crate::provider_case::T0_MS;
use crate::provider_case::within;
use crate::provider_cases::plain;
use crate::provider_case::ErrorSide;
use crate::replay_errors::Left;
#[cfg(node_twin)]
use crate::replay_world;

/// Cases whose recording is Node's and whose behavior the product departs from on purpose, each with the decision. A departed
/// case is still sent through the same world and is compared on the request count, the clock it takes under the decided rule
/// and the terminal verdict, not against the recorded ladder; the recording itself is untouched.
const FIRST_CHUNK: &str = "first-chunk-timeouts-spend-the-stream-ladder";
const IDLE: &str = "idle-timeouts-spend-the-stream-ladder";
const DEPARTURES: &[(&str, &str)] = &[
    (
        FIRST_CHUNK,
        "Every Gemini route waits one long first-byte window (285 s, not Node's 60 s) and retries a first-byte timeout once; the second \
         is the provider's terminal verdict, which no stream-ladder attempt or non-streaming re-issue follows.",
    ),
    (
        IDLE,
        "The idle window starts with the first output, not with the stream (Node re-armed it on every decoded payload, the recording's \
         quiet empty-text one included): a payload without output enters the first-output phase, whose 600 s window the model-exchange \
         driver enforces on every path, so nothing ends the attempt at 120 s; at 600 s the driver expires it as one failure of the \
         attempt, which the provider's stream ladder then retries after its back-off.",
    ),
];

#[cfg(node_twin)]
pub const REPLAYS: &[Replay] = &[Replay { set: "gemini-send-retry", run: every_case_replays_as_nodes }];

/// On the paused clock; every draw of the replay runs on the test's thread, whose scope holds its scripts.
#[cfg(node_twin)]
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
        // The decided departure's clock: the long window of the attempt, the stream ladder's first wait, the long window of the
        // one retry, and nothing after the terminal verdict.
        let departed = DEPARTURES.iter().any(|(id, _)| *id == case.id);
        let decided: Vec<ClockStep> = {
            let origin = case.clock_origin_ms;
            let mut at = origin;
            [285_000, 1_000, 285_000]
                .into_iter()
                .map(|advance_ms| {
                    let step = ClockStep { advance_ms, from_ms: at, to_ms: at + advance_ms, fired: Vec::new() };
                    at += advance_ms;
                    step
                })
                .collect()
        };
        let steps: &[ClockStep] = if departed { &decided } else { &case.clock };
        let clock = async {
            if departed && case.id == IDLE {
                // The decided ladder, each streaming attempt in turn: it has read the fixture's non-semantic payload, survives the
                // 120 s at which Node's idle window cut it, and expires at its 600 s first-output window; the stream ladder then waits
                // 1, 2 and 4 s. After the fourth the single non-streaming recovery goes out.
                let step = |advance_ms: u64| ClockStep { advance_ms, from_ms: endpoint.now_ms(), to_ms: 0, fired: Vec::new() };
                for (k, backoff) in [1_000_u64, 2_000, 4_000, 0].into_iter().enumerate() {
                    endpoint.until(&format!("{what}: attempt {k} has read its payload"), |e| e.body(k).reads >= reads).await;
                    endpoint.advance(&step(120_000)).await;
                    for _ in 0..32 {
                        tokio::task::yield_now().await;
                    }
                    assert!(!endpoint.body(k).dropped, "{what}: attempt {k} survives 120 s");
                    endpoint.advance(&step(480_000)).await;
                    endpoint.until(&format!("{what}: attempt {k} expired"), |e| e.body(k).dropped).await;
                    if backoff > 0 {
                        endpoint.advance(&step(backoff)).await;
                    }
                }
                return;
            }
            for (i, step) in steps.iter().enumerate() {
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
        if departed && case.id == IDLE {
            let stderr: Vec<String> = lines.lock().unwrap().iter().filter(|(_, channel, _)| *channel == Channel::Stderr).map(|(_, _, line)| format!("{line}\n")).collect();
            assert_idle_ladder(&what, case, &endpoint, &sent, &events, &stderr);
            if let Some((_, reason)) = DEPARTURES.iter().find(|(id, _)| *id == case.id) {
                set.departed(&case.id, reason);
            }
            set.assert_requests(case, &endpoint.arrivals(), None);
            continue;
        }
        if departed {
            let shape = |steps: &[ClockStep]| -> Vec<(u64, u64, u64)> { steps.iter().map(|s| (s.advance_ms, s.from_ms, s.to_ms)).collect() };
            assert_eq!(shape(&endpoint.steps()), shape(&decided), "{what}: the clock of the decided rule");
            let Err(error) = &sent else { panic!("{what}: the departed case ends in an error") };
            assert_eq!(endpoint.arrivals().len(), 2, "{what}: the first attempt and its one retry, then the terminal verdict");
            assert!(format!("{error:?}").contains("first byte timed out after 285000ms"), "{what}: {error:?}");
            if let Some((_, reason)) = DEPARTURES.iter().find(|(id, _)| *id == case.id) {
                set.departed(&case.id, reason);
            }
            continue;
        }
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

/// The decided outcome of `idle-timeouts-spend-the-stream-ladder`, compared explicitly where it differs from the recording (the
/// recording stays as recorded): the fixture's non-semantic payload then silence, four streaming requests each expiring at the 600 s
/// first-output window the driver enforces (Node's idle window was 120 s), backoffs of 1, 2 and 4 s, then exactly one
/// non-streaming `:generateContent` request whose recorded 503 fails it, and the send exhausted with the stream's own timeout.
/// Request contents are compared against the recording by the caller.
#[cfg(node_twin)]
fn assert_idle_ladder(what: &str, case: &Case, endpoint: &Endpoint, sent: &Result<u32, SendError>, events: &crate::replay_world::Events, stderr: &[String]) {
    const WINDOW: &str = "Gemini REST streamGenerateContent first output timed out after 600000ms";
    // The clock: each attempt's 120 s and the rest of its window are one 600 s step of the decided sequence.
    let steps = endpoint.steps();
    let mut merged = Vec::new();
    let mut walk = steps.iter();
    while let Some(step) = walk.next() {
        if step.advance_ms == 120_000 {
            let rest = walk.next().expect("the rest of the window");
            assert_eq!(rest.advance_ms, 480_000, "{what}: the window's rest");
            merged.push((600_000_u64, step.from_ms, rest.to_ms));
        } else {
            merged.push((step.advance_ms, step.from_ms, step.to_ms));
        }
    }
    let mut at = case.clock_origin_ms;
    let want: Vec<(u64, u64, u64)> = [600_000_u64, 1_000, 600_000, 2_000, 600_000, 4_000, 600_000]
        .into_iter()
        .map(|advance| {
            let step = (advance, at, at + advance);
            at += advance;
            step
        })
        .collect();
    assert_eq!(merged, want, "{what}: the clock of the decided rule");
    // Requests: four streaming, one recovery, no sixth.
    let arrivals = endpoint.arrivals();
    assert_eq!(arrivals.len(), 5, "{what}: four streaming requests and the one recovery");
    for (i, arrival) in arrivals.iter().enumerate() {
        let path = arrival.get("path").as_str().to_owned();
        assert_eq!(path.contains(":streamGenerateContent"), i < 4, "{what}: request {i} is {path}");
        assert_eq!(path.ends_with(":generateContent"), i == 4, "{what}: request {i} is {path}");
    }
    // The result: exhausted with the stream's first-output timeout, neither cancelled nor the recovery's 503, and no text.
    let Err(SendError::Exhausted(error)) = sent else { panic!("{what}: the send ends exhausted: {sent:?}") };
    assert_eq!((error.code.as_deref(), error.message.as_str()), (Some("EGEMINITIMEOUT"), WINDOW), "{what}: the stream's timeout");
    assert!(error.timed_out && error.timeout_phase == Some(StreamTimeoutPhase::Idle), "{what}: the idle-timeout classification: {error:?}");
    assert_ne!(error.status, Some(503), "{what}: not the recovery's refusal");
    assert!(events.events.iter().all(|event| !matches!(event, StreamEvent::TextDelta(_))), "{what}: no text");
    // The stages: the recorded ones, with the retry times moved by the longer windows (the k-th retry comes k x 480 s later) and the
    // reason and message worded for the new window.
    let recorded = case.recorded();
    let stages = recorded.get("stages").raw();
    let want = stages.as_array();
    assert_eq!(events.stages.len(), want.len(), "{what}: the stages");
    for (got, recorded) in events.stages.iter().zip(want) {
        assert_eq!(got.0, recorded.get("stage").as_str(), "{what}: the stage");
        let Some(recorded) = recorded.try_get("payload") else {
            assert!(got.1.is_none(), "{what}: a stage without a payload");
            continue;
        };
        let payload = got.1.as_ref().expect("a reconnecting payload");
        let (attempt, max, wait) = (recorded.get("attempt").as_f64(), recorded.get("max").as_f64(), recorded.get("waitMs").as_f64());
        assert_eq!(payload["reasonClass"].as_str(), Some(recorded.get("reasonClass").as_str()), "{what}: the class");
        assert_eq!((payload["attempt"].as_f64(), payload["max"].as_f64(), payload["waitMs"].as_f64()), (Some(attempt), Some(max), Some(wait)), "{what}: the ladder");
        assert_eq!(payload["retryAt"].as_f64(), Some(recorded.get("retryAt").as_f64() + (attempt - 1.0) * 480_000.0), "{what}: the retry time");
        // The decided 600 s first-output window, stated here and not read back from the payload.
        let reason = "No progress 10m";
        assert_eq!(payload["reason"].as_str(), Some(reason), "{what}: the reason");
        assert_eq!(payload["message"].as_str(), Some(format!("{reason} · retry {attempt}/{max} in {}s", wait / 1000.0).as_str()), "{what}: the message");
        assert!(payload["classifier"].is_null(), "{what}: no classifier");
    }
    // The lines on stderr: the retries, worded for the new window, and no successful-recovery line.
    let lines: Vec<String> = (2..=4).map(|n| format!("[gemini] retry attempt {n} after {WINDOW}\n")).collect();
    assert_eq!(stderr, lines, "{what}: stderr");
}