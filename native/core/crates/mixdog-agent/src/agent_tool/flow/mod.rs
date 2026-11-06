//! The worker flows behind the agent tool's `SpawnFlow` and `SendFlow`: a job as a background
//! task, a worker's turn under it, the reconcile of its task and the worker row it keeps (Node
//! `session-runtime/services/agent-tool/{spawn-flow/,send-flow.mjs,worker-turns.mjs,
//! job-task-reconcile.mjs,notify*}`). What they borrow from the session side is in [`seams`].
//!
//! The progress watchdog is not ported: it decides a turn's death from silence or elapsed time,
//! and nothing here stops a turn for either. Progress is reported (`agent_tool::progress`).

pub mod early;
pub mod job_starter;
pub mod notify;
pub mod preset;
pub mod reconcile;
pub mod result;
pub mod review;
pub mod seams;
pub mod send;
pub mod spawn;
pub mod turn;
pub mod worker_turns;
pub mod world;
