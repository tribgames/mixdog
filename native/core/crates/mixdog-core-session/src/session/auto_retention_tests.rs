//! The auto-retention rule and pass over a host that keeps its sessions in memory.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use super::*;

const NOW: f64 = 1_800_000_000_000.0;
const POLICY: Policy = Policy { archive_days: 7, delete_days: 30 };

fn days(n: f64) -> f64 {
    n * DAY_MS
}

/// An idle, read session last used `idle` days ago: the one the rule archives.
fn session(id: &str, idle: f64) -> Session {
    Session { id: id.to_owned(), activity_at: NOW - days(idle), last_used_at: NOW - days(idle), message_count: 4.0, ..Session::default() }
}

fn record() -> RetentionRecord {
    RetentionRecord { enabled_at: NOW - days(200.0), restored: HashMap::new() }
}

#[derive(Default)]
struct State {
    sessions: Vec<Session>,
    stamps: HashMap<String, f64>,
    background: HashSet<String>,
    live_sub: HashSet<String>,
    /// Sub-sessions that turn live only by the time the final judgment reads them afresh (a turn completed since the listing).
    live_sub_fresh: HashSet<String>,
    /// The sub-sessions a session has, with the activity stamp of each.
    children: HashMap<String, Vec<(String, f64)>>,
    /// What the session's own actor answers an archive with, by id; anything else is archived.
    archive_refusals: HashMap<String, String>,
    /// The archives asked for, with the policy each was judged under.
    trees: Vec<(String, Policy)>,
    identity: Arc<PolicyIdentity>,
    /// While set, the worktree check waits for `wt_gate`.
    wt_hold: bool,
    wt_gate: Arc<tokio::sync::Notify>,
    wt_entered: usize,
    worktree: HashSet<String>,
    /// What the core answers an idle delete with, by id; anything else is deleted.
    refusals: HashMap<String, String>,
    policy: Option<Policy>,
    record: RetentionRecord,
    archived: Vec<String>,
    deleted_asked: Vec<(String, f64)>,
    logs: Vec<String>,
    /// Listings read: one per pass.
    listings: usize,
    /// While set, an archive waits for `gate` (a pass held mid-way).
    hold: bool,
    gate: Arc<tokio::sync::Notify>,
    entered: usize,
    active: usize,
    max_active: usize,
}

struct Fake(Mutex<State>);

impl Fake {
    fn with(sessions: Vec<Session>) -> Self {
        Self(Mutex::new(State { sessions, policy: Some(POLICY), record: record(), ..State::default() }))
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap()
    }
}

