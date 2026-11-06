//! Conformance checks every implementation of a domain trait runs in its own
//! tests (with its own fixtures); the mocks in [`super::mock`] pass them here.
//! Each check panics with the violated contract.

use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::MaintenanceIo;
use tokio_util::sync::CancellationToken;

use super::approval::ApprovalAsk;
use super::approval::ApprovalGate;
use super::common::AbsPath;
use super::common::EventSource;
use super::computer::ComputerAction;
use super::computer::ComputerBackend;
use super::computer::ComputerError;
use super::computer::ComputerRequest;
use super::computer::PointerButton;
use super::computer::ScreenInput;
use super::ext::ExtCall;
use super::ext::ExtError;
use super::ext::ExtFrame;
use super::ext::ExtPool;
use super::fs::FileService;
use super::fs::FsError;
use super::fs::FsErrorKind;
use super::fs::ReadRange;
use super::fs::SearchRequest;
use super::fs::WalkRequest;
use super::fs::WritePrecondition;
use super::fs::WriteRequest;
use super::keepalive::KeepaliveSchedule;
use super::keepalive::LinkLiveness;
use super::keepalive::TransportKeepalive;
use super::login::LoginFailure;
use super::login::LoginFlow;
use super::login::LoginState;
use super::media::MediaFrameSource;
use super::media::VideoCodec;
use super::media::VideoTrack;
use super::ownership::Ownership;
use super::process::CommandSpec;
use super::process::EnvSpec;
use super::process::ExitStatus;
use super::process::KillReason;
use super::process::OutputMode;
use super::process::ProcessError;
use super::process::ProcessEvent;
use super::process::ProcessManager;
use super::process::ProcessOwner;
use super::process::ProcessQueue;
use super::process::PtySize;
use super::process::SpawnRequest;
use super::provider::DeliveryState;
use super::provider::ErrorKind;
use super::provider::MessageSource;
use super::provider::ModelRequest;
use super::provider::ProviderAdapter;
use super::provider::ErrorResponse;
use super::provider::RequestThread;
use super::provider::Role;
use super::provider::ProviderError;
use super::provider::StreamEvent;
use super::provider::TransportFault;
use super::provider::WireCodec;
use super::repo::Cached;
use super::repo::RepoEvidence;
use super::repo::RepoInspector;
use super::repo::RepoRef;
use super::repo::ReviewRequest;
use super::retry::AdviceCombine;
use super::retry::AdviceRule;
use super::retry::Backoff;
use super::retry::Jitter;
use super::retry::JitterMode;
use super::retry::JitterSamples;
use super::retry::JitterStage;
use super::retry::KindSchedule;
use super::retry::RetryClass;
use super::retry::RetryDecider;
use super::retry::RetryPolicy;
use super::retry::RetryRow;
use super::retry::RetrySchedule;
use super::retry::RetryState;
use super::retry::ScheduleCount;
use super::retry::Verdict;
use super::tool::Tool;
use super::tool::ToolContext;
use super::tool::ToolErrorCode;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProcessHandle;

