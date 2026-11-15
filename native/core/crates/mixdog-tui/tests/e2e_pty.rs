//! The terminal UI end to end on a pseudo-terminal: `mixdog_tui::run::run_tui` in a child process (this test binary on the
//! `tui_child` test), connected to the real core over a private root, answered by a scripted stand-in provider, read back
//! through a VT grid. Each test is a session of checkpoints on what the grid shows; every one ends with `/exit` and the
//! terminal left as a shell expects it (main screen, cursor visible).
//!
//! Needs `mixdogd` built (`cargo build --offline -p mixdog-cli --bin mixdogd`, or `MIXDOGD_BIN`) and `node` on `PATH` for
//! the core's JS runtime; the support folder says how the machine is laid out. One test runs at a time.
//!
//! The copy checkpoint (Ctrl+C after a drag selection: the OSC 52 bytes and the clipboard helper's input) runs on Unix, where
//! the helpers (`xclip`, `pbcopy`, `wl-copy`) are faked on `PATH`; on Windows the helper is the system's `clip.exe`, which
//! `PATH` cannot stand in for, so the test stops at the highlighted selection.
#![allow(clippy::disallowed_methods, reason = "the test lays out files and waits on a pseudo-terminal")]

mod support;

use std::time::Duration;

use mixdog_term::testing::VtGrid;
use mixdog_termtext::display_width;
use serde_json::json;
use support::daemon::{Setup, Workspace};
use support::provider::Reply;
use support::pty::{TuiSession, dump_text};

/// The boot: the core starts, the session is created, the first frame is painted.
const BOOT: Duration = Duration::from_secs(90);
/// One step of a session.
const STEP: Duration = Duration::from_secs(30);
const COLUMNS: u16 = 100;
const ROWS: u16 = 30;

/// Not a test: the terminal UI child of the others (see `support::run_child`).
#[test]
fn tui_child() {
    support::run_child();
}

// ---- reading the screen -----------------------------------------------------------------------------------------------

fn rows(grid: &VtGrid) -> Vec<String> {
    grid.dump()
}

fn any_row(grid: &VtGrid, needle: &str) -> bool {
    rows(grid).iter().any(|row| row.contains(needle))
}

/// The top border row of the prompt box: the lowest row with a rounded corner.
fn prompt_top(grid: &VtGrid) -> Option<u16> {
    (0..grid.grid().height).rev().find(|&y| grid.row_text(y).contains('\u{256d}'))
}

/// The first content row of the prompt box.
fn prompt_row(grid: &VtGrid) -> Option<u16> {
    prompt_top(grid).map(|top| top + 1)
}

fn prompt_text(grid: &VtGrid) -> String {
    prompt_row(grid).map(|y| grid.row_text(y)).unwrap_or_default()
}

fn frame_ready(grid: &VtGrid) -> bool {
    let Some(top) = prompt_top(grid) else { return false };
    rows(grid).iter().skip(usize::from(top)).any(|row| row.to_lowercase().contains("sonnet"))
}

/// `(row, n)` of every row that shows `row-NN`.
fn numbered_rows(grid: &VtGrid) -> Vec<(u16, u32)> {
    rows(grid)
        .iter()
        .enumerate()
        .filter_map(|(y, row)| {
            let at = row.find("row-")?;
            let digits: String = row[at + 4..].chars().take_while(char::is_ascii_digit).collect();
            Some((u16::try_from(y).ok()?, digits.parse().ok()?))
        })
        .collect()
}

// ---- driving it -----------------------------------------------------------------------------------------------------------

fn boot(workspace: &Workspace) -> TuiSession {
    let session = TuiSession::spawn(workspace, COLUMNS, ROWS);
    // An empty session opens on the project list (`useProjectPickerBoot`): the folder the run started in is its first row.
    session.wait_until("the first frame: banner and the project list", BOOT, |grid| any_row(grid, "mixdog coding agent") && any_row(grid, "Choose a project."));
    session.send("\r");
    session.wait_until("the prompt and the statusline after the project is entered", BOOT, frame_ready);
    session
}

/// Types `text` and presses Enter.
fn submit(session: &TuiSession, text: &str) {
    session.send(text);
    session.wait_until("the typed text in the prompt", STEP, |grid| prompt_text(grid).contains(text));
    session.send("\r");
}