#[async_trait]
impl AutoRetentionHost for Fake {
    fn policy(&self) -> Option<Policy> {
        self.state().policy
    }
    fn identity(&self) -> Arc<PolicyIdentity> {
        self.state().identity.clone()
    }
    async fn record(&self) -> Result<RetentionRecord, String> {
        Ok(self.state().record.clone())
    }
    async fn sessions(&self) -> Result<Vec<Session>, String> {
        let mut state = self.state();
        state.listings += 1;
        Ok(state.sessions.clone())
    }
    async fn session(&self, id: &str) -> Result<Option<Session>, String> {
        Ok(self.state().sessions.iter().find(|s| s.id == id).cloned())
    }
    async fn archived_stamp(&self, id: &str) -> Result<Option<f64>, String> {
        Ok(self.state().stamps.get(id).copied())
    }
    async fn background_jobs(&self, id: &str) -> Result<bool, String> {
        Ok(self.state().background.contains(id))
    }
    async fn sub_sessions(&self, id: &str, _now: f64, _window: f64, fresh: bool) -> Result<Option<Vec<(String, f64)>>, String> {
        let state = self.state();
        if state.live_sub.contains(id) || (fresh && state.live_sub_fresh.contains(id)) {
            return Ok(None);
        }
        Ok(Some(state.children.get(id).cloned().unwrap_or_default()))
    }
    async fn archive_tree(&self, id: &str, _now: f64, policy: Policy, admit: Admit) -> Result<TreeOutcome, String> {
        let (hold, gate) = {
            let mut state = self.state();
            state.entered += 1;
            state.active += 1;
            state.max_active = state.max_active.max(state.active);
            (state.hold, state.gate.clone())
        };
        if hold {
            gate.notified().await;
        }
        let mut state = self.state();
        state.active -= 1;
        // Admitted as the state writer admits it: a stop, or a policy changed since the judgment, admits nothing.
        if let Some(reason) = admit.refusal() {
            return Ok(TreeOutcome::Refused(reason.to_owned()));
        }
        if state.policy != Some(policy) {
            return Ok(TreeOutcome::Refused("policy".to_owned()));
        }
        if let Some(reason) = state.archive_refusals.get(id).cloned() {
            return Ok(TreeOutcome::Refused(reason));
        }
        state.trees.push((id.to_owned(), policy));
        state.archived.push(id.to_owned());
        // The archive stamps the session now: it is archived from here on.
        state.stamps.insert(id.to_owned(), NOW);
        if let Some(found) = state.sessions.iter_mut().find(|s| s.id == id) {
            found.archived = true;
        }
        Ok(TreeOutcome::Archived(vec![id.to_owned()]))
    }
    async fn delete_if_idle(&self, id: &str, last_used_at: f64, _activity: f64, _cancel: &CancellationToken) -> Result<IdleDelete, String> {
        let mut state = self.state();
        state.deleted_asked.push((id.to_owned(), last_used_at));
        if let Some(reason) = state.refusals.get(id).cloned() {
            return Ok(IdleDelete { deleted: false, reason: Some(reason) });
        }
        state.sessions.retain(|s| s.id != id);
        Ok(IdleDelete { deleted: true, reason: None })
    }
    async fn worktree_work(&self, id: &str) -> Result<bool, String> {
        let (hold, gate) = {
            let mut state = self.state();
            state.wt_entered += 1;
            (state.wt_hold, state.wt_gate.clone())
        };
        if hold {
            gate.notified().await;
        }
        Ok(self.state().worktree.contains(id))
    }
    fn log(&self, line: &str) {
        self.state().logs.push(line.to_owned());
    }
}

async fn verdict(s: &Session) -> Option<Action> {
    verdict_with(&Fake::with(vec![]), s, &record(), POLICY).await
}

async fn verdict_with(host: &Fake, s: &Session, record: &RetentionRecord, policy: Policy) -> Option<Action> {
    judge(host, s, NOW, policy, record, false).await.unwrap().map(|verdict| verdict.action)
}

async fn pass(host: &Fake) -> Option<Report> {
    let clock = || NOW;
    run_pass(host, &clock, &CancellationToken::new(), &Arc::default()).await.unwrap()
}

#[tokio::test]
async fn an_idle_read_session_is_archived_and_a_recent_one_is_not() {
    assert_eq!(verdict(&session("a", 8.0)).await, Some(Action::Archive));
    assert_eq!(verdict(&session("a", 6.9)).await, None);
    // The age is the activity; a session without one is never judged.
    assert_eq!(verdict(&Session { activity_at: 0.0, ..session("a", 30.0) }).await, None);
}

/// Each exemption on its own: the same idle session, with only that fact changed, is left alone.
macro_rules! exempt {
    ($name:ident, |$s:ident| $change:expr) => {
        #[tokio::test]
        async fn $name() {
            let mut $s = session("a", 30.0);
            assert_eq!(verdict(&$s).await, Some(Action::Archive), "the unexempted session is archived");
            $change;
            assert_eq!(verdict(&$s).await, None);
        }
    };
}

exempt!(a_favorite_is_exempt, |s| s.favorite = true);
exempt!(an_agent_home_is_exempt, |s| s.agent_home = true);
exempt!(a_room_log_is_exempt, |s| s.agent_room = true);
exempt!(an_agent_mode_chat_is_exempt, |s| s.agent_mode = true);
exempt!(an_automation_is_exempt, |s| s.automation = true);
exempt!(a_task_a_bot_run_made_is_exempt, |s| s.task_run = true);
exempt!(a_sub_agent_session_is_exempt, |s| s.agent_session = true);
exempt!(a_running_session_is_exempt, |s| s.working = true);
exempt!(a_session_open_in_a_window_is_exempt, |s| s.visible = true);
exempt!(a_scheduled_quota_resume_is_exempt, |s| s.scheduled_resume = true);
exempt!(unread_output_is_exempt, |s| {
    s.read_message_count = Some(2.0);
    s.message_count = 4.0;
    s.incoming_tail = Some(vec![3.0, 4.0]);
});
exempt!(unread_output_without_a_tail_is_exempt, |s| {
    s.read_message_count = Some(2.0);
    s.message_count = 4.0;
});
#[tokio::test]
async fn the_approval_grace_is_a_day_so_it_cannot_outlast_the_shortest_archive_window() {
    // Node's grace (`now - activity < 1 day`) only matters under an archive window shorter than a day; the shortest offered is
    // one day, so a session idle that long and waiting on the user is archived, as in Node.
    let waiting = Session { awaiting_approval: true, ..session("a", 1.0) };
    let one_day = Policy { archive_days: 1, delete_days: 0 };
    assert_eq!(verdict_with(&Fake::with(vec![]), &waiting, &record(), one_day).await, Some(Action::Archive));
}

