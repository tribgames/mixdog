//! A session the product's retention deletes is settled `expired` behind a serving core and removed unconverted
//! ([`Retention`]). The rule here is a stand-in that deletes a session idle a week; the product's own is tested with it.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixtures build and inspect data dirs with blocking std::fs")]

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use serde_json::Map;
use serde_json::Value;

use super::tests::drivers;
use super::tests::journal_records;
use super::tests::write;
use super::*;

const DAY: u64 = 24 * 60 * 60 * 1000;
const NOW: u64 = 1_800_000_000_000;
const OLD: u64 = NOW - 8 * DAY;

#[derive(Default)]
struct Week {
    now: AtomicU64,
    /// Opens that arrive while the judgement reads the sessions: the sessions asked for, and what tells of each opener told.
    opening: Mutex<Option<(Arc<Waiting>, Vec<&'static str>, Arc<Mutex<Vec<String>>>)>>,
    /// Opens that arrive while the verdict is given, and while the expired sessions' rows are withdrawn.
    in_verdict: Mutex<Option<Opens>>,
    in_cleanup: Mutex<Option<Opens>>,
    /// The header each session was judged by.
    seen: Mutex<BTreeMap<String, Map<String, Value>>>,
    judged_at: Mutex<Vec<u64>>,
    unlisted: Mutex<Vec<String>>,
    purged: Mutex<Vec<String>>,
}

/// Sessions opened from inside one of the retention's own steps, which then does not return before the openers of
/// `served` were told: an opener that waits for the step is never told.
struct Opens {
    waiting: Arc<Waiting>,
    open: Vec<&'static str>,
    served: Vec<&'static str>,
    told: Arc<(Mutex<Vec<String>>, std::sync::Condvar)>,
}

impl Opens {
    fn arrive(self, step: &str) {
        for session in self.open {
            let told = self.told.clone();
            let then = Box::new(move || {
                told.0.lock().unwrap().push(session.to_owned());
                told.1.notify_all();
            });
            assert!(self.waiting.first(session, then), "{session} is still to convert");
        }
        let all = |told: &mut Vec<String>| !self.served.iter().all(|session| told.iter().any(|told| told == session));
        let (told, timeout) = self.told.1.wait_timeout_while(self.told.0.lock().unwrap(), std::time::Duration::from_secs(60), all).unwrap();
        assert!(!timeout.timed_out(), "{:?} waited for {step}: only {told:?} were told", self.served);
    }
}

impl Week {
    fn at(now: u64) -> Arc<Self> {
        Arc::new(Self { now: AtomicU64::new(now), ..Self::default() })
    }
}

impl Retention for Week {
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }

    fn fields(&self) -> Vec<String> {
        if let Some((waiting, sessions, told)) = self.opening.lock().unwrap().take() {
            for session in sessions {
                let told = told.clone();
                assert!(waiting.first(session, Box::new(move || told.lock().unwrap().push(session.to_owned()))), "{session} is still to convert");
            }
        }
        vec!["lastUsedAt".to_owned(), "worker".to_owned()]
    }

    fn candidate(&self, session: &str, _header: &Map<String, Value>) -> bool {
        !session.starts_with("sess_ordinary")
    }

    fn expired(&self, sessions: &BTreeMap<String, Map<String, Value>>, held: &BTreeSet<String>, now_ms: u64) -> BTreeSet<String> {
        self.judged_at.lock().unwrap().push(now_ms);
        *self.seen.lock().unwrap() = sessions.clone();
        if let Some(opens) = self.in_verdict.lock().unwrap().take() {
            opens.arrive("the verdict");
        }
        // As the product: a worker the worker index holds anything of is stored with it.
        let indexed = |header: &Map<String, Value>| header.contains_key("worker");
        let idle = |header: &Map<String, Value>| header.get("lastUsedAt").and_then(Value::as_u64).is_some_and(|at| at + 7 * DAY <= now_ms);
        sessions.iter().filter(|(id, header)| !held.contains(*id) && idle(header) && !indexed(header)).map(|(id, _)| id.clone()).collect()
    }

