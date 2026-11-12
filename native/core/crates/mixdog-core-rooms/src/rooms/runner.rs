//! The room runner (`RoomRunner`) of the `room` domain over the one scheduler of what runs in each
//! room (`RoomCalls`, Node `agent-room-scheduler.ts`): `room/continue` starts an exchange through
//! the same state a member's relay and the stop button use, so a room is never run twice.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use super::RoomError;
use super::calls::{CallRunner, Request, RoomCalls};
use super::rows::room_user_waiting;
use super::service::RoomRunner;

/// The room log's rows in log order (`rows(roomId)` of the room log).
#[async_trait]
pub trait RoomRowsSource: Send + Sync {
    async fn rows(&self, room_id: &str) -> Result<Vec<Value>, String>;
}

pub struct CallsRunner<R: CallRunner> {
    calls: Arc<RoomCalls<R>>,
    rows: Arc<dyn RoomRowsSource>,
}

impl<R: CallRunner> CallsRunner<R> {
    pub fn new(calls: Arc<RoomCalls<R>>, rows: Arc<dyn RoomRowsSource>) -> Self {
        Self { calls, rows }
    }
}

#[async_trait]
impl<R: CallRunner + 'static> RoomRunner for CallsRunner<R> {
    fn is_running(&self, room_id: &str) -> bool {
        self.calls.is_running(room_id)
    }

    fn stop(&self, room_id: &str) {
        self.calls.stop(room_id);
    }

    /// `start(roomId, { to })` of `proceed`: no call rides it, and a user still waiting is read
    /// from the log (`waiting` unset). The request addresses the whole room when it names nobody.
    async fn start(&self, room_id: &str, to: Vec<String>) -> Result<(), RoomError> {
        let rows = self.rows.rows(room_id).await.map_err(RoomError::Port)?;
        let waiting = room_user_waiting(&rows);
        let everyone = to.is_empty();
        self.calls.route(room_id, Request { to, waiting, everyone, only: false, calls: Vec::new() });
        Ok(())
    }

    fn cancel_owed_to(&self, room_id: &str, gone: &[String]) {
        self.calls.cancel_owed_to(room_id, &gone.iter().cloned().collect());
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;
    use tokio::sync::Notify;

    use super::*;
    use crate::rooms::calls::Run;

    #[derive(Default)]
    struct Recorder {
        seen: Mutex<Vec<(String, Vec<String>, bool, bool, bool)>>,
        ran: Notify,
    }
    #[async_trait]
    impl CallRunner for Recorder {
        async fn run(&self, room_id: &str, request: &Request, _: &Arc<Run>) -> Result<(), String> {
            self.seen.lock().unwrap().push((room_id.to_owned(), request.to.clone(), request.waiting, request.everyone, request.only));
            self.ran.notify_one();
            Ok(())
        }
        async fn cut_off(&self, _: &str) {}
    }

    struct Rows(Result<Vec<Value>, String>);
    #[async_trait]
    impl RoomRowsSource for Rows {
        async fn rows(&self, _: &str) -> Result<Vec<Value>, String> {
            self.0.clone()
        }
    }

    fn runner(rows: Result<Vec<Value>, String>) -> (CallsRunner<Recorder>, Arc<Recorder>) {
        // `route` spawns through mixdog_rt, which needs its backend installed.
        mixdog_rt::testing::tokens();
        let recorder = Arc::new(Recorder::default());
        let calls = RoomCalls::new(recorder.clone(), Arc::new(|_: &str| {}));
        (CallsRunner::new(calls, Arc::new(Rows(rows))), recorder)
    }

    #[tokio::test]
    async fn a_whole_room_continue_reads_the_waiting_user_from_the_log_and_a_named_one_is_not_the_whole_room() {
        let user = json!({ "id": "u1", "kind": "user", "text": "hi" });
        let (open, recorder) = runner(Ok(vec![user.clone()]));
        open.start("room01", vec![]).await.unwrap();
        recorder.ran.notified().await;
        assert_eq!(recorder.seen.lock().unwrap()[0], ("room01".to_owned(), vec![], true, true, false));

        let answered = json!({ "id": "s1", "kind": "speech", "speaker": "a", "text": "yo" });
        let (named, recorder) = runner(Ok(vec![user, answered]));
        named.start("room01", vec!["b".into()]).await.unwrap();
        recorder.ran.notified().await;
        assert_eq!(recorder.seen.lock().unwrap()[0], ("room01".to_owned(), vec!["b".to_owned()], false, false, false));
    }

    #[tokio::test]
    async fn a_log_that_cannot_be_read_starts_nothing() {
        let (broken, recorder) = runner(Err("log gone".into()));
        assert_eq!(broken.start("room01", vec![]).await, Err(RoomError::Port("log gone".into())));
        assert!(recorder.seen.lock().unwrap().is_empty());
        assert!(!broken.is_running("room01"));
    }
}
