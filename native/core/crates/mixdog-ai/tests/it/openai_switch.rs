//! When a WebSocket exchange moves to HTTP/SSE: the oauth (Codex) route's dispatch, the direct API-key route's send and the
//! transport policy switch, over the typed facts of a failure. The expected decision of each case is stated here from
//! the rules the product documents: an exposed or unsafe failure is never replayed; the Codex route switches for a
//! replay-safe transient failure once its budget is spent (at once for a 426 or a too-big close), never for a 429, and
//! every switch stays; the direct route does the same without sticking, except after a too-big close, and never for a
//! 4xx; a refused upgrade (Codex: 404; direct: 403, 404, 429) switches whatever the budget.

use mixdog_ai::providers::openai::config::Route;
use mixdog_ai::providers::openai::switch::Fallback;
use mixdog_ai::providers::openai::switch::TransportMode;
use mixdog_ai::providers::openai::switch::decide;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;

fn status(status: u16) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
    err.status = Some(status);
    err
}

fn fault(fault: TransportFault) -> ProviderError {
    ProviderError::transport(fault, DeliveryState::Accepted)
}

fn close(code: u16) -> ProviderError {
    fault(TransportFault::WsClose { code: Some(code) })
}

fn exposed(mut err: ProviderError) -> ProviderError {
    err.exposure.text_emitted = true;
    err
}

fn unsafe_to_retry(mut err: ProviderError) -> ProviderError {
    err.unsafe_to_retry = true;
    err
}

const STICKY: Option<Fallback> = Some(Fallback { sticky: true });
const ONCE: Option<Fallback> = Some(Fallback { sticky: false });

/// A socket that opens and yields nothing (an idle-window stall) or a `response.failed` naming a dropped link is a typed
/// transport failure: once the retry budget is spent the session moves to HTTP/SSE and stays there.
#[test]
fn a_stall_or_a_dropped_link_with_no_status_switches_to_http_and_stays() {
    use mixdog_core_api::domain::provider::StreamTimeoutPhase;
    let mut stall = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
    stall.code = Some("ESTREAMSTALL".into());
    stall.timed_out = true;
    stall.timeout_phase = Some(StreamTimeoutPhase::Idle);
    let fallback = decide(Route::Codex, &stall, false, true).expect("a stall switches once the budget is spent");
    assert!(fallback.sticky);
    assert!(decide(Route::Codex, &stall, false, false).is_none(), "not before the budget is spent");

    let mut dropped = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
    dropped.code = Some("network_error".into());
    assert!(decide(Route::Codex, &dropped, false, true).is_some());

    stall.exposure.text_emitted = true;
    assert!(decide(Route::Codex, &stall, false, true).is_none(), "output already shown is never replayed");
}

#[test]
fn each_route_decides_every_failure_by_its_own_rule() {
    struct Case {
        name: &'static str,
        error: ProviderError,
        handshake: bool,
        exhausted: bool,
        codex: Option<Fallback>,
        direct: Option<Fallback>,
    }
    let case = |name, error, handshake, exhausted, codex, direct| Case { name, error, handshake, exhausted, codex, direct };
    let cases = [
        case("503, budget spent", status(503), false, true, STICKY, ONCE),
        case("503, budget left", status(503), false, false, None, None),
        case("426, budget left", status(426), false, false, STICKY, None),
        case("429, budget spent", status(429), false, true, None, None),
        case("401, budget spent", status(401), false, true, None, None),
        case("525, budget spent", status(525), false, true, None, None),
        case("503 after text was shown", exposed(status(503)), false, true, None, None),
        case("503 that is unsafe to retry", unsafe_to_retry(status(503)), false, true, None, None),
        case("refused upgrade, 404", status(404), true, false, STICKY, ONCE),
        case("refused upgrade, 429", status(429), true, false, None, ONCE),
        case("refused upgrade, 403", status(403), true, false, None, ONCE),
        case("refused upgrade, 500", status(500), true, false, None, None),
        case("too-big close, budget left", close(1009), false, false, STICKY, STICKY),
        case("link-loss close, budget spent", close(1006), false, true, STICKY, ONCE),
        case("link-loss close, budget left", close(1006), false, false, None, None),
        case("unlisted close code, budget spent", close(4999), false, true, None, None),
        case("reset, budget spent", fault(TransportFault::Reset), false, true, STICKY, ONCE),
        case("dns failure, budget spent", fault(TransportFault::Dns), false, true, STICKY, ONCE),
        case("a failure with no typed fact, budget spent", ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted), false, true, None, None),
    ];
    for case in cases {
        let codex = decide(Route::Codex, &case.error, case.handshake, case.exhausted);
        assert_eq!(codex, case.codex, "oauth route: {}", case.name);
        let direct = decide(Route::ApiKey, &case.error, case.handshake, case.exhausted);
        assert_eq!(direct, case.direct, "direct route: {}", case.name);
    }
}

#[test]
fn the_transport_modes_pin_the_socket_and_only_auto_may_fall_back() {
    let modes = [(TransportMode::Auto, true, true), (TransportMode::WsDelta, true, false), (TransportMode::WsFull, false, false)];
    for (mode, delta, fallback) in modes {
        assert_eq!((mode.delta(), mode.http_fallback()), (delta, fallback), "{mode:?}");
    }
}
