//! The Rust editor against what the Node editor does (tests/goldens/editor.json, recorded by
//! tests/recorders/record-editor.mjs): the text functions at every offset, the wrapped geometry, the deletions and moves from
//! many drafts, the escape, restore and interrupt policies, the key-signal recognisers, the rows Ink's hard wrap makes of a
//! prompt value, and whole key sessions (draft, callback calls, undo depth and escape arming after every event).
//!
//! The live check, which runs the recorder on a Node checkout and compares its fresh output with Rust, is `live_editor`; it
//! only runs where node and the tree exist (`cargo test -p mixdog-tui -- --ignored live_editor`).

use std::sync::atomic::{AtomicU64, Ordering};

use mixdog_term::KeyFlags;
use mixdog_tui::editor::draft::Draft;
use mixdog_tui::editor::editing::{
    caret_position, delete_backward_word, delete_forward_word, delete_selected_text, delete_to_line_end,
    delete_to_line_start, line_end, line_start, move_cursor, next_offset, next_word_offset, offset_at_cell,
    previous_offset, previous_word_offset, replace_selection, selection_range, vertical_offset, word_range_at,
};
use mixdog_tui::editor::escape::{EscapeInput, classify_prompt_escape};
use mixdog_tui::editor::helpers::{
    HintTone, csi_body, delete_backward_char, delete_forward_char, is_any_modified_enter_sequence,
    is_modified_enter_sequence, left_arrow_offset, normalize_pasted_text, right_arrow_offset,
    single_trailing_line_break_prefix,
};
use mixdog_tui::editor::interrupt::{InterruptResult, prompt_interrupt_restore_text};
use mixdog_tui::editor::prompt::{
    BoxLayout, EscapePhase, HistoryDirection, PaletteNav, PaletteReply, PasteReply, PasteSource, PromptCallbacks,
    PromptEditor, PromptProps, RestoreRequest,
};
use mixdog_tui::editor::render::{PromptView, render_prompt};
use mixdog_tui::editor::restore::{
    merge_queued_restore_draft, palette_owns_prompt_vertical_arrow, queued_restore_prefix, queued_restore_projection,
    replace_queued_restore_prefix,
};
use mixdog_tui::editor::signals::{
    decode_arrow_signals, is_csi_private_reply, is_discarded_control_input, is_mouse_report_sequence,
    printable_from_input,
};
use serde_json::Value;

const GOLDEN: &str = include_str!("goldens/editor.json");

static NOW: AtomicU64 = AtomicU64::new(0);

fn clock() -> u64 {
    NOW.load(Ordering::SeqCst)
}

/// Collects the first mismatches of a group of cases.
#[derive(Default)]
struct Mismatches(Vec<String>);

impl Mismatches {
    fn expect<T: PartialEq + std::fmt::Debug>(&mut self, what: &str, got: T, want: T) {
        if got != want && self.0.len() < 12 {
            self.0.push(format!("{what}: got {got:?}, want {want:?}"));
        }
    }

    fn finish(self, group: &str) {
        assert!(self.0.is_empty(), "{group}: {} mismatches, first:\n{}", self.0.len(), self.0.join("\n"));
    }
}

fn cases(kind: &str) -> Vec<Value> {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden parses");
    golden["cases"].as_array().expect("cases").iter().filter(|case| case["t"] == kind).cloned().collect()
}

fn text_of(value: &Value) -> &str {
    value.as_str().expect("string")
}

fn n(value: &Value) -> usize {
    value.as_u64().expect("non-negative number") as usize
}

fn opt_n(value: &Value) -> Option<usize> {
    if value.is_null() { None } else { Some(n(value)) }
}

fn draft_of(shape: &Value) -> Draft {
    Draft::new(text_of(&shape[0]), n(&shape[1]), opt_n(&shape[2]))
}

fn shape_of(draft: &Draft) -> (String, usize, Option<usize>) {
    (draft.value.clone(), draft.cursor, draft.selection_anchor)
}

fn want_shape(shape: &Value) -> (String, usize, Option<usize>) {
    shape_of(&draft_of(shape))
}