#[tokio::test]
async fn a_read_cursor_at_the_end_or_none_at_all_is_not_unread() {
    let waiting = Session { awaiting_approval: true, ..session("a", 9.0) };
    assert_eq!(verdict(&waiting).await, Some(Action::Archive));
    // Read up to the last message, or a tail of messages already read: nothing unread.
    let read = Session { read_message_count: Some(4.0), incoming_tail: Some(vec![3.0, 4.0]), ..session("a", 9.0) };
    assert_eq!(verdict(&read).await, Some(Action::Archive));
    let seen = Session { read_message_count: Some(2.0), incoming_tail: Some(vec![1.0, 2.0]), ..session("a", 9.0) };
    assert_eq!(verdict(&seen).await, Some(Action::Archive));
    // Never read on any surface: reads as seen.
    assert_eq!(verdict(&Session { read_message_count: None, ..session("a", 9.0) }).await, Some(Action::Archive));
}

#[tokio::test]
async fn background_jobs_and_a_live_sub_session_exempt_from_the_archive() {
    let host = Fake::with(vec![]);
    let s = session("a", 30.0);
    assert_eq!(verdict_with(&host, &s, &record(), POLICY).await, Some(Action::Archive));
    host.state().background.insert("a".into());
    assert_eq!(verdict_with(&host, &s, &record(), POLICY).await, None);
    host.state().background.clear();
    host.state().live_sub.insert("a".into());
    assert_eq!(verdict_with(&host, &s, &record(), POLICY).await, None);
}

#[tokio::test]
async fn a_restored_session_is_spared_until_it_is_used_again() {
    let mut record = record();
    let host = Fake::with(vec![]);
    let s = session("a", 30.0);
    // Restored after its last use: kept out, however old.
    record.restored.insert("a".into(), NOW - days(1.0));
    assert_eq!(verdict_with(&host, &s, &record, POLICY).await, None);
    // Used again after the restore, and idle past the window since: it ages from that use like any other.
    // (Its last use was 30 days ago, so a restore 40 days ago is before it.)
    record.restored.insert("a".into(), NOW - days(40.0));
    assert_eq!(verdict_with(&host, &s, &record, POLICY).await, Some(Action::Archive));
    // Used again but not yet old enough.
    assert_eq!(verdict_with(&host, &session("a", 3.0), &record, POLICY).await, None);
}

fn archived(id: &str) -> Session {
    Session { archived: true, ..session(id, 90.0) }
}

#[tokio::test]
async fn an_archived_session_is_deleted_once_its_archive_is_old_enough() {
    let host = Fake::with(vec![]);
    let s = archived("a");
    // No stamp: the archive's age is unknown, nothing is deleted.
    assert_eq!(verdict_with(&host, &s, &record(), POLICY).await, None);
    host.state().stamps.insert("a".into(), NOW - days(29.9));
    assert_eq!(verdict_with(&host, &s, &record(), POLICY).await, None);
    host.state().stamps.insert("a".into(), NOW - days(30.0));
    assert_eq!(verdict_with(&host, &s, &record(), POLICY).await, Some(Action::Delete));
    // The delete window runs from the archive, not from the last activity: a long-idle session archived today is kept.
    host.state().stamps.insert("a".into(), NOW);
    assert_eq!(verdict_with(&host, &s, &record(), POLICY).await, None);
}

#[tokio::test]
async fn an_archive_from_before_the_feature_counts_from_its_start() {
    let host = Fake::with(vec![]);
    let s = archived("a");
    host.state().stamps.insert("a".into(), NOW - days(100.0));
    // The feature first ran 5 days ago: the archive is aged from then.
    let recent = RetentionRecord { enabled_at: NOW - days(5.0), restored: HashMap::new() };
    assert_eq!(verdict_with(&host, &s, &recent, POLICY).await, None);
    let started = RetentionRecord { enabled_at: NOW - days(30.0), restored: HashMap::new() };
    assert_eq!(verdict_with(&host, &s, &started, POLICY).await, Some(Action::Delete));
}

