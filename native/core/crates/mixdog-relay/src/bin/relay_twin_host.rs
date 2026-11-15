//! The scripted relay the twin tests drive: `relay_twin_host '<knob json>'` (see `mixdog_relay::server::twin`).

fn main() -> std::process::ExitCode {
    mixdog_relay::server::twin::main()
}
