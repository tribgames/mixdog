//! What runs in each room: at most one exchange per room, in memory only. `RoomScheduler` marks
//! the room running, drives `run_room_exchange` with a host that asks the supervisor (the
//! Maintainer model) for each step and the room's members for their turns, then clears the mark
//! and records the members a message cap left owed a turn.
//!
//! The room's log and the members' sessions sit behind `RoomTalk`; the Maintainer model behind
//! `Maintainer`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_rt::TaskClass;

use super::RoomError;
use super::exchange::{
    Action, Answer, DecideInput, Decision, ExchangeHost, ExchangeParams, ExchangeResult, Outcome, Turn, run_room_exchange,
};
use super::records::{RoomStore, Rooms, Running};
use super::rows::{RoomRow, room_user_waiting};
use super::service::RoomRunner;
use super::supervisor::{SupervisorInput, SupervisorMember, parse_room_decision, supervisor_prompt};

/// The Maintainer model's answer to one supervisor prompt.
pub enum Maintained {
    /// No Maintainer model is configured: nobody moderates.
    Unmanaged,
    /// The call failed or answered nothing.
    Failed,
    Text(String),
}

#[async_trait]
pub trait Maintainer: Send + Sync {
    async fn ask(&self, system: &str, user: &str) -> Maintained;
}

pub struct Roster {
    pub name: String,
    pub members: Vec<SupervisorMember>,
}

/// The room's log and its members' sessions.
#[async_trait]
pub trait RoomTalk: Send + Sync {
    async fn roster(&self, room_id: &str) -> Result<Roster, RoomError>;
    /// The room log's rows, in log order.
    async fn rows(&self, room_id: &str) -> Result<Vec<RoomRow>, RoomError>;
    /// One member's turn in the room. It watches `stop` and `superseded` and answers
    /// `Stopped`/`Superseded` when either is set.
    async fn speak(&self, room_id: &str, agent_id: &str, turn: &Turn, flags: &Flags) -> Answer;
    /// Cuts the member's turn in flight short.
    async fn abort(&self, room_id: &str, agent_id: &str);
    /// The exchange ended: the log shows why (cap, stop, interruption).
    async fn ended(&self, room_id: &str, result: &ExchangeResult);
    fn now_ms(&self) -> i64;
}

/// The two ways an exchange is cut short from outside.
#[derive(Default)]
pub struct Flags {
    stop: AtomicBool,
    superseded: AtomicBool,
}

impl Flags {
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
    pub fn superseded(&self) -> bool {
        self.superseded.load(Ordering::SeqCst)
    }
}

struct Host<T: RoomTalk, M: Maintainer> {
    room_id: String,
    talk: Arc<T>,
    maintainer: Arc<M>,
    flags: Arc<Flags>,
}

#[async_trait]
impl<T: RoomTalk + 'static, M: Maintainer + 'static> ExchangeHost for Host<T, M> {
    async fn speak(&self, agent_id: &str, turn: &Turn) -> Answer {
        self.talk.speak(&self.room_id, agent_id, turn, &self.flags).await
    }

    async fn decide(&self, input: &DecideInput) -> Option<Decision> {
        let roster = self.talk.roster(&self.room_id).await.ok()?;
        let rows = self.talk.rows(&self.room_id).await.ok()?;
        let prompt = supervisor_prompt(&SupervisorInput {
            room_name: &roster.name,
            members: &roster.members,
            rows: &rows,
            decide: input,
        });
        match self.maintainer.ask(&prompt.system, &prompt.user).await {
            Maintained::Unmanaged => Some(Decision { action: Action::Unmanaged, scene: None }),
            Maintained::Failed => None,
            Maintained::Text(reply) => parse_room_decision(&reply, &roster.members),
        }
    }

    fn stopped(&self) -> bool {
        self.flags.stopped()
    }

    fn superseded(&self) -> bool {
        self.flags.superseded()
    }
}

struct Inner<T: RoomTalk, M: Maintainer, S: RoomStore> {
    rooms: Arc<Rooms<S>>,
    talk: Arc<T>,
    maintainer: Arc<M>,
    running: Mutex<HashMap<String, Arc<Flags>>>,
}

