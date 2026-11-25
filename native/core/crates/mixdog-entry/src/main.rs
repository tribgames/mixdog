//! `mixdog`: the command (`src/cli.mjs`, `src/app.mjs`). It reads the command line as Node's CLI did (`argv`), answers `--help` and
//! the refusals itself, runs `exec` on its own core and starts the interactive runs (`dispatch`, `interactive`), and serves the
//! helper processes that core starts (`mixdog_cli::helpers`).

mod argv;
mod dispatch;
mod interactive;

fn main() -> std::process::ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    // The core `mixdog exec` composes in this process starts its helpers as this program, as `mixdogd`'s starts them as
    // `mixdogd`: their words are taken as the OS gave them.
    if let Some(helper) = mixdog_cli::helpers::requested(&args) {
        return mixdog_cli::helpers::run(helper);
    }
    // Node reads its arguments as text: a word that is not Unicode is read with its invalid parts replaced.
    let words: Vec<String> = args.iter().map(|word| word.to_string_lossy().into_owned()).collect();
    std::process::exit(dispatch::run(&words));
}