fn flags_of(names: &Value) -> KeyFlags {
    let mut flags = KeyFlags::default();
    for name in names.as_array().expect("names") {
        match text_of(name) {
            "upArrow" => flags.up_arrow = true,
            "downArrow" => flags.down_arrow = true,
            "leftArrow" => flags.left_arrow = true,
            "rightArrow" => flags.right_arrow = true,
            "pageDown" => flags.page_down = true,
            "pageUp" => flags.page_up = true,
            "home" => flags.home = true,
            "end" => flags.end = true,
            "return" => flags.return_key = true,
            "escape" => flags.escape = true,
            "ctrl" => flags.ctrl = true,
            "shift" => flags.shift = true,
            "tab" => flags.tab = true,
            "backspace" => flags.backspace = true,
            "delete" => flags.delete = true,
            "meta" => flags.meta = true,
            "super" => flags.super_key = true,
            "hyper" => flags.hyper = true,
            "capsLock" => flags.caps_lock = true,
            "numLock" => flags.num_lock = true,
            other => panic!("unknown key flag {other}"),
        }
    }
    flags
}

#[test]
fn text_functions_agree_at_every_offset() {
    let mut bad = Mismatches::default();
    for case in cases("offsets") {
        let text = text_of(&case["text"]);
        for row in case["rows"].as_array().expect("rows") {
            let off = n(&row[0]);
            let range = word_range_at(text, off);
            let got = [
                off,
                previous_offset(text, off),
                next_offset(text, off),
                previous_word_offset(text, off),
                next_word_offset(text, off),
                line_start(text, off),
                line_end(text, off),
                range.start,
                range.end,
            ];
            let want: Vec<usize> = row.as_array().expect("row").iter().map(n).collect();
            bad.expect(&format!("{text:?} at {off}"), got.to_vec(), want);
        }
    }
    bad.finish("offsets");
}

#[test]
fn wrapped_geometry_agrees() {
    let mut bad = Mismatches::default();
    for case in cases("geometry") {
        let text = text_of(&case["text"]);
        let width = n(&case["width"]);
        for row in case["rows"].as_array().expect("rows") {
            let off = n(&row[0]);
            let caret = caret_position(text, off, width, None);
            let caret_t = caret_position(text, off, width, Some(true));
            let up = vertical_offset(text, off, width, -1, None);
            let down = vertical_offset(text, off, width, 1, None);
            let up_pref = vertical_offset(text, off, width, -1, Some(3));
            let down_pref = vertical_offset(text, off, width, 1, Some(3));
            let got = vec![
                off, caret.row, caret.col, caret_t.row, caret_t.col, up.cursor, up.preferred_column, down.cursor,
                down.preferred_column, up_pref.cursor, down_pref.cursor,
            ];
            let want: Vec<usize> = row.as_array().expect("row").iter().map(n).collect();
            bad.expect(&format!("{text:?} width {width} at {off}"), got, want);
        }
        for cell in case["cells"].as_array().expect("cells") {
            let got = offset_at_cell(text, n(&cell[0]), n(&cell[1]), width);
            bad.expect(&format!("{text:?} width {width} cell {}/{}", cell[0], cell[1]), got, n(&cell[2]));
        }
    }
    bad.finish("geometry");
}

#[test]
fn edits_agree_from_every_draft() {
    let mut bad = Mismatches::default();
    for case in cases("edits") {
        for row in case["rows"].as_array().expect("rows") {
            let draft = draft_of(&row[0]);
            let tag = format!("{:?}", shape_of(&draft));
            let outputs: [Draft; 10] = [
                delete_backward_word(&draft),
                delete_forward_word(&draft),
                delete_to_line_start(&draft),
                delete_to_line_end(&draft),
                delete_backward_char(&draft),
                delete_forward_char(&draft),
                replace_selection(&draft, "XY\u{1f600}"),
                delete_selected_text(&draft),
                move_cursor(&draft, draft.len16() / 2, true),
                move_cursor(&draft, 1, false),
            ];
            for (at, output) in outputs.iter().enumerate() {
                bad.expect(&format!("{tag} op {at}"), shape_of(output), want_shape(&row[at + 1]));
            }
            let range = selection_range(&draft).map(|r| vec![r.start, r.end]);
            let want_range = row[11].as_array().map(|pair| pair.iter().map(n).collect::<Vec<_>>());
            bad.expect(&format!("{tag} range"), range, want_range);
            let arrows = vec![
                left_arrow_offset(&draft, false, false),
                left_arrow_offset(&draft, true, false),
                left_arrow_offset(&draft, false, true),
                right_arrow_offset(&draft, false, false),
                right_arrow_offset(&draft, true, false),
                right_arrow_offset(&draft, false, true),
            ];
            let want_arrows: Vec<usize> = row[12].as_array().expect("arrows").iter().map(n).collect();
            bad.expect(&format!("{tag} arrows"), arrows, want_arrows);
        }
    }
    bad.finish("edits");
}