impl<T: RoomTalk, M: Maintainer, S: RoomStore> Inner<T, M, S> {
    fn running(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Flags>>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct RoomScheduler<T: RoomTalk, M: Maintainer, S: RoomStore> {
    inner: Arc<Inner<T, M, S>>,
}

impl<T: RoomTalk + 'static, M: Maintainer + 'static, S: RoomStore + 'static> RoomScheduler<T, M, S> {
    pub fn new(rooms: Arc<Rooms<S>>, talk: Arc<T>, maintainer: Arc<M>) -> Self {
        Self { inner: Arc::new(Inner { rooms, talk, maintainer, running: Mutex::new(HashMap::new()) }) }
    }

    /// A newer user message arrived: the exchange in flight ends without a trace of its turn.
    pub fn supersede(&self, room_id: &str) {
        if let Some(flags) = self.inner.running().get(room_id) {
            flags.superseded.store(true, Ordering::SeqCst);
        }
    }

    /// Start-up: an exchange a restart cut off is marked interrupted and its members are
    /// stopped; nothing resumes on its own. The rooms to republish.
    pub async fn recover(&self) -> Result<Vec<String>, RoomError> {
        let cut = self.inner.rooms.recover().await?;
        for room in &cut {
            for member in &room.config.members {
                self.inner.talk.abort(&room.id, member).await;
            }
            let result = ExchangeResult {
                outcome: Outcome::Stopped,
                rounds: 0,
                steps: 0,
                messages: 0,
                limit: None,
                remaining: vec![],
                usage: None,
            };
            self.inner.talk.ended(&room.id, &result).await;
        }
        Ok(cut.into_iter().map(|room| room.id).collect())
    }
}

#[async_trait]
impl<T: RoomTalk + 'static, M: Maintainer + 'static, S: RoomStore + 'static> RoomRunner for RoomScheduler<T, M, S> {
    fn is_running(&self, room_id: &str) -> bool {
        self.inner.running().contains_key(room_id)
    }

    fn stop(&self, room_id: &str) {
        let flags = self.inner.running().get(room_id).cloned();
        if let Some(flags) = flags {
            flags.stop.store(true, Ordering::SeqCst);
            let inner = self.inner.clone();
            let room_id = room_id.to_owned();
            mixdog_rt::spawn("room-stop", TaskClass::Work, async move {
                if let Ok(room) = inner.rooms.get(&room_id).await {
                    for member in &room.config.members {
                        inner.talk.abort(&room_id, member).await;
                    }
                }
            });
        }
    }

