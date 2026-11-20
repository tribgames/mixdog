//! The prompt editor over real decoder output: bytes become `(input, key)` events through `mixdog_term::Decoder`, as the run
//! loop feeds them. Ports of `draft-override.test.mjs` and `skill-mention-caret.test.mjs` plus the dispatch rules of
//! `key-handler.mjs`.

use std::cell::Cell;
use std::sync::OnceLock;
use std::time::Instant;

use mixdog_js::JsRegex;
use mixdog_term::{Decoder, InputEvent};

use super::*;
use crate::editor::editing::slice16_from;

// One clock per test thread: the tests run in parallel and each moves its own time.
thread_local! {
    static NOW: Cell<u64> = const { Cell::new(1_000_000) };
}

fn test_clock() -> u64 {
    NOW.with(Cell::get)
}

#[derive(Default)]
struct Recorder {
    draft_changes: Vec<String>,
    carets: Vec<usize>,
    submits: Vec<String>,
    submit_accepts: Option<bool>,
    accepts: Vec<(String, usize)>,
    cancels: Vec<String>,
    navs: Vec<PaletteNav>,
    escapes: Vec<(String, EscapePhase)>,
    interrupt_restore: Option<String>,
    restore_answer: bool,
    restore_requests: usize,
    history_answer: Option<String>,
    history_calls: Vec<(HistoryDirection, String, bool)>,
    paste_reply: Option<PasteReply>,
    pastes: Vec<(String, PasteSource)>,
    grid_selection: bool,
    /// Complete `$name` mentions with this skill (the skill palette of the app).
    skill: Option<&'static str>,
}

impl PromptCallbacks for Recorder {
    fn on_submit(&mut self, text: &str) -> bool {
        self.submits.push(text.to_owned());
        self.submit_accepts.unwrap_or(true)
    }
    fn on_draft_change(&mut self, value: &str) {
        self.draft_changes.push(value.to_owned());
    }
    fn on_caret_change(&mut self, cursor: usize) {
        self.carets.push(cursor);
    }
    fn on_interrupt(&mut self, _value: &str) -> Option<String> {
        self.interrupt_restore.clone()
    }
    fn on_escape(&mut self, value: &str, phase: EscapePhase) -> bool {
        self.escapes.push((value.to_owned(), phase));
        false
    }
    fn on_command_palette_navigate(&mut self, nav: PaletteNav) {
        self.navs.push(nav);
    }
    fn on_command_palette_accept(&mut self, value: &str, cursor: usize) -> PaletteReply {
        self.accepts.push((value.to_owned(), cursor));
        match self.skill.and_then(|name| complete_skill_mention(value, name, cursor)) {
            Some((value, cursor)) => PaletteReply::Draft { value, cursor },
            None => PaletteReply::Declined,
        }
    }
    fn on_command_palette_cancel(&mut self, value: &str) {
        self.cancels.push(value.to_owned());
    }
    fn on_command_palette_complete(&mut self, value: &str, cursor: usize) -> PaletteReply {
        match self.skill.and_then(|name| complete_skill_mention(value, name, cursor)) {
            Some((value, cursor)) => PaletteReply::Draft { value, cursor },
            None => PaletteReply::Accepted,
        }
    }
    fn on_restore_queued(&mut self, _request: &RestoreRequest) -> bool {
        self.restore_requests += 1;
        self.restore_answer
    }
    fn on_history_navigate(&mut self, direction: HistoryDirection, value: &str, empty_draft: bool) -> Option<String> {
        self.history_calls.push((direction, value.to_owned(), empty_draft));
        self.history_answer.clone()
    }
    fn on_paste_text(&mut self, text: &str, source: PasteSource) -> PasteReply {
        self.pastes.push((text.to_owned(), source));
        self.paste_reply.clone().unwrap_or(PasteReply::Fallback)
    }
    fn grid_selection_active(&mut self) -> bool {
        self.grid_selection
    }
}

