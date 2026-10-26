//! Mixdog secure-desktop bridge: a LocalSystem Windows service plus a SYSTEM
//! session helper that lets the Mixdog app see and drive the secure desktop
//! (UAC consent, lock / sign-in screen) and the ordinary desktop over a local,
//! secret-gated named pipe. Built for the upcoming remote-desktop feature; the
//! WebRTC transport that streams frames to the phone and relays input is a
//! separate effort and not part of this crate.
//!
//! One executable, several roles selected by the first argument:
//!   service    SCM entry point; runs as LocalSystem (installed, not run by hand)
//!   helper     launched by the service into the active console session
//!   install    elevated: create secret + state, register and start the service
//!   uninstall  elevated: stop and delete the service, remove all state
//!   status     report installed / running / version as JSON (no elevation)
//!   probe      manual-test client over the pipe (run as the installing user)

// Pure, portable modules: the wire contract and the security logic. These carry
// the unit tests and build on any host.
mod paths;
mod protocol;
mod security;

// Lifecycle logging is std-only and useful everywhere.
mod log;

#[cfg(windows)]
mod acl;
#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod helper;
#[cfg(windows)]
mod inject;
#[cfg(windows)]
mod install;
#[cfg(windows)]
mod ipc;
#[cfg(windows)]
mod launch;
#[cfg(windows)]
mod probe;
#[cfg(windows)]
mod service;
#[cfg(windows)]
mod shutdown;
#[cfg(windows)]
mod winutil;

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("service") => service::run(),
        Some("helper") => helper::run(&args[1..]),
        Some("install") => install::install(),
        Some("uninstall") => install::uninstall(),
        Some("status") => install::status(),
        Some("probe") => probe::run(&args[1..]),
        other => {
            eprintln!(
                "mixdog-secure-desktop: unknown command {:?}\n\
                 commands: service | helper | install | uninstall | status | probe",
                other.unwrap_or("")
            );
            2
        }
    };
    std::process::exit(code);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("mixdog-secure-desktop runs only on Windows");
    std::process::exit(2);
}
