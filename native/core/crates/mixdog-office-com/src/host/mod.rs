//! The process Microsoft Office automation runs in: `mixdogd office-com-host` (one request, one answer) and
//! `mixdogd office-com-host --session` (one request per line until stdin ends). It speaks the line protocol of the
//! PowerShell hosts it replaces and carries the guarantee they gave: whatever happens to a request, the cleanup of the
//! document and the application the host owns runs before the process ends.
//!
//! * [`apartment`]: the single-threaded apartment, the stdin reader and the wait that keeps dispatching window messages.
//! * [`oneshot`] and [`session_loop`]: the two protocols.
//! * [`emit`]: the answer lines and the cleanup lines.
//! * [`handlers`]: the operations the protocols call, and where they are registered.
//!
//! The host builds its own lane runtime and runs the apartment thread as a job of the maintenance lane, so file work on
//! that thread has a lane proof ([`HostEnv::lane`]). Every path ends the same way: the handler is dropped (and with it every
//! COM handle it held), the apartment is left, and only then does [`run`] answer the exit code; nothing calls
//! `std::process::exit` with a COM reference alive, since an unreleased reference to an Office application keeps that
//! process running until COM's rundown.

pub mod apartment;
pub mod emit;
pub mod handlers;
pub mod ledger;
pub mod oneshot;
pub mod session_loop;

use std::ffi::OsString;

use mixdog_rt::Backend;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::RtConfig;
use tokio_util::sync::CancellationToken;

pub use emit::Emitter;
pub use handlers::Closed;
pub use handlers::Handlers;
pub use handlers::HostEnv;
pub use handlers::OneShotHandler;
pub use handlers::SessionHandler;

use apartment::Input;

/// The flag of the long-lived host.
pub const SESSION_FLAG: &str = "--session";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_flag_is_the_one_the_transport_passes() {
        assert_eq!(crate::session::host_args(true, std::path::Path::new("d"))[..2], [OsString::from("office-com-host"), OsString::from(SESSION_FLAG)]);
    }
}



/// The host with the registered operations. `args` are the arguments after `office-com-host`. Answers the exit code.
pub fn run(args: &[OsString]) -> i32 {
    run_with(args, handlers::registered())
}
/// The host with the given parts (the test host registers its own operations and apartment).
pub fn run_with(args: &[OsString], parts: Handlers) -> i32 {
    let session = args.iter().any(|arg| arg == SESSION_FLAG);
    let data_dir = ledger::data_dir_from_args(args);
    // A panic inside a request is answered as an error line with its text; the default report on stderr would only be noise
    // for the transport, which reads that stream for cleanup lines and failure text.
    std::panic::set_hook(Box::new(|_| {}));
    let (executors, tokens) = match mixdog_rt::exec::boot(RtConfig::for_cores(1)) {
        Ok(booted) => booted,
        Err(error) => {
            eprintln!("mixdogd office-com-host: starting the executors: {error}");
            return 1;
        }
    };
    let (sender, inbox) = match apartment::channel() {
        Ok(channel) => channel,
        Err(error) => {
            eprintln!("mixdogd office-com-host: {error}");
            return 1;
        }
    };
    let reader = std::thread::Builder::new()
        .name("office-com-host-stdin".to_owned())
        .spawn(move || apartment::pump(session, std::io::stdin(), &sender));
    if let Err(error) = reader {
        eprintln!("mixdogd office-com-host: starting the stdin reader: {error}");
        return 1;
    }
    let job = tokens.maintenance_io.submit(&CancellationToken::new(), move |lane| host(lane, session, data_dir.as_deref(), parts, &inbox));
    match job {
        Ok(handle) => match executors.handle(TaskClass::Work).block_on(handle) {
            Ok(code) => code,
            Err(error) => {
                eprintln!("mixdogd office-com-host: the host thread ended without an exit code: {error}");
                1
            }
        },
        Err(full) => {
            eprintln!("mixdogd office-com-host: {full}");
            1
        }
    }
}
/// The apartment thread: enters the apartment, serves until the protocol ends, and gives everything back in order.
fn host(lane: &InLane<MaintenanceIo>, session: bool, data_dir: Option<&std::path::Path>, parts: Handlers, inbox: &apartment::Inbox) -> i32 {
    let Handlers { apartment, one_shot, session: session_factory } = parts;
    let mut out = Emitter::stdio();
    let apartment = match apartment() {
        Ok(apartment) => apartment,
        Err(message) => {
            out.line(&emit::error_answer(&message));
            return 1;
        }
    };
    let env = HostEnv::new(lane, data_dir);
    let code = if session {
        let mut handler = session_factory(env);
        let code = session_loop::run(&mut *handler, &mut out, inbox);
        drop(handler);
        code
    } else {
        let text = match inbox.recv() {
            Some(Input::Text(text)) => text,
            _ => String::new(),
        };
        let mut handler = one_shot(env);
        let code = oneshot::run(&mut *handler, &mut out, &text);
        drop(handler);
        code
    };
    drop(apartment);
    code
}