    async fn start(&self, room_id: &str, to: Vec<String>) -> Result<(), RoomError> {
        let inner = self.inner.clone();
        let flags = Arc::new(Flags::default());
        {
            let mut running = inner.running();
            if running.contains_key(room_id) {
                return Err(RoomError::Invalid("The room is already talking.".into()));
            }
            running.insert(room_id.to_owned(), flags.clone());
        }
        let begun = async {
            let room = inner.rooms.get(room_id).await?;
            let rows = inner.talk.rows(room_id).await?;
            inner.rooms.set_running(room_id, Some(Running { started_at: inner.talk.now_ms() })).await?;
            Ok::<_, RoomError>((room, rows))
        }
        .await;
        let (room, rows) = match begun {
            Ok(ready) => ready,
            Err(error) => {
                inner.running().remove(room_id);
                return Err(error);
            }
        };
        let room_id = room_id.to_owned();
        mixdog_rt::spawn("room-exchange", TaskClass::Work, async move {
            let host = Host { room_id: room_id.clone(), talk: inner.talk.clone(), maintainer: inner.maintainer.clone(), flags };
            let result = run_room_exchange(
                &host,
                ExchangeParams {
                    members: room.config.members.clone(),
                    to,
                    max_rounds: room.config.max_rounds,
                    max_messages: room.config.max_messages,
                    waiting: room_user_waiting(&rows),
                    only: false,
                    whole_room: None,
                },
            )
            .await;
            inner.running().remove(&room_id);
            let owed = (result.outcome == Outcome::Capped).then(|| result.remaining.clone());
            let _ = inner.rooms.end_exchange(&room_id, owed).await;
            inner.talk.ended(&room_id, &result).await;
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use tokio::sync::Notify;

    use super::*;
    use crate::rooms::config::RoomConfigInput;
    use crate::rooms::exchange::TurnResult;
    use crate::rooms::records::RoomDoc;

    struct Mem(Mutex<RoomDoc>);
    #[async_trait]
    impl RoomStore for Mem {
        async fn load(&self) -> Result<RoomDoc, RoomError> {
            Ok(self.0.lock().unwrap().clone())
        }
        async fn save(&self, doc: &RoomDoc) -> Result<(), RoomError> {
            *self.0.lock().unwrap() = doc.clone();
            Ok(())
        }
    }

    struct Talk {
        speeches: AtomicUsize,
        ended: Notify,
        outcome: Mutex<Option<Outcome>>,
    }
    #[async_trait]
    impl RoomTalk for Talk {
        async fn roster(&self, _: &str) -> Result<Roster, RoomError> {
            Ok(Roster { name: "Plan".into(), members: vec![] })
        }
        async fn rows(&self, _: &str) -> Result<Vec<RoomRow>, RoomError> {
            // An unanswered user message: the room is waiting, so an unmanaged room gives each member a turn.
            Ok(vec![RoomRow {
                id: "1".into(),
                kind: crate::rooms::rows::RowKind::User,
                speaker: String::new(),
                to: vec![],
                text: "hi".into(),
                seen: false,
            }])
        }
        async fn speak(&self, _: &str, _: &str, _: &Turn, _: &Flags) -> Answer {
            self.speeches.fetch_add(1, Ordering::SeqCst);
            Answer::of(TurnResult::Speech)
        }
        async fn abort(&self, _: &str, _: &str) {}
        async fn ended(&self, _: &str, result: &ExchangeResult) {
            *self.outcome.lock().unwrap() = Some(result.outcome);
            self.ended.notify_one();
        }
        fn now_ms(&self) -> i64 {
            7
        }
    }

    struct Unmanaged;
    #[async_trait]
    impl Maintainer for Unmanaged {
        async fn ask(&self, _: &str, _: &str) -> Maintained {
            Maintained::Unmanaged
        }
    }

    #[tokio::test]
    async fn an_exchange_runs_once_then_the_room_is_idle_and_unmarked() {
        // `start` spawns through mixdog_rt, which needs its backend installed.
        mixdog_rt::testing::tokens();
        let rooms = Arc::new(Rooms::new(Mem(Default::default())));
        let input = RoomConfigInput { name: "Plan".into(), members: vec!["lead".into(), "bench".into()], ..Default::default() };
        rooms.create(&input, "room01", 1).await.unwrap();
        let talk = Arc::new(Talk { speeches: AtomicUsize::new(0), ended: Notify::new(), outcome: Mutex::new(None) });
        let scheduler = RoomScheduler::new(rooms.clone(), talk.clone(), Arc::new(Unmanaged));
        scheduler.start("room01", vec![]).await.unwrap();
        talk.ended.notified().await;
        assert!(talk.speeches.load(Ordering::SeqCst) >= 1);
        assert!(!scheduler.is_running("room01"));
        assert_eq!(rooms.get("room01").await.unwrap().running, None);
    }

    #[tokio::test]
    async fn a_second_start_while_the_room_talks_is_refused() {
        let rooms = Arc::new(Rooms::new(Mem(Default::default())));
        let input = RoomConfigInput { name: "Plan".into(), members: vec!["lead".into(), "bench".into()], ..Default::default() };
        rooms.create(&input, "room01", 1).await.unwrap();
        let talk = Arc::new(Talk { speeches: AtomicUsize::new(0), ended: Notify::new(), outcome: Mutex::new(None) });
        let scheduler = RoomScheduler::new(rooms, talk, Arc::new(Unmanaged));
        scheduler.inner.running().insert("room01".into(), Arc::new(Flags::default()));
        assert!(matches!(scheduler.start("room01", vec![]).await, Err(RoomError::Invalid(_))));
    }
}
