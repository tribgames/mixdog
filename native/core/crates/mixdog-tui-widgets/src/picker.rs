//! `components/Picker.jsx`: the selectable list picker of the slash commands.
//!
//! A bordered, scrollable list with a title row, a description row, an optional footer, an optional confirm bar and an
//! optional sign-in URL block under the panel. The scroll window is centred on the selected row; the chrome around the
//! list is a constant six rows. The keys are in [`state`]; [`picker_rows`] is the exact height of what
//! [`paint_picker`] draws.

use mixdog_js::js_trim;
use mixdog_term::frame::{Color, Rect};
use mixdog_term::paint::{Painter, RoundBorder, TextWrap};
use mixdog_tui_style::Key;
use mixdog_tui_style::theme::Color as ThemeColor;

use crate::confirm_bar::{ConfirmButton, clamp_confirm_focus, confirm_bar_width, paint_confirm_bar};
use crate::hint_overprint::clean_right_message;
use crate::panel_cell_text::{cells, truncate_panel_text};
use crate::sign_in_url::{CopyStatus, SignInUrlLayout, paint_sign_in_url, sign_in_url_layout, sign_in_url_note};
use crate::{Justify, Run, grid_color, paint_runs, paint_split, split_row, themed};

pub mod layout;
mod row;
pub mod state;

use layout::{
    ADJUST_HELP, CONFIRM_HELP, DEFAULT_LABEL_WIDTH, FooterInput, FooterLine, MAX_VISIBLE, SELECT_HELP, clamp_label_width, clamp_meta_width,
    normalize_footer_lines,
};
use row::{ItemRow, paint_item_row};

/// One part of a row's meta column, cut and padded to its own width.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MetaPart {
    pub text: String,
    pub width: usize,
}

/// One list row.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PickerItem {
    pub value: String,
    pub label: String,
    pub label_suffix: String,
    pub label_suffix_color: Option<ThemeColor>,
    pub marker: String,
    pub marker_color: Option<ThemeColor>,
    /// A check mark in the marker column: `Some(true)` shows `✓`, `Some(false)` a blank that keeps the column.
    pub checked: Option<bool>,
    pub meta: String,
    pub model_profile: String,
    pub meta_parts: Option<Vec<MetaPart>>,
    pub description: String,
}

impl PickerItem {
    pub fn new(value: &str, label: &str) -> Self {
        Self { value: value.to_owned(), label: label.to_owned(), ..Self::default() }
    }

    fn has_marker(&self) -> bool {
        !self.marker.is_empty() || self.checked.is_some()
    }

    fn has_meta(&self) -> bool {
        !self.meta.is_empty() || !self.model_profile.is_empty() || self.meta_parts.is_some()
    }

    /// The marker the row shows: its own, else the check mark state.
    fn shown_marker(&self) -> &str {
        if !self.marker.is_empty() {
            return &self.marker;
        }
        match self.checked {
            Some(true) => "\u{2713}",
            Some(false) => " ",
            None => "",
        }
    }

    fn shown_meta(&self) -> &str {
        if self.meta.is_empty() { &self.model_profile } else { &self.meta }
    }
}

/// When the row numbers show.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IndexMode {
    /// Only when the list scrolls.
    #[default]
    Auto,
    Always,
    Never,
}

/// The footer lines for the highlighted row (`None` when the list is empty) and its index.
pub type FooterFn = Box<dyn Fn(Option<&PickerItem>, usize) -> Vec<FooterInput>>;

/// The footer: lines, or lines that depend on the highlighted row.
#[derive(Default)]
pub enum Footer {
    #[default]
    None,
    Lines(Vec<FooterInput>),
    ByItem(FooterFn),
}

impl Footer {
    /// A single plain footer line (nothing for an empty text).
    pub fn text(text: &str) -> Self {
        if text.is_empty() { Self::None } else { Self::Lines(vec![FooterInput::plain(text)]) }
    }

