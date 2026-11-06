//! The Goal runtime (Node `runtime-core/goal-*.mjs`, `session-runtime/goal-facade-api.mjs`,
//! `session-calls/goal-recovery.mjs`): the durable objective a session keeps working on across
//! turns, with its time cap, continuation turns, storage and recovery.
//!
//! `GoalRuntime` implements the tool front end's `GoalPort` and the three session hook traits
//! of [`hooks`]; the quota-resume handoff is [`quota`], boot recovery is [`recovery`].

mod control;
mod deadlines;
pub mod error;
pub mod hooks;
pub mod js;
mod mutations;
pub mod quota;
pub mod recovery;
mod runtime;
pub mod session_title;
pub mod state;
pub mod storage;
pub mod text;
mod title;
mod tool;
mod turns;

#[cfg(test)]
mod tests;

pub use control::GOAL_REPLACE_REQUIRED;
pub use error::{GoalError, GoalResult};
pub use mutations::{CreateArgs, assert_expected_goal, goal_finished, goal_stalled};
pub use runtime::{
    Admission, GoalClock, GoalConfig, GoalEnv, GoalEvent, GoalRuntime, GoalTimers, GoalTitles, Subscription, SystemClock,
    TickerTimers, Timer,
};
pub use turns::{Continuation, ContinuationInput};
