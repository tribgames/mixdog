use super::test_support::request;
use super::*;

#[test]
fn every_file_enumeration_uses_the_bulk_lane() {
    assert_eq!(
        search_class(&request(&["--files", "."], 0)),
        SearchClass::Bulk
    );
    assert_eq!(
        search_class(&request(&["--files", "."], 50_000)),
        SearchClass::Bulk
    );
    assert_eq!(
        search_class(&request(&["-e", "needle", "."], 400)),
        SearchClass::Interactive
    );
    let mut broad = request(&["-e", "needle", "."], 400);
    broad.bulk_hint = true;
    assert_eq!(search_class(&broad), SearchClass::Bulk);
    let mut fuzzy = request(&[], 20);
    fuzzy.fuzzy = Some("needle".to_string());
    assert_eq!(search_class(&fuzzy), SearchClass::Fuzzy);
}

#[test]
fn internal_abandonment_returns_an_error_instead_of_silence() {
    let response = response_for_handler_result(7, Err(CANCELLED.to_string()), false).unwrap();
    assert_eq!(response["id"], 7);
    assert!(response["error"]
        .as_str()
        .is_some_and(|error| error.contains("without request cancellation")));
    assert!(response_for_handler_result(7, Err(CANCELLED.to_string()), true).is_none());
}

#[test]
fn adaptive_scheduler_reserves_interactive_capacity_and_throttles_bulk() {
    assert_eq!(interactive_dispatch_ceiling(4, 1, true), 5);
    assert_eq!(interactive_dispatch_ceiling(4, 1, false), 4);
    assert_eq!(queue_admission_capacity(SearchClass::Bulk, 16, 2), 14);
    assert_eq!(
        queue_admission_capacity(SearchClass::Interactive, 16, 2),
        16
    );
    let mut state = SchedulerState::new(2);
    assert_eq!(adaptive_bulk_limit(2, &state), 2);
    state.interactive_inflight = 1;
    assert_eq!(adaptive_bulk_limit(2, &state), 1);
}

#[test]
fn handler_panics_are_isolated_as_request_errors() {
    let result: Result<(), String> =
        contain_search_panic("probe handler", || panic!("isolated panic"));
    assert!(result
        .unwrap_err()
        .contains("probe handler panicked; request isolated"));
}

#[test]
fn single_file_reader_checks_cancellation_between_bounded_chunks() {
    let cancelled = AtomicBool::new(false);
    let source = std::io::Cursor::new(vec![b'x'; search_reader_chunk_bytes() * 2]);
    let mut reader = CancellableReader::new(source, &cancelled, None, None);
    let mut buffer = vec![0u8; search_reader_chunk_bytes() * 2];
    assert_eq!(
        reader.read(&mut buffer).unwrap(),
        search_reader_chunk_bytes()
    );
    cancelled.store(true, Ordering::Relaxed);
    assert_eq!(
        reader.read(&mut buffer).unwrap_err().kind(),
        io::ErrorKind::Interrupted
    );
}

#[test]
fn scheduler_aimd_uses_observed_queue_and_handler_latency() {
    let mut state = SchedulerState::new(4);
    let target = aimd_target();
    observe_scheduler_latency(&mut state, target * 2, Duration::from_millis(1), 4);
    assert_eq!(state.bulk_window, 2);
    for _ in 0..aimd_increase_every() {
        observe_scheduler_latency(&mut state, Duration::ZERO, Duration::from_millis(1), 4);
    }
    assert_eq!(state.bulk_window, 3);
}

#[test]
fn engine_api_stays_reachable_under_the_serve_search_path() {
    // The transports are the only exported surface: src/main.rs calls `run`
    // and the in-process host builds a `SearchServer`. Splitting the engine
    // into submodules must not move either behind a module path.
    let _: fn() = crate::serve_search::run;
    let _: fn(&crate::serve_search::SearchServer, &str) -> bool =
        crate::serve_search::SearchServer::dispatch;
    let _: fn(&mut crate::serve_search::SearchServer) = crate::serve_search::SearchServer::shutdown;
    assert_ne!(
        crate::serve_search::IdlePolicy::ExitProcess,
        crate::serve_search::IdlePolicy::ReleaseCaches
    );
}