    fn active(&self, items: &[PickerItem], selected: usize) -> Vec<FooterInput> {
        match self {
            Self::None => Vec::new(),
            Self::Lines(lines) => lines.clone(),
            Self::ByItem(by_item) => by_item(items.get(selected), selected),
        }
    }
}

/// The props of the picker.
pub struct PickerProps {
    pub items: Vec<PickerItem>,
    pub title: String,
    pub description: String,
    /// A sign-in URL, drawn complete and borderless under the panel (never truncated like `description`).
    pub detail: String,
    pub footer: Footer,
    pub help: Option<String>,
    pub columns: usize,
    pub label_width: Option<usize>,
    pub meta_width: Option<usize>,
    pub footer_gap_rows: usize,
    pub index_mode: IndexMode,
    /// The rows the panel fills (`height="100%"` of a parent of that height); `None` is the height of its content.
    pub fill_height: Option<u16>,
    pub visible_count: usize,
    /// A loading panel reserves the content-row geometry of the real list.
    pub loading: bool,
    /// The onboarding confirm bar.
    pub confirm_buttons: Vec<ConfirmButton>,
    /// The owner handles left, right or tab (the help line says `←/→ Adjust`).
    pub adjustable: bool,
}

impl PickerProps {
    pub fn new(items: Vec<PickerItem>, title: &str) -> Self {
        Self {
            items,
            title: title.to_owned(),
            description: String::new(),
            detail: String::new(),
            footer: Footer::None,
            help: None,
            columns: 80,
            label_width: None,
            meta_width: None,
            footer_gap_rows: 1,
            index_mode: IndexMode::Auto,
            fill_height: None,
            visible_count: MAX_VISIBLE,
            loading: false,
            confirm_buttons: Vec::new(),
            adjustable: false,
        }
    }
}

/// Everything the layout decides before drawing.
struct Plan {
    visible_limit: usize,
    footer_lines: Vec<FooterLine>,
    url_layout: SignInUrlLayout,
    detail_text: String,
    effective_visible_limit: usize,
    help_text: String,
}

/// The rows the chrome around a list needs (title, blank, description, blank).
const RHYTHM_ROWS: u16 = 3;

fn plan(props: &PickerProps, selected: usize) -> Plan {
    let visible_limit = if props.visible_count == 0 { MAX_VISIBLE } else { props.visible_count };
    let has_confirm = !props.confirm_buttons.is_empty();
    let confirm_inline = confirm_bar_width(&props.confirm_buttons);
    let active = props.footer.active(&props.items, selected);
    let footer_lines = normalize_footer_lines(&active, props.columns.saturating_sub(if has_confirm { confirm_inline + 1 } else { 0 }));
    let footer_gap = if footer_lines.is_empty() { 0 } else { props.footer_gap_rows };
    let footer_reserve = if footer_lines.is_empty() { 0 } else { footer_lines.len() + footer_gap };
    let confirm_reserve = if has_confirm && footer_lines.is_empty() { 2 } else { 0 };
    let detail_text = js_trim(&props.detail).to_owned();
    // The URL is drawn under the panel: its rows come out of the list so the total height is unchanged. It gets the
    // rows left beside up to two list rows (one, if that leaves nothing) and degrades until it fits.
    let rows_after_chrome = visible_limit as i64 - footer_reserve as i64 - confirm_reserve as i64;
    let items = props.items.len().min(2) as i64;
    let kept_list_rows = if rows_after_chrome - items >= 1 { items } else { 1 };
    let url_layout = sign_in_url_layout(&detail_text, props.columns, rows_after_chrome - kept_list_rows);
    let effective_visible_limit = (visible_limit as i64 - footer_reserve as i64 - confirm_reserve as i64 - url_layout.rows as i64).max(1) as usize;
    let help_text = match &props.help {
        Some(help) if !help.is_empty() => help.clone(),
        _ if has_confirm => CONFIRM_HELP.to_owned(),
        _ if props.adjustable => ADJUST_HELP.to_owned(),
        _ => SELECT_HELP.to_owned(),
    };
    Plan { visible_limit, footer_lines, url_layout, detail_text, effective_visible_limit, help_text }
}

