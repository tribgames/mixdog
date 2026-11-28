//! `mixdog`: the command (`src/cli.mjs`, `src/app.mjs`). It reads the command line as Node's CLI did (`argv`), answers `--help` and
//! the refusals itself and starts the interactive runs (`dispatch`, `interactive`); `exec` and the helper processes a core starts
//! as its own program run on the `mixdogd` beside it (`handoff`), as this program holds no core.

mod argv;
mod dispatch;
mod handoff;
mod interactive;

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    // A helper's line is its own grammar's, handed on with its words as the OS gave them.
    if args.first().and_then(|word| word.to_str()).is_some_and(|word| mixdog_launch::command::HELPER_SUBCOMMANDS.contains(&word)) {
        std::process::exit(handoff::hand_off(&args));
    }
    // Node reads its arguments as text: a word that is not Unicode is read with its invalid parts replaced.
    let words: Vec<String> = args.iter().map(|word| word.to_string_lossy().into_owned()).collect();
    std::process::exit(dispatch::run(&words));
}
