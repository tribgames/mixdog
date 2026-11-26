//! The code graph helper process: the wire between the core and the helper, the core's supervisor of it, and the
//! helper's serve loop.
//!
//! The core never builds or holds a code graph. One helper per core (`current_exe() graph-worker`, started through
//! `mixdog_spawn::owned`) owns the graph cache and answers each query with rendered text; it exits after an idle deadline,
//! so its memory returns to the operating system.
//!
//! - [`wire`]: the messages; the engine implements [`worker::Handler`] over them.
//! - [`frame`]: frames on the standard pipes; a message over one frame is chunked, never cut.
//! - [`worker`]: the helper's serve loop.
//! - [`GraphHost`]: the core's supervisor of the helper.

mod client;
pub mod clock;
pub mod frame;
mod supervisor;
pub mod wire;
pub mod worker;

/// Seams for the supervisor's tests.
#[cfg(feature = "test-support")]
pub mod testing {
    use std::sync::Condvar;
    use std::sync::Mutex;
    use std::sync::MutexGuard;
    use std::sync::PoisonError;

    use tokio::sync::Notify;

    #[derive(Default)]
    struct Window {
        armed: bool,
        entered: bool,
        released: bool,
    }

    static WINDOW: Mutex<Window> = Mutex::new(Window { armed: false, entered: false, released: false });
    static CHANGED: Condvar = Condvar::new();
    static ENTERED: Notify = Notify::const_new();

    fn window() -> MutexGuard<'static, Window> {
        WINDOW.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The next message a core reader reads waits, before the supervisor is given it, until [`release_reader`].
    pub fn hold_reader() {
        *window() = Window { armed: true, ..Window::default() };
    }

    /// Completes once a reader is waiting with its message.
    pub async fn reader_held() {
        loop {
            let entered = ENTERED.notified();
            tokio::pin!(entered);
            entered.as_mut().enable();
            if window().entered {
                return;
            }
            entered.await;
        }
    }

    pub fn release_reader() {
        window().released = true;
        CHANGED.notify_all();
    }

    pub(crate) fn reader_window() {
        let mut window = window();
        if !window.armed {
            return;
        }
        window.armed = false;
        window.entered = true;
        ENTERED.notify_waiters();
        while !window.released {
            window = CHANGED.wait(window).unwrap_or_else(PoisonError::into_inner);
        }
    }
}

pub use clock::Clock;
pub use clock::RuntimeClock;
pub use mixdog_spawn::owned::OwnedCommand;
pub use supervisor::*;