/// The page size of the page keys for these props.
pub fn effective_visible_limit(props: &PickerProps, selected: usize) -> usize {
    plan(props, selected).effective_visible_limit
}

/// The description row: collapsed to one line and truncated, so a multi-line description cannot push the title off the
/// top. With no hint row under the URL, the row carries the copy note.
fn panel_description(props: &PickerProps, plan: &Plan, status: CopyStatus) -> String {
    let source = if !plan.url_layout.hint && !plan.detail_text.is_empty() { sign_in_url_note(status) } else { props.description.clone() };
    truncate_panel_text(&clean_right_message(&source), props.columns.saturating_sub(4))
}

/// The first and last list row shown: a window centred on the selected row.
fn scroll_window(total: usize, selected: usize, limit: usize) -> (usize, usize) {
    let half = limit / 2;
    let mut start = selected.saturating_sub(half);
    let end = total.min(start + limit);
    if end < start + limit && start > 0 {
        start = end.saturating_sub(limit);
    }
    (start, end.max(start))
}

/// The rows a picker takes for these props with row `selected` highlighted, the URL block under it included.
pub fn picker_rows(props: &PickerProps, selected: usize) -> u16 {
    layout_of(props, selected).total_rows
}

struct Frame {
    /// The title row's split and its rows.
    title: crate::Split,
    border_height: u16,
    total_rows: u16,
    footer_rows: u16,
    confirm_rows: u16,
}

fn layout_of(props: &PickerProps, selected: usize) -> Frame {
    let plan = plan(props, selected);
    let inner = props.columns.saturating_sub(4);
    let has_confirm = !props.confirm_buttons.is_empty();
    let empty = props.items.is_empty();
    let title_text = if empty && props.title.is_empty() { "Picker" } else { props.title.as_str() };
    let title = split_row(title_text, &plan.help_text, inner, (TextWrap::Wrap, TextWrap::Wrap), Justify::Between);
    let (list_rows, footer_rows, confirm_rows) = if empty {
        (if props.loading { plan.visible_limit } else { 1 }, 0, if has_confirm { 2 } else { 0 })
    } else {
        let (start, end) = scroll_window(props.items.len(), selected, plan.effective_visible_limit);
        let footer = plan.footer_lines.len();
        (end - start, footer, if has_confirm && footer == 0 { 2 } else { 0 })
    };
    let detail_rows = if empty { 0 } else { plan.url_layout.rows as u16 };
    let content = title.rows + RHYTHM_ROWS + list_rows as u16 + footer_rows as u16 + confirm_rows;
    let border_height = match props.fill_height {
        Some(rows) => rows.saturating_sub(detail_rows),
        None => content + 2,
    };
    Frame { title, border_height, total_rows: border_height + detail_rows, footer_rows: footer_rows as u16, confirm_rows }
}

fn line_of(text: String, color: Color) -> Run {
    (text, mixdog_term::frame::Style { fg: color, ..Default::default() })
}

