//! The test build of `mixdogd skill-run` (feature `test-support`): tests/launch.rs puts it in launchers.
//! The interpreter of the transitional user-script variant comes from `MIXDOG_TEST_SKILL_INTERPRETER` and
//! `MIXDOG_TEST_SKILL_ENTRY`; without them a script that is not shipped is unavailable.

use std::path::PathBuf;
use std::process::ExitCode;

use mixdog_skill_scripts::UserScriptRuntime;

fn main() -> ExitCode {
    let runtime = match (std::env::var_os("MIXDOG_TEST_SKILL_INTERPRETER"), std::env::var_os("MIXDOG_TEST_SKILL_ENTRY")) {
        (Some(program), Some(entry)) => UserScriptRuntime::Interpreter { program: PathBuf::from(program), entry: PathBuf::from(entry), electron: false },
        _ => UserScriptRuntime::Unavailable { reason: "no interpreter is configured".to_owned() },
    };
    mixdog_skill_scripts::skill_run(std::env::args_os().skip(1).collect(), runtime)
}
