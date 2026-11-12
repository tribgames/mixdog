//! A test-only end of `mixdogd serve` right after the crash recorder is installed (`MIXDOG_TEST_BOOT_FAULT`): what a
//! recording of Node's ends (an uncaught exception, a fatal boot error, an exit with no reason, a kill, an abort that runs
//! no hook) needs the real start-up to do. Compiled only into a build that asks for `crash-gates`.
#![allow(clippy::disallowed_methods, reason = "a test build's fault point reads its variables, the launcher's stdin and ends the process")]

use std::io::BufRead;
use std::io::Write;

const SCENARIO: &str = "MIXDOG_TEST_BOOT_FAULT";
/// The text a scenario fails with (the recording's message or boot error).
const TEXT: &str = "MIXDOG_TEST_BOOT_FAULT_TEXT";

fn scenario() -> Option<String> {
    std::env::var(SCENARIO).ok()
}

fn expect(lines: &mut impl Iterator<Item = std::io::Result<String>>, line: &str) {
    assert_eq!(lines.next().expect("the launcher's line").expect("stdin"), line);
}

/// A launcher writes the boot's sidecar once it knows this process's id: the process waits for its `go` line before it
/// installs the recorder (a `next-boot` has no launcher).
pub fn wait_for_launcher() {
    if scenario().is_some_and(|scenario| scenario != "next-boot") {
        expect(&mut std::io::stdin().lock().lines(), "go");
    }
}

/// The scenario's end, in place of the start-up it replaces; `None` when none is asked for.
pub fn run() -> Option<Result<(), String>> {
    let scenario = scenario()?;
    let text = std::env::var(TEXT).unwrap_or_default();
    let mut lines = std::io::stdin().lock().lines();
    use mixdog_app_server_daemon::crash_record::record_exit;
    use mixdog_app_server_daemon::crash_record::settle_exit;
    Some(match scenario.as_str() {
        // The start-up itself, no fault added: whatever it fails on is the end (the launcher still names it first).
        "real" => return None,
        "main-panic" => panic!("{text}"),
        "fatal-error" => Err(text),
        "exit-code" => {
            record_exit(3);
            std::process::exit(3)
        }
        "killed" => {
            println!("installed");
            std::io::stdout().flush().unwrap();
            expect(&mut lines, "never");
            Ok(())
        }
        "stack-overflow" => {
            fn deeper(n: u64) -> u64 {
                let frame = [n; 512];
                std::hint::black_box(&frame);
                deeper(n + 1) + frame[0]
            }
            std::process::exit(std::thread::Builder::new().stack_size(64 * 1024).spawn(|| deeper(0)).unwrap().join().map_or(1, |_| 0))
        }
        "oom" => std::alloc::handle_alloc_error(std::alloc::Layout::from_size_align(1 << 40, 8).unwrap()),
        "next-boot" => Ok(()),
        "caught-panic" => {
            let worker = std::thread::Builder::new().name("worker".into()).spawn(move || panic!("{text}")).unwrap();
            assert!(worker.join().is_err(), "the worker panicked");
            println!("caught");
            std::io::stdout().flush().unwrap();
            expect(&mut lines, "stop");
            let code = settle_exit("no live session clients", 0);
            record_exit(code);
            std::process::exit(code)
        }
        other => panic!("no boot fault {other}"),
    })
}
