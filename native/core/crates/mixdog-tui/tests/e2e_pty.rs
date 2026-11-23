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
use support::provider::{Gate, Reply};
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

/// The row that shows a welcome hint: one of the starter tips, or the tip a setup problem replaces it with.
fn welcome_hint(grid: &VtGrid) -> Option<String> {
    use mixdog_tui::view::format::{WELCOME_PROMPT_HINTS, conditional_hints};
    let conditional = [
        conditional_hints::NO_PROVIDER,
        conditional_hints::NO_MODEL,
        conditional_hints::SOLO_WORKFLOW,
        conditional_hints::WEB_SEARCH_DEFAULT_UNSUPPORTED,
        conditional_hints::ERROR,
    ];
    rows(grid).into_iter().find(|row| WELCOME_PROMPT_HINTS.iter().chain(conditional.iter()).any(|hint| row.contains(hint)))
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
    // The key counts when the list is gone: what follows is typed into the prompt of the entered project.
    session.wait_until("the prompt and the statusline after the project is entered", BOOT, |grid| !any_row(grid, "Choose a project.") && frame_ready(grid));
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

/// `/exit`, then the terminal as the shell finds it. Enter on the palette's command row runs it (`accept_slash_palette`).
fn exit_and_check(mut session: TuiSession) {
    session.send("/exit");
    session.wait_until("/exit in the prompt", STEP, |grid| prompt_text(grid).contains("/exit"));
    session.send("\r");
    let code = session.wait_exit(STEP);
    assert_eq!(code, Some(0), "the terminal UI ends with code 0 after /exit\n{}", session.screen_text());
    // The child's last bytes may still be on their way to the grid when its exit is seen.
    session.wait_until("the main screen back with the cursor visible", STEP, |grid| !grid.in_alternate_screen() && grid.cursor_visible());
}

fn markdown_answer() -> String {
    [
        "Here is the plan.",
        "",
        "```rust",
        "fn main() {",
        "    println!(\"hello\");",
        "}",
        "```",
        "",
        "| name | value |",
        "| --- | --- |",
        "| alpha | 1 |",
        "| beta | 2 |",
        "",
        "markdown-answer-done",
        "",
    ]
    .join("\n")
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
        // An empty session shows a starter tip (or the tip that names a setup problem) under the banner.
        assert!(welcome_hint(grid).is_some(), "the welcome prompt hint\n{}", dump_text(grid));
    });

    // Korean and an emoji: the characters are in the prompt and the caret is on the cell after the last one. The first character
    // typed takes the welcome hint away.
    let typed = "\u{ac00}\u{b098}\u{1f600}x";
    session.send(typed);
    session.wait_until("the welcome hint gone with the first typed character", STEP, |grid| welcome_hint(grid).is_none());
    session.wait_until("the caret after the typed text", STEP, |grid| {
        let Some(y) = prompt_row(grid) else { return false };
        // One border cell and one padding cell, then the content.
        prompt_text(grid).contains(typed) && grid.cursor() == (u16::try_from(2 + display_width(typed)).unwrap_or(u16::MAX), y) && grid.cursor_visible()
    });
    session.send(&"\x7f".repeat(4));
    session.wait_until("the prompt empty again", STEP, |grid| !prompt_text(grid).contains('x') && !prompt_text(grid).contains('\u{ac00}'));

    // The slash palette filters as the user types.
    session.send("/mo");
    session
        .wait_until("the palette filtered to /model", STEP, |grid| any_row(grid, "Switch model for subsequent turns") && !any_row(grid, "Resume a saved chat"));
    session.send("\x7f\x7f\x7f");
    session.wait_until("the palette closed", STEP, |grid| !any_row(grid, "Switch model for subsequent turns"));

    // /model opens the Model panel on its provider list (`pickers/model/picker.rs`); Enter opens the provider's models, and a
    // selection closes it.
    session.send("/model");
    session.wait_until("/model in the prompt", STEP, |grid| prompt_text(grid).contains("/model"));
    // Enter on the palette's command row runs it (`accept_slash_palette`).
    session.send("\r");
    session.wait_until("the provider list of the Model panel", STEP, |grid| any_row(grid, "Choose a provider.") && any_row(grid, "Anthropic API"));
    session.send("\r");
    session.wait_until("the model picker", STEP, |grid| any_row(grid, "Select a model"));
    // Keys that arrive in one read are taken in their order.
    session.send("\x1b[B\r");
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
    workspace
        .provider
        .script(vec![Reply::calls(vec![("toolu_read_1", "read", json!({ "file_path": notes_path.display().to_string() }))]), Reply::text("read-finished")]);
    submit(&session, "read the notes");
    session.wait_until("the finished tool turn", STEP, |grid| any_row(grid, "read-finished"));
    // A collapsed read is the aggregate card of Node (`aggregate-card.jsx`): the header counts the files ("Read 1 file") with the
    // ctrl+o hint and the row under it holds the summary; the file's own text and path are the expanded view's.
    session.with_grid(|grid| {
        assert!(any_row(grid, "Read 1 file") && any_row(grid, "ctrl+o expand"), "the card counts the file and offers ctrl+o\n{}", dump_text(grid))
    });
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
    let workspace = Workspace::new(Setup { ask_tool: Some("glob") });
    let session = boot(&workspace);

    // The stand-in holds the answer after row-45, so the view is paged up while the rest is still to come. The answer ends with a
    // call whose approval panel shows over the scrolled view only once the rows before it are in: the growth is on screen then.
    // The answer after the call is held before its message ends, so the drag below is made on a screen nothing moves, and the
    // turn then ends under the released selection.
    let answer: String = (1..=80).map(|n| format!("row-{n:02} stays where it was put\n")).collect();
    let (rest, end) = (Gate::default(), Gate::default());
    let mut streamed = Reply::streamed(&answer, 1, Duration::ZERO);
    streamed.holds = vec![(45, rest.clone())];
    streamed.calls = vec![("toolu_glob_1".to_owned(), "glob".to_owned(), json!({ "pattern": "*.none" }))];
    // A streaming answer shows its completed lines only (`mixdog-session-view` `live_fields`): the held one ends its line.
    let after = Reply { chunks: vec!["rows-done\n".to_owned()], holds: vec![(1, end.clone())], ..Reply::default() };
    workspace.provider.script(vec![streamed, after]);
    submit(&session, "stream the rows");
    // PageUp moves 60 percent of the screen: 18 rows of 30 (`use-global-key-input.mjs`). The view is read once the newest rows are
    // far enough from the first for a page and then the wheel to still have rows to go up.
    session.wait_until("row-45 on screen", STEP, |grid| numbered_rows(grid).iter().any(|(_, n)| *n == 45));

    // PageUp while the answer is still arriving: the row the user is looking at stays on its screen row.
    let top_before = session.with_grid(|grid| numbered_rows(grid).first().map(|(_, n)| *n).unwrap_or(0));
    session.send("\x1b[5~");
    session.wait_until("the view moved up", STEP, |grid| numbered_rows(grid).first().is_some_and(|(_, n)| *n < top_before));
    let (anchor_row, anchor_n) = session.with_grid(|grid| numbered_rows(grid).first().copied().expect("a numbered row"));
    rest.open();
    session.wait_until("the approval panel after the rest of the answer", STEP, |grid| any_row(grid, "Tool approval") && any_row(grid, "Approve once"));
    session.with_grid(|grid| {
        assert!(
            numbered_rows(grid).contains(&(anchor_row, anchor_n)),
            "row-{anchor_n:02} stays on screen row {anchor_row} while the answer grows\n{}",
            dump_text(grid)
        );
    });
    session.send("y");
    session.wait_until("the approval panel closed", STEP, |grid| !any_row(grid, "Tool approval"));

    // The wheel scrolls too, and scrolling back down reaches the end of the answer.
    let top_now = session.with_grid(|grid| numbered_rows(grid).first().map(|(_, n)| *n).unwrap_or(0));
    for _ in 0..3 {
        mouse(&session, 64, 40, 12, true);
    }
    session.wait_until("the wheel scrolled up", STEP, |grid| numbered_rows(grid).first().is_none_or(|(_, n)| *n < top_now));
    for _ in 0..40 {
        mouse(&session, 65, 40, 12, true);
    }
    session.wait_until("the end of the answer and the answer after the call", STEP, |grid| {
        numbered_rows(grid).iter().any(|(_, n)| *n == 80) && any_row(grid, "rows-done")
    });

    // A drag over part of a row highlights it; the turn ends under the released selection, and Ctrl+C copies exactly that text.
    let (target_row, column) = session.with_grid(|grid| {
        let (y, _) = numbered_rows(grid).into_iter().find(|(_, n)| *n == 70).expect("row-70 on screen");
        let text = grid.row_text(y);
        (usize::from(y), text[..text.find("row-70").expect("its text")].chars().count())
    });
    mouse(&session, 0, column + 1, target_row + 1, true);
    mouse(&session, 32, column + 4, target_row + 1, true);
    mouse(&session, 32, column + 6, target_row + 1, true);
    mouse(&session, 0, column + 6, target_row + 1, false);
    let highlighted = |grid: &VtGrid, row: usize| {
        let style = |x: usize| grid.grid().cell(u16::try_from(x).unwrap_or(0), u16::try_from(row).unwrap_or(0)).map(|cell| cell.style);
        style(column + 1) != style(column + 14)
    };
    session.wait_until("the selection highlighted", STEP, |grid| highlighted(grid, target_row));
    // The turn ends: its completion line goes under the answer and the followed view moves row-70 up; the copy is made once the
    // screen shows that, with the highlight on row-70 at its new row.
    end.open();
    session.wait_until("the turn ended with the selection on row-70 at its new row", STEP, |grid| {
        let at = numbered_rows(grid).into_iter().find(|(_, n)| *n == 70).map(|(y, _)| usize::from(y));
        any_row(grid, "Work complete") && at.is_some_and(|y| y != target_row && highlighted(grid, y))
    });
    #[cfg(unix)]
    {
        // The fake helper writes into a pipe the test reads to its end: its whole input, whenever it runs.
        let made = std::process::Command::new("mkfifo").arg(&workspace.clipboard_out).status().expect("mkfifo runs");
        assert!(made.success(), "the clipboard pipe is made");
        let (told, helper_input) = std::sync::mpsc::channel();
        let pipe = workspace.clipboard_out.clone();
        std::thread::spawn(move || told.send(std::fs::read_to_string(pipe)));
        let mark = session.raw_len();
        session.send("\x03");
        let copied =
            session.try_wait_raw(mark, STEP, support::last_osc52_text).unwrap_or_else(|| panic!("no OSC 52 sequence after Ctrl+C\n{}", session.screen_text()));
        assert_eq!(copied.trim(), "row-70", "the OSC 52 bytes carry the selected text");
        let given = helper_input.recv_timeout(STEP).expect("the clipboard helper ran").expect("the clipboard pipe is read");
        assert_eq!(given.trim(), "row-70", "the clipboard helper's input");
    }

    exit_and_check(session);
}

