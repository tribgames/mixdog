//! The rooms' first load, as Node's room service prepares it: `ready` (`agent-rooms.ts:353-362`), the one preparation every room
//! mutation awaits first (`create`, `update`, `remove`, `forgetMember`, `leave`, `reset`, `proceed`: `agent-rooms.ts:267,294,323,
//! 341,365,376,409`; a member's relay, `agent-room-messages.ts:221`), and the start-up `recover` (`agent-rooms.ts:465-480`) that
//! `SessionHost.create` starts and does not await, logging its rejection (`session-host.ts:430-432`). A preparation runs once when
//! it succeeds; one that fails is forgotten (`prepared = null`), so the next caller prepares again, while every caller that joined
//! the failed one gets its error. What does not await it (a listing's rooms, `withRooms`; a room's view, `decorate`; `stop`,
//! `approve`) reads the rooms as they are.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use tokio::sync::watch;

use super::RoomError;
use super::records::{RoomStore, Rooms};

/// One preparation of the rooms (their hosting and `pruneDeleted`).
pub type Prepare = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<(), RoomError>> + Send>> + Send + Sync>;

enum Attempt {
    Idle,
    Running(watch::Receiver<Option<Result<(), RoomError>>>),
    Done,
}

/// Node's `prepared` promise.
pub struct RoomsReady {
    prepare: OnceLock<Prepare>,
    attempt: Arc<Mutex<Attempt>>,
}

impl RoomsReady {
    /// Not prepared yet; its preparation is bound once the rooms' ports exist ([`Self::bind`]).
    pub fn new() -> Arc<Self> {
        Arc::new(Self { prepare: OnceLock::new(), attempt: Arc::new(Mutex::new(Attempt::Idle)) })
    }

    /// Rooms with nothing to prepare.
    pub fn prepared() -> Arc<Self> {
        Arc::new(Self { prepare: OnceLock::new(), attempt: Arc::new(Mutex::new(Attempt::Done)) })
    }

    /// The preparation. Fails when one is bound already.
    pub fn bind<F, Fut>(&self, prepare: F) -> Result<(), &'static str>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), RoomError>> + Send + 'static,
    {
        let prepare: Prepare = Arc::new(move || Box::pin(prepare()));
        self.prepare.set(prepare).map_err(|_| "the rooms' preparation is bound already")
    }

    /// `ready()`: the preparation in flight is joined, a finished one answers at once, and otherwise one starts. It runs to its end
    /// whoever stops waiting (a promise is not cancelled).
    pub async fn ready(&self) -> Result<(), RoomError> {
        let mut outcome = {
            let mut attempt = self.attempt.lock().unwrap_or_else(|e| e.into_inner());
            match &*attempt {
                Attempt::Done => return Ok(()),
                Attempt::Running(outcome) => outcome.clone(),
                Attempt::Idle => {
                    let prepare = self.prepare.get().ok_or_else(|| RoomError::Port("the rooms' preparation is not bound".into()))?;
                    let (told, outcome) = watch::channel(None);
                    *attempt = Attempt::Running(outcome.clone());
                    let preparing = prepare();
                    let state = self.attempt.clone();
                    tokio::spawn(async move {
                        let result = preparing.await;
                        // Forgotten before its callers hear of the failure, as `prepared = null` comes before the rejection.
                        *state.lock().unwrap_or_else(|e| e.into_inner()) = if result.is_ok() { Attempt::Done } else { Attempt::Idle };
                        let _ = told.send(Some(result));
                    });
                    outcome
                }
            }
        };
        let ended = outcome.wait_for(Option::is_some).await.map_err(|_| RoomError::Port("the rooms' preparation ended without an outcome".into()))?;
        ended.clone().expect("an ended preparation has its outcome")
    }
}

/// The start-up `recover` (`agent-rooms.ts:465-480`), started and not awaited (`session-host.ts:430-432`): with no rooms nothing
/// happens; else the rooms are prepared ([`RoomsReady::ready`]) and `after` runs (an exchange a restart cut off is marked
/// interrupted, the catalog republished). A failure is logged (`[mixdog-rooms] Could not recover group rooms:` and the error) and is
/// no one's: the next room mutation prepares again.
pub fn recover<S, F, Fut>(rooms: Arc<Rooms<S>>, ready: Arc<RoomsReady>, after: F, log: Arc<dyn Fn(&str) + Send + Sync>) -> tokio::task::JoinHandle<()>
where
    S: RoomStore + 'static,
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), RoomError>> + Send,
{
    tokio::spawn(async move {
        let recovered = async {
            if rooms.list().await?.is_empty() {
                return Ok(());
            }
            ready.ready().await?;
            after().await
        };
        if let Err(error) = recovered.await {
            log(&format!("Could not recover group rooms: {error}"));
        }
    })
}