async fn drain<T: Send>(source: &mut dyn EventSource<T>) -> Vec<T> {
    let mut out = Vec::new();
    while let Some(item) = source.next().await {
        out.push(item);
    }
    out
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/// `complete` is a recorded wire body that ends with the terminal event;
/// `truncated` is the same body cut before it. `complete` is fed in two
/// units split at `split_at` to prove incremental decoding.
pub fn check_wire_codec(
    codec: &dyn WireCodec,
    request: &ModelRequest,
    complete: &[u8],
    truncated: &[u8],
    split_at: usize,
) {
    let mut decoder = codec.decoder(request);
    let (head, tail) = complete.split_at(split_at.min(complete.len()));
    let mut events = decoder.feed(head).expect("feed head");
    events.extend(decoder.feed(tail).expect("feed tail"));
    events.extend(decoder.finish().expect("a complete body finishes"));
    assert!(decoder.terminal_seen(), "terminal event seen");
    let terminals = events
        .iter()
        .filter(|e| matches!(e, StreamEvent::Completed { .. }))
        .count();
    assert_eq!(terminals, 1, "exactly one terminal event");
    assert!(
        matches!(events.last(), Some(StreamEvent::Completed { .. })),
        "terminal event is last"
    );

    let mut decoder = codec.decoder(request);
    decoder.feed(truncated).expect("feed truncated");
    let err = decoder
        .finish()
        .expect_err("end without terminal is an error");
    assert_eq!(err.transport, Some(TransportFault::TruncatedStream));
    assert_eq!(err.kind, ErrorKind::Transient);
    assert!(!decoder.terminal_seen());
}

/// One attempt ends with exactly one `Completed` or exactly one error,
/// and nothing follows it. `reached` is how far the fixture's transport let
/// this attempt's request get: `NotSent` for a fault before the first request
/// byte, `Ambiguous` for a fault after the write and before a response status
/// (a reset), `Accepted` once a status arrived (an HTTP rejection or a
/// stream). Every delivery state the adapter reports must equal it.
pub async fn check_provider_attempt(
    adapter: &dyn ProviderAdapter,
    request: Arc<ModelRequest>,
    reached: DeliveryState,
) {
    check_keepalive_schedule(adapter.keepalive());
    check_retry_policy(adapter.retry_policy());
    let mut stream = match adapter.attempt(request).await {
        Ok(stream) => stream,
        Err(err) => {
            check_error_delivery(&err, reached);
            return;
        }
    };
    let mut ended = false;
    let mut usage_seen = None;
    while let Some(item) = stream.next().await {
        assert!(!ended, "nothing after the terminal event or error");
        match item {
            Ok(StreamEvent::Completed { .. }) => ended = true,
            Ok(StreamEvent::Usage(usage)) => usage_seen = Some(usage),
            Err(err) => {
                check_error_delivery(&err, reached);
                if let Some(usage) = &usage_seen {
                    assert_eq!(
                        err.partial_usage.as_deref(),
                        Some(usage),
                        "an error after reported usage carries it, cost included"
                    );
                }
                ended = true;
            }
            Ok(_) => {}
        }
    }
    assert!(
        ended,
        "a stream ends with Completed or an error, never silently"
    );
    assert_eq!(
        stream.delivery(),
        reached,
        "the stream reports the delivery state the transport reached"
    );
}

/// The adapter lists its models: at least one, ids unique, limits positive,
/// and a default reasoning level that is one of the listed levels.
pub async fn check_model_listing(adapter: &dyn ProviderAdapter) {
    let models = adapter
        .models()
        .expect("a product adapter lists its models")
        .list_models()
        .await
        .expect("list models");
    assert!(!models.is_empty(), "a listing is never empty");
    let mut ids = std::collections::HashSet::new();
    for model in &models {
        assert!(!model.id.is_empty());
        assert!(ids.insert(model.id.as_str()), "model ids are unique");
        assert_ne!(model.context_window, Some(0));
        assert_ne!(model.max_output_tokens, Some(0));
        if let Some(level) = &model.default_reasoning_level {
            assert!(
                model.reasoning_levels.contains(level),
                "the default level is a listed level"
            );
        }
    }
}

/// `request` ends with a [`MessageSource::TailReminder`] user message whose
/// text is `reminder` (plain ASCII, so it appears verbatim in the body): the
/// codec sends it.
pub fn check_tail_reminder(codec: &dyn WireCodec, request: &ModelRequest, reminder: &str) {
    let last = request.messages.last().expect("a message");
    assert_eq!(last.source, Some(MessageSource::TailReminder));
    let wire = codec.encode(request).expect("encode");
    let body = String::from_utf8_lossy(&wire.body);
    assert!(body.contains(reminder), "the tail reminder is sent");
}

/// `request.options.hosted_tools` names a tool the codec's wire hosts: the
/// body carries it (differs from the same request without hosted tools), and
/// the function tools still encode.
pub fn check_hosted_tools(codec: &dyn WireCodec, request: &ModelRequest) {
    assert!(!request.options.hosted_tools.is_empty(), "fixture sets a hosted tool");
    let with = codec.encode(request).expect("encode with a hosted tool");
    let mut bare = request.clone();
    bare.options.hosted_tools.clear();
    let without = codec.encode(&bare).expect("encode without hosted tools");
    assert_ne!(with.body, without.body, "the hosted tool reaches the body");
    assert_eq!(with.url, without.url, "a hosted tool never changes where the request goes");
}

/// For a codec on the turn-scoped layout: an assistant message of `request`
/// carries [`super::provider::Message::turn_reminder`] `stored` (plain ASCII), which the body
/// re-sends as a `clear_at` system message; the message's own text is not
/// changed by it.
pub fn check_turn_reminder_replay(codec: &dyn WireCodec, request: &ModelRequest, stored: &str) {
    assert!(
        request
            .messages
            .iter()
            .any(|m| m.role == Role::Assistant && m.turn_reminder.as_deref() == Some(stored)),
        "fixture stores the reminder on an assistant turn"
    );
    let wire = codec.encode(request).expect("encode");
    let body: JsonValue = serde_json::from_slice(&wire.body).expect("a JSON body");
    let resent = body["messages"].as_array().into_iter().flatten().any(|m| {
        m["role"] == "system"
            && m["clear_at"] == "next_user_message"
            && m["content"][0]["text"] == stored
    });
    assert!(resent, "the stored reminder is re-sent as a clear_at system message");
}

/// `request.options.thread` is set: the identity encodes with and without a
/// turn (prewarm), and never changes where the request goes.
pub fn check_request_thread(codec: &dyn WireCodec, request: &ModelRequest) {
    let thread = request.options.thread.clone().expect("fixture sets a thread");
    let with_turn = codec.encode(request).expect("encode with a turn");
    let mut prewarm = request.clone();
    prewarm.options.thread = Some(RequestThread { turn: None, ..thread });
    let without_turn = codec.encode(&prewarm).expect("encode without a turn");
    let mut anonymous = request.clone();
    anonymous.options.thread = None;
    let without_thread = codec.encode(&anonymous).expect("encode without a thread");
    for other in [&without_turn, &without_thread] {
        assert_eq!(other.transport, with_turn.transport);
        assert_eq!(other.method, with_turn.method);
        assert_eq!(other.url, with_turn.url);
    }
}

fn check_error_delivery(err: &ProviderError, reached: DeliveryState) {
    assert_eq!(
        err.delivery, reached,
        "an error reports the delivery state the transport reached"
    );
    if let Some(url) = &err.verification_url {
        assert!(url.starts_with("https://"), "a verification URL is a page");
    }
    if err.status.is_some() {
        assert_eq!(
            err.delivery,
            DeliveryState::Accepted,
            "an error with a response status was accepted"
        );
    }
    if matches!(
        err.transport,
        Some(TransportFault::Connect { .. } | TransportFault::Dns)
    ) {
        assert_eq!(
            err.delivery,
            DeliveryState::NotSent,
            "nothing is sent without a connection"
        );
    }
}

pub fn check_keepalive_schedule(schedule: &KeepaliveSchedule) {
    let tcp = schedule.tcp;
    assert!(
        tcp.idle > Duration::ZERO && tcp.interval > Duration::ZERO && tcp.count > 0,
        "TCP keepalive on"
    );
    for ping in [schedule.h2, schedule.ws] {
        assert!(
            ping.interval > Duration::ZERO && ping.timeout > Duration::ZERO,
            "PING keepalive on"
        );
        assert!(ping.while_idle, "PING keepalive runs while idle");
    }
}

/// `go_half_open` makes the peer stop answering (e.g. drops its packets).
pub fn check_transport_keepalive(
    conn: &dyn TransportKeepalive,
    schedule: &KeepaliveSchedule,
    go_half_open: impl FnOnce(),
) {
    conn.arm(schedule).expect("arm");
    assert_eq!(conn.liveness(), LinkLiveness::Alive);
    go_half_open();
    assert_eq!(
        conn.liveness(),
        LinkLiveness::Dead(TransportFault::KeepaliveExpired {
            transport: conn.kind()
        }),
        "a half-open link becomes a keepalive failure"
    );
}

/// Each `(response, kind)` classifies to `kind`; the request-rejection kinds
/// (image, replay, tool schema) are never retried unchanged.
pub fn check_error_classification(codec: &dyn WireCodec, cases: &[(ErrorResponse, ErrorKind)]) {
    for (response, kind) in cases {
        let err = codec.classify(response);
        assert_eq!(err.kind, *kind, "status {:?}", response.status);
        if matches!(
            kind,
            ErrorKind::ImageRejected | ErrorKind::ReplayRejected | ErrorKind::ToolSchemaRejected
        ) {
            assert!(kind.is_deterministic(), "a rejected request is not retried unchanged");
        }
    }
}

/// `request` sets every send option: it encodes, and toggling the options
/// never changes where the request goes.
pub fn check_request_options(codec: &dyn WireCodec, request: &ModelRequest) {
    let options = &request.options;
    assert!(options.parent_session_id.is_some() && options.parallel_tool_calls.is_some());
    assert!(options.temperature.is_some());
    let set = codec.encode(request).expect("encode with options");
    let mut bare = request.clone();
    bare.options.parent_session_id = None;
    bare.options.parallel_tool_calls = None;
    bare.options.temperature = None;
    let unset = codec.encode(&bare).expect("encode without options");
    assert_eq!(set.transport, unset.transport);
    assert_eq!(set.method, unset.method);
    assert_eq!(set.url, unset.url);
}

pub fn check_retry_policy(policy: &RetryPolicy) {
    assert_ne!(
        policy.empty_response_reasks,
        Some(0),
        "no re-ask is `None`, not a zero bound"
    );
    for class in [
        RetryClass::Request,
        RetryClass::Midstream,
        RetryClass::Transport,
        RetryClass::Connection,
        RetryClass::Recovery,
    ] {
        let Some(row) = policy.row(class) else {
            continue;
        };
        for (i, entry) in row.by_kind.iter().enumerate() {
            assert!(
                row.by_kind[..i]
                    .iter()
                    .all(|other| other.kind != entry.kind),
                "{class:?}: one schedule per kind ({:?})",
                entry.kind
            );
        }
        for schedule in
            std::iter::once(&row.schedule).chain(row.by_kind.iter().map(|entry| &entry.schedule))
        {
            assert!(
                (0.0..=1.0).contains(&schedule.jitter.ratio),
                "{class:?}: jitter ratio in 0..=1"
            );
            assert!(
                (0.0..=1.0).contains(&schedule.advice.jitter.ratio),
                "{class:?}: advice jitter ratio in 0..=1"
            );
            match &schedule.backoff {
                Backoff::Ladder(steps) => {
                    assert!(
                        schedule.max_retries == 0 || !steps.is_empty(),
                        "{class:?}: ladder has steps"
                    );
                }
                Backoff::Exponential { base } => {
                    assert!(*base > Duration::ZERO, "{class:?}: positive base")
                }
            }
        }
    }
}

pub fn check_retry_decider(decider: &dyn RetryDecider) {
    let policy = RetryPolicy::codex_default();
    let fresh = |class| RetryState::new(class, "m");
    let request = || fresh(RetryClass::Request);
    let transient = |delivery| ProviderError::new(ErrorKind::Transient, delivery);
    let at = |step, advice| JitterSamples { step, advice };
    // Symmetric jitter is zero at 0.5.
    let mid = at(0.5, 0.5);
    let ms = Duration::from_millis;
    let verdict = |err: &ProviderError, state: &RetryState, policy: &RetryPolicy, samples| {
        decider.verdict(err, state, policy, samples).verdict
    };
    let delay_of = |verdict: Verdict| match verdict {
        Verdict::Retry { delay, .. } => Some(delay),
        _ => None,
    };
    // The state after `retries` retries of `err`, advanced only by the decider.
    let driven = |policy: &RetryPolicy, class, err: &ProviderError, retries: u32| {
        let mut state = fresh(class);
        for _ in 0..retries {
            let decision = decider.verdict(err, &state, policy, mid);
            assert!(
                matches!(decision.verdict, Verdict::Retry { .. }),
                "driving retries"
            );
            state = decision.next;
        }
        state
    };

    for kind in [
        ErrorKind::QuotaExhausted,
        ErrorKind::Entitlement,
        ErrorKind::Billing,
        ErrorKind::Auth,
        ErrorKind::Permission,
        ErrorKind::ContextOverflow,
        ErrorKind::RequestTooLarge,
        ErrorKind::Policy,
        ErrorKind::ServiceTierUnavailable,
        ErrorKind::InvalidRequest,
    ] {
        let err = ProviderError::new(kind, DeliveryState::Accepted);
        let decision = decider.verdict(&err, &request(), &policy, mid);
        assert_eq!(decision.verdict, Verdict::Surface, "{kind:?} surfaces");
        assert_eq!(
            decision.next.count(None),
            ScheduleCount::default(),
            "a surfaced failure uses no retry"
        );
    }

    let mut exposed = transient(DeliveryState::Accepted);
    exposed.exposure.text_emitted = true;
    assert_eq!(
        verdict(&exposed, &request(), &policy, mid),
        Verdict::Surface,
        "replay boundary"
    );

    let ambiguous = decider.verdict(
        &transient(DeliveryState::Ambiguous),
        &request(),
        &policy,
        mid,
    );
    match ambiguous.verdict {
        Verdict::Retry {
            delivery, delay, ..
        } => {
            assert_eq!(delivery, DeliveryState::Ambiguous, "delivery state carried");
            assert_eq!(
                ambiguous.next.count(None),
                ScheduleCount {
                    retries: 1,
                    waited: delay
                },
                "the decider records the retry"
            );
        }
        other => panic!("an ambiguous transient attempt is retried, got {other:?}"),
    }
    let spent = driven(
        &policy,
        RetryClass::Request,
        &transient(DeliveryState::NotSent),
        policy.request.schedule.max_retries,
    );
    assert_eq!(
        verdict(&transient(DeliveryState::NotSent), &spent, &policy, mid),
        Verdict::Exhausted,
        "row bounds retries"
    );

    let mut advised = transient(DeliveryState::Accepted);
    advised.retry_after = Some(Duration::from_secs(30));
    assert!(
        delay_of(verdict(&advised, &request(), &policy, at(1.0, 1.0)))
            .is_some_and(|d| d >= Duration::from_secs(30)),
        "advice honoured in full"
    );
    let mut capped = policy.clone();
    capped.request.schedule.advice.ceiling = Some(Duration::from_secs(10));
    assert_eq!(
        verdict(&advised, &request(), &capped, mid),
        Verdict::Exhausted,
        "advice beyond the ceiling"
    );

    let mut long = transient(DeliveryState::Ambiguous);
    long.retry_after = Some(Duration::from_secs(45));
    assert_eq!(
        delay_of(verdict(
            &long,
            &fresh(RetryClass::Transport),
            &policy,
            at(0.0, 0.0)
        )),
        Some(Duration::from_secs(45)),
        "session-level advice replaces the step and is honoured in full"
    );

    // An xai-shaped provider rule: clamped and jittered except on a 429.
    let mut windowed = policy.clone();
    windowed.request.schedule.advice = AdviceRule {
        clamp: Some(Duration::from_secs(30)),
        jitter: Jitter::symmetric(0.2),
        jitter_stage: JitterStage::Advice,
        raw_statuses: vec![429],
        ..AdviceRule::honored_in_full()
    };
    let advised_status = |kind, status| {
        let mut err = ProviderError::new(kind, DeliveryState::Accepted);
        err.status = Some(status);
        err.retry_after = Some(Duration::from_secs(60));
        err
    };
    let xai = |err: &ProviderError, samples| delay_of(verdict(err, &request(), &windowed, samples));
    let unavailable = advised_status(ErrorKind::Transient, 503);
    assert_eq!(
        xai(&unavailable, mid),
        Some(Duration::from_secs(30)),
        "advice clamped"
    );
    assert_eq!(
        xai(&unavailable, at(0.0, 1.0)),
        Some(Duration::from_secs(36)),
        "clamped advice jittered by its own draw"
    );
    let limited = advised_status(ErrorKind::RateLimited, 429);
    assert_eq!(
        xai(&limited, at(1.0, 1.0)),
        Some(Duration::from_secs(60)),
        "raw status keeps its advice"
    );

    // The Gemini request row (`gemini-retry-policy.mjs`): a ±30 % step and
    // positive 0.2 jitter on the floored wait. With step > advice the JS
    // waits `jitter⁺(max(advice, jitter±(step)))` with two `Math.random()`
    // draws: retry 3 has a 20 s step and 5 s of advice. Expected values come
    // from `jitterDelayMs`: step 20 000 + (2s − 1)·6 000, then wait · (1 + 0.2a).
    let mut gemini = policy.clone();
    gemini.request = RetryRow::single(RetrySchedule {
        max_retries: 9,
        backoff: Backoff::Ladder([5, 10, 20, 30].map(Duration::from_secs).to_vec()),
        jitter: Jitter::symmetric(0.3),
        advice: AdviceRule {
            combine: AdviceCombine::Floor,
            ceiling: Some(Duration::from_secs(300)),
            jitter: Jitter {
                ratio: 0.2,
                mode: JitterMode::Positive,
            },
            jitter_stage: JitterStage::Wait,
            ..AdviceRule::honored_in_full()
        },
    });
    // The Gemini midstream row: 4 attempts at an unjittered 1 s · 2^n step;
    // `midstreamRetryDelayMs` returns retryable advice unchanged, and advice
    // over 300 s ends recovery on both phases.
    gemini.midstream = RetryRow::single(RetrySchedule {
        max_retries: 3,
        backoff: Backoff::Exponential {
            base: Duration::from_secs(1),
        },
        jitter: Jitter::NONE,
        advice: AdviceRule {
            ceiling: Some(Duration::from_secs(300)),
            ..AdviceRule::honored_in_full()
        },
    });
    let mut short_advice = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
    short_advice.status = Some(503);
    short_advice.retry_after = Some(Duration::from_secs(5));
    let third = driven(
        &gemini,
        RetryClass::Request,
        &transient(DeliveryState::Accepted),
        2,
    );
    let wait = |step, advice| delay_of(verdict(&short_advice, &third, &gemini, at(step, advice)));
    assert_eq!(wait(0.5, 0.0), Some(ms(20_000)), "both jitters zero");
    assert_eq!(
        wait(1.0, 1.0),
        Some(ms(31_200)),
        "both jitters at maximum: 26 000 · 1.2"
    );
    // Distinct draws: each result depends on both, and swapping them changes it.
    assert_eq!(wait(1.0, 0.25), Some(ms(27_300)), "26 000 · 1.05");
    assert_eq!(wait(0.25, 1.0), Some(ms(20_400)), "17 000 · 1.2");

    // Gemini midstream retry 2 (2 s step): advice replaces the step whether
    // it is longer or shorter, with neither draw applied.
    let second = driven(
        &gemini,
        RetryClass::Midstream,
        &transient(DeliveryState::Accepted),
        1,
    );
    let mid_wait = |advice_s, samples| {
        let mut err = short_advice.clone();
        err.retry_after = Some(Duration::from_secs(advice_s));
        verdict(&err, &second, &gemini, samples)
    };
    for samples in [at(0.0, 0.0), at(1.0, 1.0), at(0.25, 0.75)] {
        assert_eq!(
            delay_of(mid_wait(5, samples)),
            Some(ms(5_000)),
            "Gemini midstream: longer advice waited unchanged"
        );
        assert_eq!(
            delay_of(mid_wait(1, samples)),
            Some(ms(1_000)),
            "Gemini midstream: shorter advice replaces the step"
        );
    }
    assert_eq!(
        mid_wait(301, mid),
        Verdict::Exhausted,
        "Gemini midstream: advice over 300 s ends recovery"
    );

    check_antigravity(decider, &policy);
}

/// The Antigravity request row (`antigravity-retry-policy.mjs`,
/// `antigravity-transport.mjs`). Expected values by hand from the JS:
/// - the inner `withRetry` (`ANTIGRAVITY_RETRY`, `retry429: false`): 3
///   retries at backoff[n] of [1000, 1000, 2000, 4000], ±10 %, advice in
///   full; every 429 surfaces from it to the outer loop;
/// - capacity (`antigravity429WaitMs` :174-183, a 429, or a 503/529 the inner
///   ladder spent): 3 retries, wait `max(round(min(1000·2^i, 8000)·(0.9 +
///   0.2·rand)), advice)`, surfacing when `waited + advice > 60 000`, where
///   `waited` sums the actual waits;
/// - RPM (:186-189): one retry, `advice ?? 1000` unjittered, surfacing when
///   advice > 60 000;
/// - each outer retry runs a fresh inner `withRetry` (:152-176).
fn check_antigravity(decider: &dyn RetryDecider, base: &RetryPolicy) {
    let at = |step, advice| JitterSamples { step, advice };
    let mid = at(0.5, 0.5);
    let ms = Duration::from_millis;
    let steps = || Backoff::Ladder([1, 2, 4].map(Duration::from_secs).to_vec());
    let mut policy = base.clone();
    policy.status.retry_429 = false;
    policy.request = RetryRow {
        schedule: RetrySchedule {
            max_retries: 3,
            backoff: steps(),
            jitter: Jitter::symmetric(0.1),
            advice: AdviceRule::honored_in_full(),
        },
        by_kind: vec![
            KindSchedule {
                kind: ErrorKind::Overloaded,
                schedule: RetrySchedule {
                    max_retries: 3,
                    backoff: steps(),
                    jitter: Jitter::symmetric(0.1),
                    advice: AdviceRule {
                        combine: AdviceCombine::Floor,
                        budget: Some(Duration::from_secs(60)),
                        ..AdviceRule::honored_in_full()
                    },
                },
                resets_base: true,
            },
            KindSchedule {
                kind: ErrorKind::RateLimited,
                schedule: RetrySchedule {
                    max_retries: 1,
                    backoff: Backoff::Ladder(vec![Duration::from_secs(1)]),
                    jitter: Jitter::NONE,
                    advice: AdviceRule {
                        ceiling: Some(Duration::from_secs(60)),
                        ..AdviceRule::honored_in_full()
                    },
                },
                resets_base: true,
            },
        ],
    };
    check_retry_policy(&policy);

    let failure = |kind, status, advice_ms: Option<u64>| {
        let mut err = ProviderError::new(kind, DeliveryState::Accepted);
        err.status = Some(status);
        err.retry_after = advice_ms.map(ms);
        err
    };
    let capacity = |advice| failure(ErrorKind::Overloaded, 429, advice);
    let capacity_503 = failure(ErrorKind::Overloaded, 503, None);
    let plain_503 = failure(ErrorKind::Transient, 503, None);
    let rpm = |advice| failure(ErrorKind::RateLimited, 429, advice);
    // One send: the caller only stores the state each decision returns.
    struct Sending<'a> {
        decider: &'a dyn RetryDecider,
        policy: &'a RetryPolicy,
        state: RetryState,
    }
    impl Sending<'_> {
        fn fail(&mut self, err: &ProviderError, samples: JitterSamples) -> Option<Duration> {
            let decision = self.decider.verdict(err, &self.state, self.policy, samples);
            self.state = decision.next;
            match decision.verdict {
                Verdict::Retry { delay, .. } => Some(delay),
                _ => None,
            }
        }
    }
    let send = || Sending {
        decider,
        policy: &policy,
        state: RetryState::new(RetryClass::Request, "m"),
    };
    let count = |send: &Sending<'_>, kind: Option<ErrorKind>| send.state.count(kind);

    // The JS sequence: a capacity 429 bypasses the inner ladder; a capacity
    // 503 runs the inner ladder, then reaches the capacity path, and the next
    // failure starts a fresh inner ladder.
    let mut s = send();
    assert_eq!(
        s.fail(&capacity(None), mid),
        Some(ms(1_000)),
        "429: capacity retry 1"
    );
    assert_eq!(
        s.fail(&capacity_503, mid),
        Some(ms(1_000)),
        "503: inner retry 1"
    );
    assert_eq!(
        s.fail(&capacity_503, mid),
        Some(ms(2_000)),
        "503: inner retry 2"
    );
    assert_eq!(
        s.fail(&capacity_503, mid),
        Some(ms(4_000)),
        "503: inner retry 3"
    );
    assert_eq!(
        count(&s, None),
        ScheduleCount {
            retries: 3,
            waited: ms(7_000)
        }
    );
    assert_eq!(
        s.fail(&capacity_503, mid),
        Some(ms(2_000)),
        "spent inner ladder: capacity retry 2"
    );
    assert_eq!(
        count(&s, Some(ErrorKind::Overloaded)),
        ScheduleCount {
            retries: 2,
            waited: ms(3_000)
        }
    );
    assert_eq!(
        count(&s, None),
        ScheduleCount::default(),
        "a capacity retry starts a fresh inner ladder"
    );
    assert_eq!(
        s.fail(&capacity_503, mid),
        Some(ms(1_000)),
        "fresh inner retry 1"
    );
    assert_eq!(s.fail(&rpm(None), mid), Some(ms(1_000)), "RPM quick retry");
    assert_eq!(
        count(&s, None),
        ScheduleCount::default(),
        "an RPM retry starts a fresh inner ladder"
    );
    assert_eq!(s.fail(&plain_503, mid), Some(ms(1_000)));
    assert_eq!(s.fail(&plain_503, mid), Some(ms(2_000)));
    assert_eq!(s.fail(&plain_503, mid), Some(ms(4_000)));
    let before = s.state.clone();
    assert_eq!(
        s.fail(&plain_503, mid),
        None,
        "a non-capacity 503 ends with the inner ladder"
    );
    assert_eq!(
        s.state.count(None),
        before.count(None),
        "an unretried failure uses no retry"
    );
    assert_eq!(s.fail(&rpm(None), mid), None, "one RPM retry per send");

    // Capacity ladder: 1 s, 2 s, 4 s at ±10 % (rand 0 → 0.9, 0.5 → 1.0, 1 → 1.1).
    let mut s = send();
    assert_eq!(s.fail(&capacity(None), mid), Some(ms(1_000)));
    assert_eq!(s.fail(&capacity(None), at(1.0, 0.5)), Some(ms(2_200)));
    assert_eq!(s.fail(&capacity(None), at(0.0, 0.5)), Some(ms(3_600)));
    assert_eq!(s.fail(&capacity(None), mid), None, "three capacity retries");
    assert_eq!(
        s.fail(&rpm(None), mid),
        Some(ms(1_000)),
        "spent capacity leaves the RPM retry"
    );
    let mut s = send();
    assert_eq!(
        s.fail(&rpm(None), at(1.0, 1.0)),
        Some(ms(1_000)),
        "RPM wait is unjittered"
    );
    assert_eq!(
        s.fail(&capacity(None), mid),
        Some(ms(1_000)),
        "a spent RPM retry leaves capacity"
    );
    // Capacity advice is a floor and is never jittered.
    assert_eq!(
        send().fail(&capacity(Some(10)), at(0.5, 1.0)),
        Some(ms(1_000))
    );
    assert_eq!(
        send().fail(&capacity(Some(40_000)), at(1.0, 1.0)),
        Some(ms(40_000))
    );
    let mut s = send();
    s.fail(&capacity(None), mid);
    s.fail(&capacity(None), mid);
    assert_eq!(
        s.fail(&capacity(Some(20_000)), at(1.0, 1.0)),
        Some(ms(20_000))
    );
    // Cumulative cap: waited + advice may reach 60 s but not exceed it.
    let mut s = send();
    assert_eq!(s.fail(&capacity(Some(20_000)), mid), Some(ms(20_000)));
    assert_eq!(
        s.fail(&capacity(Some(40_000)), mid),
        Some(ms(40_000)),
        "exactly 60 s"
    );
    let mut s = send();
    assert_eq!(s.fail(&capacity(Some(40_000)), mid), Some(ms(40_000)));
    assert_eq!(
        s.fail(&capacity(Some(40_000)), mid),
        None,
        "80 s exceeds the 60 s cap"
    );
    let mut s = send();
    assert_eq!(s.fail(&capacity(None), at(1.0, 0.5)), Some(ms(1_100)));
    assert_eq!(
        s.fail(&capacity(Some(58_901)), mid),
        None,
        "1 100 + 58 901 exceeds the 60 s cap"
    );

    // RPM quick retry: 1 s or the advice up to 60 s, unjittered.
    assert_eq!(
        send().fail(&rpm(Some(45_000)), at(0.0, 0.0)),
        Some(ms(45_000))
    );
    assert_eq!(send().fail(&rpm(Some(60_000)), mid), Some(ms(60_000)));
    assert_eq!(
        send().fail(&rpm(Some(60_001)), mid),
        None,
        "RPM advice over 60 s"
    );
}