#[test]
fn escape_interrupts_a_turn_and_the_queued_steer_runs_next() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup::default());
    let session = boot(&workspace);

    // The stand-in holds the answer after its second delta and is never let go: the turn runs until Escape ends it.
    let answer: String = (0..60).map(|n| format!("chunk-{n:02} of a slow answer\n")).collect();
    let mut held = Reply::streamed(&answer, 1, Duration::ZERO);
    held.holds = vec![(2, Gate::default())];
    workspace.provider.script(vec![held, Reply::text("steer-answer-e2e")]);
    submit(&session, "start a slow answer");
    session.wait_until("the answer under way", STEP, |grid| any_row(grid, "chunk-01"));

    // A message sent while the turn runs is queued.
    let steer = "steer-e2e-queued";
    submit(&session, steer);
    session.wait_until("the steer queued above the prompt", STEP, |grid| {
        let own = prompt_row(grid).map(usize::from);
        rows(grid).iter().enumerate().any(|(y, row)| Some(y) != own && row.contains(steer))
    });

    // Escape interrupts the turn and the answer stops. A steering message already queued means the user redirected the turn, so it
    // runs next and the interrupted prompt is not put back into the box (`abort.mjs`: `hasPendingSteering`; the prompt input's
    // Escape restores the interrupted prompt only into an empty box, and the queue back into the box only while idle).
    session.send("\x1b");
    session.wait_until("the steering message's answer", STEP, |grid| any_row(grid, "steer-answer-e2e"));
    session.with_grid(|grid| {
        assert!(any_row(grid, "Cancelled"), "the interrupted turn is marked\n{}", dump_text(grid));
        assert!(!any_row(grid, "chunk-59"), "the interrupted answer does not go on\n{}", dump_text(grid));
        assert!(
            !prompt_text(grid).contains("start a slow answer") && !prompt_text(grid).contains(steer),
            "nothing is put back into the box\n{}",
            dump_text(grid)
        );
    });
    assert!(workspace.provider.served() >= 2, "the model was asked again for the steering message");
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