fn mouse(session: &TuiSession, code: u32, column: usize, row: usize, press: bool) {
    session.send(&format!("\x1b[<{code};{column};{row}{}", if press { 'M' } else { 'm' }));
}

fn pause(duration: Duration) {
    std::thread::park_timeout(duration);
}

/// `/exit`, then the terminal as the shell finds it.
fn exit_and_check(mut session: TuiSession) {
    session.send("/exit");
    session.wait_until("/exit in the prompt", STEP, |grid| prompt_text(grid).contains("/exit"));
    session.send("\r");
    let mut code = session.wait_exit(Duration::from_secs(8));
    if code.is_none() {
        // The first Enter completed the palette's selection; the second runs it.
        session.send("\r");
        code = session.wait_exit(Duration::from_secs(20));
    }
    assert_eq!(code, Some(0), "the terminal UI ends with code 0 after /exit\n{}", session.screen_text());
    session.settle(Duration::from_millis(300), Duration::from_secs(5));
    session.with_grid(|grid| {
        assert!(!grid.in_alternate_screen(), "the main screen is back");
        assert!(grid.cursor_visible(), "the cursor is visible");
    });
}

fn markdown_answer() -> String {
    ["Here is the plan.", "", "```rust", "fn main() {", "    println!(\"hello\");", "}", "```", "", "| name | value |", "| --- | --- |", "| alpha | 1 |", "| beta | 2 |", "", "markdown-answer-done", ""].join("\n")
}

// ---- the sessions ------------------------------------------------------------------------------------------------------------

#[test]
fn first_frame_typing_slash_palette_and_model_picker() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup::default());
    let session = boot(&workspace);

    // The first frame: the logo, the version line with the folder, the prompt box and the statusline under it.
    session.with_grid(|grid| {
        assert!(any_row(grid, "\u{2588}\u{2588}\u{2588}\u{2557}"), "the logo\n{}", dump_text(grid));
        assert!(any_row(grid, &format!("v{}", env!("CARGO_PKG_VERSION"))), "the version line");
        assert!(prompt_top(grid).is_some_and(|top| any_row_below(grid, top, "\u{2570}")), "the prompt box is closed under its content");
    });

    // Korean and an emoji: the characters are in the prompt and the caret is on the cell after the last one.
    let typed = "\u{ac00}\u{b098}\u{1f600}x";
    session.send(typed);
    session.wait_until("the caret after the typed text", STEP, |grid| {
        let Some(y) = prompt_row(grid) else { return false };
        // One border cell and one padding cell, then the content.
        prompt_text(grid).contains(typed) && grid.cursor() == (u16::try_from(2 + display_width(typed)).unwrap_or(u16::MAX), y) && grid.cursor_visible()
    });
    session.send(&"\x7f".repeat(4));
    session.wait_until("the prompt empty again", STEP, |grid| !prompt_text(grid).contains('x') && !prompt_text(grid).contains('\u{ac00}'));

    // The slash palette filters as the user types.
    session.send("/mo");
    session.wait_until("the palette filtered to /model", STEP, |grid| any_row(grid, "Switch model for subsequent turns") && !any_row(grid, "Resume a saved chat"));
    session.send("\x7f\x7f\x7f");
    session.wait_until("the palette closed", STEP, |grid| !any_row(grid, "Switch model for subsequent turns"));

    // /model opens the picker; a selection closes it.
    session.send("/model");
    session.wait_until("/model in the prompt", STEP, |grid| prompt_text(grid).contains("/model"));
    session.send("\r");
    if session.try_wait_until(Duration::from_secs(5), |grid| any_row(grid, "Select a model")).is_none() {
        // The first Enter completed the palette's selection; the second runs it.
        session.send("\r");
    }
    session.wait_until("the model picker", STEP, |grid| any_row(grid, "Select a model"));
    session.send("\x1b[B");
    pause(Duration::from_millis(200));
    session.send("\r");
    session.wait_until("the picker closed", STEP, |grid| !any_row(grid, "Select a model"));

    exit_and_check(session);
}

fn any_row_below(grid: &VtGrid, top: u16, needle: &str) -> bool {
    rows(grid).iter().skip(usize::from(top)).any(|row| row.contains(needle))
}