/// Paints the picker with its top-left cell at `(x, y)`, `props.columns` wide; `selected` and `confirm_focus` are the
/// state, `status` what the last URL copy did. Returns the rows it took.
pub fn paint_picker(painter: &mut Painter, x: i32, y: i32, props: &PickerProps, selected: usize, confirm_focus: i64, status: CopyStatus) -> u16 {
    let plan = plan(props, selected);
    let frame = layout_of(props, selected);
    let columns = props.columns;
    let inner = columns.saturating_sub(4);
    let (cx, width16) = (x + 2, columns as u16);
    let has_confirm = !props.confirm_buttons.is_empty();
    let focus = clamp_confirm_focus(confirm_focus, props.confirm_buttons.len());
    let empty = props.items.is_empty();

    if x >= 0 && y >= 0 {
        painter.border(Rect::new(x as u16, y as u16, width16, frame.border_height), &RoundBorder::all(themed(Key::PromptBorder)));
    }
    let title_text = if empty && props.title.is_empty() { "Picker" } else { props.title.as_str() };
    let left = (title_text.to_owned(), themed(Key::PanelTitle));
    let right = (plan.help_text.clone(), themed(Key::Subtle));
    let title_rows = paint_split(painter, cx, y + 1, &frame.title, &left, &right, (TextWrap::Wrap, TextWrap::Wrap)) as i32;
    let description = panel_description(props, &plan, status);
    let description_row = y + 1 + title_rows + 1;
    let shown = if description.is_empty() { " " } else { description.as_str() };
    painter.line(cx, description_row, shown, themed(Key::Text));
    let list_top = description_row + 2;
    // A box that fills its parent pushes the footer and the confirm bar to its bottom edge.
    let tail_rows = i32::from(frame.footer_rows) + i32::from(frame.confirm_rows);
    let last_content = y + i32::from(frame.border_height) - 2;

    if empty {
        if props.loading {
            for index in 0..plan.visible_limit {
                painter.line(cx, list_top + index as i32, " ", themed(Key::Inactive));
            }
        } else {
            painter.line(cx, list_top, "(empty)", themed(Key::Inactive));
        }
        if has_confirm {
            paint_confirm_bar(painter, cx, last_content, &props.confirm_buttons, focus);
        }
        return frame.total_rows;
    }

    let total = props.items.len();
    let (start, end) = scroll_window(total, selected, plan.effective_visible_limit);
    let show_index = match props.index_mode {
        IndexMode::Always => total > 0,
        IndexMode::Never => false,
        IndexMode::Auto => total > plan.effective_visible_limit,
    };
    let index_width = if show_index { cells(&format!("{total}.")) } else { 0 };
    let index_offset = if show_index { index_width + 1 } else { 0 };
    let label_width = clamp_label_width(props.label_width.unwrap_or(DEFAULT_LABEL_WIDTH), columns);
    let marker_width = if props.items.iter().any(PickerItem::has_marker) { 2 } else { 0 };
    let has_meta = props.meta_width.is_some() || props.items.iter().any(PickerItem::has_meta);
    let meta_width = if has_meta { clamp_meta_width(props.meta_width, columns, label_width) } else { 0 };
    let description_width =
        (columns as i64 - index_offset as i64 - marker_width as i64 - label_width as i64 - if has_meta { meta_width as i64 + 14 } else { 12 }).max(0) as usize;

    for (offset, item) in props.items[start..end].iter().enumerate() {
        let index = start + offset;
        let index_text = if show_index { format!("{}.", index + 1) } else { String::new() };
        let item_row = ItemRow {
            index_text: &index_text,
            index_width,
            marker: item.shown_marker(),
            marker_color: item.marker_color.map(grid_color),
            marker_width,
            label: &item.label,
            label_suffix: &item.label_suffix,
            label_suffix_color: item.label_suffix_color.map(grid_color),
            meta: item.shown_meta(),
            meta_parts: item.meta_parts.as_deref(),
            description: &item.description,
            label_width,
            meta_width,
            description_width,
            show_meta: has_meta,
            selected: index == selected && focus < 0,
        };
        paint_item_row(painter, cx, list_top + offset as i32, inner, &item_row);
    }

    let tail_top = if props.fill_height.is_some() { last_content - tail_rows + 1 } else { list_top + (end - start) as i32 };
    if !plan.footer_lines.is_empty() {
        let last = plan.footer_lines.len() - 1;
        for (index, line) in plan.footer_lines.iter().enumerate() {
            let row = tail_top + index as i32;
            let mut runs: Vec<Run> = Vec::new();
            if !line.glyph.is_empty() {
                runs.push(line_of(format!("{} ", line.glyph), line.color));
            }
            runs.push((line.text.clone(), themed(Key::Text)));
            paint_runs(painter, cx, row, &runs);
            if has_confirm && index == last {
                let bar_x = cx + inner as i32 - confirm_bar_width(&props.confirm_buttons) as i32;
                paint_confirm_bar(painter, bar_x, row, &props.confirm_buttons, focus);
            }
        }
    } else if has_confirm {
        paint_confirm_bar(painter, cx, tail_top + 1, &props.confirm_buttons, focus);
    }
    paint_sign_in_url(painter, x, y + i32::from(frame.border_height), columns, &plan.detail_text, &plan.url_layout, status);
    frame.total_rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(count: usize) -> Vec<PickerItem> {
        (0..count).map(|index| PickerItem::new(&format!("v{index}"), &format!("Item {index}"))).collect()
    }

    #[test]
    fn the_scroll_window_is_centred_and_keeps_the_page_full_at_the_end() {
        assert_eq!(scroll_window(20, 0, 8), (0, 8));
        assert_eq!(scroll_window(20, 10, 8), (6, 14));
        assert_eq!(scroll_window(20, 19, 8), (12, 20));
        assert_eq!(scroll_window(3, 1, 8), (0, 3));
    }

    #[test]
    fn the_height_is_the_chrome_the_list_and_the_footer() {
        // Border (2) + title, blank, description, blank (4) + the rows.
        assert_eq!(picker_rows(&PickerProps::new(items(3), "T"), 0), 2 + 4 + 3);
        assert_eq!(picker_rows(&PickerProps::new(items(30), "T"), 0), 2 + 4 + 8);
        let mut footer = PickerProps::new(items(3), "T");
        footer.footer = Footer::text("hint");
        assert_eq!(picker_rows(&footer, 0), 2 + 4 + 3 + 1);
        // Only the list gives rows up for the footer and its gap.
        let mut many = PickerProps::new(items(30), "T");
        many.footer = Footer::text("hint");
        assert_eq!(picker_rows(&many, 0), 2 + 4 + 6 + 1);
    }

    #[test]
    fn an_empty_or_loading_list_keeps_the_geometry() {
        assert_eq!(picker_rows(&PickerProps::new(Vec::new(), ""), 0), 2 + 4 + 1);
        let mut loading = PickerProps::new(Vec::new(), "T");
        loading.loading = true;
        assert_eq!(picker_rows(&loading, 0), 2 + 4 + MAX_VISIBLE as u16);
        loading.confirm_buttons = vec![ConfirmButton::new("next", "Next")];
        assert_eq!(picker_rows(&loading, 0), 2 + 4 + MAX_VISIBLE as u16 + 2);
    }

    #[test]
    fn the_url_block_takes_its_rows_from_the_list_and_sits_under_the_border() {
        let mut props = PickerProps::new(items(30), "T");
        props.detail = "https://example.com/a/very/long/oauth/authorize/url?with=query&and=more".to_owned();
        props.columns = 60;
        let rows = picker_rows(&props, 0);
        let plan = plan(&props, 0);
        assert_eq!(usize::from(rows), 2 + 4 + plan.effective_visible_limit + plan.url_layout.rows);
        assert_eq!(plan.effective_visible_limit + plan.url_layout.rows, MAX_VISIBLE);
    }

    #[test]
    fn markers_and_meta_come_from_the_items() {
        let mut checked = PickerItem::new("a", "A");
        checked.checked = Some(true);
        assert_eq!(checked.shown_marker(), "\u{2713}");
        checked.checked = Some(false);
        assert_eq!(checked.shown_marker(), " ");
        let mut profile = PickerItem::new("b", "B");
        profile.model_profile = "fast".to_owned();
        assert!(profile.has_meta());
        assert_eq!(profile.shown_meta(), "fast");
    }
}
