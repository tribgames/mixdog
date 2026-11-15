//! The final-answer watcher over fakes, for both of its users (this PC's session notifier and a server's): the tracker that finds
//! the turn that just ended, and the reads of its answer. Each test names the test of the TypeScript watcher it replaces
//! (`final-answer-watcher.test.mjs` = FAW, `push-turn-events.test.mjs` = PTE, `desktop-turn-notifier.test.mjs` = DTN).

use std::collections::VecDeque;
use std::sync::Mutex;

use mixdog_services::bots::routine::ROUTINE_QUIET;
use serde_json::json;

use super::*;

fn done(text: &str) -> FinalAnswer {
    FinalAnswer { id: json!("turn"), at: i64::MAX, status: FinalAnswerStatus::Done, text: text.into(), reacted: false }
}

fn facts(working: bool) -> TurnFacts {
    TurnFacts { working, lead_busy: working, silent: false }
}

fn nothing_pending() -> HashSet<String> {
    HashSet::new()
}

// ---- the tracker (PTE)

/// PTE "the first roster only establishes a baseline", "a session that never started working is not announced", "a repeated
/// idle roster does not announce the same finish twice".
#[test]
fn a_session_is_announced_once_when_it_stops_working_and_never_before_it_worked() {
    let mut tracker = TurnTracker::default();
    assert_eq!(tracker.observe("a", &facts(false), 10, &nothing_pending()), None);
    assert_eq!(tracker.observe("a", &facts(false), 11, &nothing_pending()), None);
    assert_eq!(tracker.observe("a", &facts(true), 20, &nothing_pending()), None);
    assert!(!tracker.is_idle("a"));
    assert_eq!(
        tracker.observe("a", &facts(false), 30, &nothing_pending()),
        Some(TurnEnd { started_at: 20, lead_finished: true })
    );
    assert!(tracker.is_idle("a"));
    assert_eq!(tracker.observe("a", &facts(false), 40, &nothing_pending()), None, "a repeated idle roster is not a second finish");
}

/// PTE "a turn that stops records its start", "every real finish is announced, even one shortly after the previous".
#[test]
fn every_real_finish_is_announced_with_its_own_start() {
    let mut tracker = TurnTracker::default();
    for (start, stop) in [(100, 200), (201, 202)] {
        assert_eq!(tracker.observe("a", &facts(true), start, &nothing_pending()), None);
        assert_eq!(
            tracker.observe("a", &facts(false), stop, &nothing_pending()),
            Some(TurnEnd { started_at: start, lead_finished: true })
        );
    }
}

/// PTE "child-agent work counts as the session still working", "a Lead that stops to wait on background work is not announced
/// until the work settles", "background work settling without a new Lead turn announces the answer already given".
#[test]
fn a_lead_waiting_on_its_agents_is_still_working_until_they_settle() {
    let mut tracker = TurnTracker::default();
    let pending = HashSet::from(["lead".to_owned()]);
    assert_eq!(tracker.observe("lead", &facts(true), 1, &pending), None);
    assert_eq!(tracker.observe("lead", &facts(false), 2, &pending), None, "the Lead only waits for its agents");
    assert!(!tracker.is_idle("lead"));
    assert_eq!(
        tracker.observe("lead", &facts(false), 3, &nothing_pending()),
        Some(TurnEnd { started_at: 1, lead_finished: false }),
        "the agents settled with no new Lead turn: the answer already given is the final one"
    );
}

/// PTE "an archived session stays silent", "a sub-agent session stays silent while its Lead is still announced".
#[test]
fn an_archived_or_sub_agent_session_stays_silent_and_its_lead_is_announced() {
    let mut tracker = TurnTracker::default();
    let silent = |working| TurnFacts { working, lead_busy: working, silent: true };
    assert_eq!(tracker.observe("sub", &silent(true), 1, &nothing_pending()), None);
    assert_eq!(tracker.observe("sub", &silent(false), 2, &nothing_pending()), None);
    assert_eq!(tracker.observe("lead", &facts(true), 1, &nothing_pending()), None);
    assert!(tracker.observe("lead", &facts(false), 2, &nothing_pending()).is_some());
}