#[test]
fn streamed_markdown_answer_and_tool_card_expanded_with_ctrl_o() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup::default());
    let notes: Vec<String> = (1..=14).map(|n| format!("e2e-line-{n:02}")).collect();
    let notes_path = workspace.cwd.join("notes.txt");
    std::fs::write(&notes_path, notes.join("\n")).expect("the notes file");
    let session = boot(&workspace);

    // A streamed markdown answer: the code block's lines and the table's cells reach the screen, the table as a table.
    workspace.provider.script(vec![Reply::streamed(&markdown_answer(), 1, Duration::from_millis(25))]);
    submit(&session, "show me markdown");
    session.wait_until("the markdown answer", STEP, |grid| any_row(grid, "markdown-answer-done"));
    session.with_grid(|grid| {
        let screen = dump_text(grid);
        assert!(any_row(grid, "fn main()") && any_row(grid, "println!"), "the code block\n{screen}");
        assert!(any_row(grid, "alpha") && any_row(grid, "beta"), "the table's rows\n{screen}");
        assert!(!any_row(grid, "| --- |"), "the table is rendered, not shown as source\n{screen}");
    });

    // A tool call card: collapsed, then expanded with Ctrl+O.
    workspace.provider.script(vec![Reply::calls(vec![("toolu_read_1", "read", json!({ "file_path": notes_path.display().to_string() }))]), Reply::text("read-finished")]);
    submit(&session, "read the notes");
    session.wait_until("the finished tool turn", STEP, |grid| any_row(grid, "read-finished"));
    session.with_grid(|grid| assert!(any_row(grid, "notes.txt"), "the card names the file\n{}", dump_text(grid)));
    let before = session.with_grid(|grid| any_row(grid, "e2e-line-12"));
    session.send("\x0f");
    session.wait_until("the card expanded", STEP, |grid| any_row(grid, "e2e-line-12"));
    if !before {
        session.send("\x0f");
        session.wait_until("the card collapsed again", STEP, |grid| !any_row(grid, "e2e-line-12"));
    }

    exit_and_check(session);
}

#[test]
fn scrolling_keeps_the_anchor_while_the_answer_streams_and_a_drag_selection_copies() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup::default());
    let session = boot(&workspace);

    let answer: String = (1..=70).map(|n| format!("row-{n:02} stays where it was put\n")).collect();
    workspace.provider.script(vec![Reply::streamed(&answer, 1, Duration::from_millis(40))]);
    submit(&session, "stream the rows");
    session.wait_until("row-30 on screen", STEP, |grid| numbered_rows(grid).iter().any(|(_, n)| *n >= 30));

    // PageUp while the answer is still arriving: the row the user is looking at stays on its screen row.
    let top_before = session.with_grid(|grid| numbered_rows(grid).first().map(|(_, n)| *n).unwrap_or(0));
    session.send("\x1b[5~");
    session.wait_until("the view moved up", STEP, |grid| numbered_rows(grid).first().is_some_and(|(_, n)| *n < top_before));
    let (anchor_row, anchor_n) = session.with_grid(|grid| numbered_rows(grid).first().copied().expect("a numbered row"));
    pause(Duration::from_millis(1200));
    session.with_grid(|grid| {
        assert!(numbered_rows(grid).contains(&(anchor_row, anchor_n)), "row-{anchor_n:02} stays on screen row {anchor_row} while the answer grows\n{}", dump_text(grid));
    });

    // The wheel scrolls too, and scrolling back down reaches the end of the answer.
    let top_now = session.with_grid(|grid| numbered_rows(grid).first().map(|(_, n)| *n).unwrap_or(0));
    for _ in 0..3 {
        mouse(&session, 64, 40, 12, true);
    }
    session.wait_until("the wheel scrolled up", STEP, |grid| numbered_rows(grid).first().is_none_or(|(_, n)| *n < top_now));
    for _ in 0..40 {
        mouse(&session, 65, 40, 12, true);
    }
    session.wait_until("the end of the answer", STEP, |grid| numbered_rows(grid).iter().any(|(_, n)| *n == 70));

    // A drag over part of a row highlights it; Ctrl+C copies exactly that text.
    let (target_row, column) = session.with_grid(|grid| {
        let (y, _) = numbered_rows(grid).into_iter().find(|(_, n)| *n == 60).expect("row-60 on screen");
        let text = grid.row_text(y);
        (usize::from(y), text[..text.find("row-60").expect("its text")].chars().count())
    });
    mouse(&session, 0, column + 1, target_row + 1, true);
    mouse(&session, 32, column + 4, target_row + 1, true);
    mouse(&session, 32, column + 6, target_row + 1, true);
    mouse(&session, 0, column + 6, target_row + 1, false);
    session.wait_until("the selection highlighted", STEP, |grid| {
        let style = |x: usize| grid.grid().cell(u16::try_from(x).unwrap_or(0), u16::try_from(target_row).unwrap_or(0)).map(|cell| cell.style);
        style(column + 1) != style(column + 14)
    });
    #[cfg(unix)]
    {
        let mark = session.raw_len();
        session.send("\x03");
        let mut copied = None;
        for _ in 0..100 {
            copied = support::last_osc52_text(&session.raw_since(mark));
            if copied.is_some() {
                break;
            }
            pause(Duration::from_millis(50));
        }
        let copied = copied.unwrap_or_else(|| panic!("no OSC 52 sequence after Ctrl+C\n{}", session.screen_text()));
        assert_eq!(copied.trim(), "row-60", "the OSC 52 bytes carry the selected text");
        for _ in 0..100 {
            if std::fs::read_to_string(&workspace.clipboard_out).is_ok_and(|text| text.trim() == "row-60") {
                break;
            }
            pause(Duration::from_millis(50));
        }
        assert_eq!(std::fs::read_to_string(&workspace.clipboard_out).unwrap_or_default().trim(), "row-60", "the clipboard helper's input");
    }

    exit_and_check(session);
}