#[test]
fn escape_policy_agrees() {
    let mut bad = Mismatches::default();
    for case in cases("escape") {
        for row in case["rows"].as_array().expect("rows") {
            let input = EscapeInput {
                interrupt_active: row[0].as_bool().unwrap_or(false),
                has_selection: row[1].as_bool().unwrap_or(false),
                has_queued_messages: row[2].as_bool().unwrap_or(false),
                has_messages: row[3].as_bool().unwrap_or(false),
                value: text_of(&row[4]),
                last_clear_press_at: row[5].as_u64().expect("last"),
                now: row[6].as_u64().expect("now"),
            };
            let decision = classify_prompt_escape(input);
            let action = format!("{:?}", decision.action);
            let want = match text_of(&row[7]) {
                "interrupt" => "Interrupt",
                "collapse-selection" => "CollapseSelection",
                "restore-queue" => "RestoreQueue",
                "idle" => "Idle",
                "message-selector" => "MessageSelector",
                "arm-select" => "ArmSelect",
                "clear" => "Clear",
                "arm-clear" => "ArmClear",
                other => panic!("unknown action {other}"),
            };
            bad.expect(&format!("{:?}", &row.as_array().expect("row")[..7]), (action.as_str(), decision.next_clear_press_at), (want, row[8].as_u64().expect("next")));
        }
    }
    bad.finish("escape");
}

#[test]
fn restore_and_interrupt_policies_agree() {
    let mut bad = Mismatches::default();
    for case in cases("restore") {
        for merge in case["merges"].as_array().expect("merges") {
            let queued = text_of(&merge[0]);
            let draft = draft_of(&merge[1]);
            bad.expect(&format!("merge {queued:?} {:?}", shape_of(&draft)), shape_of(&merge_queued_restore_draft(queued, &draft)), want_shape(&merge[2]));
            bad.expect(&format!("prefix {queued:?} {:?}", draft.value), queued_restore_prefix(queued, &draft.value), text_of(&merge[3]).to_owned());
        }
        for replace in case["replaces"].as_array().expect("replaces") {
            let draft = draft_of(&replace[2]);
            let result = replace_queued_restore_prefix(text_of(&replace[0]), text_of(&replace[1]), &draft);
            bad.expect(&format!("replace {:?}", replace[0]), (shape_of(&result.draft), result.replaced), (want_shape(&replace[3]), replace[4].as_bool().unwrap_or(false)));
        }
        let entries = case["entries"].as_array().expect("entries").clone();
        for projection in case["projections"].as_array().expect("projections") {
            let got = queued_restore_projection(&entries, text_of(&projection[0]));
            let want = &projection[1];
            let want_ids: Vec<String> = want["ids"].as_array().expect("ids").iter().map(|id| text_of(id).to_owned()).collect();
            bad.expect(&format!("projection {:?}", projection[0]), (got.count, got.ids, got.text), (n(&want["count"]), want_ids, text_of(&want["text"]).to_owned()));
        }
        for vertical in case["verticals"].as_array().expect("verticals") {
            let count = vertical[0].as_i64().expect("count");
            bad.expect(&format!("vertical {count}"), palette_owns_prompt_vertical_arrow(count), vertical[1].as_bool().unwrap_or(false));
        }
    }
    for case in cases("interrupt") {
        for row in case["rows"].as_array().expect("rows") {
            let result = row[0].as_object().map(|object| InterruptResult {
                aborted: object.get("aborted").and_then(Value::as_bool),
                restore_text: object.get("restoreText").and_then(Value::as_str).unwrap_or("").to_owned(),
            });
            let got = prompt_interrupt_restore_text(result.as_ref(), text_of(&row[1]));
            bad.expect(&format!("interrupt {:?} {:?}", row[0], row[1]), got, text_of(&row[2]).to_owned());
        }
    }
    bad.finish("restore and interrupt");
}