/// PTE "a deleted session leaves no state behind and re-baselines if it returns", "several sessions finishing in one roster each
/// get a completion", "idleness is reported for the quiet-period recheck".
#[test]
fn a_roster_is_the_whole_list_and_each_session_in_it_finishes_on_its_own() {
    let mut tracker = TurnTracker::default();
    for id in ["a", "b", "c"] {
        assert_eq!(tracker.observe(id, &facts(true), 5, &nothing_pending()), None);
    }
    let finished = ["a", "b", "c"].into_iter().filter(|id| tracker.observe(id, &facts(false), 6, &nothing_pending()).is_some()).count();
    assert_eq!(finished, 3);
    assert!(tracker.is_idle("a") && !tracker.is_idle("unknown"));

    tracker.retain(&HashSet::from(["b".to_owned()]));
    assert!(!tracker.is_idle("a"), "a session the roster no longer lists leaves no state");
    assert_eq!(tracker.observe("a", &facts(false), 7, &nothing_pending()), None, "and re-baselines if it returns");
    tracker.forget("b");
    assert!(!tracker.is_idle("b"));
}

// ---- the reads

/// What a read answers, in order; `hang` never answers.
struct Scripted {
    replies: Mutex<VecDeque<Result<Option<FinalAnswer>, AnswerReadError>>>,
    reads: Mutex<Vec<String>>,
    hang: bool,
}

impl Scripted {
    fn new(replies: Vec<Result<Option<FinalAnswer>, AnswerReadError>>, hang: bool) -> Arc<Self> {
        Arc::new(Self { replies: Mutex::new(replies.into()), reads: Mutex::default(), hang })
    }
}

#[async_trait]
impl FinalAnswers for Scripted {
    async fn read(&self, session_id: &str, _started_at: i64) -> Result<Option<FinalAnswer>, AnswerReadError> {
        self.reads.lock().unwrap().push(session_id.to_owned());
        if self.hang {
            std::future::pending::<()>().await;
        }
        self.replies.lock().unwrap().pop_front().unwrap_or(Ok(None))
    }
}

struct Rig {
    watch: AnswerWatch<&'static str>,
    wakes: mpsc::UnboundedReceiver<WatchWake>,
    steps: Arc<Mutex<Vec<(String, Value)>>>,
    answers: Arc<Scripted>,
}

fn rig(answers: Arc<Scripted>) -> Rig {
    let (tx, wakes) = mpsc::unbounded_channel();
    let steps = Arc::new(Mutex::new(Vec::new()));
    let recorded = steps.clone();
    let watch = AnswerWatch::new(
        answers.clone(),
        Arc::new(move |wake| {
            let _ = tx.send(wake);
        }),
        Arc::new(|| true),
        Arc::new(move |step, _, details| recorded.lock().unwrap().push((step.to_owned(), details))),
    );
    Rig { watch, wakes, steps, answers }
}

async fn settle() {
    for _ in 0..64 {
        tokio::task::yield_now().await;
    }
}

impl Rig {
    /// The turn of `id` runs and ends; its answer is then read.
    fn finish(&mut self, id: &str, detail: &'static str) {
        assert_eq!(self.watch.observe(id, &facts(true), 1_000, &nothing_pending()), None);
        let end = self.watch.observe(id, &facts(false), 1_001, &nothing_pending()).expect("the turn ended");
        self.watch.begin(id, end, detail);
    }

    /// Hands the watcher every wake that has arrived (and those they set going); what settled.
    async fn drain(&mut self) -> Vec<Settled<&'static str>> {
        let mut settled = Vec::new();
        settle().await;
        while let Ok(wake) = self.wakes.try_recv() {
            settled.extend(self.watch.on_wake(wake));
            settle().await;
        }
        settled
    }

    async fn advance(&mut self, ms: u64) -> Vec<Settled<&'static str>> {
        settle().await;
        tokio::time::advance(Duration::from_millis(ms)).await;
        self.drain().await
    }

    fn steps_named(&self, name: &str) -> Vec<Value> {
        self.steps.lock().unwrap().iter().filter(|(step, _)| step == name).map(|(_, details)| details.clone()).collect()
    }
}

/// FAW "a late read from a previous turn cannot notify after another turn starts and finishes".
#[tokio::test(start_paused = true)]
async fn a_read_of_an_earlier_turn_cannot_tell_after_another_turn_ran() {
    let mut rig = rig(Scripted::new(vec![], false));
    rig.finish("a", "first");
    // The session runs again before the first read lands, and ends again.
    assert_eq!(rig.watch.observe("a", &facts(true), 2_000, &nothing_pending()), None);
    rig.watch.drop_stale(|_| true);
    let end = rig.watch.observe("a", &facts(false), 2_001, &nothing_pending()).expect("the second turn ended");
    rig.watch.begin("a", end, "second");
    let late = rig.watch.on_wake(WatchWake::Read { session_id: "a".into(), generation: 1, result: Ok(Some(done("old"))) });
    assert!(late.is_none(), "the answer of the first turn is not the second's");
    let current = rig.watch.on_wake(WatchWake::Read { session_id: "a".into(), generation: 2, result: Ok(Some(done("new"))) });
    let settled = current.expect("the second turn's answer tells");
    assert_eq!((settled.detail, settled.text.as_str(), settled.failed), ("second", "new", false));
}