#[test]
fn escape_interrupts_a_turn_and_restores_the_queued_steer_to_the_prompt() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup::default());
    let session = boot(&workspace);

    let answer: String = (0..60).map(|n| format!("chunk-{n:02} of a slow answer\n")).collect();
    workspace.provider.script(vec![Reply::streamed(&answer, 1, Duration::from_millis(250))]);
    submit(&session, "start a slow answer");
    session.wait_until("the answer under way", STEP, |grid| any_row(grid, "chunk-01"));

    // A message sent while the turn runs is queued.
    let steer = "steer-e2e-queued";
    submit(&session, steer);
    session.wait_until("the steer queued above the prompt", STEP, |grid| {
        let own = prompt_row(grid).map(usize::from);
        rows(grid).iter().enumerate().any(|(y, row)| Some(y) != own && row.contains(steer))
    });

    // Escape interrupts the turn: the answer stops and the queued text is back in the prompt for editing.
    session.send("\x1b");
    session.wait_until("the queued text restored to the prompt", STEP, |grid| prompt_text(grid).contains(steer));
    pause(Duration::from_secs(1));
    session.with_grid(|grid| assert!(!any_row(grid, "chunk-59"), "the interrupted answer does not go on\n{}", dump_text(grid)));

    // Clear the restored draft so /exit is what is typed.
    session.send(&"\x7f".repeat(steer.len() + 2));
    session.wait_until("the prompt empty", STEP, |grid| !prompt_text(grid).contains(steer));
    exit_and_check(session);
}

#[test]
fn a_tool_approval_is_answered_with_y() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup { ask_tool: Some("glob") });
    std::fs::write(workspace.cwd.join("a.txt"), "a").expect("a file to find");
    let session = boot(&workspace);

    workspace.provider.script(vec![Reply::calls(vec![("toolu_glob_1", "glob", json!({ "pattern": "*.txt" }))]), Reply::text("approved-flow-done")]);
    submit(&session, "find the text files");
    session.wait_until("the approval panel", STEP, |grid| any_row(grid, "Tool approval") && any_row(grid, "Approve once"));
    session.send("y");
    session.wait_until("the turn finished after the approval", STEP, |grid| any_row(grid, "approved-flow-done") && !any_row(grid, "Tool approval"));
    assert!(workspace.provider.served() >= 2, "the model was asked again after the tool ran");

    exit_and_check(session);
}
