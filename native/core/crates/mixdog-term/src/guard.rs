//! The terminal guard: restores the terminal on exit, signals and a dead stdio. Filled in by the console task.

/// Restores the terminal when dropped.
#[derive(Debug, Default)]
pub struct TerminalGuard;

/// Signal and stdio-death cleanup handlers.
#[derive(Debug, Default)]
pub struct SignalCleanup;
