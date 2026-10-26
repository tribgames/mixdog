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
//!   install    admin-gated: create secret + state, register and start the
//!              service, and enroll zero or more phone keys (--controller-key).
//!              Elevated (UAC) or, with --logon, under a batch-logon admin
//!              token from a password on stdin.
//!   enroll     admin-gated (UAC, --logon, or --delegated): add --controller-key
//!              values (and apply --revoke-key values) to an installed helper
//!   revoke     admin-gated (UAC, --logon, or --delegated): remove the given
//!              --controller-key values
//!   disable-delegation
//!              admin-gated (UAC or --logon): turn off app-delegated enroll/revoke
//!   uninstall  elevated: stop and delete the service, remove all state
//!   status     report installed / running / version as JSON (no elevation)
//!   check      exit 0 current / 1 missing / 2 stale / 4 other-user (no
//!              elevation; the app's decision whether to install / uninstall)
//!   start      start the installed demand-start service (no elevation; the
//!              install granted the user start rights) — used after a reboot
//!   verify-image [path]  check an image (default: this one) against the
//!              release signer pinned at build time, as `install` does
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
mod delegation;
#[cfg(windows)]
mod install;
#[cfg(windows)]
mod ipc;
#[cfg(windows)]
mod logon;
#[cfg(windows)]
mod launch;
#[cfg(windows)]
mod probe;
#[cfg(windows)]
mod service;
#[cfg(windows)]
mod signature;
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
        Some("install") => install::install(&args[1..]),
        Some("enroll") => install::enroll(&args[1..]),
        Some("revoke") => install::revoke(&args[1..]),
        Some("disable-delegation") => install::disable_delegation(&args[1..]),
        Some("uninstall") => install::uninstall(&args[1..]),
        Some("status") => install::status(),
        Some("check") => install::check(&args[1..]),
        Some("start") => install::start(),
        Some("verify-image") => install::verify_image(&args[1..]),
        Some("probe") => probe::run(&args[1..]),
        other => {
            eprintln!(
                "mixdog-secure-desktop: unknown command {:?}\n\
                 commands: service | helper | install | enroll | revoke | disable-delegation | uninstall | status | check | start | verify-image | probe",
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