#[test]
fn a_question_of_ask_user_is_answered_by_key() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup::default());
    let session = boot(&workspace);

    let questions = json!({ "questions": [{
        "question": "Which flavor do you want?",
        "header": "Flavor",
        "options": [
            { "label": "Vanilla", "description": "plain and classic" },
            { "label": "Mango", "description": "sweet and fruity" }
        ]
    }] });
    workspace.provider.script(vec![Reply::calls(vec![("toolu_ask_1", "ask_user", questions)]), Reply::text("question-flow-done")]);
    submit(&session, "ask me something");
    // The question panel: the question, its options, and the keys that answer it.
    session.wait_until("the question panel", STEP, |grid| any_row(grid, "Which flavor do you want?") && any_row(grid, "Vanilla") && any_row(grid, "Mango"));
    // Down moves to the second option, Enter answers with it.
    session.send("\x1b[B");
    // The option rows lead with `› ` on the highlighted one (`question.rs`); the card above may name the options too.
    session.wait_until("Mango highlighted", STEP, |grid| rows(grid).iter().any(|row| row.contains("Mango") && row.contains("\u{203a} ")));
    session.send("\r");
    session.wait_until("the turn finished after the answer", STEP, |grid| any_row(grid, "question-flow-done") && !any_row(grid, "Vanilla"));
    // The transcript records the answer that was given, the second option.
    session.with_grid(|grid| assert!(any_row(grid, "=\"Mango\""), "the card shows the answer\n{}", dump_text(grid)));
    assert!(workspace.provider.served() >= 2, "the model was asked again after the answer");

    exit_and_check(session);
}