fn snake(camel: &str) -> String {
    let mut out = String::new();
    for ch in camel.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[test]
fn key_signals_agree() {
    let mut bad = Mismatches::default();
    for case in cases("signals") {
        for row in case["enters"].as_array().expect("enters") {
            let s = text_of(&row[0]);
            bad.expect(&format!("modified enter {s:?}"), (is_modified_enter_sequence(s), is_any_modified_enter_sequence(s), csi_body(s).to_owned()), (row[1].as_bool().unwrap_or(false), row[2].as_bool().unwrap_or(false), text_of(&row[3]).to_owned()));
        }
        for row in case["pastes"].as_array().expect("pastes") {
            let s = text_of(&row[0]);
            let want = row[2].as_str().map(str::to_owned);
            bad.expect(&format!("paste {s:?}"), (normalize_pasted_text(s), single_trailing_line_break_prefix(s)), (text_of(&row[1]).to_owned(), want));
        }
        for row in case["arrows"].as_array().expect("arrows") {
            let raw = text_of(&row[0]);
            let key = flags_of(&row[1]);
            let s = decode_arrow_signals(raw, &key);
            let all = [
                ("ctrl_shift_held", s.ctrl_shift_held),
                ("raw_ctrl_shift_down", s.raw_ctrl_shift_down),
                ("raw_ctrl_shift_left", s.raw_ctrl_shift_left),
                ("raw_ctrl_shift_right", s.raw_ctrl_shift_right),
                ("raw_ctrl_shift_up", s.raw_ctrl_shift_up),
                ("raw_down_arrow", s.raw_down_arrow),
                ("raw_shift_arrow_for_grid", s.raw_shift_arrow_for_grid),
                ("raw_shift_down", s.raw_shift_down),
                ("raw_shift_left", s.raw_shift_left),
                ("raw_shift_right", s.raw_shift_right),
                ("raw_shift_up", s.raw_shift_up),
                ("raw_up_arrow", s.raw_up_arrow),
                ("shift_held", s.shift_held),
            ];
            let got: Vec<String> = all.iter().filter(|(_, on)| *on).map(|(name, _)| (*name).to_owned()).collect();
            let want: Vec<String> = row[2].as_array().expect("names").iter().map(|name| snake(text_of(name))).collect();
            bad.expect(&format!("arrows {raw:?} {}", row[1]), got, want);
        }
        for row in case["reports"].as_array().expect("reports") {
            let raw = text_of(&row[0]);
            let got = (is_mouse_report_sequence(raw), is_csi_private_reply(raw), is_discarded_control_input(raw), printable_from_input(raw));
            let want = (row[1].as_bool().unwrap_or(false), row[2].as_bool().unwrap_or(false), row[3].as_bool().unwrap_or(false), text_of(&row[4]).to_owned());
            bad.expect(&format!("report {raw:?}"), got, want);
        }
    }
    bad.finish("signals");
}

#[test]
fn render_rows_equal_inks_hard_wrap() {
    let mut bad = Mismatches::default();
    for case in cases("wrap") {
        for row in case["rows"].as_array().expect("rows") {
            let text = text_of(&row[0]);
            let width = n(&row[1]);
            let trailing = row[2].as_bool().unwrap_or(false);
            if text.is_empty() && !trailing {
                continue;
            }
            // The caret at the end renders the trailing blank cell; anywhere else it does not.
            let draft = Draft::new(text, if trailing { draft_len(text) } else { 0 }, None);
            let view = PromptView { draft: &draft, mask: false, hint: "", hint_tone: HintTone::Info, width, caret_enabled: false };
            let rows: Vec<String> = render_prompt(&view)
                .rows
                .iter()
                .map(|spans| spans.iter().map(|span| span.text.as_str()).collect::<String>())
                .collect();
            let want: Vec<String> = row[3].as_array().expect("rows").iter().map(|line| text_of(line).to_owned()).collect();
            bad.expect(&format!("{text:?} width {width} trailing {trailing}"), rows, want);
        }
    }
    bad.finish("wrap");
}

fn draft_len(text: &str) -> usize {
    Draft::at_end(text).cursor
}

/// The callbacks of a recorded session: they log what the Node harness logs and answer from the session's script.
struct Sim<'a> {
    log: Vec<String>,
    script: &'a Value,
}

