//! The core's process service (DS §6), linked as a library by `mixdogd`.
//!
//! One [`manager::LocalProcessManager`] starts every child process the core runs for a user-visible
//! purpose: shell tool, background tasks, terminal tabs, LSP servers, `git`, `gh`. [`terminal`]
//! keeps the tab layer over PTY handles, [`tasks`] the background-task registry behind the shell
//! job strip, [`ports`] the listening-ports sampler.
//!
//! The library exists only with the `core` feature; without it this crate is the stdio-server
//! binary alone and the library is empty.
#![cfg(feature = "core")]

mod contain;
mod feed;
mod launch;
pub mod manager;
pub mod ports;
mod pty;
pub mod service;
pub mod survivors;
pub mod tasks;
pub mod terminal;

/// Seams for the library's integration tests.
#[cfg(feature = "core-test")]
pub mod testing {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    static FAIL_NEXT_ADOPTION: AtomicBool = AtomicBool::new(false);

    /// The next process placed into a job fails, as if the OS had refused the assignment.
    pub fn fail_next_adoption() {
        FAIL_NEXT_ADOPTION.store(true, Ordering::SeqCst);
    }

    #[cfg(windows)]
    pub(crate) fn take_adoption_failure() -> bool {
        FAIL_NEXT_ADOPTION.swap(false, Ordering::SeqCst)
    }

    #[derive(Default)]
    struct Window {
        armed: bool,
        entered: bool,
        released: bool,
    }

    static WINDOW: std::sync::Mutex<Window> = std::sync::Mutex::new(Window {
        armed: false,
        entered: false,
        released: false,
    });
    static WINDOW_CHANGED: std::sync::Condvar = std::sync::Condvar::new();

    fn window() -> std::sync::MutexGuard<'static, Window> {
        WINDOW.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The next process to finalize its exit parks between fixing the exit's kill reason and
    /// publishing it, until [`release_exit_window`].
    pub fn arm_exit_window() {
        *window() = Window {
            armed: true,
            ..Window::default()
        };
    }

    /// Blocks until a process is parked in the window.
    pub fn wait_exit_window_entered() {
        let mut state = window();
        while !state.entered {
            state = WINDOW_CHANGED.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }

    pub fn release_exit_window() {
        window().released = true;
        WINDOW_CHANGED.notify_all();
    }

    pub(crate) fn exit_window() {
        let mut state = window();
        if !state.armed {
            return;
        }
        state.armed = false;
        state.entered = true;
        WINDOW_CHANGED.notify_all();
        while !state.released {
            state = WINDOW_CHANGED.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }
}

pub use manager::LocalProcessManager;
pub use manager::OutputFilter;
pub use manager::ProcessConfig;
pub use manager::SpawnOptions;
pub use terminal::TerminalTabs;
