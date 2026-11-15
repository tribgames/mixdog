//! The Node pieces of the coturn provisioning as subcommands of the relay binary, so the relay host needs no node for them:
//! `reserved-ports`, `stun-probe`, `udp-sink` and `turn-credential` (the credential `verify-turn.sh` hands `turnutils_uclient`).

pub mod credential;
pub mod reserved_ports;
pub mod stun_probe;
pub mod udp_sink;

use std::process::ExitCode;

/// `args[0]` is the subcommand name, the rest its arguments.
pub fn main(args: &[String]) -> ExitCode {
    let Some((command, rest)) = args.split_first() else { return ExitCode::from(2) };
    match command.as_str() {
        "reserved-ports" => reserved_ports::main(rest),
        "stun-probe" => stun_probe::main(rest),
        "udp-sink" => udp_sink::main(rest),
        "turn-credential" => credential::main(rest),
        _ => ExitCode::from(2),
    }
}
