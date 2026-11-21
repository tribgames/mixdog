use super::*;
use crate::manager::OutputFilter;
use crate::manager::ProcessConfig;

struct Quiet;

impl TerminalEvents for Quiet {
    fn activity(&self, _: &str, _: Option<ActivityState>) {}
    fn size_owner(&self, _: &SizeOwnerChange) {}
    fn size_claims_forgotten(&self, _: &str) {}
}

fn tab() -> Arc<Tab> {
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
    Arc::new(Tab {
        id: "term_held".to_owned(),
        seq: 1,
        handle: ProcessHandle::from("term_held"),
        shell: "pwsh".to_owned(),
        cwd: None,
        state: Mutex::new(TabState {
            buffer: ReplayBuffer::new(REPLAY_BUFFER_LIMIT, 0),
            scanner: Some(MarkerScanner::default()),
            decoder: Utf8Decoder::default(),
            activity: ActivityTracker::new(false),
            exited: false,
            paused_by: BTreeSet::new(),
            size: (80, 24),
            emitted: 0,
            order: None,
            held_gen: 0,
            held_timer: None,
            flushing: false,
        }),
        pty_gate: Mutex::new(()),
        flushed: Condvar::new(),
        events: Arc::new(Quiet),
        manager,
    })
}

fn take(filter: &mut TabFilter, chunk: &[u8]) -> Vec<u8> {
    let out = filter.filter(chunk);
    filter.admitted();
    out
}

/// A chunk ending in the start of a marker prefix is held back; with no chunk after it, the flush after 50 ms puts it into the feed
/// and the replay window (Node's `flushHeld`): without the flush it stays invisible until the next chunk or the shell's end.
#[test]
fn a_lone_trailing_escape_is_released_when_no_chunk_follows() {
    let tab = tab();
    let feed = Feed::new(1 << 20);
    let mut filter = TabFilter::new(Arc::clone(&tab));
    assert_eq!(take(&mut filter, b"PS> \x1b"), b"PS> ");
    let held_gen = tab.lock().held_gen;
    assert!(tab.lock().scanner.as_ref().unwrap().is_holding());
    tab.flush_held(&feed, held_gen);
    assert_eq!(feed.pushed(), 1);
    let state = tab.lock();
    // The window and the count hold the admitted `PS> ` and, after it, the released escape.
    assert_eq!(state.buffer.read(), "PS> \x1b");
    assert_eq!(state.emitted, 5);
    assert!(!state.scanner.as_ref().unwrap().is_holding());
    assert!(!state.flushing);
}

/// A chunk that arrived after the one that held the tail decides the tail itself: the flush armed for the earlier chunk does nothing.
#[test]
fn a_flush_armed_before_a_later_chunk_does_nothing() {
    let tab = tab();
    let feed = Feed::new(1 << 20);
    let mut filter = TabFilter::new(Arc::clone(&tab));
    take(&mut filter, b"a\x1b");
    let armed = tab.lock().held_gen;
    assert_eq!(take(&mut filter, b"]697;P\x07b"), b"b");
    tab.flush_held(&feed, armed);
    assert_eq!(feed.pushed(), 0);
}

/// A tab whose shell has no integration holds nothing back, so nothing is flushed.
#[test]
fn a_tab_without_integration_has_nothing_to_flush() {
    let tab = tab();
    tab.lock().scanner = None;
    let feed = Feed::new(1 << 20);
    let mut filter = TabFilter::new(Arc::clone(&tab));
    assert_eq!(take(&mut filter, b"x\x1b"), b"x\x1b");
    let held_gen = tab.lock().held_gen;
    tab.flush_held(&feed, held_gen);
    assert_eq!(feed.pushed(), 0);
}

#[tokio::test(start_paused = true)]
async fn admitted_replaces_the_timer_and_only_dispatches_the_current_tail() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let tab = tab();
    let ticker = mixdog_rt::Ticker::start();
    let calls = Arc::new(AtomicUsize::new(0));
    let feed = Feed::new(1 << 20);
    let mut filter = TabFilter::new(tab.clone());
    for _ in 0..12 {
        filter.filter(b"\x1b");
        let (called, held) = (calls.clone(), feed.clone());
        filter.admitted_with(Some(&ticker), move |tab, generation| {
            called.fetch_add(1, Ordering::SeqCst);
            tab.flush_held(&held, generation);
        });
        tokio::task::yield_now().await;
        tokio::time::advance(std::time::Duration::from_millis(10)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    tokio::time::advance(HELD_FLUSH + std::time::Duration::from_millis(1)).await;
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1, "stale deadlines must never dispatch threads");
    assert_eq!(feed.pushed(), 1);
    assert!(!tab.lock().scanner.as_ref().unwrap().is_holding());
}

#[tokio::test(start_paused = true)]
async fn finish_cancels_the_real_armed_tail_and_a_dequeued_stale_callback_is_refused() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let tab = tab();
    let ticker = mixdog_rt::Ticker::start();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut filter = TabFilter::new(tab.clone());
    filter.filter(b"\x1b");
    let count = calls.clone();
    filter.admitted_with(Some(&ticker), move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
    });
    let old = tab.lock().held_gen;
    assert!(tab.flush_ready(old));
    assert_eq!(filter.finish(), b"\x1b");
    assert!(!tab.flush_ready(old));
    assert!(tab.lock().held_timer.is_none());
    tokio::task::yield_now().await;
    tokio::time::advance(HELD_FLUSH + std::time::Duration::from_millis(1)).await;
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn focus_arms_and_renews_the_actual_thirty_second_lease() {
    let tab = tab();
    let tabs = TerminalTabs::new(tab.manager.clone(), TerminalConfig::new(Arc::new(Quiet)));
    tabs.table().insert(tab.id.clone(), Slot::Live(tab.clone()));
    let ticker = mixdog_rt::Ticker::start();
    tabs.focus_with(&tab.id, "view", true, Some(&ticker));
    tokio::task::yield_now().await;
    tokio::time::advance(std::time::Duration::from_secs(20)).await;
    tabs.focus_with(&tab.id, "view", true, Some(&ticker));
    tokio::time::advance(std::time::Duration::from_secs(15)).await;
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
    assert!(tab.lock().activity.focused_by("view"), "renewal survived the old deadline");
    tokio::time::advance(std::time::Duration::from_secs(16)).await;
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
    assert!(!tab.lock().activity.focused_by("view"));
    tabs.focus_with(&tab.id, "view", true, Some(&ticker));
    tabs.connection_closed("view");
    assert!(!tab.lock().activity.focused_by("view"));
}

#[tokio::test(start_paused = true)]
async fn a_stale_callback_that_still_fires_never_dispatches_a_thread() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let tab = tab();
    let ticker = mixdog_rt::Ticker::start();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut filter = TabFilter::new(tab.clone());
    filter.filter(b"\x1b");
    let count = calls.clone();
    filter.admitted_with(Some(&ticker), move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
    });
    // Keep the actual deadline armed while invalidating its generation. This
    // represents cancellation losing to a callback already dequeued to run.
    tab.lock().held_gen += 1;
    tokio::task::yield_now().await;
    tokio::time::advance(HELD_FLUSH + std::time::Duration::from_millis(1)).await;
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0, "the callback must check before OS-thread dispatch");
}