impl Sim<'_> {
    fn flag(&self, name: &str) -> bool {
        self.script[name].as_bool().unwrap_or(false)
    }

    fn palette(&self, name: &str) -> PaletteReply {
        let answer = &self.script[name];
        match answer["kind"].as_str().unwrap_or("accepted") {
            "declined" => PaletteReply::Declined,
            "text" => PaletteReply::Text(text_of(&answer["value"]).to_owned()),
            "draft" => PaletteReply::Draft { value: text_of(&answer["value"]).to_owned(), cursor: n(&answer["cursor"]) },
            _ => PaletteReply::Accepted,
        }
    }
}

impl PromptCallbacks for Sim<'_> {
    fn on_submit(&mut self, text: &str) -> bool {
        self.log.push(format!("submit:{text}"));
        self.script["submitAccept"].as_bool() != Some(false)
    }
    fn on_draft_change(&mut self, value: &str) {
        self.log.push(format!("draft:{value}"));
    }
    fn on_caret_change(&mut self, cursor: usize) {
        self.log.push(format!("caret:{cursor}"));
    }
    fn on_interrupt(&mut self, value: &str) -> Option<String> {
        self.log.push(format!("interrupt:{value}"));
        self.script["interrupt"].as_str().map(str::to_owned)
    }
    fn on_escape(&mut self, value: &str, phase: EscapePhase) -> bool {
        let name = match phase {
            EscapePhase::Before => "before",
            EscapePhase::ClearArm => "clear-arm",
            EscapePhase::Clear => "clear",
            EscapePhase::SelectArm => "select-arm",
            EscapePhase::Select => "select",
            EscapePhase::Empty => "empty",
        };
        self.log.push(format!("escape:{name}:{value}"));
        self.flag("escapeBefore") && phase == EscapePhase::Before
    }
    fn on_tab(&mut self, value: &str) -> bool {
        self.log.push(format!("tab:{value}"));
        self.flag("tab")
    }
    fn on_command_palette_navigate(&mut self, nav: PaletteNav) {
        let name = match nav {
            PaletteNav::Step(step) => step.to_string(),
            PaletteNav::Home => "home".to_owned(),
            PaletteNav::End => "end".to_owned(),
            PaletteNav::Left => "left".to_owned(),
            PaletteNav::Right => "right".to_owned(),
        };
        self.log.push(format!("nav:{name}"));
    }
    fn on_command_palette_accept(&mut self, value: &str, cursor: usize) -> PaletteReply {
        self.log.push(format!("accept:{value}:{cursor}"));
        self.palette("accept")
    }
    fn on_command_palette_cancel(&mut self, value: &str) {
        self.log.push(format!("cancel:{value}"));
    }
    fn on_command_palette_complete(&mut self, value: &str, cursor: usize) -> PaletteReply {
        self.log.push(format!("complete:{value}:{cursor}"));
        self.palette("complete")
    }
    fn on_restore_queued(&mut self, request: &RestoreRequest) -> bool {
        self.log.push(format!("restore:{}:{}", request.show_hint, request.current_text));
        self.flag("restore")
    }
    fn on_history_navigate(&mut self, direction: HistoryDirection, value: &str, empty_draft: bool) -> Option<String> {
        let name = if direction == HistoryDirection::Up { "up" } else { "down" };
        self.log.push(format!("history:{name}:{value}:{empty_draft}"));
        self.script["history"].as_str().map(str::to_owned)
    }
    fn on_paste_text(&mut self, text: &str, source: PasteSource) -> PasteReply {
        let name = match source {
            PasteSource::Paste => "paste",
            PasteSource::PasteFallback => "paste-fallback",
            PasteSource::ClipboardShortcut => "clipboard-shortcut",
        };
        self.log.push(format!("paste:{name}:{text}"));
        match self.script["paste"]["kind"].as_str() {
            Some("insert") => PasteReply::Insert(text_of(&self.script["paste"]["text"]).to_owned()),
            Some("drop") => PasteReply::Drop,
            _ => PasteReply::Fallback,
        }
    }
    fn grid_selection_active(&mut self) -> bool {
        self.flag("grid")
    }
}