// ---------------------------------------------------------------------------
// Tools and approval
// ---------------------------------------------------------------------------

/// `ctx` carries an already-cancelled token: the tool either completes (it
/// committed first) or returns `Cancelled`.
pub async fn check_tool_cancelled(
    tool: &dyn Tool,
    ctx: &ToolContext,
    args: mixdog_protocol::JsonValue,
) {
    let spec = tool.spec();
    assert!(!spec.name.is_empty());
    assert!(
        spec.input_schema.is_object(),
        "input schema is a JSON object"
    );
    assert!(
        ctx.cancel.is_cancelled(),
        "fixture passes a cancelled token"
    );
    if let Err(err) = tool.call(ctx, args).await {
        assert_eq!(
            err.code,
            ToolErrorCode::Cancelled,
            "a cancelled call fails only as Cancelled"
        );
    }
}

/// `args` make `server` report a failure (a JSON-RPC error or an `isError` result): the call
/// fails as `McpError` naming that server, never as `Internal`, and tells the model.
pub async fn check_mcp_error(
    tool: &dyn Tool,
    ctx: &ToolContext,
    args: mixdog_protocol::JsonValue,
    server: &str,
) {
    let err = tool
        .call(ctx, args)
        .await
        .expect_err("the server reports a failure");
    match err.code {
        ToolErrorCode::McpError { server: named, .. } => assert_eq!(named, server),
        other => panic!("a server-reported failure is McpError, got {other:?}"),
    }
    assert!(!err.message_for_model.is_empty());
}

