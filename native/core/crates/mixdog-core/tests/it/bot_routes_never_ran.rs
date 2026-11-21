use mixdog_core::run_host::turn_inputs::BotRouteStore;
use mixdog_core_run::run_host::route_chain::AGENT_MODE;
use mixdog_core_run::run_host::route_chain::BotRoutes;
use mixdog_core_run::run_host::route_chain::LaneFault;
use mixdog_core_run::run_host::route_chain::RouteReadUnavailable;
use mixdog_core_run::run_host::route_chain::owner_route_fallbacks;

// Current-thread: the reads submit from the test thread, the one the refusal covers.
#[tokio::test(flavor = "current_thread")]
async fn a_bot_route_read_that_never_ran_is_an_error() {
    let tokens = mixdog_rt::testing::tokens();
    let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
    let data = tempfile::tempdir().unwrap();
    let store = BotRouteStore::new(data.path(), tokens.interactive_io);

    assert!(matches!(store.bot_route("botty").await, Err(RouteReadUnavailable(_))));
    assert!(matches!(store.stored_bot_route("lead").await, Err(RouteReadUnavailable(_))));

    // Through the readers: the chain of a bot is an error, not an empty chain or the config's.
    let config = serde_json::Map::new();
    assert!(matches!(owner_route_fallbacks(AGENT_MODE, "botty", "xai", "grok-4", &config, &store).await, Err(RouteReadUnavailable(_))));
}

#[tokio::test]
async fn a_cancelled_turn_stops_waiting_and_says_so() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().unwrap();
    let store = BotRouteStore::new(data.path(), tokens.interactive_io);
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();

    let read = mixdog_agent::compact::blob_reads::within_turn(cancel, store.bot_route("botty")).await;

    assert_eq!(read, Err(RouteReadUnavailable(LaneFault::Cancelled)));
}

/// Runs `read` with the interactive lane held full until `release` is called; returns once the read is parked at it.
async fn parked(
    cancel: tokio_util::sync::CancellationToken,
) -> (mixdog_rt::testing::HeldFull, tokio::task::JoinHandle<Result<Option<Option<serde_json::Value>>, RouteReadUnavailable>>) {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().unwrap();
    let held = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    let store = std::sync::Arc::new(BotRouteStore::new(data.path(), tokens.interactive_io));
    // The read is made from a task the turn spawned, as a tool's is: it carries the turn's token as the tool spawn does.
    let read = tokio::spawn(async move {
        let _data = data;
        mixdog_agent::compact::blob_reads::within_turn(cancel, async move { store.bot_route("botty").await }).await
    });
    held.met_by_a_submit().await;
    (held, read)
}

#[tokio::test(flavor = "current_thread")]
async fn a_read_parked_at_a_full_lane_gets_its_answer_once_room_is_released() {
    let (held, read) = parked(tokio_util::sync::CancellationToken::new()).await;
    assert!(!read.is_finished(), "the read waits for room");
    drop(held);
    assert_eq!(read.await.unwrap(), Ok(None), "no store bot of that name: an answer, not an error");
}

#[tokio::test(flavor = "current_thread")]
async fn a_read_parked_at_a_full_lane_ends_cancelled_across_a_spawned_task_when_the_turn_is_cancelled() {
    let cancel = tokio_util::sync::CancellationToken::new();
    let (_held, read) = parked(cancel.clone()).await;
    cancel.cancel();
    let error = read.await.unwrap().expect_err("the wait ended");
    assert_eq!(error, RouteReadUnavailable(LaneFault::Cancelled));
    assert!(error.to_string().contains("cancelled"), "{error}");
}