/// `MENTION_TAIL` and `skillMentionQuery` of `app/skill-mention-palette.mjs`, the palette the caret tests wire in: the mention
/// being typed before the caret, as (start, end).
fn skill_mention_query(value: &str, caret: usize) -> Option<(usize, usize)> {
    static TAIL: OnceLock<JsRegex> = OnceLock::new();
    let tail = TAIL.get_or_init(|| JsRegex::new_static(r#"(^|[\s([{"'`])\$([a-z0-9][a-z0-9-]{0,63})?$"#, ""));
    let end = caret.min(mixdog_js::utf16_len(value));
    let head = slice16(value, 0, end);
    let caps = tail.captures(head)?;
    let whole = caps.range();
    let start = mixdog_js::utf16_len(&head[..whole.start]) + mixdog_js::utf16_len(caps.get(1)?);
    Some((start, end))
}

/// `completeSkillMention`: the `$fragment` before the caret becomes `$name `, the rest is kept, the caret lands after it.
fn complete_skill_mention(value: &str, name: &str, caret: usize) -> Option<(String, usize)> {
    let (start, end) = skill_mention_query(value, caret)?;
    let head = format!("{}${} ", slice16(value, 0, start), name);
    let cursor = mixdog_js::utf16_len(&head);
    Some((format!("{}{}", head, slice16_from(value, end)), cursor))
}

struct Harness {
    editor: PromptEditor,
    rec: Recorder,
    props: PromptProps,
    decoder: Decoder,
}

impl Harness {
    fn new(initial: &str) -> Self {
        NOW.with(|now| now.set(1_000_000));
        let mut harness = Self {
            editor: PromptEditor::with_clock(initial, test_clock),
            rec: Recorder::default(),
            props: PromptProps { raw_mode_supported: true, ..PromptProps::default() },
            decoder: Decoder::new(),
        };
        harness.editor.mount(&mut harness.rec);
        harness
    }

    /// Feeds raw terminal bytes; each decoded key goes through the handler, then the input batch ends.
    fn feed(&mut self, bytes: &str) {
        for event in self.decoder.feed(bytes.as_bytes(), Instant::now()) {
            match event {
                InputEvent::Key { input, key } => self.editor.handle_key(&input, &key, &self.props, &mut self.rec),
                InputEvent::Paste(text) => self.editor.handle_paste(&text, &self.props, &mut self.rec),
                InputEvent::Mouse(_) | InputEvent::Focus(_) => {}
            }
        }
        self.editor.end_input_batch();
    }

    /// One `(input, key)` event built by hand, for sequences whose decoded form is the decoder's business.
    fn press(&mut self, input: &str, flags: KeyFlags) {
        self.editor.handle_key(input, &flags, &self.props, &mut self.rec);
    }

    fn type_all(&mut self, text: &str) {
        for ch in text.chars() {
            self.feed(&ch.to_string());
        }
    }

    fn advance(&mut self, ms: u64) {
        NOW.with(|now| now.set(now.get() + ms));
    }

    fn value(&self) -> &str {
        self.editor.value()
    }

    fn cursor(&self) -> usize {
        self.editor.draft().cursor
    }

    /// The skill palette is active while a mention precedes the reported caret.
    fn refresh_palette(&mut self) {
        let caret = self.rec.carets.last().copied();
        let active =
            skill_mention_query(&self.rec.draft_changes.last().cloned().unwrap_or_else(|| self.value().to_owned()), caret.unwrap_or(usize::MAX)).is_some();
        self.props.command_palette_active = active;
        self.props.command_palette_option_count = Some(i64::from(active));
        self.props.command_palette_moves_caret = true;
    }
}

const LEFT: &str = "\x1b[D";

// ---- draft-override.test.mjs ----

#[test]
fn a_draft_override_applies_on_every_published_field_not_on_its_id_alone() {
    let mut h = Harness::new("");
    let first = DraftOverride { value: "optimistic queued text".into(), cursor: None, selection_anchor: None };
    h.editor.apply_draft_override(&first, &mut h.rec);
    assert_eq!(h.value(), "optimistic queued text");

    // The reconciliation of the same restore: a different draft published in the same millisecond.
    let second = DraftOverride { value: "authoritative queued text".into(), cursor: Some(4), selection_anchor: None };
    h.editor.apply_draft_override(&second, &mut h.rec);
    assert_eq!(h.value(), "authoritative queued text");
    assert_eq!(h.cursor(), 4);

    h.feed("!");
    assert_eq!(h.value(), "auth!oritative queued text");
    // A new id republishing the same text still re-applies.
    h.editor.apply_draft_override(&second, &mut h.rec);
    assert_eq!(h.value(), "authoritative queued text");
}

#[test]
fn an_override_is_clamped_resets_undo_and_drops_a_paste_in_flight() {
    let mut h = Harness::new("");
    h.rec.paste_reply = Some(PasteReply::Pending);
    h.editor.handle_external_paste("late", PasteSource::Paste, &mut h.rec);
    let tickets = h.editor.take_pending_pastes();
    assert_eq!(tickets.len(), 1);
    h.feed("typed");
    assert_eq!(h.editor.undo_stack().past_len(), 1);
    let over = DraftOverride { value: "abc".into(), cursor: Some(99), selection_anchor: Some(77) };
    h.editor.apply_draft_override(&over, &mut h.rec);
    assert_eq!(*h.editor.draft(), Draft::new("abc", 3, Some(3)));
    assert_eq!(h.editor.undo_stack().past_len(), 0);
    let ticket = tickets.into_iter().next().expect("one ticket");
    h.editor.finish_paste(ticket, PasteReply::Fallback, &mut h.rec);
    assert_eq!(h.value(), "abc", "the paste that settled after the override is dropped");
}

// ---- skill-mention-caret.test.mjs ----

fn skill_prompt(initial: &str) -> Harness {
    let mut h = Harness::new(initial);
    h.rec.skill = Some("pdf-tools");
    h.rec.draft_changes.push(initial.to_owned());
    h.refresh_palette();
    h
}

fn type_chunks(h: &mut Harness, chunks: &[&str]) {
    for chunk in chunks {
        h.feed(chunk);
        h.refresh_palette();
    }
}

#[test]
fn enter_inserts_the_skill_at_a_mid_text_caret_keeps_the_suffix_and_leaves_the_caret_after_it() {
    let mut h = skill_prompt("fix  then ship");
    assert_eq!(h.rec.carets.last(), Some(&14), "mount reports the caret at the end");
    type_chunks(&mut h, &[LEFT; 10]);
    assert_eq!(h.rec.carets.last(), Some(&4));
    type_chunks(&mut h, &["$", "p", "d"]);
    assert_eq!(h.value(), "fix $pd then ship");
    assert_eq!(h.rec.carets.last(), Some(&7));
    type_chunks(&mut h, &["\r"]);
    assert_eq!(h.rec.accepts, [("fix $pd then ship".to_owned(), 7)]);
    assert_eq!(h.value(), "fix $pdf-tools  then ship");
    assert_eq!(h.rec.carets.last(), Some(&15));
    type_chunks(&mut h, &["x"]);
    assert_eq!(h.value(), "fix $pdf-tools x then ship");
}

#[test]
fn tab_completes_at_the_caret_on_a_later_line_of_a_multi_line_draft() {
    let mut h = skill_prompt("first line\n\nlast line");
    type_chunks(&mut h, &[LEFT; 10]);
    assert_eq!(h.rec.carets.last(), Some(&11));
    type_chunks(&mut h, &["$", "p"]);
    type_chunks(&mut h, &["\t"]);
    assert_eq!(h.value(), "first line\n$pdf-tools \nlast line");
    assert_eq!(h.rec.carets.last(), Some(&22));
}

#[test]
fn left_and_right_move_the_caret_while_the_skill_palette_is_open_and_escape_cancels_without_editing() {
    let mut h = skill_prompt("");
    type_chunks(&mut h, &["$", "p", "d"]);
    type_chunks(&mut h, &[LEFT]);
    assert_eq!(h.rec.carets.last(), Some(&2), "the caret moved instead of the palette selection");
    type_chunks(&mut h, &["\x1b"]);
    assert_eq!(h.rec.cancels, ["$pd"]);
    assert_eq!(h.value(), "$pd");
}

#[test]
fn a_dollar_name_mid_text_never_activates_the_palette_so_enter_submits_as_usual() {
    let mut h = skill_prompt("echo $HOME please");
    type_chunks(&mut h, &[LEFT; 7]);
    assert_eq!(h.rec.carets.last(), Some(&10));
    assert!(skill_mention_query(h.value(), 10).is_none());
    type_chunks(&mut h, &["\r"]);
    assert!(h.rec.accepts.is_empty());
    assert_eq!(h.rec.submits, ["echo $HOME please"]);
}

// ---- key-handler.mjs ----

#[test]
fn typing_inserts_at_the_caret_and_reports_value_and_caret() {
    let mut h = Harness::new("");
    h.type_all("hi");
    h.feed("\x1b[D");
    h.feed("X");
    assert_eq!((h.value(), h.cursor()), ("hXi", 2));
    assert_eq!(h.rec.draft_changes, ["h", "hi", "hXi"]);
    assert_eq!(h.rec.carets, [0, 1, 2, 1, 2]);
    assert_eq!(h.editor.take_render_request(), RenderRequest::Immediate);
    assert_eq!(h.editor.take_render_request(), RenderRequest::None);
}

#[test]
fn enter_submits_and_clears_and_the_gate_blocks_a_second_return_of_the_same_batch() {
    let mut h = Harness::new("send it");
    let enter = KeyFlags { return_key: true, ..KeyFlags::default() };
    h.press("", enter.clone());
    h.press("", enter);
    assert_eq!(h.rec.submits, ["send it"]);
    assert_eq!(h.value(), "");
    h.editor.end_input_batch();
    h.feed("again");
    h.feed("\r");
    assert_eq!(h.rec.submits, ["send it", "again"]);
}

#[test]
fn a_blank_draft_is_not_submitted_and_a_refused_submit_keeps_the_draft() {
    let mut h = Harness::new("   ");
    h.feed("\r");
    assert!(h.rec.submits.is_empty());
    let mut h = Harness::new("keep me");
    h.rec.submit_accepts = Some(false);
    h.feed("\r");
    assert_eq!(h.rec.submits, ["keep me"]);
    assert_eq!(h.value(), "keep me");
    h.feed("\r");
    assert_eq!(h.rec.submits.len(), 2, "the gate was released by the refusal");
}

#[test]
fn newline_chords_and_the_backslash_enter() {
    let mut h = Harness::new("a");
    h.press("", KeyFlags { return_key: true, shift: true, ..KeyFlags::default() });
    h.feed("b");
    h.press("\n", KeyFlags::default());
    h.feed("c");
    h.press("\x1b[13;5u", KeyFlags::default());
    assert_eq!(h.value(), "a\nb\nc\n");
    assert!(h.rec.submits.is_empty());
    let mut h = Harness::new("line\\");
    // A bare Enter event carries no text of its own; a decoded CR is raw Enter text, which takes the submit-chunk path
    // before the backslash rule, in Node as here.
    h.press("", KeyFlags { return_key: true, ..KeyFlags::default() });
    assert_eq!((h.value(), h.cursor()), ("line\n", 5));
    assert!(h.rec.submits.is_empty());
    let mut h = Harness::new("x");
    h.press("\x1b[13;9u", KeyFlags::default());
    h.press("\x1b[27;3;13~", KeyFlags::default());
    assert_eq!(h.value(), "x\n", "an uncommon modifier is consumed, Alt+Enter is a newline");
}

#[test]
fn terminal_reports_and_discarded_controls_never_type() {
    let mut h = Harness::new("");
    h.press("\x1b[<64;55;22M", KeyFlags::default());
    h.press("[<0;1;1m", KeyFlags::default());
    h.press("\x1b[?7u", KeyFlags::default());
    h.press("\0", KeyFlags::default());
    h.press("\x1b[32;5u", KeyFlags::default());
    assert_eq!(h.value(), "");
    h.press("a\x1b[<0;1;1Mb", KeyFlags::default());
    assert_eq!(h.value(), "", "an input carrying a mouse report is dropped whole");
}

#[test]
fn a_multi_line_chunk_is_a_paste_and_the_clipboard_shortcut_asks_the_callback() {
    let mut h = Harness::new("");
    h.editor.handle_key("a\r\nb\nc", &KeyFlags::default(), &h.props, &mut h.rec);
    assert_eq!(h.value(), "a\nb\nc");
    assert_eq!(h.rec.pastes, [("a\nb\nc".to_owned(), PasteSource::PasteFallback)]);
    h.rec.paste_reply = Some(PasteReply::Insert("[image 1]".into()));
    h.feed("\x16");
    assert_eq!(h.rec.pastes.last(), Some(&(String::new(), PasteSource::ClipboardShortcut)));
    assert!(h.value().ends_with("[image 1]"));
    h.rec.paste_reply = Some(PasteReply::Drop);
    let before = h.value().to_owned();
    h.feed("\x1b[200~dropped\x1b[201~");
    assert_eq!(h.value(), before);
    h.rec.paste_reply = None;
    h.feed("\x1b[200~kept\x1b[201~");
    assert!(h.value().ends_with("kept"));
}

#[test]
fn shift_arrows_select_and_a_plain_arrow_collapses_to_the_near_edge() {
    let mut h = Harness::new("alpha beta");
    h.feed("\x1b[1;2D");
    h.feed("\x1b[1;2D");
    assert_eq!(*h.editor.draft(), Draft::new("alpha beta", 8, Some(10)));
    h.feed(LEFT);
    assert_eq!(*h.editor.draft(), Draft::new("alpha beta", 8, None));
    h.feed("\x1b[1;6D");
    assert_eq!(*h.editor.draft(), Draft::new("alpha beta", 6, Some(8)));
    h.feed("\x1b[1;6C");
    assert_eq!(*h.editor.draft(), Draft::new("alpha beta", 10, Some(8)));
    h.feed("\x01");
    assert_eq!(*h.editor.draft(), Draft::new("alpha beta", 10, Some(0)));
    h.feed("x");
    assert_eq!(h.value(), "x");
}

#[test]
fn a_shift_arrow_belongs_to_the_grid_selection_when_it_is_live() {
    let mut h = Harness::new("abc");
    h.rec.grid_selection = true;
    h.feed("\x1b[1;2D");
    assert_eq!(*h.editor.draft(), Draft::new("abc", 3, None));
    h.feed("\x1b[D");
    assert_eq!(h.cursor(), 2, "a plain arrow still moves the caret");
}

#[test]
fn undo_and_redo_coalesce_typing_and_accept_the_legacy_control_bytes() {
    let mut h = Harness::new("");
    h.type_all("one");
    h.advance(600);
    h.type_all(" two");
    assert_eq!(h.editor.undo_stack().past_len(), 2);
    h.feed("\x1a");
    assert_eq!(h.value(), "one");
    h.feed("\x1a");
    assert_eq!(h.value(), "");
    h.feed("\x19");
    assert_eq!(h.value(), "one");
    h.feed("\x1b[122;6u");
    assert_eq!(h.value(), "one two", "ctrl+shift+z redoes");
}

#[test]
fn word_and_line_chords() {
    let mut h = Harness::new("alpha beta gamma");
    h.feed("\x17");
    assert_eq!(h.value(), "alpha beta ");
    h.feed("\x1bb");
    assert_eq!(h.cursor(), 6);
    h.feed("\x1bd");
    assert_eq!(h.value(), "alpha  ");
    h.feed("\x15");
    assert_eq!(h.value(), " ");
    let mut h = Harness::new("ab\ncd");
    h.feed("\x1b[D");
    h.feed("\x0b");
    assert_eq!(h.value(), "ab\nc");
}

#[test]
fn vertical_arrows_keep_the_column_then_fall_to_history_at_the_edges() {
    let mut h = Harness::new("abcdef\nab\nabcdef");
    h.rec.history_answer = Some("older".into());
    h.feed("\x1b[A");
    assert_eq!(h.cursor(), 9);
    h.feed("\x1b[A");
    assert_eq!(h.cursor(), 6, "the preferred column came back");
    h.feed("\x1b[A");
    assert_eq!(h.rec.history_calls, [(HistoryDirection::Up, "abcdef\nab\nabcdef".to_owned(), false)]);
    assert_eq!(h.value(), "older");
    h.rec.history_answer = None;
    h.feed("\x1b[B");
    assert_eq!(h.rec.history_calls.last(), Some(&(HistoryDirection::Down, "older".to_owned(), false)));
}

#[test]
fn shift_up_extends_to_the_start_and_never_navigates_history() {
    let mut h = Harness::new("one\ntwo");
    h.feed("\x1b[1;2A");
    h.feed("\x1b[1;2A");
    assert_eq!(*h.editor.draft(), Draft::new("one\ntwo", 0, Some(7)));
    assert!(h.rec.history_calls.is_empty());
    h.feed("\x1b[1;2B");
    h.feed("\x1b[1;2B");
    assert_eq!(h.cursor(), 7);
}

#[test]
fn up_on_the_first_line_restores_queued_messages_before_history() {
    let mut h = Harness::new("");
    h.props.has_queued_messages = true;
    h.rec.restore_answer = true;
    h.feed("\x1b[A");
    assert_eq!(h.rec.restore_requests, 1);
    assert!(h.rec.history_calls.is_empty());
    h.rec.restore_answer = false;
    h.feed("\x1b[A");
    assert_eq!(h.rec.history_calls.len(), 1);
}

#[test]
fn an_open_palette_with_options_owns_up_down_page_home_and_end() {
    let mut h = Harness::new("/mo");
    h.props.command_palette_active = true;
    h.feed("\x1b[A");
    h.feed("\x1b[B");
    h.feed("\x1b[5~");
    h.feed("\x1b[6~");
    h.feed("\x1b[H");
    h.feed("\x1b[F");
    h.feed("\x1b[D");
    assert_eq!(
        h.rec.navs,
        [PaletteNav::Step(-1), PaletteNav::Step(1), PaletteNav::Step(-8), PaletteNav::Step(8), PaletteNav::Home, PaletteNav::End, PaletteNav::Left]
    );
    h.props.command_palette_option_count = Some(1);
    h.feed("\x1b[A");
    assert_eq!(h.rec.navs.len(), 7, "with one option the prompt keeps the vertical arrows");
    // A palette that declines the accept leaves the draft as it is.
    h.rec.skill = None;
    h.props.command_palette_active = true;
    h.rec.accepts.clear();
    h.feed("\r");
    assert_eq!(h.rec.accepts.len(), 1);
    assert_eq!(h.value(), "/mo", "a declined accept leaves the draft");
}

#[test]
fn escape_priority_overlays_selection_interrupt_queue_then_the_double_press() {
    let mut h = Harness::new("draft");
    h.props.command_palette_active = true;
    h.feed("\x1b");
    assert_eq!(h.rec.cancels, ["draft"]);
    h.props.command_palette_active = false;

    // A selection collapses first.
    h.feed("\x01");
    h.feed("\x1b");
    assert_eq!(h.editor.draft().selection_anchor, None);
    assert!(h.rec.escapes.is_empty());

    // Idle with a draft: arm, then clear on the second press inside the window.
    h.feed("\x1b");
    assert_eq!(h.rec.escapes.last(), Some(&("draft".to_owned(), EscapePhase::ClearArm)));
    assert_ne!(h.editor.escape_clear_armed_at(), 0);
    h.advance(300);
    h.feed("\x1b");
    assert_eq!(h.rec.escapes.last(), Some(&("draft".to_owned(), EscapePhase::Clear)));
    assert_eq!(h.value(), "");

    // Active work wins over everything and restores the submitted prompt into an empty box only.
    h.props.interrupt_active = true;
    h.rec.interrupt_restore = Some("restored".into());
    h.feed("\x1b");
    assert_eq!(h.value(), "restored");
    h.feed("\x01");
    h.feed("x");
    h.feed("\x1b");
    assert_eq!(h.value(), "x", "the typed draft is kept");
}

#[test]
fn an_empty_draft_with_history_arms_then_opens_the_message_selector() {
    let mut h = Harness::new("");
    h.props.has_messages = true;
    h.feed("\x1b");
    h.advance(100);
    h.feed("\x1b");
    let phases: Vec<EscapePhase> = h.rec.escapes.iter().map(|(_, phase)| *phase).collect();
    assert_eq!(phases, [EscapePhase::Before, EscapePhase::SelectArm, EscapePhase::Before, EscapePhase::Select]);
    h.props.has_queued_messages = true;
    h.rec.restore_answer = true;
    h.feed("\x1b");
    assert_eq!(h.rec.restore_requests, 1);
    assert_eq!(h.editor.escape_clear_armed_at(), 0);
}

#[test]
fn a_key_other_than_escape_disarms_the_double_press() {
    let mut h = Harness::new("draft");
    h.feed("\x1b");
    assert_ne!(h.editor.escape_clear_armed_at(), 0);
    h.feed("x");
    assert_eq!(h.editor.escape_clear_armed_at(), 0);
}

#[test]
fn a_disabled_prompt_ignores_keys_and_pastes() {
    let mut h = Harness::new("keep");
    h.props.disabled = true;
    h.feed("x");
    h.feed("\x1b[200~p\x1b[201~");
    assert_eq!(h.value(), "keep");
}

#[test]
fn korean_and_emoji_are_deleted_by_grapheme() {
    let mut h = Harness::new("a\u{d55c}\u{1F1F0}\u{1F1F7}");
    h.feed("\x7f");
    assert_eq!(h.value(), "a\u{d55c}");
    h.feed("\x7f");
    assert_eq!(h.value(), "a");
}

// ---- cursor anchor and mouse ----

#[test]
fn the_cursor_anchor_follows_the_caret_and_publishes_the_box() {
    let mut h = Harness::new("abcdef");
    let layout = BoxLayout { top: 3, left: 2, width: 6, height: 2 };
    let caret = h.editor.cursor_anchor(&layout, true);
    // The caret is at the end, where the prompt renders a trailing blank cell, so a flush last column rolls to the next row.
    assert_eq!(caret, Some(Caret { row: 1, col: 0 }));
    assert_eq!(h.editor.content_width(), 6);
    assert_eq!(h.editor.box_rect(), Some(BoxRect { top: 3, left: 2, height: 2, content_width: 80 }));
    assert_eq!(h.editor.cursor_anchor(&layout, false), None);
    let unlaid = h.editor.cursor_anchor(&BoxLayout::default(), true);
    assert_eq!(unlaid, Some(Caret { row: 0, col: 6 }));
}

#[test]
fn mouse_drag_selection_coalesces_extend_commits() {
    let mut h = Harness::new("hello world");
    h.editor.mouse_anchor_at(2, &mut h.rec);
    assert_eq!(*h.editor.draft(), Draft::new("hello world", 2, Some(2)));
    h.advance(100);
    h.editor.mouse_extend_to(Some(5), false, &mut h.rec);
    assert_eq!(*h.editor.draft(), Draft::new("hello world", 5, Some(2)));
    // A second motion inside the window waits.
    h.advance(5);
    h.editor.mouse_extend_to(Some(7), false, &mut h.rec);
    assert_eq!(h.cursor(), 5);
    let due = h.editor.mouse_deadline();
    assert_eq!(due, Some(test_clock() + 19));
    h.editor.flush_mouse_due(&mut h.rec);
    assert_eq!(h.cursor(), 5, "not due yet");
    h.advance(19);
    h.editor.flush_mouse_due(&mut h.rec);
    assert_eq!(*h.editor.draft(), Draft::new("hello world", 7, Some(2)));
    assert_eq!(h.editor.mouse_deadline(), None);
    // The release commits straight through and cancels anything waiting.
    h.advance(1);
    h.editor.mouse_extend_to(Some(9), false, &mut h.rec);
    h.editor.mouse_extend_to(Some(10), true, &mut h.rec);
    assert_eq!(h.cursor(), 10);
    assert_eq!(h.editor.mouse_deadline(), None);
    assert!(h.editor.mouse_has_selection());
    h.editor.mouse_clear(&mut h.rec);
    assert!(!h.editor.mouse_has_selection());
}

#[test]
fn double_and_triple_click_select_a_word_and_a_line() {
    let mut h = Harness::new("one two\nthree");
    h.editor.mouse_select_word_at(5, &mut h.rec);
    assert_eq!(*h.editor.draft(), Draft::new("one two\nthree", 7, Some(4)));
    h.editor.mouse_select_line_at(10, &mut h.rec);
    assert_eq!(*h.editor.draft(), Draft::new("one two\nthree", 13, Some(8)));
    assert_eq!(h.editor.selection(false).map(|s| s.text), Some("three".to_owned()));
    assert_eq!(h.editor.selection(true).map(|s| s.text), Some(String::new()));
    h.editor.cursor_anchor(&BoxLayout { top: 0, left: 0, width: 4, height: 1 }, true);
    assert_eq!(h.editor.mouse_offset_at_cell(1, 1), 5);
}