#[tokio::test]
async fn the_delete_step_off_deletes_nothing_and_the_archive_step_off_archives_nothing() {
    let host = Fake::with(vec![]);
    host.state().stamps.insert("a".into(), NOW - days(100.0));
    let off_delete = Policy { archive_days: 7, delete_days: 0 };
    assert_eq!(verdict_with(&host, &archived("a"), &record(), off_delete).await, None);
    let off_archive = Policy { archive_days: 0, delete_days: 30 };
    assert_eq!(verdict_with(&host, &session("b", 99.0), &record(), off_archive).await, None);
    assert_eq!(verdict_with(&host, &archived("a"), &record(), off_archive).await, Some(Action::Delete));
}

#[tokio::test]
async fn a_favorite_busy_or_jobbed_archived_session_is_not_deleted() {
    let host = Fake::with(vec![]);
    host.state().stamps.insert("a".into(), NOW - days(100.0));
    assert_eq!(verdict_with(&host, &archived("a"), &record(), POLICY).await, Some(Action::Delete));
    assert_eq!(verdict_with(&host, &Session { favorite: true, ..archived("a") }, &record(), POLICY).await, None);
    assert_eq!(verdict_with(&host, &Session { visible: true, ..archived("a") }, &record(), POLICY).await, None);
    host.state().background.insert("a".into());
    assert_eq!(verdict_with(&host, &archived("a"), &record(), POLICY).await, None);
}

#[tokio::test]
async fn the_plan_orders_oldest_first_and_a_pass_archives_before_it_deletes() {
    let host = Fake::with(vec![session("new", 8.0), session("old", 40.0), session("mid", 20.0), archived("gone")]);
    host.state().stamps.insert("gone".into(), NOW - days(31.0));
    let report = pass(&host).await.unwrap();
    assert_eq!(host.state().archived, ["old", "mid", "new"]);
    assert_eq!(report.archived, ["old", "mid", "new"]);
    assert_eq!(report.deleted, ["gone"]);
    // Nothing archived in this pass is deleted in it: its stamp is today's.
    assert!(host.state().sessions.iter().any(|s| s.id == "old"));
    assert_eq!(host.state().logs, ["[mixdog-session] auto-retention: archived 3, deleted 1, kept 0, refused 0"]);
}

#[tokio::test]
async fn a_pass_reads_the_setting_afresh_and_a_turned_off_policy_does_nothing() {
    let host = Fake::with(vec![session("a", 40.0), session("b", 40.0)]);
    host.state().policy = Some(Policy { archive_days: 0, delete_days: 0 });
    assert_eq!(pass(&host).await, None);
    // An invalid stored value: the pass does nothing rather than act on a guess.
    host.state().policy = None;
    assert_eq!(pass(&host).await, None);
    // Changed in Settings between passes: applies to the next one.
    host.state().policy = Some(Policy { archive_days: 7, delete_days: 0 });
    assert_eq!(pass(&host).await.unwrap().archived.len(), 2);
    // Delete turned on afterwards: the sessions archived above (stamped today) are not due, an older archive is.
    host.state().stamps.insert("b".into(), NOW - days(31.0));
    host.state().policy = Some(Policy { archive_days: 7, delete_days: 30 });
    let report = pass(&host).await.unwrap();
    assert_eq!(report.deleted, ["b"]);
    assert!(host.state().sessions.iter().any(|s| s.id == "a"));
}

#[tokio::test]
async fn one_pass_acts_on_everything_due_with_no_cap() {
    let sessions: Vec<Session> = (0..120).map(|n| session(&format!("s{n:03}"), 40.0 - f64::from(n) * 0.1)).collect();
    let host = Fake::with(sessions);
    let report = pass(&host).await.unwrap();
    assert_eq!(report.archived.len(), 120);
    assert_eq!(host.state().archived.len(), 120);
    assert_eq!(host.state().listings, 1);
}

