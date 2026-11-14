//! The interactive runs: the terminal interface (`runTui`) and the line-based REPL of `--plain` (`runRepl`). Both are filled in
//! by the switch task (nr-tui-switch), which adds `mixdog-tui` and `mixdog-repl` to this crate; until then the binary is not
//! shipped and an interactive start says so once and ends with 1.

use crate::argv::Options;

/// Which interactive run the line asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The terminal interface (`mixdog`).
    Tui,
    /// The line-based REPL (`mixdog --plain`).
    Plain,
}

/// Runs the interactive session with `options` and returns the process's exit code.
pub fn run_interactive(mode: Mode, _options: &Options) -> i32 {
    let name = match mode {
        Mode::Tui => "the terminal interface",
        Mode::Plain => "the --plain REPL",
    };
    eprintln!("mixdog: {name} is not part of this build yet");
    1
}
