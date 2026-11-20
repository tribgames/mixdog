//! The server assembly: `apps/relay/server.mjs` in Rust. [`start`] builds every service of the relay from its configuration, binds,
//! starts the heartbeat and the diagnostics, and returns the [`RunningRelay`]; [`router`] is `routeRequest`, [`upgrade`] is
//! `handleUpgrade` with the `/desktop` and `/hookleg` authentication, and [`run_cli`] is the command line entry (the block under
//! `invokedDirectly`). [`spawn`] starts a relay inside a process that already runs the executors (the interop tests of
//! mixdog-remote).
//!
//! Like the Node entry the process installs no SIGTERM or SIGINT handler: a stop from systemd ends it as it ends Node, and the
//! debounce window of the device store can be lost exactly as it can today.

mod router;
mod start;
mod upgrade;

use std::process::ExitCode;

use mixdog_rt::exec::RtConfig;
use mixdog_rt::{Backend, LaneTokens, TaskClass};

pub use self::start::{Options, RunningRelay, Seams, start};
use crate::config::Config;
use crate::logline;

/// Starts a relay from `config` with the defaults of the relay: its environment is the one the feedback, native push and TURN
/// settings are read from. The executors of mixdog-rt must be installed by the caller, who passes its tokens.
pub async fn spawn(config: &Config, tokens: LaneTokens) -> Result<RunningRelay, String> {
    start(config, Options::for_environment(&config.env), Seams::default(), tokens).await
}

/// What the process does with the outcome of [`start`]: the listening line and the wait for ever, or the failure line and 1.
fn report(config: &Config, started: Result<RunningRelay, String>) -> Result<RunningRelay, ExitCode> {
    match started {
        Ok(relay) => {
            logline::emit(&logline::listening(config.scheme(), relay.port, &config.renderer_dir));
            Ok(relay)
        }
        Err(message) => {
            logline::emit(&logline::failed_to_start(&message));
            Err(ExitCode::from(1))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_start_is_the_failure_line_and_exit_one() {
        let config = Config::from_env(Default::default(), Default::default());
        assert!(report(&config, Err("listen EADDRINUSE: address already in use 0.0.0.0:9800".to_owned())).is_err());
    }
}


/// Runs the relay from the process environment until the process ends.
pub fn run_cli() -> ExitCode {
    let config = Config::from_process();
    let (executors, tokens) = match mixdog_rt::exec::boot(RtConfig::detect()) {
        Ok(booted) => booted,
        Err(error) => {
            logline::emit(&logline::failed_to_start(&error.to_string()));
            return ExitCode::from(1);
        }
    };
    executors.handle(TaskClass::Work).block_on(async move {
        match report(&config, spawn(&config, tokens).await) {
            Ok(_relay) => std::future::pending::<ExitCode>().await,
            Err(code) => code,
        }
    })
}
