//! What the panels put on the screen: each panel is painted into a grid and its rows are read back as text.

use mixdog_term::frame::Grid;
use mixdog_term::paint::Painter;
use mixdog_tui_widgets::confirm_bar::{ConfirmButton, clamp_confirm_focus, confirm_bar_width, paint_confirm_bar};
use mixdog_tui_widgets::palette::{PALETTE_ROWS, PaletteProps, SlashCommand, paint_palette};
use mixdog_tui_widgets::picker::{PickerItem, PickerProps, paint_picker, picker_rows};
use mixdog_tui_widgets::question::{CUSTOM_LABEL, Question, QuestionState, initial_cursor, paint_question, question_view_rows, questions_of};
use mixdog_tui_widgets::sign_in_url::{CopyStatus, SignInUrlLayout, paint_sign_in_url, sign_in_url_layout};
use mixdog_tui_widgets::text_entry::{TextEntryDraft, TextEntryProps, paint_text_entry, text_entry_rows};
use serde_json::json;

/// Paints with `draw` onto a grid `columns` wide and returns the rows it reports and the text of every row.
fn screen(columns: u16, draw: impl Fn(&mut Painter) -> u16) -> (u16, Vec<String>) {
    let mut tall = Grid::new(columns, 60);
    let rows = draw(&mut Painter::new(&mut tall));
    let mut grid = Grid::new(columns, rows.max(1));
    draw(&mut Painter::new(&mut grid));
    (rows, (0..rows.max(1)).map(|y| grid.row_text(y).trim_end().to_owned()).collect())
}

fn has_row(rows: &[String], needle: &str) -> bool {
    rows.iter().any(|row| row.contains(needle))
}

// ---- the confirm bar -----------------------------------------------------------------------------------------------------

#[test]
fn the_confirm_bar_is_one_row_of_bracketed_buttons_one_cell_apart() {
    let buttons = [ConfirmButton::new("a", "A"), ConfirmButton::new("b", "B")];
    assert_eq!(confirm_bar_width(&buttons), 15);
    let (rows, text) = screen(40, |painter| paint_confirm_bar(painter, 0, 0, &buttons, 1));
    assert_eq!(rows, 1);
    assert_eq!(text[0], " [ A ]   [ B ]");
    assert_eq!(paint_confirm_bar(&mut Painter::new(&mut Grid::new(10, 2)), 0, 0, &[], -1), 0, "no buttons take no row");
}

#[test]
fn the_focus_is_a_button_or_minus_one_for_the_list() {
    assert_eq!(clamp_confirm_focus(-1, 2), -1);
    assert_eq!(clamp_confirm_focus(5, 2), 1);
    assert_eq!(clamp_confirm_focus(0, 0), -1);
    assert_eq!(clamp_confirm_focus(0, 3), 0);
}

// ---- the command palette ------------------------------------------------------------------------------------------------

fn commands(count: usize) -> Vec<SlashCommand> {
    (0..count).map(|index| SlashCommand::new(&format!("/cmd{index}"), &format!("does {index}"))).collect()
}

#[test]
fn the_palette_shows_a_window_of_commands_around_the_selected_one() {
    let mut props = PaletteProps::new(commands(20));
    props.selected_index = 15;
    let (rows, text) = screen(80, |painter| paint_palette(painter, 0, 0, &props));
    assert_eq!(rows, PALETTE_ROWS);
    assert!(text[1].contains("Commands") && text[1].contains("Esc cancel"), "{:?}", text[1]);
    assert!(text[3].contains("Type to filter"), "{:?}", text[3]);
    for shown in 11..19 {
        assert!(has_row(&text[5..], &format!("Cmd{shown}")), "Cmd{shown} is in the window");
    }
    assert!(!has_row(&text, "Cmd10") && !has_row(&text, "Cmd19"), "the window is eight commands");
    assert!(text[5 + 4].contains("Cmd15") && text[5 + 4].contains("does 15"), "{:?}", text[9]);
}

