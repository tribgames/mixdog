//! A worker with scripted methods, for the pool's end-to-end tests (`tests/pool_e2e.rs`). Development only (feature `test-support`).
//!
//! - `echo`: answers `{params, paths, thread}`.
//! - `chunks {bytes, fill}`: emits that many bytes, answers `{sent}`.
//! - `sleep {ms}`: waits that long, or until cancelled (cooperative).
//! - `spin`: never returns and never looks at the cancel (CPU-bound code that ignores it).
//! - `panic`: panics.
//! - `pin {pin}`: answers the worker's process id and reports `pin`.
#![allow(
    clippy::disallowed_methods,
    reason = "a test worker: its sleep method waits on the real clock, which no replay drives"
)]

use std::process::ExitCode;
use std::time::Duration;

use mixdog_exthost_worker::Outcome;
use mixdog_exthost_worker::Registry;
use serde_json::json;

fn registry() -> Registry {
    let mut registry = Registry::new();
    registry.register("echo", |ctx| async move {
        Ok(Outcome::value(
            json!({"params": ctx.params, "paths": ctx.paths, "thread": ctx.thread}),
        ))
    });
    registry.register("chunks", |ctx| async move {
        let bytes = ctx.params["bytes"].as_u64().unwrap_or(0) as usize;
        let fill = ctx.params["fill"].as_u64().unwrap_or(7) as u8;
        ctx.emit(&vec![fill; bytes]).await?;
        Ok(Outcome::value(json!({"sent": bytes})))
    });
    registry.register("sleep", |ctx| async move {
        let ms = ctx.params["ms"].as_u64().unwrap_or(0);
        tokio::select! {
            () = ctx.cancel.cancelled() => {}
            () = tokio::time::sleep(Duration::from_millis(ms)) => {}
        }
        Ok(Outcome::value(json!(std::process::id())))
    });
    registry.register_blocking("spin", |_| {
        loop {
            std::hint::spin_loop();
        }
    });
    registry.register("panic", |_| async move {
        let nothing: Option<Outcome> = None;
        Ok(nothing.expect("boom from ext_worker_dev"))
    });
    registry.register("pin", |ctx| async move {
        let pid = json!(std::process::id());
        Ok(if ctx.params["pin"].as_bool() == Some(true) {
            Outcome::pinned(pid)
        } else {
            Outcome::value(pid)
        })
    });
    registry
}

fn main() -> ExitCode {
    let (input, output) = match mixdog_exthost_worker::run::stdio() {
        Ok(pipes) => pipes,
        Err(error) => {
            eprintln!("ext-host: cannot take the frame pipes: {error}");
            return ExitCode::from(1);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("ext-host: cannot start the runtime: {error}");
            return ExitCode::from(1);
        }
    };
    let code = runtime.block_on(mixdog_exthost_worker::serve(registry(), input, output));
    // The blocked read of standard input and a handler that never returns must not hold the process.
    runtime.shutdown_background();
    code
}
