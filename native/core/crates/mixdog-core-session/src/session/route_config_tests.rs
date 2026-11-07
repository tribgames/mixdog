//! The configured route values and the settings announcement: Node's initial state holds `baseRouteState()` from its first read
//! (no frame announces it), and `setupChanged` counts each settings change the runtime announced (`notification-router.mjs`).

use std::sync::Arc;

use mixdog_app_protocol::v2::thread::ThreadContext;
use mixdog_app_protocol::v2::thread::ThreadRoute;
use mixdog_core_api::ids::TurnId;
use mixdog_core_ports::ports::threads::Section;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::lock;
use super::tests::eventually_on;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;

fn newest(rig: &Rig, thread: &str, method: &str) -> Option<Value> {
    rig.feeds.frames(thread).into_iter().rev().find(|(_, name, _)| name == method).map(|(_, _, params)| params["value"].clone())
}

/// An installed session holds the configured route values in its state, and publishes no route frame to say so; the next route
/// frame carries them.
#[tokio::test(start_paused = true)]
async fn the_configured_route_values_are_state_from_install_and_no_frame() {
    let rig = Rig::new();
    let auto_clear = json!({ "enabled": true, "idleMs": 3_600_000, "custom": false });
    let system_shell = json!({ "source": "auto", "command": "", "effective": "" });
    let web_search_route = json!({ "provider": "default", "model": "default" });
    *lock(&rig.compaction.route) = ThreadRoute {
        auto_clear: Some(auto_clear.clone()),
        system_shell: Some(system_shell.clone()),
        web_search_route: Some(web_search_route.clone()),
        ..Default::default()
    };
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    assert_eq!(newest(&rig, handle.id.as_str(), "thread/route/updated"), None, "install publishes no route frame");
    handle.set_section(Section::Route(ThreadRoute { effort: Some("high".into()), ..Default::default() })).await.expect("route");
    let route = eventually_on(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/route/updated")).await;
    assert_eq!((&route["autoClear"], &route["systemShell"], &route["webSearchRoute"]), (&auto_clear, &system_shell, &web_search_route));
}

/// A route written into the header (`updateSessionRoute`) moves the route state: `provider`, `model` and the session's own
/// (`sessionProvider`, `sessionModel`) follow, and the values read under the provider (`autoClear`) are read again.
#[tokio::test(start_paused = true)]
async fn a_route_written_into_the_header_moves_the_route_state() {
    let rig = Rig::new();
    let auto_clear = json!({ "enabled": true, "provider": "anthropic-oauth" });
    *lock(&rig.compaction.route) = ThreadRoute { auto_clear: Some(auto_clear.clone()), ..Default::default() };
    let directory = SessionDirectory::new(rig.deps());
    let handle = super::tests::start_routed_thread(&directory).await;
    let route = eventually_on(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/route/updated")).await;
    assert_eq!(
        (&route["provider"], &route["model"], &route["sessionProvider"], &route["sessionModel"], &route["autoClear"]),
        (&json!(super::tests::ROUTE_PROVIDER), &json!(super::tests::ROUTE_MODEL), &json!(super::tests::ROUTE_PROVIDER), &json!(super::tests::ROUTE_MODEL), &auto_clear)
    );
}

/// The context a run's pressure check publishes: the window, and the display fields Node's `syncContextDisplayFields` sets once a turn
/// that was not cancelled has measured its context.
fn pressure() -> ThreadContext {
    ThreadContext {
        context_window: Some(9_000),
        display_context_window: Some(9_000),
        auto_compact_token_limit: Some(7_000),
        compact_boundary_tokens: Some(8_000),
        ..Default::default()
    }
}

/// Runs one turn whose run publishes [`pressure`] and then ends as `interrupted` or completed; the thread's context afterwards.
async fn context_after_turn(interrupted: bool) -> ThreadContext {
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.section(Section::Context(pressure())).await.expect("pressure");
            if interrupted {
                run.cancel.cancelled().await;
                RunOutcome::Interrupted
            } else {
                RunOutcome::Completed(Default::default())
            }
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let started = turn(&handle, "measure", "op-1").await;
    // The window is published while the turn runs; the display fields are not.
    let published = eventually_on(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/context/updated").filter(|context| context["contextWindow"] == json!(9_000))).await;
    if interrupted {
        assert_eq!(published["displayContextWindow"], json!(0), "a running turn has not published its display fields");
        handle.interrupt(&TurnId::from(started["turnId"].as_str().expect("turn id")), None).expect("interrupt");
    }
    eventually_on(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    handle.cell.view.load_full().state.context.clone().expect("context")
}

/// Node's `syncContextDisplayFields` runs with the measurement of a turn that was not cancelled: a cancelled turn leaves the display
/// fields at their initial 0, a completed one publishes them.
#[tokio::test(start_paused = true)]
async fn a_cancelled_turn_leaves_the_context_display_fields_and_a_completed_one_publishes_them() {
    let cancelled = context_after_turn(true).await;
    assert_eq!(
        (cancelled.display_context_window, cancelled.auto_compact_token_limit, cancelled.compact_boundary_tokens),
        (Some(0), Some(0), Some(0))
    );
    let completed = context_after_turn(false).await;
    assert_eq!(
        (completed.display_context_window, completed.auto_compact_token_limit, completed.compact_boundary_tokens),
        (Some(9_000), Some(7_000), Some(8_000))
    );
}

/// Each announced settings change moves `setupChanged` (`{ action: 'settings_changed', seq, at }`, `seq` counting the thread's changes), and
/// the route section follows the saved configuration.
#[tokio::test(start_paused = true)]
async fn each_announced_settings_change_moves_setup_changed() {
    let rig = Rig::new();
    let (announce, changes) = tokio::sync::watch::channel(0_u64);
    *lock(&rig.compaction.settings) = Some(changes);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let seq_of = |value: Option<Value>| value.and_then(|runtime| runtime["setupChanged"]["seq"].as_u64());
    assert_eq!(seq_of(newest(&rig, handle.id.as_str(), "thread/runtime/updated")), None, "nothing is announced before a change");
    announce.send_modify(|count| *count += 1);
    let first = eventually_on(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/runtime/updated").filter(|runtime| runtime["setupChanged"]["seq"] == json!(1))).await;
    assert_eq!(first["setupChanged"]["action"], json!("settings_changed"));
    announce.send_modify(|count| *count += 1);
    eventually_on(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/runtime/updated").filter(|runtime| runtime["setupChanged"]["seq"] == json!(2))).await;
}