#[test]
fn an_empty_palette_says_nothing_matches() {
    let props = PaletteProps::new(Vec::new());
    let (rows, text) = screen(80, |painter| paint_palette(painter, 0, 0, &props));
    assert_eq!(rows, PALETTE_ROWS);
    assert!(text[5].contains("No matching commands"));
}

// ---- the picker -----------------------------------------------------------------------------------------------------------

#[test]
fn a_picker_lists_its_items_under_the_title_and_reports_its_height() {
    let items = vec![PickerItem::new("a", "Alpha"), PickerItem::new("b", "Beta"), PickerItem::new("c", "Gamma")];
    let mut props = PickerProps::new(items, "Pick one");
    props.description = "Choose carefully".to_owned();
    props.columns = 60;
    let (rows, text) = screen(60, |painter| paint_picker(painter, 0, 0, &props, 1, -1, CopyStatus::Idle));
    assert_eq!(rows, picker_rows(&props, 1));
    let title = text.iter().position(|row| row.contains("Pick one")).expect("the title");
    let alpha = text.iter().position(|row| row.contains("Alpha")).expect("Alpha");
    assert!(title < text.iter().position(|row| row.contains("Choose carefully")).expect("description"));
    assert!(alpha < text.iter().position(|row| row.contains("Beta")).expect("Beta"));
    assert!(has_row(&text, "Gamma"));
    assert!(text.iter().all(|row| row.chars().count() <= 60));
}

#[test]
fn a_long_list_shows_one_page_with_the_selected_row_in_it() {
    let items: Vec<PickerItem> = (0..30).map(|index| PickerItem::new(&format!("v{index}"), &format!("Item{index:02}"))).collect();
    let mut props = PickerProps::new(items, "Many");
    props.columns = 60;
    let (_, text) = screen(60, |painter| paint_picker(painter, 0, 0, &props, 20, -1, CopyStatus::Idle));
    assert!(has_row(&text, "Item20"), "the selected item is on screen");
    assert!(!has_row(&text, "Item00") && !has_row(&text, "Item29"), "only a page is drawn");
    let shown = text.iter().filter(|row| row.contains("Item")).count();
    assert!((1..=8).contains(&shown), "{shown} items drawn");
}

#[test]
fn a_sign_in_address_is_drawn_whole_under_the_list_and_never_cut() {
    let url = format!("https://example.test/auth?state={}", "x".repeat(80));
    let mut props = PickerProps::new(vec![PickerItem::new("a", "Alpha")], "Sign in");
    props.detail = url.clone();
    props.columns = 60;
    let (_, text) = screen(60, |painter| paint_picker(painter, 0, 0, &props, 0, -1, CopyStatus::Idle));
    let joined: String = text.iter().filter(|row| row.contains("example.test") || row.contains("xxxx")).map(|row| row.trim()).collect();
    assert!(joined.contains(&url), "{joined}");
}

// ---- the sign-in address block -----------------------------------------------------------------------------------------------

#[test]
fn the_url_block_degrades_until_it_fits_and_only_the_label_shrinks() {
    let url = format!("https://example.test/{}", "p".repeat(100));
    let full = sign_in_url_layout(&url, 40, i64::MAX);
    assert!(!full.compact && full.hint && full.rows >= 3 && full.label == url);
    let two = sign_in_url_layout(&url, 40, 2);
    assert_eq!((two.compact, two.rows, two.hint), (true, 2, true));
    assert!(two.label.chars().count() <= 40 && two.label.ends_with('\u{2026}'));
    let one = sign_in_url_layout(&url, 40, 1);
    assert_eq!((one.compact, one.rows, one.hint), (true, 1, false));
    let none = sign_in_url_layout(&url, 40, 0);
    assert_eq!((none.rows, none.label.as_str()), (0, ""));
    assert_eq!(sign_in_url_layout("  ", 40, 5).rows, 0);
}

