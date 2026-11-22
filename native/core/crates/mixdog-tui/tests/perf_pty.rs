//! The terminal UI's speed on a pseudo-terminal against the Node program's numbers on the same machine
//! (`tests/support/node-perf-baseline.json`, recorded from `scripts/tui-perf-run.ps1` and `scripts/tui-runtime-load-bench.mjs`
//! runs on the baseline machine): the first frame, the time from a keystroke to the frame that shows it, and the streaming
//! throughput. Each is asserted not worse than Node's. The tests are ignored: they run on the baseline machine
//! (`cargo test --offline -p mixdog-tui --test it -- --ignored perf_pty::`), one at a time.
//!
//! A number the baseline file does not hold yet fails its test with what was measured, so a machine without a recording never
//! passes by comparing with nothing.
#![allow(clippy::disallowed_methods, reason = "the test lays out files and waits on a pseudo-terminal")]

mod support;

use std::time::{Duration, Instant};

use mixdog_term::testing::VtGrid;
use support::baseline::{Baseline, median};
use support::daemon::{Setup, Workspace};
use support::provider::Reply;
use support::pty::TuiSession;

const BOOT: Duration = Duration::from_secs(90);
const STEP: Duration = Duration::from_secs(60);
const COLUMNS: u16 = 100;
const ROWS: u16 = 30;
/// Keystrokes timed one by one.
const KEYSTROKES: usize = 40;
/// Lines of the streamed answer.
const STREAM_LINES: usize = 600;

/// Not a test: the terminal UI child of the others (see `support::run_child`).
#[test]
fn tui_child() {
    support::run_child();
}

/// The lowest row with the prompt box's rounded corner.
fn prompt_top(grid: &VtGrid) -> Option<u16> {
    (0..grid.grid().height).rev().find(|&y| grid.row_text(y).contains('\u{256d}'))
}

fn prompt_text(grid: &VtGrid) -> String {
    prompt_top(grid).map(|top| grid.row_text(top + 1)).unwrap_or_default()
}

/// Starts the terminal UI and waits until the prompt box is painted.
fn first_frame(workspace: &Workspace) -> TuiSession {
    let session = TuiSession::spawn(workspace, COLUMNS, ROWS);
    session.wait_until("the first frame", BOOT, |grid| prompt_top(grid).is_some());
    session
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

#[test]
#[ignore = "perf baseline machine"]
fn first_frame_is_not_slower_than_node() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup::default());
    // The first start brings the core up; it is not the time under test.
    drop(first_frame(&workspace));
    let mut samples = Vec::new();
    for _ in 0..3 {
        let session = first_frame(&workspace);
        // The time from the start of the process to the chunk that made the frame appear.
        samples.push(ms(session.started.elapsed()));
    }
    let measured = median(&mut samples);
    let node = Baseline::load().recorded("firstFrameMs", measured).unwrap_or_else(|message| panic!("{message}"));
    assert!(measured <= node, "first frame {measured:.1} ms is slower than Node's {node:.1} ms");
}

#[test]
#[ignore = "perf baseline machine"]
fn keystroke_to_frame_is_not_slower_than_node() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup::default());
    let session = first_frame(&workspace);
    // Let the boot's background work (statusline, catalog) settle before timing.
    session.settle(Duration::from_millis(500), Duration::from_secs(10));
    let mut samples = Vec::new();
    for typed in 1..=KEYSTROKES {
        session.send("x");
        let seen = session.wait_until("the keystroke on the screen", STEP, |grid| prompt_text(grid).matches('x').count() == typed);
        samples.push(ms(seen));
        session.settle(Duration::from_millis(60), Duration::from_secs(2));
    }
    let measured = median(&mut samples);
    let node = Baseline::load().recorded("keystrokeToFrameMs", measured).unwrap_or_else(|message| panic!("{message}"));
    assert!(measured <= node, "keystroke to frame {measured:.2} ms is slower than Node's {node:.2} ms");
}

#[test]
#[ignore = "perf baseline machine"]
fn streaming_throughput_is_not_lower_than_node() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup::default());
    let session = first_frame(&workspace);
    let answer: String = (1..=STREAM_LINES).map(|n| format!("line-{n:04} {}\n", "streamed text ".repeat(4))).collect();
    workspace.provider.script(vec![Reply::streamed(&answer, 1, Duration::ZERO)]);
    session.send("stream it");
    session.wait_until("the text in the prompt", STEP, |grid| prompt_text(grid).contains("stream it"));
    let sent = Instant::now();
    session.send("\r");
    let last = format!("line-{STREAM_LINES:04}");
    session.wait_until("the last line of the answer", Duration::from_secs(180), |grid| grid.dump().iter().any(|row| row.contains(&last)));
    let seconds = sent.elapsed().as_secs_f64();
    let measured = answer.chars().count() as f64 / seconds;
    let node = Baseline::load().recorded("streamCharsPerSecond", measured).unwrap_or_else(|message| panic!("{message}"));
    assert!(measured >= node, "streaming {measured:.0} chars/s is lower than Node's {node:.0} chars/s");
}
