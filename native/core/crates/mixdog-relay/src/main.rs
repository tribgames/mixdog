//! `mixdog-relay`: with no argument the relay server; otherwise one of the operator subcommands.

use std::process::ExitCode;

use mixdog_relay::{server, tools};

const USAGE: &str = "usage: mixdog-relay [verify-release|renderer-releases|renderer-delta|reserved-ports|stun-probe|udp-sink|turn-credential] [args...]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args_os().skip(1).map(|arg| arg.to_string_lossy().into_owned()).collect();
    let Some((command, rest)) = args.split_first() else {
        return server::run_cli();
    };
    match command.as_str() {
        "verify-release" => tools::verify_release::main(rest),
        "renderer-releases" => tools::renderer_releases::main(rest),
        "renderer-delta" => tools::renderer_delta::main(rest),
        "reserved-ports" | "stun-probe" | "udp-sink" | "turn-credential" => tools::coturn::main(&args),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
