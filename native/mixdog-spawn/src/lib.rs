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

#[cfg(windows)]
mod console_hosts;
mod contain;
pub mod detached;
mod feed;
mod launch;
pub mod manager;
#[cfg(unix)]
mod osproc;
pub mod ports;
mod pty;
pub mod service;
pub mod survivors;
pub mod tasks;
pub mod terminal;
#[cfg(any(unix, test))]
mod tree;

#[cfg(feature = "core-test")]
pub mod scripted;

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

    /// A point in the library where the next process to reach it parks until released.
    struct Seam {
        state: std::sync::Mutex<Window>,
        changed: std::sync::Condvar,
    }

    #[derive(Default)]
    struct Window {
        armed: bool,
        entered: bool,
        released: bool,
    }

    impl Seam {
        const fn new() -> Self {
            Self {
                state: std::sync::Mutex::new(Window {
                    armed: false,
                    entered: false,
                    released: false,
                }),
                changed: std::sync::Condvar::new(),
            }
        }

        fn window(&self) -> std::sync::MutexGuard<'_, Window> {
            self.state.lock().unwrap_or_else(|e| e.into_inner())
        }

        fn arm(&self) {
            *self.window() = Window {
                armed: true,
                ..Window::default()
            };
        }

        fn wait_entered(&self) {
            let mut state = self.window();
            while !state.entered {
                state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
            }
        }

        fn release(&self) {
            self.window().released = true;
            self.changed.notify_all();
        }

        fn pass(&self) {
            let mut state = self.window();
            if !state.armed {
                return;
            }
            state.armed = false;
            state.entered = true;
            self.changed.notify_all();
            while !state.released {
                state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
            }
        }
    }

    /// The next settle of a root that ended on its own, having found only console hosts left in its job, parks before it
    /// waits on them until [`release_settle_window`].
    pub fn arm_settle_window() {
        SETTLE_WINDOW.arm();
    }

    /// Blocks until a settle is parked in the window.
    pub fn wait_settle_window_entered() {
        SETTLE_WINDOW.wait_entered();
    }

    pub fn release_settle_window() {
        SETTLE_WINDOW.release();
    }

    #[cfg(windows)]
    pub(crate) fn settle_window() {
        SETTLE_WINDOW.pass();
    }

    static SETTLE_WINDOW: Seam = Seam::new();
    static EXIT_WINDOW: Seam = Seam::new();
    static KILL_WINDOW: Seam = Seam::new();
    static LAUNCH_WINDOW: Seam = Seam::new();
    static ANSWER_WINDOW: Seam = Seam::new();

    /// The next spawn parks on its launch thread before it creates its child, until
    /// [`release_launch_window`]: a spawn in flight whose child is not yet committed.
    pub fn arm_launch_window() {
        LAUNCH_WINDOW.arm();
    }

    /// Blocks until a spawn is parked in the window.
    pub fn wait_launch_window_entered() {
        LAUNCH_WINDOW.wait_entered();
    }

    pub fn release_launch_window() {
        LAUNCH_WINDOW.release();
    }

    pub(crate) fn launch_window() {
        LAUNCH_WINDOW.pass();
    }

    /// The next spawn parks on its launch thread once its child is committed (listed) and the
    /// launch has looked whether the requester is still there, until [`release_answer_window`]:
    /// the child exists, the requester has not been told.
    pub fn arm_answer_window() {
        ANSWER_WINDOW.arm();
    }

    /// Blocks until a spawn is parked in the window.
    pub fn wait_answer_window_entered() {
        ANSWER_WINDOW.wait_entered();
    }

    pub fn release_answer_window() {
        ANSWER_WINDOW.release();
    }

    pub(crate) fn answer_window() {
        ANSWER_WINDOW.pass();
    }

    /// The next process to finalize its exit parks between fixing the exit's kill reason and
    /// publishing it, until [`release_exit_window`].
    pub fn arm_exit_window() {
        EXIT_WINDOW.arm();
    }

    /// Blocks until a process is parked in the window.
    pub fn wait_exit_window_entered() {
        EXIT_WINDOW.wait_entered();
    }

    pub fn release_exit_window() {
        EXIT_WINDOW.release();
    }

    pub(crate) fn exit_window() {
        EXIT_WINDOW.pass();
    }

    /// The next kill parks once the tree is signalled, before the kill returns, until
    /// [`release_kill_window`]: a kill held in flight.
    pub fn arm_kill_window() {
        KILL_WINDOW.arm();
    }

    /// Blocks until a kill is parked in the window.
    pub fn wait_kill_window_entered() {
        KILL_WINDOW.wait_entered();
    }

    pub fn release_kill_window() {
        KILL_WINDOW.release();
    }

    pub(crate) fn kill_window() {
        KILL_WINDOW.pass();
    }
}
pub use manager::LocalProcessManager;
pub use manager::OutputFilter;
pub use manager::ProcessConfig;
pub use manager::SpawnOptions;
pub use terminal::TerminalTabs;
