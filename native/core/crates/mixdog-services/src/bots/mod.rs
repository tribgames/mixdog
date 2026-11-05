//! Bots: how a schedule or webhook fire becomes a turn in its owner bot's home thread. The
//! prompt contract (headers, quiet sentinels, trigger markers) is `routine`; the guards a
//! run passes, the turn, the executor sub-agent, redelivery and the two fire paths are the
//! `RoutineRuntime`; everything session-side sits behind the one `RoutineHost` seam.

pub mod attachments;
pub mod delivery;
pub mod executor;
pub mod host;
pub mod ids;
pub mod owned;
pub mod routine;
pub mod runner;
pub mod runtime;
pub mod sessions;
pub mod turn;

#[cfg(test)]
pub(crate) mod tests;

pub use executor::{ExecutorProblem, normalize_executor_agent_id};
pub use host::{AnnouncedRun, DeliveryItem, ExecutorFacts, ExecutorRun, OwnerProblem, RoutineHost, RoutineTurn, TurnSettle};
pub use owned::{OwnedOutcome, RoutineRun, RunOpts, Skip};
pub use routine::{RoutineKind, RoutineTrigger};
pub use runner::{HomeScheduleRunner, HomeWebhookDispatch, WebhookEvents};
pub use runtime::{AutomationRuns, Reservation, RoutineRecords, RoutineRuntime, RoutineState, StoreRoutineRecords};
pub use sessions::{ScheduleRunOpts, WebhookRun};
pub use turn::TurnArgs;
