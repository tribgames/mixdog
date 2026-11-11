//! The real clock of the no-clients grace: one OS thread per armed grace, ended by dropping its handle.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the grace must run while the async runtime is busy or stopping; a parked OS thread holds nothing else"
)]

use std::sync::mpsc;
use std::time::Duration;

use super::ports::GraceTimer;

pub struct ThreadTimer;

impl GraceTimer for ThreadTimer {
    fn after(&self, delay: Duration, fire: Box<dyn FnOnce() + Send>) -> Box<dyn Send> {
        let (cancel, cancelled) = mpsc::channel::<()>();
        std::thread::Builder::new()
            .name("mixdog-client-grace".into())
            .spawn(move || {
                // The sender is only dropped (never sent on): a disconnect is the cancel, a timeout is the grace running out.
                if matches!(cancelled.recv_timeout(delay), Err(mpsc::RecvTimeoutError::Timeout)) {
                    fire();
                }
            })
            .expect("the OS refused a client-grace thread");
        Box::new(cancel)
    }
}