/// `args` make the tool's operation run and fail: the call fails as `Failed`, and the model
/// text shows its `reason` verbatim.
pub async fn check_operation_failed(tool: &dyn Tool, ctx: &ToolContext, args: mixdog_protocol::JsonValue) {
    let err = tool.call(ctx, args).await.expect_err("the operation fails");
    match err.code {
        ToolErrorCode::Failed { reason } => {
            assert!(!reason.is_empty(), "a failure carries its text");
            assert!(
                err.message_for_model.contains(&reason),
                "the model sees the failure text verbatim"
            );
        }
        other => panic!("an operation that ran and failed is Failed, got {other:?}"),
    }
}

pub async fn check_approval_gate(gate: &dyn ApprovalGate, ask: ApprovalAsk) {
    let _resolution = gate.request(ask).await;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct FsLanes {
    pub interactive: InteractiveIo,
    pub durability: DurabilityIo,
    pub maintenance: MaintenanceIo,
}

/// `root` is an existing, empty directory.
pub async fn check_file_service(fs: &dyn FileService, lanes: FsLanes, root: AbsPath) {
    let a = root.join("a.txt");
    let b = root.join("b.txt");
    let write = |path: &AbsPath, content: &[u8], precondition| WriteRequest {
        path: path.clone(),
        content: content.to_vec(),
        precondition,
    };

    fs.write(
        lanes.durability,
        write(&a, b"one\ntwo\n", WritePrecondition::Absent),
    )
    .await
    .expect("create");
    let err = fs
        .write(lanes.durability, write(&a, b"x", WritePrecondition::Absent))
        .await
        .expect_err("Absent on an existing file");
    assert_eq!(
        err.kind,
        FsErrorKind::PreconditionFailed {
            actual: Some(b"one\ntwo\n".to_vec())
        }
    );
    let err = fs
        .write(
            lanes.durability,
            write(
                &a,
                b"x",
                WritePrecondition::ContentEquals(b"stale".to_vec()),
            ),
        )
        .await
        .expect_err("compare-and-set mismatch");
    assert!(matches!(err.kind, FsErrorKind::PreconditionFailed { .. }));
    fs.write(
        lanes.durability,
        write(
            &a,
            b"one\nneedle\n",
            WritePrecondition::ContentEquals(b"one\ntwo\n".to_vec()),
        ),
    )
    .await
    .expect("compare-and-set match");

    let read = fs
        .read(
            lanes.interactive,
            a.clone(),
            ReadRange {
                offset: 4,
                max_len: Some(3),
            },
        )
        .await
        .expect("read");
    assert_eq!(
        (read.offset, read.bytes.as_slice(), read.total_len),
        (4, &b"nee"[..], 11)
    );
    assert_eq!(
        fs.stat(lanes.interactive, a.clone())
            .await
            .expect("stat")
            .len,
        11
    );

    let err = fs
        .write_batch(
            lanes.durability,
            vec![
                write(&b, b"b", WritePrecondition::Absent),
                write(&a, b"lost", WritePrecondition::Absent),
            ],
        )
        .await
        .expect_err("one failed precondition fails the batch");
    assert!(matches!(err.kind, FsErrorKind::PreconditionFailed { .. }));
    let err = fs
        .stat(lanes.interactive, b.clone())
        .await
        .expect_err("batch wrote nothing");
    assert_eq!(err.kind, FsErrorKind::NotFound);

    let listed = fs
        .list_dir(lanes.interactive, root.clone())
        .await
        .expect("list");
    assert!(listed.iter().any(|e| e.path == a));

    fs.rename(lanes.durability, a.clone(), b.clone(), false)
        .await
        .expect("rename");
    let walked = drain(
        fs.walk(
            lanes.maintenance,
            WalkRequest {
                root: root.clone(),
                recursive: true,
                include_hidden: false,
                respect_ignore: false,
                include_dirs: false,
            },
        )
        .as_mut(),
    )
    .await;
    let walked: Vec<_> = walked
        .into_iter()
        .map(|e| e.expect("walk entry").path)
        .collect();
    assert_eq!(walked, vec![b.clone()]);

    let found = drain(
        fs.search_text(
            lanes.maintenance,
            SearchRequest {
                root: root.clone(),
                pattern: "needle".into(),
                regex: false,
                case_sensitive: true,
                include_globs: Vec::new(),
                exclude_globs: Vec::new(),
                include_hidden: false,
                respect_ignore: false,
            },
        )
        .as_mut(),
    )
    .await;
    let found: Vec<_> = found.into_iter().map(|m| m.expect("match")).collect();
    assert_eq!(found.len(), 1);
    assert_eq!((found[0].line, found[0].column), (2, 1));

    let invalid = drain(
        fs.search_text(
            lanes.maintenance,
            SearchRequest {
                root: root.clone(),
                pattern: "(needle".into(),
                regex: true,
                case_sensitive: true,
                include_globs: Vec::new(),
                exclude_globs: Vec::new(),
                include_hidden: false,
                respect_ignore: false,
            },
        )
        .as_mut(),
    )
    .await;
    match invalid.as_slice() {
        [Err(FsError { kind: FsErrorKind::InvalidPattern { message }, .. })] => assert!(
            message.starts_with("regex parse error"),
            "the parser's text passes through: {message}"
        ),
        other => panic!("an unparsable regex is one InvalidPattern error, got {other:?}"),
    }

    fs.remove(lanes.durability, b.clone(), false)
        .await
        .expect("remove");
    let err = fs
        .read(lanes.interactive, b, ReadRange::default())
        .await
        .expect_err("removed");
    assert_eq!(err.kind, FsErrorKind::NotFound);
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

pub struct ProcessFixture {
    pub cwd: AbsPath,
    /// Prints `hello` and exits 0.
    pub hello: CommandSpec,
    /// Runs until killed.
    pub long_running: CommandSpec,
    /// A program that does not exist.
    pub missing: CommandSpec,
}

fn spawn_request(handle: &str, command: CommandSpec, cwd: &AbsPath) -> SpawnRequest {
    SpawnRequest {
        handle: ProcessHandle::from(handle),
        command,
        cwd: cwd.clone(),
        env: EnvSpec {
            inherit: true,
            ..EnvSpec::default()
        },
        pty: None,
        stdin_piped: false,
        output: OutputMode::Merged,
        owner: ProcessOwner::Internal,
        time_limit: None,
    }
}

async fn events_until_exit(pm: &dyn ProcessManager, handle: &ProcessHandle) -> Vec<ProcessEvent> {
    let mut source = pm.subscribe(handle, Some(0)).expect("subscribe");
    let mut events = Vec::new();
    while let Some(event) = source.next().await {
        let exited = matches!(event, ProcessEvent::Exited { .. });
        events.push(event);
        if exited {
            break;
        }
    }
    events
}

pub async fn check_process_manager(pm: &dyn ProcessManager, fx: ProcessFixture) {
    let hello = spawn_request("conf-hello", fx.hello, &fx.cwd);
    let handle = hello.handle.clone();
    pm.spawn(hello).await.expect("spawn");
    let events = events_until_exit(pm, &handle).await;
    for (i, event) in events.iter().enumerate() {
        assert_eq!(event.seq(), i as u64, "seq is dense from 0");
    }
    let output: Vec<u8> = events
        .iter()
        .filter_map(|e| match e {
            ProcessEvent::Output { bytes, .. } => Some(bytes.clone()),
            ProcessEvent::Exited { .. } => None,
        })
        .flatten()
        .collect();
    assert!(String::from_utf8_lossy(&output).contains("hello"));
    match events.last() {
        Some(ProcessEvent::Exited { exit, .. }) => {
            assert_eq!(exit.status, ExitStatus::Code(0));
            assert_eq!(exit.killed, None);
        }
        other => panic!("last event is Exited, got {other:?}"),
    }

    let long = spawn_request("conf-long", fx.long_running.clone(), &fx.cwd);
    let handle = long.handle.clone();
    pm.spawn(long).await.expect("spawn long");
    let again = pm
        .spawn(spawn_request("conf-long", fx.long_running, &fx.cwd))
        .await;
    assert_eq!(
        again.expect_err("duplicate live handle"),
        ProcessError::HandleInUse
    );
    assert_eq!(
        pm.resize_pty(&handle, PtySize { cols: 80, rows: 24 }),
        Err(ProcessError::NotPty)
    );
    assert!(
        pm.list()
            .iter()
            .any(|p| p.handle == handle && p.exit.is_none())
    );
    pm.kill(&handle).expect("kill");
    match events_until_exit(pm, &handle).await.last() {
        Some(ProcessEvent::Exited { exit, .. }) => {
            assert_eq!(exit.killed, Some(KillReason::Requested))
        }
        other => panic!("killed process exits, got {other:?}"),
    }

    let unknown = ProcessHandle::from("conf-unknown");
    assert_eq!(pm.kill(&unknown), Err(ProcessError::UnknownHandle));
    let missing = pm
        .spawn(spawn_request("conf-missing", fx.missing, &fx.cwd))
        .await;
    assert!(
        matches!(missing, Err(ProcessError::ProgramNotFound { .. })),
        "missing program is typed"
    );
}

/// A full admission queue answers `Overloaded` naming that queue, and admits nothing.
/// `saturate` fills the named queue of `pm` for the rest of the check (the implementation's
/// test hook); `fx.long_running` must keep running with stdin piped.
pub async fn check_process_overloaded(
    pm: &dyn ProcessManager,
    fx: ProcessFixture,
    saturate: &dyn Fn(ProcessQueue),
) {
    let mut long = spawn_request("conf-overload", fx.long_running.clone(), &fx.cwd);
    long.stdin_piped = true;
    let handle = long.handle.clone();
    pm.spawn(long).await.expect("spawn before saturation");

    saturate(ProcessQueue::Input);
    assert_eq!(
        pm.write_stdin(&handle, b"x".to_vec()).await,
        Err(ProcessError::Overloaded {
            queue: ProcessQueue::Input
        })
    );

    saturate(ProcessQueue::Spawn);
    let refused = pm
        .spawn(spawn_request("conf-refused", fx.long_running, &fx.cwd))
        .await;
    assert_eq!(
        refused.expect_err("a full spawn queue admits nothing"),
        ProcessError::Overloaded {
            queue: ProcessQueue::Spawn
        }
    );
    let refused = ProcessHandle::from("conf-refused");
    assert!(pm.list().iter().all(|p| p.handle != refused));

    pm.kill(&handle).expect("kill");
    let written = events_until_exit(pm, &handle).await;
    assert!(
        written
            .iter()
            .all(|e| !matches!(e, ProcessEvent::Output { bytes, .. } if bytes == b"x")),
        "refused input is not written"
    );
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/// `change` modifies the work tree of `repo` (e.g. writes a file).
pub async fn check_repo_inspector(
    inspector: &dyn RepoInspector,
    lane: MaintenanceIo,
    repo: RepoRef,
    base: super::repo::ObjectId,
    change: impl FnOnce(),
) {
    let key = inspector.key(lane, repo.clone()).await.expect("key");
    assert_eq!(
        inspector.key(lane, repo.clone()).await.expect("key"),
        key,
        "key is stable without change"
    );
    assert_eq!(
        inspector
            .status(lane, repo.clone())
            .await
            .expect("status")
            .key,
        key
    );

    let request = ReviewRequest {
        repo: repo.clone(),
        scope: super::repo::ReviewScope::Session {
            thread_id: mixdog_protocol::ThreadId::from("conf-thread"),
        },
        base,
    };
    let summary = inspector
        .review_summary(lane, request)
        .await
        .expect("review");
    assert!(matches!(
        inspector.review_page(&summary.key, None, None),
        Ok(Cached::Ready(_))
    ));

    change();
    inspector.evidence(&repo, RepoEvidence::WorkTree);
    let changed = inspector.key(lane, repo).await.expect("key");
    assert_ne!(changed, key, "a work-tree change moves the key");
    assert!(
        matches!(
            inspector.review_page(&changed, None, None),
            Ok(Cached::Pending { .. })
        ),
        "no page for a key not yet computed"
    );
}

// ---------------------------------------------------------------------------
// Extension pool
// ---------------------------------------------------------------------------

/// `pending_cap` is the pool's global pending cap.
pub async fn check_ext_pool(pool: &dyn ExtPool, call: ExtCall, pending_cap: usize) {
    let mut stream = pool.call(call.clone()).expect("call");
    let frames = drain(stream.as_mut()).await;
    let dones = frames
        .iter()
        .filter(|f| matches!(f, ExtFrame::Done(_)))
        .count();
    assert_eq!(dones, 1, "exactly one Done");
    assert!(
        matches!(frames.last(), Some(ExtFrame::Done(_))),
        "Done is last"
    );
    drop(stream);

    let held: Vec<_> = (0..pending_cap)
        .map(|_| pool.call(call.clone()).expect("within cap"))
        .collect();
    assert!(
        matches!(pool.call(call.clone()), Err(ExtError::Overloaded)),
        "beyond the cap"
    );
    drop(held);
    assert!(pool.call(call).is_ok(), "dropping calls frees capacity");
}

// ---------------------------------------------------------------------------
// Computer and media
// ---------------------------------------------------------------------------

pub async fn check_computer_backend(backend: &dyn ComputerBackend) {
    for action in ComputerAction::ALL {
        assert_eq!(ComputerAction::from_wire(action.wire_name()), Some(action));
    }
    backend
        .inject(ScreenInput::Button {
            button: PointerButton::Left,
            down: true,
            at: Some((1, 1)),
        })
        .expect("inject");
    assert!(
        backend.release_input().expect("release") >= 1,
        "held input is released"
    );
    assert_eq!(
        backend.release_input().expect("release"),
        0,
        "nothing held after release"
    );

    let cancel = CancellationToken::new();
    cancel.cancel();
    let request = ComputerRequest {
        action: ComputerAction::List,
        input: serde_json::json!({}),
    };
    if let Err(err) = backend.run(request, cancel).await {
        assert_eq!(err, ComputerError::Cancelled);
    }

    let displays = backend.displays().expect("displays");
    let first = displays.first().expect("a display");
    let mut source = backend.screen_source(first.id).expect("screen source");
    check_frame_source(source.as_mut(), 2).await;
}

/// Reads up to `frames` frames.
pub async fn check_frame_source(source: &mut dyn MediaFrameSource, frames: usize) {
    let mut last: Option<(u64, Duration)> = None;
    for _ in 0..frames {
        let Some(frame) = source.next_frame().await.expect("frame") else {
            break;
        };
        if let Some(len) = frame.required_len() {
            assert!(
                frame.data.len() >= len,
                "raw frame holds stride × height bytes"
            );
        }
        if let Some((seq, at)) = last {
            assert!(frame.seq > seq, "seq increases");
            assert!(frame.captured_at >= at, "capture time is monotonic");
        }
        last = Some((frame.seq, frame.captured_at));
    }
}

/// `next_frame` is cancel-safe: a future polled once and dropped (the media
/// loop on a control change) consumes nothing. The source then still yields
/// a frame whose `seq` follows `last_seq`; with `lossless` (a source that
/// skips no frames, like a fixture) it is exactly `last_seq + 1`.
pub async fn check_frame_source_cancel_safe(
    source: &mut dyn MediaFrameSource,
    last_seq: u64,
    lossless: bool,
) {
    {
        let mut pending = source.next_frame();
        let waker = std::task::Waker::noop();
        let mut cx = std::task::Context::from_waker(waker);
        if let std::task::Poll::Ready(result) =
            std::future::Future::poll(pending.as_mut(), &mut cx)
        {
            // A frame that was ready is delivered, not consumed silently.
            let frame = result.expect("frame").expect("source not ended");
            assert!(frame.seq > last_seq, "seq increases");
            return;
        }
    }
    let frame = source
        .next_frame()
        .await
        .expect("frame after a dropped call")
        .expect("source not ended");
    if lossless {
        assert_eq!(frame.seq, last_seq + 1, "the dropped call consumed no frame");
    } else {
        assert!(frame.seq > last_seq, "seq increases");
    }
}

pub fn check_video_track(track: &dyn VideoTrack) {
    assert_eq!(track.codec(), VideoCodec::Vp8, "VP8 only");
    let mut params = track.encoding();
    assert!(params.maintain_resolution);
    params.max_bitrate_bps = Some(2_000_000);
    params.max_framerate = Some(15);
    track.set_encoding(params).expect("set encoding");
    assert_eq!(track.encoding(), params);
    track.request_keyframe();
    track.stop();
}

// ---------------------------------------------------------------------------
// Login and ownership
// ---------------------------------------------------------------------------

/// Drives the flow to its end: exactly one terminal state, last, and the
/// snapshot equals it.
pub async fn check_login_flow(flow: &dyn LoginFlow) {
    let session = flow.start().await.expect("start");
    let mut states = Vec::new();
    while let Some(state) = session.next().await {
        states.push(state);
    }
    let terminals = states.iter().filter(|s| s.is_terminal()).count();
    assert_eq!(terminals, 1, "exactly one terminal state");
    let last = states.last().expect("states").clone();
    assert!(last.is_terminal(), "terminal state is last");
    assert_eq!(session.state(), last, "snapshot equals the last state");
    if let LoginState::Failed(LoginFailure::VerificationRequired { url, .. }) = &last {
        assert!(url.starts_with("https://"), "a verification URL is a page");
    }
}

pub async fn check_login_cancel(flow: &dyn LoginFlow) {
    let session = flow.start().await.expect("start");
    session.cancel();
    let mut last = None;
    while let Some(state) = session.next().await {
        last = Some(state);
    }
    assert_eq!(
        last,
        Some(LoginState::Cancelled),
        "cancel ends the flow as Cancelled"
    );
}

/// `lose` breaks ownership (replaces the lock file, removes the barrier, …).
pub fn check_ownership(ownership: &dyn Ownership, lose: impl FnOnce()) {
    assert!(!ownership.instance_id().is_empty());
    ownership.revalidate().expect("owner");
    ownership
        .revalidate()
        .expect("revalidation has no side effect");
    lose();
    let reason = ownership
        .revalidate()
        .expect_err("loss is detected at the next revalidation");
    assert_eq!(ownership.revalidate(), Err(reason), "fencing is sticky");
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use mixdog_protocol::ApprovalRemember;
    use mixdog_protocol::ApprovalResolution;
    use mixdog_protocol::ThreadId;
    use mixdog_protocol::ToolApprovalDecision;
    use mixdog_protocol::TurnId;

    use super::*;
    use crate::domain::approval::ActionKind;
    use crate::domain::approval::ApprovalId;
    use crate::domain::approval::ApprovalKind;
    use crate::domain::approval::ApprovalRequest;
    use crate::domain::approval::DecisionRejected;
    use crate::domain::keepalive::TransportKind;
    use crate::domain::login::LoginTarget;
    use crate::domain::media::EncodingParams;
    use crate::domain::media::FrameSourceKind;
    use crate::domain::media::negotiate_codec;
    use crate::domain::mock::*;
    use crate::domain::ownership::FenceReason;
    use crate::domain::provider::Content;
    use crate::domain::provider::ErrorResponse;
    use crate::domain::provider::HostedTool;
    use crate::domain::provider::HostedWebSearch;
    use crate::domain::provider::Message;
    use crate::domain::provider::UserLocation;
    use crate::domain::provider::ProviderReplay;
    use crate::domain::provider::RequestOptions;
    use crate::domain::provider::Temperature;
    use crate::domain::provider::UsdTicks;
    use crate::domain::repo::ObjectId;
    use crate::domain::tool::SurfaceKind;
    use crate::domain::tool::ToolIo;
    use mixdog_protocol::ProviderId;
    use mixdog_protocol::ToolCallId;

    fn root() -> AbsPath {
        AbsPath::new(std::env::temp_dir().join("mixdog-domain-conformance"))
            .expect("absolute temp dir")
    }

    fn request() -> Arc<ModelRequest> {
        Arc::new(ModelRequest {
            model: "mock-model".into(),
            messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
            tools: Vec::new(),
            options: RequestOptions::default(),
        })
    }

    #[test]
    fn codec() {
        check_wire_codec(&MockCodec, &request(), b"t:hel\nka\nt:lo\ndone\n", b"t:hel\nka\n", 3);
    }

    #[tokio::test]
    async fn provider_attempts() {
        let script = [
            (
                MockAttempt::Body(b"t:a\ndone\n".to_vec()),
                DeliveryState::Accepted,
            ),
            (
                MockAttempt::Body(b"t:a\n".to_vec()),
                DeliveryState::Accepted,
            ),
            (
                MockAttempt::Fault {
                    fault: TransportFault::Connect { os_code: None },
                    reached: DeliveryState::NotSent,
                },
                DeliveryState::NotSent,
            ),
            (
                MockAttempt::Fault {
                    fault: TransportFault::Reset,
                    reached: DeliveryState::Ambiguous,
                },
                DeliveryState::Ambiguous,
            ),
            (
                MockAttempt::Rejected(ErrorResponse {
                    status: Some(400),
                    headers: Vec::new(),
                    body: Vec::new(),
                }),
                DeliveryState::Accepted,
            ),
            (
                MockAttempt::Body(b"u:3,5,1200\nt:a\n".to_vec()),
                DeliveryState::Accepted,
            ),
            (
                MockAttempt::Body(b"t:part\ncont\n".to_vec()),
                DeliveryState::Accepted,
            ),
            (
                MockAttempt::Rejected(ErrorResponse {
                    status: Some(403),
                    headers: Vec::new(),
                    body: b"https://accounts.google.com/signin/continue".to_vec(),
                }),
                DeliveryState::Accepted,
            ),
        ];
        let provider = MockProvider::new(script.iter().map(|(attempt, _)| attempt.clone()));
        for (_, reached) in script {
            check_provider_attempt(&provider, request(), reached).await;
        }
        check_model_listing(&provider).await;
    }

    #[test]
    fn request_shape() {
        let mut reminder = Message::new(Role::User, Content::Text("REMINDER-1".into()));
        reminder.source = Some(MessageSource::TailReminder);
        let mut request = (*request()).clone();
        request.messages.push(reminder);
        check_tail_reminder(&MockCodec, &request, "REMINDER-1");

        request.options.thread = Some(RequestThread {
            id: ThreadId::from("t"),
            window: 1,
            turn: Some(TurnId::from("r")),
        });
        check_request_thread(&MockCodec, &request);

        request.options.parent_session_id = Some("parent".into());
        request.options.parallel_tool_calls = Some(false);
        request.options.temperature = Temperature::new(0.7);
        check_request_options(&MockCodec, &request);

        request.options.hosted_tools = vec![HostedTool::WebSearch(HostedWebSearch {
            tool_type: "web_search".into(),
            allowed_domains: vec!["example.com".into()],
            user_location: Some(UserLocation {
                country: Some("KR".into()),
                ..UserLocation::default()
            }),
            max_uses: None,
            context_size: Some("low".into()),
            include_sources: true,
        })];
        check_hosted_tools(&MockCodec, &request);

        let rejected = |status| ErrorResponse {
            status: Some(status),
            headers: Vec::new(),
            body: Vec::new(),
        };
        check_error_classification(
            &MockCodec,
            &[
                (rejected(409), ErrorKind::ReplayRejected),
                (rejected(415), ErrorKind::ImageRejected),
                (rejected(422), ErrorKind::ToolSchemaRejected),
            ],
        );
        assert_eq!(UsdTicks::from_usd(0.00012), Some(UsdTicks(1_200_000)));
    }

    #[test]
    fn retry_policy_reask_bound() {
        let mut policy = RetryPolicy::codex_default();
        policy.empty_response_reasks = Some(2);
        check_retry_policy(&policy);
    }

    #[test]
    fn keepalive() {
        check_keepalive_schedule(&KeepaliveSchedule::SPEC);
        assert_eq!(
            KeepaliveSchedule::SPEC.tcp_detection_bound(),
            Duration::from_secs(360)
        );
        for kind in [
            TransportKind::Http1,
            TransportKind::Http2,
            TransportKind::WebSocket,
        ] {
            let conn = MockKeepalive::new(kind);
            check_transport_keepalive(&conn, &KeepaliveSchedule::SPEC, || conn.go_half_open());
        }
        let ws = MockKeepalive::new(TransportKind::WebSocket);
        ws.arm(&KeepaliveSchedule::SPEC.with_ws_max_age(Duration::from_secs(3600)))
            .expect("arm");
        ws.set_age(Duration::from_secs(3600));
        assert!(
            !ws.may_start_response(),
            "no new response at the connection age limit"
        );
    }

    #[test]
    fn retry() {
        check_retry_policy(&RetryPolicy::codex_default());
        check_retry_decider(&MockRetryDecider);
    }

    #[test]
    fn replay_is_owner_scoped() {
        let mut message = Message::new(Role::Assistant, Content::Text(String::new()));
        let anthropic = ProviderId::from("anthropic");
        let openai = ProviderId::from("openai");
        message.push_replay(ProviderReplay {
            owner: anthropic.clone(),
            items: serde_json::json!([1]),
        });
        assert_eq!(message.replay_for(&anthropic).count(), 1);
        assert_eq!(message.replay_for(&openai).count(), 0);
    }

    fn tool_context(cancel: CancellationToken) -> ToolContext {
        let tokens = mixdog_rt::testing::tokens();
        ToolContext {
            call_id: ToolCallId::from("call-1"),
            thread_id: ThreadId::from("t"),
            turn_id: TurnId::from("r"),
            tool: "echo".into(),
            cwd: root(),
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
            review: None,
        }
    }

    #[tokio::test]
    async fn tool() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        check_tool_cancelled(
            &EchoTool::default(),
            &tool_context(cancel),
            serde_json::json!({"a": 1}),
        )
        .await;
    }

    #[tokio::test]
    async fn mcp_error() {
        check_mcp_error(
            &FailingMcpTool::default(),
            &tool_context(CancellationToken::new()),
            serde_json::json!({"why": "boom"}),
            "mock",
        )
        .await;
    }

    #[tokio::test]
    async fn operation_failed() {
        check_operation_failed(
            &FailingTool::default(),
            &tool_context(CancellationToken::new()),
            serde_json::json!({"why": "fatal: not a git repository"}),
        )
        .await;
    }

    fn ask(action_kind: Option<ActionKind>) -> ApprovalAsk {
        ApprovalAsk {
            kind: ApprovalKind::Tool,
            call_id: Some(ToolCallId::from("call-1")),
            tool: Some("github".into()),
            action_kind,
            reason: None,
            payload: serde_json::json!({}),
            remember: vec![ApprovalRemember::Session],
            expires_after: None,
        }
    }

    #[tokio::test]
    async fn approval() {
        let gate = MockApprovalGate::default();
        lock_push(&gate, ApprovalResolution::TimedOut { at: 1 });
        check_approval_gate(&gate, ask(None)).await;

        let request = |action_kind| ApprovalRequest {
            id: ApprovalId(7),
            thread_id: ThreadId::from("t"),
            surface_thread_id: ThreadId::from("t"),
            chain: Vec::new(),
            order: 0,
            requested_at: SystemTime::UNIX_EPOCH,
            expires_at: None,
            ask: ask(action_kind),
        };
        assert_eq!(ApprovalId(7).request_id().as_str(), "7");
        let decide = |remember| ToolApprovalDecision {
            approved: true,
            reason: None,
            answers: None,
            reply: None,
            response: None,
            edited_args: None,
            remember,
            scope: None,
        };
        let comment = request(Some(ActionKind::Comment));
        assert_eq!(
            comment.check_decision(&decide(Some(ApprovalRemember::Session))),
            Ok(())
        );
        assert_eq!(
            comment.check_decision(&decide(Some(ApprovalRemember::Once))),
            Ok(())
        );
        assert_eq!(
            comment.check_decision(&decide(Some(ApprovalRemember::Always))),
            Err(DecisionRejected::RememberNotAllowed)
        );
        assert_eq!(
            request(Some(ActionKind::Payment))
                .check_decision(&decide(Some(ApprovalRemember::Session))),
            Err(DecisionRejected::UnrememberableAction)
        );
        assert_eq!(
            ApprovalKind::Computer.method().as_str(),
            "item/computer/requestApproval"
        );
    }

    fn lock_push(gate: &MockApprovalGate, resolution: ApprovalResolution) {
        gate.script.lock().expect("script").push_back(resolution);
    }

    #[tokio::test]
    async fn file_service() {
        let tokens = mixdog_rt::testing::tokens();
        let fs = MockFileService::default();
        fs.create_dir(tokens.durability_io, root(), true)
            .await
            .expect("root");
        let lanes = FsLanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
        };
        check_file_service(&fs, lanes, root()).await;
    }

    #[tokio::test]
    async fn process_manager() {
        let argv = |program: &str, args: &[&str]| CommandSpec::Argv {
            program: program.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
        };
        check_process_manager(
            &MockProcessManager::default(),
            ProcessFixture {
                cwd: root(),
                hello: argv("echo", &["hello"]),
                long_running: argv("sleep", &["forever"]),
                missing: argv("missing", &[]),
            },
        )
        .await;
    }

    #[tokio::test]
    async fn process_overloaded() {
        let argv = |program: &str| CommandSpec::Argv {
            program: program.into(),
            args: Vec::new(),
        };
        let pm = MockProcessManager::default();
        check_process_overloaded(
            &pm,
            ProcessFixture {
                cwd: root(),
                hello: argv("echo"),
                long_running: argv("sleep"),
                missing: argv("missing"),
            },
            &|queue| pm.saturate(queue),
        )
        .await;
    }

    #[tokio::test]
    async fn repo_inspector() {
        let tokens = mixdog_rt::testing::tokens();
        let repo = RepoRef {
            common_dir: root().join(".git"),
            work_tree: Some(root()),
        };
        check_repo_inspector(
            &MockRepoInspector::default(),
            tokens.maintenance_io,
            repo,
            ObjectId("0".repeat(40)),
            || {},
        )
        .await;
    }

    #[tokio::test]
    async fn ext_pool() {
        let call = ExtCall {
            thread: ThreadId::from("t"),
            method: "office.render".into(),
            params: serde_json::json!({"x": 1}),
            paths: Vec::new(),
        };
        check_ext_pool(&MockExtPool::new(2), call, 2).await;
    }

    #[tokio::test]
    async fn computer_and_media() {
        check_computer_backend(&MockComputerBackend::default()).await;
        let track = MockVideoTrack::default();
        track.set_source(Box::new(MockFrameSource::new(
            FrameSourceKind::SecureDesktop,
            1,
        )));
        assert_eq!(track.source_kind(), Some(FrameSourceKind::SecureDesktop));
        check_video_track(&track);
        assert_eq!(EncodingParams::SCREEN_DEFAULT.max_framerate, Some(30));
        assert_eq!(
            negotiate_codec(&["video/H264".into(), "video/vp8".into()]),
            Some(VideoCodec::Vp8)
        );
        assert_eq!(negotiate_codec(&["video/H264".into()]), None);

        let mut source = MockFrameSource::new(FrameSourceKind::SecureDesktop, 3);
        let first = source.next_frame().await.unwrap().unwrap();
        check_frame_source_cancel_safe(&mut source, first.seq, true).await;
    }

    #[tokio::test]
    async fn login() {
        let device = MockLoginFlow::new(
            LoginTarget::Github,
            vec![
                LoginState::DeviceCode {
                    user_code: "ABCD-1234".into(),
                    verification_uri: "https://github.com/login/device".into(),
                    expires_at: None,
                },
                LoginState::Waiting,
                LoginState::Done {
                    account: Some("octocat".into()),
                },
            ],
        );
        check_login_flow(&device).await;
        check_login_cancel(&device).await;
        let provider = MockLoginFlow::new(
            LoginTarget::Provider(ProviderId::from("anthropic-oauth")),
            vec![LoginState::Waiting],
        );
        check_login_cancel(&provider).await;
        let verify = MockLoginFlow::new(
            LoginTarget::Provider(ProviderId::from("antigravity")),
            vec![
                LoginState::Waiting,
                LoginState::Failed(LoginFailure::VerificationRequired {
                    url: "https://accounts.google.com/signin/continue".into(),
                    account: Some("user@example.com".into()),
                }),
            ],
        );
        check_login_flow(&verify).await;
    }

    #[test]
    fn ownership() {
        let ownership = MockOwnership::default();
        check_ownership(&ownership, || ownership.lose(FenceReason::LockLost));
    }
}