/// FAW "a deleted session never substitutes an older assistant answer".
#[tokio::test(start_paused = true)]
async fn a_forgotten_session_is_neither_read_nor_told() {
    let mut rig = rig(Scripted::new(vec![Ok(Some(done("old")))], false));
    rig.finish("a", "gone");
    rig.watch.forget("a");
    assert!(rig.advance(LEAD_FINISHED_MS + 50).await.is_empty());
    assert!(rig.answers.reads.lock().unwrap().is_empty(), "no read for a session that left");
    assert!(rig.watch.on_wake(WatchWake::Read { session_id: "a".into(), generation: 1, result: Ok(Some(done("old"))) }).is_none());
}

/// FAW "a hung read is aborted after the deadline, counts as a transient failure and frees the slot", "the read gets an abort
/// signal that fires when it overruns its deadline", "only one answer read is in flight at a time across sessions".
#[tokio::test(start_paused = true)]
async fn a_hung_read_fails_at_its_deadline_and_frees_the_slot_for_the_next() {
    let mut rig = rig(Scripted::new(vec![], true));
    rig.finish("a", "first");
    rig.finish("b", "second");
    rig.advance(LEAD_FINISHED_MS + 50).await;
    assert_eq!(*rig.answers.reads.lock().unwrap(), ["a"], "one read at a time: b waits behind a");
    rig.advance(READ_DEADLINE.as_millis() as u64).await;
    assert_eq!(*rig.answers.reads.lock().unwrap(), ["a", "b"], "a's overrun freed the slot");
    let failed = rig.steps_named("read-failed");
    assert_eq!(failed.len(), 1);
    assert!(failed[0]["error"].as_str().unwrap().contains("timed out"), "{failed:?}");
}

/// DTN "a late answer is retried, but its pending diagnostic is not spammed"; FAW "an answer arriving after idle is awaited
/// instead of replaced by a preview or generic notice".
#[tokio::test(start_paused = true)]
async fn a_pending_answer_is_polled_and_its_wait_is_reported_once() {
    let mut rig = rig(Scripted::new(vec![Ok(None), Ok(None), Ok(None), Ok(Some(done("Now.")))], false));
    rig.finish("a", "slow");
    let mut settled = rig.advance(LEAD_FINISHED_MS + 50).await;
    for _ in 0..3 {
        settled.extend(rig.advance(ANSWER_POLL_MS + 50).await);
    }
    assert_eq!(rig.answers.reads.lock().unwrap().len(), 4);
    assert_eq!(rig.steps_named("waiting-answer").len(), 1, "reported when it starts waiting, not at every poll");
    let [answer] = <[Settled<&'static str>; 1]>::try_from(settled).ok().expect("one answer told");
    assert_eq!((answer.detail, answer.text.as_str()), ("slow", "Now."));
}

/// FAW "a failed turn is an error notification with no answer text; a cancelled one is silent", and the steps a notification
/// reports (`detected`, `suppressed` with its reason).
#[tokio::test(start_paused = true)]
async fn the_steps_of_a_turn_are_reported_with_their_reasons() {
    let failed = FinalAnswer { status: FinalAnswerStatus::Failed, ..done("") };
    let cancelled = FinalAnswer { status: FinalAnswerStatus::Cancelled, ..done("") };
    let reacted = FinalAnswer { reacted: true, ..done("") };
    let mut rig = rig(Scripted::new(vec![Ok(Some(failed)), Ok(Some(cancelled)), Ok(Some(reacted)), Ok(Some(done(ROUTINE_QUIET)))], false));
    rig.finish("a", "failed");
    let mut settled = rig.advance(LEAD_FINISHED_MS + 50).await;
    assert_eq!((settled.len(), settled[0].failed, settled[0].text.as_str()), (1, true, ""));
    for id in ["b", "c", "d"] {
        rig.finish(id, "silent");
        settled = rig.advance(LEAD_FINISHED_MS + 50).await;
        assert!(settled.is_empty(), "{id}");
    }
    assert_eq!(rig.steps_named("detected").len(), 4);
    let reasons: Vec<Value> = rig.steps_named("suppressed").iter().map(|details| details["reason"].clone()).collect();
    assert_eq!(reasons, [json!("cancelled"), json!("reaction"), json!("routine-quiet")]);
}
