//! `mixdog`: the command (`src/cli.mjs`, `src/app.mjs`). It reads the command line as Node's CLI did (`argv`), answers `--help` and
//! the refusals itself, runs `exec` on its own core and starts the interactive runs (`dispatch`, `interactive`).

mod argv;
mod dispatch;
mod interactive;

fn main() {
    // Node reads its arguments as text: a word that is not Unicode is read with its invalid parts replaced.
    let words: Vec<String> = std::env::args_os().skip(1).map(|word| word.to_string_lossy().into_owned()).collect();
    std::process::exit(dispatch::run(&words));
}