/// The row of the screen that shows `needle`.
fn row_with(grid: &VtGrid, needle: &str) -> Option<String> {
    rows(grid).into_iter().find(|row| row.contains(needle))
}

#[test]
fn the_spinner_row_runs_above_the_prompt_while_a_turn_streams() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup::default());
    let session = boot(&workspace);

    // The model answers with blank deltas first: nothing readable is on screen yet, so the spinner row stays (it gives way to the
    // answer once text shows, `live-spinner-visibility.mjs`). The stand-in holds the answer until the row has moved with the clock.
    let mut chunks: Vec<String> = vec!["\n".to_owned(); 14];
    chunks.push("spinner-answer-done".to_owned());
    let answer = Gate::default();
    workspace.provider.script(vec![Reply { chunks, holds: vec![(14, answer.clone())], ..Reply::default() }]);
    submit(&session, "think for a while");
    session.wait_until("the spinner row with the interrupt hint", STEP, |grid| row_with(grid, "esc to interrupt").is_some());
    let first = session.with_grid(|grid| row_with(grid, "esc to interrupt")).expect("the spinner row");
    assert!(first.contains('(') && first.contains(')'), "the byline is in parentheses: {first:?}");
    // It sits above the prompt box, not under it.
    session.with_grid(|grid| {
        let at = rows(grid).iter().position(|row| row.contains("esc to interrupt")).expect("its row");
        assert!(prompt_top(grid).is_some_and(|top| usize::from(top) > at), "the spinner row is above the prompt box\n{}", dump_text(grid));
    });
    // The timer and the glyph move with the clock.
    session.wait_until("the row changed with the clock", STEP, |grid| row_with(grid, "esc to interrupt").is_some_and(|row| row != first));
    answer.open();
    // The answer replaces it, and the row is gone once the turn is.
    session.wait_until("the answer", STEP, |grid| any_row(grid, "spinner-answer-done"));
    session.wait_until("the spinner row gone", STEP, |grid| !any_row(grid, "esc to interrupt"));

    exit_and_check(session);
}

#[test]
fn the_api_key_prompt_takes_typing_a_paste_and_escape_and_masks_the_key() {
    let _gate = support::serial();
    let workspace = Workspace::new(Setup::default());
    let session = boot(&workspace);

    // /providers, the OpenAI API row, its "Add API key" action: the masked key prompt.
    session.send("/providers");
    session.wait_until("/providers in the prompt", STEP, |grid| prompt_text(grid).contains("/providers"));
    // Enter on the palette's command row runs it (`accept_slash_palette`).
    session.send("\r");
    session.wait_until("the provider list", STEP, |grid| any_row(grid, "Choose a provider.") && any_row(grid, "OpenAI API"));
    // Keys that arrive in one read are taken in their order.
    session.send(&format!("{}\r", "\x1b[B".repeat(6)));
    session.wait_until("the API-key actions", STEP, |grid| any_row(grid, "Choose an API-key action.") && any_row(grid, "Add API key"));
    session.send("\r");
    session.wait_until("the key prompt", STEP, |grid| any_row(grid, "Set API key") && any_row(grid, "API key >"));

    // Typing: the characters go into the field and the screen shows a mask, never the key.
    let key_row = |grid: &VtGrid| row_with(grid, "API key >").unwrap_or_default();
    session.send("sk-secret-1234");
    session.wait_until("fourteen masked characters", STEP, |grid| key_row(grid).matches('*').count() == 14);
    session.with_grid(|grid| assert!(!any_row(grid, "sk-secret"), "the key is not on screen\n{}", dump_text(grid)));
    // Backspace removes the last one.
    session.send("\x7f");
    session.wait_until("thirteen masked characters", STEP, |grid| key_row(grid).matches('*').count() == 13);
    // A bracketed paste is inserted as text; its line break does not submit and the pasted key stays off the screen.
    session.send("\x1b[200~pasted-part\x1b[201~");
    session.wait_until("the pasted characters", STEP, |grid| key_row(grid).matches('*').count() == 13 + "pasted-part".len());
    session.with_grid(|grid| assert!(!any_row(grid, "pasted-part"), "the pasted key is not on screen\n{}", dump_text(grid)));
    // Escape cancels: the panel is gone and the prompt is back (nothing was saved).
    session.send("\x1b");
    session.wait_until("the key prompt closed", STEP, |grid| !any_row(grid, "Set API key") && frame_ready(grid));

    exit_and_check(session);
}
