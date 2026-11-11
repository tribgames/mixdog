//! `fixtures/provider-gemini-send-retry` (`record-gemini-send-retry.mjs`): `GeminiProvider({ apiKey, preconnect: false })
//! .send` under its two ladders, replayed through `DefaultProviderBuilder::build("gemini")` and `ModelBroker::send` on the
//! paused clock: a stream that never sends a byte (the first-chunk window) and one that goes quiet after a payload (the
//! idle window) each spend the stream ladder (4 attempts, 1/2/4 s) and then the non-streaming re-issue; refusals spend
//! the connection ladder (10 attempts, its jittered waits drawn from the recorders' `Math.random`).
//!
//! Compared whole: every request as it arrived (the re-issue's `:generateContent` included), the recorded clock steps,
//! the error through `ERROR_FIELDS`, the stages the send raised (`onStageChange`) and the lines it wrote to stderr.

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_rt::node_log::Channel;
use mixdog_testkit::Exact;
use tokio_util::sync::CancellationToken;

use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::RecorderDraws;
use crate::provider_case::T0_MS;
use crate::provider_case::assert_exact;
use crate::provider_case::within;
use crate::provider_cases::plain;
use crate::replay_errors::Left;
use crate::replay_errors::compare_error;
use crate::replay_world;

const RESULT_KEYS: [&str; 3] = ["error", "stages", "stderr"];

#[tokio::test(start_paused = true)]
async fn every_case_replays_as_nodes() {
    let set = CaseSet::load("gemini-send-retry");
    // The recording process's `Math.random`: one draw at module load (`PERIODIC_SNAPSHOT_INTERVAL_MS`,
    // shared/memory-snapshot.mjs:16), then one per connection-ladder retry (`withJitter`, retry-backoff.mjs:104). The stream
    // ladder draws none.
    let mut draws = RecorderDraws::default();
    draws.math_random();
    for case in &set.cases {
        let what = format!("gemini-send-retry {}", case.id);
        let endpoint = Endpoint::start().await;
        endpoint.serve(case);
        let home = tempfile::tempdir().expect("a home");
        let env: Vec<(String, String)> = case
            .input
            .try_get("env")
            .map(|env| env.entries().iter().map(|(k, v)| (k.clone(), v.as_str().to_owned())).collect())
            .unwrap_or_default();
        let builder = replay_world::builder(&endpoint, home.path(), env).await;
        let config = plain(&case.args_of("GeminiProvider", 0)[0]);
        let adapter = replay_world::adapter(&builder, "gemini", &config).await;
        let args = case.args_of("GeminiProvider#send", 0);
        // The options hold only the stage callback, which the sink's stages answer.
        assert_eq!(args[3].entries().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["onStageChange"], "{what}: send options");
        assert!(args[2].as_array().is_empty(), "{what}: no tools");
        let request = ModelRequest {
            model: args[1].as_str().to_owned(),
            messages: args[0].as_array().iter().map(replay_world::message).collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        };
        // The refusals' waits: each retry's step jitter is the next draw (no server advice, so the advice sample is
        // never applied).
        let retries = case.requests.len().saturating_sub(1);
        if case.id == "refusals-spend-the-connection-ladder" {
            mixdog_ai::random::script_jitter((0..retries).map(|_| {
                let draw = draws.math_random();
                (draw, draw)
            }));
        }
        mixdog_ai::wall::follow(Some(T0_MS + endpoint.now_ms()));
        let (lines, guard) = mixdog_rt::node_log::capture();
        let cancel = CancellationToken::new();
        let send = replay_world::send_with(adapter.as_ref(), request, &cancel, Default::default());
        // Each recorded step runs once the product waits where the recorder's did (its gate on the pending timers): a
        // window once the attempt's body is being read (after its payload, for the idle window), a retry wait once the
        // failed attempt's body is dropped.
        let reads = if case.id.starts_with("idle-") { 2 } else { 1 };
        let windows = !case.id.starts_with("refusals-");
        let clock = async {
            for (i, step) in case.clock.iter().enumerate() {
                let (k, window) = if windows { (i / 2, i % 2 == 0) } else { (i, false) };
                let gate = format!("{what}: step {i} (response {k} {})", if window { "read" } else { "dropped" });
                endpoint.until(&gate, |e| if window { e.body(k).reads >= reads } else { e.body(k).dropped }).await;
                endpoint.advance(step).await;
            }
        };
        let ((sent, events), ()) = within(&format!("{what}: the send"), async { tokio::join!(send, clock) }).await;
        drop(guard);
        mixdog_ai::wall::follow(None);
        mixdog_ai::random::script_jitter(Vec::new());
        endpoint.assert_clock(case);
        set.assert_requests(case, &endpoint.arrivals(), None);

        let recorded = case.result();
        for (key, _) in recorded.entries() {
            assert!(RESULT_KEYS.contains(&key.as_str()), "{what}: a recorded property this replay does not read: {key}");
        }
        compare_error(&format!("{what} error"), recorded.get("error"), &Left::of(&sent, &events));
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
        assert_exact(&format!("{what}: stages"), recorded.get("stages"), &stages);
        let stderr = Exact::Array(
            lines
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, channel, _)| *channel == Channel::Stderr)
                .map(|(_, _, line)| Exact::String(format!("{line}\n")))
                .collect(),
        );
        assert_exact(&format!("{what}: stderr"), recorded.get("stderr"), &stderr);
    }
}