#[test]
fn the_url_block_paints_the_wrapped_address_and_the_copy_note() {
    let url = "https://example.test/".to_owned() + &"p".repeat(40);
    let layout: SignInUrlLayout = sign_in_url_layout(&url, 30, i64::MAX);
    let (rows, text) = screen(30, |painter| paint_sign_in_url(painter, 0, 0, 30, &url, &layout, CopyStatus::Copied));
    assert_eq!(rows as usize, layout.rows);
    let address: String = text[..text.len() - 1].iter().map(|row| row.trim()).collect();
    assert!(address.contains(&url));
    assert_eq!(text[text.len() - 1], "URL copied");
}

// ---- the text entry -----------------------------------------------------------------------------------------------------------

#[test]
fn a_text_entry_shows_its_title_help_hint_and_value() {
    let mut props = TextEntryProps::new("Project name");
    props.hint = "Letters only".to_owned();
    let draft = TextEntryDraft::new("abc");
    let (rows, text) = screen(80, |painter| paint_text_entry(painter, 0, 0, &props, &draft, CopyStatus::Idle));
    assert_eq!(rows, text_entry_rows(&props, &draft, CopyStatus::Idle));
    assert!(text[1].contains("Project name") && text[1].contains("Enter to save"), "{:?}", text[1]);
    assert!(has_row(&text, "Letters only"));
    assert!(has_row(&text, "> abc"));
}

#[test]
fn a_masked_entry_never_paints_the_secret() {
    let mut props = TextEntryProps::new("API key");
    props.mask = true;
    let draft = TextEntryDraft::new("sk-secret-value");
    let (_, text) = screen(80, |painter| paint_text_entry(painter, 0, 0, &props, &draft, CopyStatus::Idle));
    assert!(!text.join("\n").contains("secret"), "{text:?}");
}

// ---- the question panel ------------------------------------------------------------------------------------------------------------

fn questions() -> Vec<Question> {
    questions_of(&json!({
        "args": { "questions": [{
            "question": "Which flavor?",
            "header": "Flavor",
            "options": [{ "label": "Vanilla", "description": "plain" }, { "label": "Mango", "description": "sweet" }],
            "recommended": 1,
        }] }
    }))
}

#[test]
fn a_question_lists_numbered_options_a_cursor_and_the_custom_row() {
    let questions = questions();
    assert_eq!(initial_cursor(&questions[0]), 1, "the cursor starts on the recommended option");
    let state = QuestionState::new(&questions);
    let (rows, text) = screen(80, |painter| paint_question(painter, 0, 0, &questions, &state, 80, None));
    assert_eq!(rows, question_view_rows(&questions, &state, 80, None));
    assert!(has_row(&text, "Which flavor?"));
    let vanilla = text.iter().position(|row| row.contains("Vanilla")).expect("Vanilla");
    let mango = text.iter().position(|row| row.contains("Mango")).expect("Mango");
    assert!(text[vanilla].contains("1.") && text[mango].contains("2."));
    assert!(text[mango].contains('\u{203a}') && !text[vanilla].contains('\u{203a}'), "the cursor marks the recommended row");
    assert!(text[mango + 1].contains("3.") && text[mango + 1].contains(CUSTOM_LABEL), "{:?}", text[mango + 1]);
}

#[test]
fn a_question_reads_from_either_place_the_arguments_can_arrive() {
    let nested = questions_of(&json!({ "args": { "questions": [{ "question": "A?" }] } }));
    let flat = questions_of(&json!({ "questions": [{ "question": "B?", "multi_select": true }] }));
    assert_eq!((nested[0].question.as_str(), nested[0].multi_select), ("A?", false));
    assert_eq!((flat[0].question.as_str(), flat[0].multi_select), ("B?", true));
    assert!(questions_of(&json!({})).is_empty());
}
