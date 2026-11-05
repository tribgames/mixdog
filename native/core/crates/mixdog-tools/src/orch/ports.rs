//! Facts about the calling thread that several front ends consult. The session actor answers
//! them from its own state; a tool never derives them from input or stored text.

use mixdog_protocol::ThreadId;

/// What the runtime knows about the thread a tool call belongs to.
pub trait CallerFacts: Send + Sync {
    /// Mixy's hidden heartbeat session, by the in-process mark on the thread.
    fn is_heartbeat(&self, thread: &ThreadId) -> bool;

    /// A schedule or webhook run: nobody is present to answer or to see a reaction.
    fn is_unattended(&self, thread: &ThreadId) -> bool;

    /// Whether a user can answer a question put to this thread now.
    fn user_available(&self, thread: &ThreadId) -> bool;
}

/// What a heartbeat turn is told when it tries to hand work off.
pub const HEARTBEAT_NO_HANDOFF: &str = "a heartbeat turn cannot hand work off: its result would reach nobody. Propose it to the user instead (session action suggest).";