#[tokio::test]
async fn a_session_kept_for_its_worktree_is_kept_and_the_rest_are_deleted() {
    let host = Fake::with(vec![archived("held"), archived("other")]);
    host.state().stamps.insert("held".into(), NOW - days(60.0));
    host.state().stamps.insert("other".into(), NOW - days(50.0));
    host.state().worktree.insert("held".into());
    let report = pass(&host).await.unwrap();
    assert_eq!(report.kept_for_worktree, ["held"]);
    assert_eq!(report.deleted, ["other"]);
    assert!(host.state().sessions.iter().any(|s| s.id == "held"), "a worktree with work keeps its session");
    assert_eq!(host.state().logs, ["[mixdog-session] auto-retention: archived 0, deleted 1, kept 1, refused 0"]);
}

#[tokio::test]
async fn a_delete_the_core_refuses_leaves_the_session_intact() {
    let host = Fake::with(vec![archived("a"), archived("b")]);
    for id in ["a", "b"] {
        host.state().stamps.insert(id.into(), NOW - days(60.0));
    }
    host.state().refusals.insert("a".into(), "busy".into());
    let report = pass(&host).await.unwrap();
    assert_eq!(report.refused, ["a"]);
    assert_eq!(report.deleted, ["b"]);
    let state = host.state();
    assert!(state.sessions.iter().any(|s| s.id == "a" && s.archived), "still there, still archived");
    assert!(state.archived.is_empty(), "a refused delete archives nothing");
    // The core was asked with the activity the pass read.
    assert!(state.deleted_asked.iter().any(|(id, at)| id == "a" && *at == NOW - days(90.0)));
    assert_eq!(state.logs, ["[mixdog-session] auto-retention: archived 0, deleted 1, kept 0, refused 1"]);
}

/// Planned from the listing, but its fresh read shows it on screen.
struct Opens(Fake);

#[async_trait]
impl AutoRetentionHost for Opens {
    fn policy(&self) -> Option<Policy> {
        self.0.policy()
    }
    fn identity(&self) -> Arc<PolicyIdentity> {
        self.0.identity()
    }
    async fn record(&self) -> Result<RetentionRecord, String> {
        self.0.record().await
    }
    async fn sessions(&self) -> Result<Vec<Session>, String> {
        self.0.sessions().await
    }
    async fn session(&self, id: &str) -> Result<Option<Session>, String> {
        Ok(self.0.session(id).await?.map(|s| Session { visible: true, ..s }))
    }
    async fn archived_stamp(&self, id: &str) -> Result<Option<f64>, String> {
        self.0.archived_stamp(id).await
    }
    async fn background_jobs(&self, id: &str) -> Result<bool, String> {
        self.0.background_jobs(id).await
    }
    async fn sub_sessions(&self, id: &str, now: f64, window: f64, fresh: bool) -> Result<Option<Vec<(String, f64)>>, String> {
        self.0.sub_sessions(id, now, window, fresh).await
    }
    async fn archive_tree(&self, id: &str, now: f64, policy: Policy, admit: Admit) -> Result<TreeOutcome, String> {
        self.0.archive_tree(id, now, policy, admit).await
    }
    async fn delete_if_idle(&self, id: &str, last_used_at: f64, activity: f64, cancel: &CancellationToken) -> Result<IdleDelete, String> {
        self.0.delete_if_idle(id, last_used_at, activity, cancel).await
    }
    async fn worktree_work(&self, id: &str) -> Result<bool, String> {
        self.0.worktree_work(id).await
    }
    fn log(&self, line: &str) {
        self.0.log(line);
    }
}

#[tokio::test]
async fn a_session_that_became_exempt_before_it_was_acted_on_is_left_alone() {
    let host = Opens(Fake::with(vec![session("a", 40.0)]));
    let clock = || NOW;
    let report = run_pass(&host, &clock, &CancellationToken::new(), &Arc::default()).await.unwrap().unwrap();
    assert_eq!(report.skipped, ["a"]);
    assert!(host.0.state().archived.is_empty());
}

#[tokio::test]
async fn a_stopped_pass_acts_on_nothing_further() {
    let host = Fake::with(vec![session("a", 40.0)]);
    let clock = || NOW;
    let stopped = CancellationToken::new();
    stopped.cancel();
    let report = run_pass(&host, &clock, &stopped, &Arc::default()).await.unwrap().unwrap();
    assert_eq!(report.archived.len() + report.deleted.len(), 0);
    assert!(host.state().archived.is_empty());
}

// ---- the cycle ----------------------------------------------------------------------------------------------------------