#[test]
fn key_sessions_agree_event_by_event() {
    let mut bad = Mismatches::default();
    let sessions = cases("session");
    assert!(sessions.len() > 100);
    for (number, session) in sessions.iter().enumerate() {
        NOW.store(1_000_000, Ordering::SeqCst);
        let props_in = &session["props"];
        let props = PromptProps {
            disabled: props_in["disabled"].as_bool().unwrap_or(false),
            interrupt_active: props_in["interruptActive"].as_bool().unwrap_or(false),
            command_palette_active: props_in["commandPaletteActive"].as_bool().unwrap_or(false),
            command_palette_open: props_in["commandPaletteOpen"].as_bool(),
            command_palette_option_count: props_in["commandPaletteOptionCount"].as_i64(),
            command_palette_moves_caret: props_in["commandPaletteMovesCaret"].as_bool().unwrap_or(false),
            has_queued_messages: props_in["hasQueuedMessages"].as_bool().unwrap_or(false),
            has_messages: props_in["hasMessages"].as_bool().unwrap_or(false),
            ..PromptProps::default()
        };
        let mut sim = Sim { log: Vec::new(), script: &session["script"] };
        let mut editor = PromptEditor::with_draft(draft_of(&serde_json::json!([
            session["draft"]["value"], session["draft"]["cursor"], session["draft"]["selectionAnchor"]
        ])), clock);
        editor.cursor_anchor(&BoxLayout { width: n(&session["width"]), ..BoxLayout::default() }, true);
        editor.mount(&mut sim);
        let events = session["events"].as_array().expect("events");
        let steps = session["steps"].as_array().expect("steps");
        for (at, (event, step)) in events.iter().zip(steps).enumerate() {
            NOW.fetch_add(event[2].as_u64().expect("dt"), Ordering::SeqCst);
            editor.end_input_batch();
            let before = sim.log.len();
            editor.handle_key(text_of(&event[0]), &flags_of(&event[1]), &props, &mut sim);
            let undo = editor.undo_stack();
            let got = (
                shape_of(editor.draft()),
                sim.log[before..].to_vec(),
                (undo.past_len(), undo.future_len(), undo.past().last().map(|d| d.value.clone())),
                editor.escape_clear_armed_at(),
            );
            let want_log: Vec<String> = step[3].as_array().expect("log").iter().map(|line| text_of(line).to_owned()).collect();
            let want = (
                want_shape(&serde_json::json!([step[0], step[1], step[2]])),
                want_log,
                (n(&step[4]), n(&step[5]), step[6].as_str().map(str::to_owned)),
                step[7].as_u64().expect("armed"),
            );
            bad.expect(&format!("session {number} event {at} {:?}", (&event[0], &event[1])), got, want);
        }
    }
    bad.finish("sessions");
}

/// Runs the recorder on a Node checkout and compares its fresh output with the recorded one: the recording is a faithful
/// record of the Node code as it stands. Needs node and the tree.
#[test]
#[ignore = "runs node on a checkout of the Node tree"]
fn live_editor() {
    let tree = std::env::var("MIXDOG_NODE_TREE").unwrap_or_else(|_| "C:/Project/mixdog".to_owned());
    let recorder = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/recorders/record-editor.mjs");
    let golden = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/goldens/editor.json");
    let output = std::process::Command::new("node")
        .args([recorder, "--tree", &tree, "--check", golden])
        .output()
        .expect("node starts");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}
