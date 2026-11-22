//! The RUSTC_WORKSPACE_WRAPPER of the gate's core builds (.github/actions/rustc-threads): compiles each workspace crate with
//! rustc's parallel front end, as the local build's wrapper does (rustc-slot under cargo-gate.ps1). The longest chain of the
//! build is one large crate after another (mixdog-core-session, mixdog-core, its test build), each spending most of its time in
//! the single-threaded front end while the runner's other cores have nothing to do. `-Zthreads` is unstable on the pinned
//! stable toolchain, so RUSTC_BOOTSTRAP is set for that one compiler process only: set for the whole build, it would reach the
//! compiler probes of build scripts, and proc-macro2 would turn its nightly code on. A compiler crash (exit 101) compiles
//! again without the flag.
//!
//!   MIXDOG_RUSTC_THREADS: threads per compiler (default 4; 0 or 1: the plain compiler)
use std::env;
use std::ffi::OsString;
use std::process::{exit, Command};

fn main() {
    let mut args = env::args_os().skip(1);
    let rustc = args.next().unwrap_or_else(|| {
        eprintln!("rustc-threads: no compiler given");
        exit(2)
    });
    let rest: Vec<OsString> = args.collect();
    let threads = env::var("MIXDOG_RUSTC_THREADS").unwrap_or_else(|_| "4".to_owned());
    // Cargo's version and target probes, and a build script's own probes (CARGO_CFG_TARGET_OS is set only while one runs).
    let probe = env::var_os("CARGO_CFG_TARGET_OS").is_some()
        || rest.iter().any(|a| a == "-vV" || a == "--version" || a == "-" || a.to_string_lossy().starts_with("--print"));
    let run = |parallel: bool| {
        let mut command = Command::new(&rustc);
        command.args(&rest);
        if parallel {
            command.arg(format!("-Zthreads={threads}")).env("RUSTC_BOOTSTRAP", "1");
        }
        match command.status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                eprintln!("rustc-threads: cannot run {}: {error}", rustc.to_string_lossy());
                1
            }
        }
    };
    if probe || threads == "0" || threads == "1" {
        exit(run(false));
    }
    let code = run(true);
    if code == 101 {
        // A warning annotation in the log and a line of the job summary for every such compile: the plain compiler's verdict
        // follows, and a real compiler crash repeats in it.
        let name = rest.iter().position(|a| a == "--crate-name").and_then(|i| rest.get(i + 1)).map(|a| a.to_string_lossy().into_owned()).unwrap_or_default();
        println!("::warning title=rustc-threads::{name}: the compiler crashed with the parallel front end (exit 101); compiling again without it");
        eprintln!("rustc-threads: {name}: the compiler crashed with the parallel front end (exit 101); compiling again without it");
        if let Some(summary) = env::var_os("GITHUB_STEP_SUMMARY") {
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(summary) {
                let _ = std::io::Write::write_all(&mut file, format!("- rustc-threads: `{name}` crashed with `-Zthreads` (exit 101) and was compiled again without it\n").as_bytes());
            }
        }
        exit(run(false));
    }
    exit(code);
}
