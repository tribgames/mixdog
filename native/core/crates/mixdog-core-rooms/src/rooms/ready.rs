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

/// The start-up's recovery ([`recover`]), handed the first preparation's outcome.
type Recovery = Box<dyn FnOnce(Result<(), RoomError>) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>;

/// Node's `prepared` promise.
pub struct RoomsReady {
    prepare: OnceLock<Prepare>,
    attempt: Arc<Mutex<Attempt>>,
    /// The start-up's recovery until the first preparation takes it.
    recovery: Arc<Mutex<Option<Recovery>>>,
}

impl RoomsReady {
    /// Not prepared yet; its preparation is bound once the rooms' ports exist ([`Self::bind`]).
    pub fn new() -> Arc<Self> {
        Arc::new(Self { prepare: OnceLock::new(), attempt: Arc::new(Mutex::new(Attempt::Idle)), recovery: Arc::default() })
    }

    /// Rooms with nothing to prepare.
    pub fn prepared() -> Arc<Self> {
        Arc::new(Self { prepare: OnceLock::new(), attempt: Arc::new(Mutex::new(Attempt::Done)), recovery: Arc::default() })
    }

    /// The start-up's recovery taken back before any preparation took it: true when it was still waiting.
    fn disarm(&self) -> bool {
        self.recovery.lock().unwrap_or_else(|e| e.into_inner()).take().is_some()
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
                    let (state, recovery) = (self.attempt.clone(), self.recovery.clone());
                    tokio::spawn(async move {
                        let result = preparing.await;
                        // The start-up's recovery goes on before any caller hears of the outcome, whoever started the preparation: the
                        // core's one order of the recovery's republish and a mutation that awaited the same load is the recovery's
                        // first, one of the two Node gives (recorded: `fixtures/room-catalog-states` `startup-*`). Only the first
                        // preparation runs it, whatever its outcome, as Node's `recover` awaits only the first (`agent-rooms.ts:469`).
                        let recovery = recovery.lock().unwrap_or_else(|e| e.into_inner()).take();
                        if let Some(recovery) = recovery {
                            recovery(result.clone()).await;
                        }
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

/// The start-up `recover` (`agent-rooms.ts:465-480`), started and not awaited (`session-host.ts:430-432`). Its recovery is
/// registered at once, before any call can await the rooms' first load: the first preparation, whoever starts it, runs it before
/// its callers hear of the outcome ([`RoomsReady::ready`]): with rooms loaded, `after` (an exchange a restart cut off is marked
/// interrupted, the catalog republished). With no rooms nothing happens and no preparation is started. A failure is logged
/// (`[mixdog-rooms] Could not recover group rooms:` and the error) and is no one's: the next room mutation prepares again, without
/// the recovery.
pub fn recover<S, F, Fut>(rooms: Arc<Rooms<S>>, ready: Arc<RoomsReady>, after: F, log: Arc<dyn Fn(&str) + Send + Sync>) -> tokio::task::JoinHandle<()>
where
    S: RoomStore + 'static,
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), RoomError>> + Send + 'static,
{
    let (told, recovered) = tokio::sync::oneshot::channel();
    let loaded = rooms.clone();
    let recovery: Recovery = Box::new(move |prepared| {
        Box::pin(async move {
            let outcome = match prepared {
                // Node reads the rooms before it awaits the first load (`agent-rooms.ts:466-468`), which adds none.
                Ok(()) => match loaded.list().await {
                    Ok(listed) if listed.is_empty() => Ok(()),
                    Ok(_) => after().await,
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            };
            let _ = told.send(outcome);
        })
    });
    *ready.recovery.lock().unwrap_or_else(|e| e.into_inner()) = Some(recovery);
    tokio::spawn(async move {
        let recovered = async move {
            match recovered.await {
                Ok(outcome) => outcome,
                Err(_) => Err(RoomError::Port("the start-up's recovery ended without an outcome".into())),
            }
        };
        let outcome = match rooms.list().await {
            // No rooms: nothing to recover. A first load another call started meanwhile finds none either.
            Ok(listed) if listed.is_empty() => {
                ready.disarm();
                Ok(())
            }
            // The preparation's outcome is the recovery's to report. One another call started has taken the recovery already.
            Ok(_) => {
                if ready.recovery.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
                    let _ = ready.ready().await;
                }
                recovered.await
            }
            Err(error) if ready.disarm() => Err(error),
            Err(_) => recovered.await,
        };
        if let Err(error) = outcome {
            log(&format!("Could not recover group rooms: {error}"));
        }
    })
}