async fn until(what: &str, mut ready: impl FnMut() -> bool) {
    for _ in 0..1000 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting for {what}");
}

fn clock() -> Arc<dyn Fn() -> f64 + Send + Sync> {
    // `start` spawns on the runtime's lanes, which a test process installs first.
    mixdog_rt::testing::tokens();
    Arc::new(|| NOW)
}

fn changed(tx: &tokio::sync::watch::Sender<u64>) {
    tx.send_modify(|revision| *revision += 1);
}

#[tokio::test]
async fn the_cycle_runs_one_complete_pass_at_start_and_none_after_it() {
    let host = Arc::new(Fake::with((0..120).map(|n| session(&format!("s{n:03}"), 40.0)).collect()));
    let (tx, rx) = tokio::sync::watch::channel(0u64);
    let stop = CancellationToken::new();
    let task = start(host.clone(), clock(), stop.clone(), Arc::default(), rx);
    until("the pass at start", || host.state().archived.len() == 120).await;
    // A config write that leaves the options alone starts nothing.
    changed(&tx);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(host.state().listings, 1, "one pass in all");
    stop.cancel();
    task.await.unwrap();
}

#[tokio::test]
async fn changing_an_option_runs_a_pass_with_the_new_value() {
    let host = Arc::new(Fake::with(vec![session("a", 10.0), session("b", 40.0)]));
    host.state().policy = Some(Policy { archive_days: 30, delete_days: 0 });
    let (tx, rx) = tokio::sync::watch::channel(0u64);
    let stop = CancellationToken::new();
    let task = start(host.clone(), clock(), stop.clone(), Arc::default(), rx);
    until("the pass at start", || host.state().archived == ["b"]).await;
    // 30 days archived only the 40-day-old one; 7 days takes the 10-day-old one too.
    host.state().policy = Some(Policy { archive_days: 7, delete_days: 0 });
    changed(&tx);
    until("the pass with the new value", || host.state().archived == ["b", "a"]).await;
    assert_eq!(host.state().listings, 2);
    stop.cancel();
    task.await.unwrap();
}

#[tokio::test]
async fn a_change_during_a_pass_supersedes_it_and_two_never_run_together() {
    let host = Arc::new(Fake::with(vec![session("a", 40.0), session("b", 30.0), session("c", 20.0)]));
    host.state().hold = true;
    let (tx, rx) = tokio::sync::watch::channel(0u64);
    let stop = CancellationToken::new();
    let task = start(host.clone(), clock(), stop.clone(), Arc::default(), rx);
    until("the first archive to begin", || host.state().entered == 1).await;
    // Delete turned on while the first pass is inside its first archive.
    host.state().policy = Some(Policy { archive_days: 7, delete_days: 90 });
    changed(&tx);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(host.state().entered, 1, "the superseding pass waits for the one under way");
    host.state().hold = false;
    host.state().gate.notify_one();
    until("the new pass to finish", || host.state().archived.len() == 3).await;
    let state = host.state();
    assert_eq!(state.archived, ["a", "b", "c"], "each archived once, in order");
    assert_eq!(state.listings, 2, "the superseded pass and the one that replaced it");
    assert_eq!(state.max_active, 1, "never two at once");
    drop(state);
    stop.cancel();
    task.await.unwrap();
}

/// A stop that comes before the archive under way is admitted admits nothing, and no other archive starts.
#[tokio::test]
async fn shutdown_mid_pass_admits_nothing_further() {
    let host = Arc::new(Fake::with(vec![session("a", 40.0), session("b", 30.0), session("c", 20.0)]));
    host.state().hold = true;
    let (_tx, rx) = tokio::sync::watch::channel(0u64);
    let stop = CancellationToken::new();
    let task = start(host.clone(), clock(), stop.clone(), Arc::default(), rx);
    until("the first archive to begin", || host.state().entered == 1).await;
    stop.cancel();
    host.state().hold = false;
    host.state().gate.notify_one();
    tokio::time::timeout(Duration::from_secs(5), task).await.expect("the task ends").unwrap();
    assert!(host.state().archived.is_empty(), "the archive not yet admitted commits nothing");
    assert_eq!(host.state().entered, 1, "no other archive starts");
}

// ---- admission: what is judged is what the owner of each fact admits --------------------------------------------------------

