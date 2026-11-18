//! The desktop notices a session's own events raise (`desktop-notice-host.mjs` callers in the live
//! turn close and the session store): a provider refusing the sign-in, and a transcript the disk
//! no longer keeps up with. The session reports the events; what is shown, and under which key,
//! is the composition's (`DesktopNotices`).

/// Told of the events of every thread's turns and saves.
pub trait SessionNotices: Send + Sync {
    /// A turn on `provider` finished normally (`completeTurn`).
    fn turn_completed(&self, provider: &str);
    /// A turn on `provider` failed (`failTurn`, not for a cancel); `kind` is the provider failure's
    /// kind (`providerErrorKind(error).kind`), none for a failure that is not the provider's.
    fn turn_failed(&self, provider: &str, kind: Option<&str>);
    /// `session` holds accepted conversation rows the disk does not have (a failed save left them, or their outcome is
    /// unknown). Told once while that stands.
    fn save_failed(&self, session: &str);
    /// `session`'s unsaved rows are acknowledged: the warning for it is over.
    fn save_resolved(&self, session: &str);
    /// No tool-result sidecar is pruned while `session` cannot be read (whether it names them is not known): the disk
    /// keeps growing until it can (`offloadCopies`).
    fn offload_prune_blocked(&self, session: &str);
}