//! When a thread schedules and wakes the code-graph prewarm (`prewarm_signals.rs`), as Node's
//! session runtime does (`code-graph-prewarm.mjs` callers).

use std::sync::Arc;
use std::sync::atomic::Ordering;

use mixdog_core_api::ids::ItemId;

use super::SessionDirectory;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::lock;
use super::tests::eventually;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;

fn calls(rig: &Rig) -> Vec<String> {
    lock(&rig.code_graph.calls).clone()
}

fn take(rig: &Rig) -> Vec<String> {
    std::mem::take(&mut *lock(&rig.code_graph.calls))
}

/// Every turn shows text: the delta is visible output.
fn speaking_turns(rig: &Rig) {
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.delta(ItemId::from("a-1".to_owned()), "hi".into()).await.expect("delta");
            RunOutcome::Completed(Default::default())
        })
    }));
}

/// Eager mode: the opened thread's cwd warms after the delay (`applyResolvedCwd` on resume) and its
/// create settling wakes; the first turn wakes on start and end and warms on its first visible
/// output, a later turn only wakes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_turns_visible_output_warms_and_every_busy_change_wakes() {
    let rig = Rig::new();
    speaking_turns(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    eventually(|| calls(&rig).contains(&"schedule:cwd:default".to_owned()).then_some(())).await;
    assert!(calls(&rig).contains(&"wake".to_owned()), "the create settling wakes: {:?}", calls(&rig));
    take(&rig);

    turn(&handle, "one", "op-1").await;
    eventually(|| idle(&handle).then_some(())).await;
    eventually(|| (calls(&rig).len() == 3).then_some(())).await;
    assert_eq!(take(&rig), ["wake", "schedule:first-visible:0", "wake"]);

    turn(&handle, "two", "op-2").await;
    eventually(|| idle(&handle).then_some(())).await;
    eventually(|| (calls(&rig).len() == 2).then_some(())).await;
    assert_eq!(take(&rig), ["wake", "wake"], "only the runtime's first turn warms");
}

/// Every cwd apply warms, the same folder again included (`applyResolvedCwd`): a move at once, a
/// re-apply after the delay; in lazy mode nothing before the first turn armed its warm.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_cwd_apply_warms_unless_lazy_before_the_first_turn() {
    let rig = Rig::new();
    rig.code_graph.lazy.store(true, Ordering::SeqCst);
    speaking_turns(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    handle.cwd_applied(true).expect("applied");
    handle.cwd_applied(false).expect("applied");
    // A turn after the applies: the control lane took them first.
    turn(&handle, "one", "op-1").await;
    eventually(|| idle(&handle).then_some(())).await;
    assert!(
        !calls(&rig).iter().any(|call| call.starts_with("schedule:cwd")),
        "lazy: no cwd warm before the first turn: {:?}",
        calls(&rig)
    );
    take(&rig);

    handle.cwd_applied(true).expect("applied");
    eventually(|| calls(&rig).contains(&"schedule:cwd-change:0".to_owned()).then_some(())).await;
    handle.cwd_applied(false).expect("applied");
    eventually(|| calls(&rig).contains(&"schedule:cwd:default".to_owned()).then_some(())).await;
    let scheduled: Vec<String> = take(&rig).into_iter().filter(|call| call.starts_with("schedule")).collect();
    assert_eq!(scheduled, ["schedule:cwd-change:0", "schedule:cwd:default"]);
}