/// Drives one pass on a task, so the test can act while it waits inside a read.
fn spawn_pass(host: &Arc<Fake>, cancel: &CancellationToken) -> tokio::task::JoinHandle<Option<Report>> {
    let (host, cancel) = (host.clone(), cancel.clone());
    tokio::spawn(async move {
        let clock = || NOW;
        run_pass(&*host, &clock, &cancel, &Arc::default()).await.unwrap()
    })
}

fn due_for_delete() -> Arc<Fake> {
    let host = Arc::new(Fake::with(vec![archived("a")]));
    host.state().stamps.insert("a".into(), NOW - days(60.0));
    host.state().wt_hold = true;
    host
}

#[tokio::test]
async fn the_delete_option_turned_off_while_the_worktree_check_is_pending_deletes_nothing() {
    let host = due_for_delete();
    let task = spawn_pass(&host, &CancellationToken::new());
    until("the worktree check to begin", || host.state().wt_entered == 1).await;
    // Settings changed: the policy read now has the delete step off (the cancel of the cycle may not have fired yet).
    host.state().policy = Some(Policy { archive_days: 7, delete_days: 0 });
    host.state().wt_gate.notify_one();
    let report = task.await.unwrap().unwrap();
    assert!(host.state().deleted_asked.is_empty(), "the core was never asked to delete");
    assert!(report.deleted.is_empty());
    assert!(host.state().sessions.iter().any(|s| s.id == "a"));
}

#[tokio::test]
async fn shutdown_while_the_worktree_check_is_pending_deletes_nothing() {
    let host = due_for_delete();
    let stop = CancellationToken::new();
    let task = spawn_pass(&host, &stop);
    until("the worktree check to begin", || host.state().wt_entered == 1).await;
    stop.cancel();
    // The read in progress runs to its end (it releases what it opened); nothing is acted on after it.
    host.state().wt_gate.notify_one();
    let report = tokio::time::timeout(Duration::from_secs(5), task).await.expect("the pass ends").unwrap().unwrap();
    assert!(host.state().deleted_asked.is_empty());
    assert!(report.deleted.is_empty());
    assert!(host.state().sessions.iter().any(|s| s.id == "a"));
}

#[tokio::test]
async fn a_child_that_completed_a_turn_just_before_the_final_judgment_keeps_parent_and_child() {
    let host = Fake::with(vec![session("parent", 40.0)]);
    host.state().children.insert("parent".into(), vec![("child".into(), NOW - days(40.0))]);
    // The listing (the plan) saw the child idle; the final judgment reads it afresh, and it has just completed a turn.
    host.state().live_sub_fresh.insert("parent".into());
    let report = pass(&host).await.unwrap();
    assert_eq!(report.skipped, ["parent"]);
    assert!(host.state().archived.is_empty(), "neither the parent nor its child is archived");
}

#[tokio::test]
async fn an_archive_is_asked_for_under_the_policy_its_judgment_read() {
    let host = Fake::with(vec![session("parent", 40.0)]);
    host.state().children.insert("parent".into(), vec![("child".into(), 222.0)]);
    pass(&host).await.unwrap();
    assert_eq!(host.state().trees, [("parent".to_owned(), POLICY)]);
}

/// The policy identity moved after the judgment (an install of a changed policy): the archive is not admitted, the pass skips it.
#[tokio::test]
async fn an_archive_judged_under_a_policy_identity_that_moved_is_skipped() {
    let host = Fake::with(vec![session("a", 40.0)]);
    host.state().hold = true;
    let host = Arc::new(host);
    let task = spawn_pass(&host, &CancellationToken::new());
    until("the archive to begin", || host.state().entered == 1).await;
    host.state().identity.moved();
    host.state().hold = false;
    host.state().gate.notify_one();
    let report = task.await.unwrap().unwrap();
    assert_eq!(report.skipped, ["a"]);
    assert!(host.state().archived.is_empty());
}

#[tokio::test]
async fn an_archive_the_actor_refuses_is_counted_refused_and_changes_nothing() {
    let host = Fake::with(vec![session("a", 40.0), session("b", 30.0)]);
    host.state().archive_refusals.insert("a".into(), "attached".into());
    let report = pass(&host).await.unwrap();
    assert_eq!(report.refused, ["a"]);
    assert_eq!(report.archived, ["b"]);
    assert!(host.state().sessions.iter().any(|s| s.id == "a" && !s.archived));
}