    fn unlisted(&self, sessions: &[String]) {
        self.unlisted.lock().unwrap().extend(sessions.iter().cloned());
        if let Some(opens) = self.in_cleanup.lock().unwrap().take() {
            opens.arrive("the withdrawal of the expired sessions' rows");
        }
    }

    fn purge(&self, session: &str, _header: &Map<String, Value>) -> std::result::Result<(), String> {
        self.purged.lock().unwrap().push(session.to_owned());
        Ok(())
    }
}

fn session(data: &Path, id: &str, last_used: u64, more: &str) {
    let body =
        format!(r#"{{"id":"{id}","lastUsedAt":{last_used}{more},"messages":[{{"role":"user","content":"hi"}},{{"role":"assistant","content":"yes"}}]}}"#);
    write(data, &format!("sessions/{id}.json"), body.as_bytes());
}

fn roots(base: &Path) -> MigrationRoots {
    let data = base.join("data");
    std::fs::create_dir_all(&data).unwrap();
    MigrationRoots { data, home: base.join("home"), profile: None }
}

fn serving(roots: &MigrationRoots, retention: Option<Arc<Week>>, fault: Option<FaultHook>) -> Migrator {
    let retention = retention.map(|week| week as Arc<dyn Retention>);
    Migrator::new(roots.clone(), drivers(), MigrateOptions { workers: 1, fault, verified: Some(Arc::new(|_| {})), retention })
}

/// The sessions journaled `expired`, each with the time it was judged at.
fn expired(roots: &MigrationRoots) -> BTreeMap<String, u64> {
    journal_records(roots)
        .into_iter()
        .filter_map(|record| match record {
            JournalRecord::Expired(entry) => Some((entry.key.as_str().to_owned(), entry.judged_at)),
            _ => None,
        })
        .collect()
}

/// An expired session with nothing but its own files is removed unconverted, purged and counted in its own bucket; one
/// that a goal, a connector conversation or a worktree names, that holds unread output or a queued message, or whose tool
/// results another session may name, converts like a young one.
#[test]
fn an_expired_session_is_removed_unconverted_unless_something_else_is_bound_to_it() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots(dir.path());
    let data = &roots.data;
    let bound = ["sess_goal", "sess_conv", "sess_tree", "sess_unread", "sess_queue", "sess_tools"];
    session(data, "sess_plain", OLD, "");
    session(data, "sess_young", NOW - DAY, "");
    for id in bound {
        session(data, id, OLD, if id == "sess_unread" { r#","readState":{"messageCount":1,"revision":1}"# } else { "" });
    }
    write(data, "goals/sess_goal.json", br#"{"sessionId":"sess_goal"}"#);
    write(data, "connector-accounts-by-conversation.json", br#"{"sess_conv":{"notion":"notion"}}"#);
    write(data, "worktrees-v1/registry.json", br#"{"version":1,"worktrees":[{"ownerSessionId":"sess_tree"}]}"#);
    write(data, "session-pending/sess_queue.json", br#"{"version":1,"sessions":{"sess_queue":[{"id":"q1","message":"m","enqueuedAt":5}]}}"#);
    write(data, "tool-results/sess_tools/1.txt", b"offloaded");
    let week = Week::at(NOW);

    let complete = serving(&roots, Some(week.clone()), None).run().unwrap();

    assert_eq!(expired(&roots), BTreeMap::from([("session/sess_plain".to_owned(), NOW)]));
    assert_eq!(complete.kinds.data.expired, 1);
    assert!(!data.join("sessions/sess_plain.json").exists(), "the expired session's source is removed");
    assert!(!data.join("sessions/sess_plain").exists(), "the expired session is not converted");
    assert_eq!(*week.purged.lock().unwrap(), ["sess_plain"]);
    assert_eq!(*week.unlisted.lock().unwrap(), ["sess_plain"]);
    for id in bound.into_iter().chain(["sess_young"]) {
        assert!(data.join("sessions").join(id).is_dir(), "{id} converts");
    }
    assert!(data.join("tool-results/sess_tools/1.txt").exists());
}

/// A connector or worktree store that does not parse is set aside and names no session: the judgement reads neither, in
/// the run that sets them aside nor in one resumed after they were moved, and the sessions convert.
#[test]
fn a_store_set_aside_names_no_session_and_does_not_stop_the_judgement() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots(dir.path());
    let data = &roots.data;
    session(data, "sess_young", NOW - DAY, "");
    write(data, "connector-accounts-by-conversation.json", b"{broken");
    write(data, "worktrees-v1/registry.json", b"{broken");
    let week = Week::at(NOW);
    let cut = format!("journal:disposed:{}:after", crate::stores::store_key(ItemKind::Worktrees));
    let fault: FaultHook = {
        let cut = cut.clone();
        Arc::new(move |point| if point == cut { Err(Blocked::Interrupted { point: cut.clone() }) } else { Ok(()) })
    };
    assert_eq!(serving(&roots, Some(week.clone()), Some(fault)).run().unwrap_err(), Blocked::Interrupted { point: cut });
    assert!(!data.join("worktrees-v1/registry.json").exists(), "the store was moved aside");

    serving(&roots, Some(week), None).run().unwrap();

    for kind in [ItemKind::ConnectorAccounts, ItemKind::Worktrees] {
        let key = crate::stores::store_key(kind);
        assert!(quarantine_dir(data, QuarantineCode::ParseError, &key).join(REASON_FILE).exists(), "{key}");
    }
    assert!(data.join("sessions/sess_young").is_dir());
}

/// Whether a published file of `sessions/<id>/` holds `text`.
fn published_holds(roots: &MigrationRoots, id: &str, text: &str) -> bool {
    let dir = roots.data.join("sessions").join(id);
    durable::walk_files(&dir).unwrap().into_iter().any(|rel| std::fs::read(dir.join(rel)).unwrap().windows(text.len()).any(|window| window == text.as_bytes()))
}

/// The verdict is given the worker row a session's conversion would install. An old worker the worker index holds a row
/// of is kept by it, so the session converts and its row is stored with it; an old worker the index holds nothing of is
/// removed.
#[test]
fn an_old_worker_with_a_row_in_the_worker_index_converts_with_its_row() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots(dir.path());
    let worker = r#","agent":"worker","ownerSessionId":"sess_lead","parentSessionId":"sess_lead""#;
    session(&roots.data, "sess_lead", NOW - DAY, r#","agent":"lead""#);
    session(&roots.data, "sess_owed", OLD, worker);
    session(&roots.data, "sess_done", OLD, worker);
    session(&roots.data, "sess_gone", OLD, worker);
    write(
        &roots.data,
        "agent-workers.json",
        br#"{"version":2,"workers":{"sess_owed":{"sessionId":"sess_owed","ownerSessionId":"sess_lead","tag":"a","status":"failed","failureReason":"process-restart","messages":[]},"sess_done":{"sessionId":"sess_done","ownerSessionId":"sess_lead","tag":"b","status":"idle","messages":[]}},"tombstones":{}}"#,
    );
    let week = Week::at(NOW);

    serving(&roots, Some(week.clone()), None).run().unwrap();

    let seen = week.seen.lock().unwrap().clone();
    assert_eq!(seen["sess_owed"]["worker"]["failureReason"], "process-restart", "{:?}", seen["sess_owed"]);
    assert_eq!(seen["sess_done"]["worker"]["status"], "idle");
    assert!(!seen["sess_gone"].contains_key("worker"), "{:?}", seen["sess_gone"]);
    assert_eq!(expired(&roots).keys().collect::<Vec<_>>(), ["session/sess_gone"]);
    assert!(published_holds(&roots, "sess_owed", "process-restart"), "the owed row is stored with its session");
    assert!(roots.data.join("sessions/sess_done").is_dir(), "the settled row is stored with its session");
}

/// The map the verdict reads is the one the conversion installs, however the worker index names the session. An old
/// worker with no row, whose tombstone of a day ago names neither a session nor an owner, is that tombstone's one owner
/// by its tag, its host and its creation: the verdict is given the tombstone with the owner recovered, so the session
/// converts and the tombstone is stored with it.
#[test]
fn an_old_worker_a_tombstone_reaches_by_its_tag_alone_converts_with_that_tombstone() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots(dir.path());
    session(&roots.data, "sess_reaped", OLD, r#","agent":"worker","agentTag":"w","clientHostPid":42,"parentSessionId":"sess_lead","createdAt":1000"#);
    session(&roots.data, "sess_plain", OLD, r#","agent":"worker","parentSessionId":"sess_lead","createdAt":1000"#);
    // `NOW` less a day.
    write(
        &roots.data,
        "agent-workers.json",
        br#"{"version":2,"workers":{},"tombstones":[{"tag":"w","clientHostPid":42,"reapedAt":"2027-01-14T08:00:00.000Z"}]}"#,
    );
    let week = Week::at(NOW);

    serving(&roots, Some(week.clone()), None).run().unwrap();

    let seen = week.seen.lock().unwrap().clone();
    assert_eq!(
        seen["sess_reaped"].get("worker"),
        Some(
            &serde_json::json!({ "tombstone": { "tag": "w", "clientHostPid": 42, "reapedAt": "2027-01-14T08:00:00.000Z", "parentSessionId": "sess_lead", "ownerSessionId": "sess_lead" } })
        ),
        "{:?}",
        seen["sess_reaped"]
    );
    assert_eq!(expired(&roots).keys().collect::<Vec<_>>(), ["session/sess_plain"]);
    assert!(published_holds(&roots, "sess_reaped", "2027-01-14T08:00:00.000Z"), "the tombstone is stored with its session");
}

/// Once every session is read, the converters serve the opens while the verdict is given, journaled, and the expired
/// sessions' rows are withdrawn. An ordinary session opened inside the verdict is converted before the verdict returns,
/// and one opened inside the withdrawal before that returns. A candidate opened inside the verdict is seen by a verdict
/// given again, which keeps it, and is converted once the judgement is closed, before the withdrawal returns.
#[test]
fn an_open_after_the_sessions_are_read_waits_for_neither_the_verdict_nor_the_withdrawal_of_the_rows() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots(dir.path());
    session(&roots.data, "sess_old1", OLD, "");
    session(&roots.data, "sess_old2", OLD, "");
    session(&roots.data, "sess_ordinary1", NOW - DAY, "");
    session(&roots.data, "sess_ordinary2", NOW - DAY, "");
    let week = Week::at(NOW);
    let told: Arc<(Mutex<Vec<String>>, std::sync::Condvar)> = Arc::default();
    let Front::Pending(back) = serving(&roots, Some(week.clone()), None).front().unwrap() else { panic!("the sessions are left") };
    let opens = |open: Vec<&'static str>, served: Vec<&'static str>| Some(Opens { waiting: back.waiting(), open, served, told: told.clone() });
    *week.in_verdict.lock().unwrap() = opens(vec!["sess_ordinary1", "sess_old1"], vec!["sess_ordinary1"]);
    *week.in_cleanup.lock().unwrap() = opens(vec!["sess_ordinary2"], vec!["sess_ordinary2", "sess_old1"]);

    back.run().unwrap();

    assert_eq!(*week.judged_at.lock().unwrap(), [NOW, NOW], "the candidate asked for inside the verdict is seen by a second one");
    assert_eq!(expired(&roots).keys().collect::<Vec<_>>(), ["session/sess_old2"]);
    assert_eq!(told.0.lock().unwrap()[0], "sess_ordinary1");
    for id in ["sess_old1", "sess_ordinary1", "sess_ordinary2"] {
        assert!(roots.data.join("sessions").join(id).is_dir(), "{id} converts");
    }
}

/// A parent that carries the only readable result of a child reaped with no session of its own converts, however old it
/// is, and publishes that result.
#[test]
fn an_old_parent_that_carries_a_reaped_childs_result_converts() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots(dir.path());
    let notice = "Async agent task t (completed) finished.\n\nResult:\nsurface: agent\nsessionId: sess_done\nstatus: completed\n\nthe body";
    let parent = serde_json::json!({"id":"sess_p","lastUsedAt":OLD,"messages":[{"role":"user","content":"start"},{"role":"user","content":notice}]});
    write(&roots.data, "sessions/sess_p.json", parent.to_string().as_bytes());
    session(&roots.data, "sess_plain", OLD, "");
    write(
        &roots.data,
        "agent-workers.json",
        serde_json::json!({"version":2,"workers":{"sess_done":{"sessionId":"sess_done","parentSessionId":"sess_p","tag":"t","status":"running"}},"tombstones":[]})
            .to_string()
            .as_bytes(),
    );
    let week = Week::at(NOW);

    serving(&roots, Some(week), None).run().unwrap();

    assert_eq!(expired(&roots).keys().collect::<Vec<_>>(), ["session/sess_plain"]);
    assert!(published_holds(&roots, "sess_p", crate::session::archived::HEADER_KEY), "the child's result is published with its parent");
}

/// An open that arrives while the judgement is being made is seen by the verdict: the session converts and its opener is
/// told, while the session nobody asked for is removed. An ordinary session opened then, which no verdict can delete,
/// does not wait for the judgement: it is converted, and its opener told, before the judgement is closed.
#[test]
fn a_session_opened_during_the_judgement_converts_and_an_ordinary_one_does_not_wait_for_it() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots(dir.path());
    session(&roots.data, "sess_old1", OLD, "");
    session(&roots.data, "sess_old2", OLD, "");
    session(&roots.data, "sess_ordinary", NOW - DAY, "");
    let week = Week::at(NOW);
    // What was told and journaled when the judgement closes.
    let at_close: Arc<Mutex<Option<(Vec<String>, bool)>>> = Arc::default();
    let told: Arc<Mutex<Vec<String>>> = Arc::default();
    let fault: FaultHook = {
        let (at_close, told, data) = (at_close.clone(), told.clone(), roots.data.clone());
        Arc::new(move |point| {
            if point == "journal:judged:before" {
                *at_close.lock().unwrap() = Some((told.lock().unwrap().clone(), data.join("sessions/sess_ordinary").is_dir()));
            }
            Ok(())
        })
    };
    let Front::Pending(back) = serving(&roots, Some(week.clone()), Some(fault)).front().unwrap() else { panic!("the sessions are left") };
    *week.opening.lock().unwrap() = Some((back.waiting(), vec!["sess_ordinary", "sess_old1"], told.clone()));

    back.run().unwrap();

    assert_eq!(*at_close.lock().unwrap(), Some((vec!["sess_ordinary".to_owned()], true)), "the ordinary session did not wait; the candidate did");
    assert_eq!(expired(&roots).keys().collect::<Vec<_>>(), ["session/sess_old2"]);
    assert!(roots.data.join("sessions/sess_old1").is_dir(), "the session asked for is converted");
    assert_eq!(*told.lock().unwrap(), ["sess_ordinary", "sess_old1"]);
}

/// The judgement is journaled with its time when it is made, whatever the verdicts. A first run that expires nothing and
/// is cut inside the stage of a session idle six and a half days is resumed a day later: the judgement stands, the
/// session converts, and the retention is not asked again.
#[test]
fn a_restart_a_day_later_keeps_what_the_first_run_kept() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots(dir.path());
    session(&roots.data, "sess_mid", NOW - 6 * DAY - DAY / 2, "");
    session(&roots.data, "sess_new", NOW - DAY, "");
    let week = Week::at(NOW);
    let cut = "journal:staged:session/sess_mid:before";
    let fault: FaultHook = Arc::new(move |point| if point == cut { Err(Blocked::Interrupted { point: cut.into() }) } else { Ok(()) });
    assert_eq!(serving(&roots, Some(week.clone()), Some(fault)).run().unwrap_err(), Blocked::Interrupted { point: cut.into() });
    let judged = |roots: &MigrationRoots| -> Vec<Option<u64>> {
        journal_records(roots)
            .into_iter()
            .filter_map(|record| match record {
                JournalRecord::Phase(entry) if entry.phase == Phase::Judged => Some(entry.at),
                _ => None,
            })
            .collect()
    };
    assert_eq!(judged(&roots), [Some(NOW)]);

    week.now.store(NOW + DAY, Ordering::SeqCst);
    let complete = serving(&roots, Some(week.clone()), None).run().unwrap();

    assert!(expired(&roots).is_empty());
    assert_eq!(complete.kinds.data.expired, 0);
    assert_eq!(*week.judged_at.lock().unwrap(), [NOW], "the run that resumes asks nothing");
    assert_eq!(judged(&roots), [Some(NOW)]);
    assert!(roots.data.join("sessions/sess_mid").is_dir() && roots.data.join("sessions/sess_new").is_dir());
}

/// A migration with an expired session left to dispose of is not finished by a run without the serving core
/// (`mixdogd migrate`): that run removes nothing of the session and journals nothing, and the core's next start purges it,
/// then removes its sources.
#[test]
fn a_run_without_the_serving_core_does_not_dispose_of_an_expired_session() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots(dir.path());
    session(&roots.data, "sess_old", OLD, "");
    session(&roots.data, "sess_new", NOW - DAY, "");
    let week = Week::at(NOW);
    let cut = "counts:before";
    let fault: FaultHook = Arc::new(move |point| if point == cut { Err(Blocked::Interrupted { point: cut.into() }) } else { Ok(()) });
    assert_eq!(serving(&roots, Some(week.clone()), Some(fault)).run().unwrap_err(), Blocked::Interrupted { point: cut.into() });
    assert_eq!(expired(&roots).keys().collect::<Vec<_>>(), ["session/sess_old"]);

    let refused = Migrator::new(roots.clone(), drivers(), MigrateOptions::default()).run().unwrap_err();
    assert!(refused.to_string().contains("start the core"), "{refused}");
    assert!(roots.data.join("sessions/sess_old.json").exists(), "its sources stay for the core to finish");
    assert!(!journal_records(&roots).iter().any(|record| matches!(record, JournalRecord::Disposed(_))), "nothing is disposed of");
    assert!(!roots.data.join(COMPLETE_PATH).exists());
    assert!(week.purged.lock().unwrap().is_empty());

    serving(&roots, Some(week.clone()), None).run().unwrap();
    assert_eq!(*week.purged.lock().unwrap(), ["sess_old"]);
    assert!(!roots.data.join("sessions/sess_old.json").exists());
}

/// A judgement cut after its first verdict, before it was closed, is made again by the run that resumes a day later, at
/// the time journaled with that verdict: the session that was young then converts, and the ones that were expired then
/// are removed, as the uninterrupted run leaves them.
#[test]
fn a_run_resumed_on_a_later_day_judges_at_the_time_of_its_first_verdict() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots(dir.path());
    session(&roots.data, "sess_old1", OLD, "");
    session(&roots.data, "sess_old2", OLD, "");
    // Idle six and a half days at `NOW`, seven and a half a day later.
    session(&roots.data, "sess_mid", NOW - 6 * DAY - DAY / 2, "");
    let week = Week::at(NOW);
    let cut = "journal:expired:session/sess_old1:after";
    let fault: FaultHook = Arc::new(move |point| if point == cut { Err(Blocked::Interrupted { point: cut.into() }) } else { Ok(()) });
    let Front::Pending(back) = serving(&roots, Some(week.clone()), Some(fault)).front().unwrap() else { panic!("the sessions are left") };
    assert_eq!(back.run().unwrap_err(), Blocked::Interrupted { point: cut.into() });
    assert_eq!(expired(&roots).len(), 1);

    week.now.store(NOW + DAY, Ordering::SeqCst);
    let complete = serving(&roots, Some(week.clone()), None).run().unwrap();

    assert_eq!(expired(&roots), BTreeMap::from([("session/sess_old1".to_owned(), NOW), ("session/sess_old2".to_owned(), NOW)]));
    assert_eq!(*week.judged_at.lock().unwrap(), [NOW, NOW]);
    assert_eq!(complete.kinds.data.expired, 2);
    assert!(roots.data.join("sessions/sess_mid").is_dir(), "the session that was young when the first was judged converts");
    for id in ["sess_old1", "sess_old2"] {
        assert!(!roots.data.join(format!("sessions/{id}.json")).exists() && !roots.data.join("sessions").join(id).exists(), "{id}");
    }
    let mut purged = week.purged.lock().unwrap().clone();
    purged.sort();
    assert_eq!(purged, ["sess_old1", "sess_old2"]);
}
