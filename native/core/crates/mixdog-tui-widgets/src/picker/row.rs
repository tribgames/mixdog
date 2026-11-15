//! `components/picker/PickerItemRow.jsx`: one list row of the picker.

use mixdog_term::frame::{Color, Rect, Style};
use mixdog_term::paint::Painter;
use mixdog_tui_style::Key;

use super::MetaPart;
use crate::panel_cell_text::{cells, pad_panel_cells, truncate_panel_text};
use crate::{paint_runs, selected_style, themed, Run};

/// The props of a row, the way the picker derives them from an item and the layout.
pub struct ItemRow<'a> {
    pub index_text: &'a str,
    pub index_width: usize,
    pub marker: &'a str,
    pub marker_color: Option<Color>,
    pub marker_width: usize,
    pub label: &'a str,
    pub label_suffix: &'a str,
    pub label_suffix_color: Option<Color>,
    pub meta: &'a str,
    pub meta_parts: Option<&'a [MetaPart]>,
    pub description: &'a str,
    pub label_width: usize,
    pub meta_width: usize,
    pub description_width: usize,
    pub show_meta: bool,
    pub selected: bool,
}

/// The pieces of a row in the order they are drawn, each with its style.
fn row_runs(row: &ItemRow<'_>) -> Vec<Run> {
    let selected = row.selected;
    let row_text = if selected { selected_style().fg } else { themed(Key::Text).fg };
    let index_color = if selected { selected_style().fg } else { themed(Key::Subtle).fg };
    let on = |fg: Color| Style { fg, bg: if selected { selected_style().bg } else { Color::Default }, ..Style::default() };

    let suffix = if row.label_suffix.is_empty() { String::new() } else { truncate_panel_text(row.label_suffix, row.label_width) };
    let suffix_gap = if !suffix.is_empty() && cells(&suffix) < row.label_width { " " } else { "" };
    let suffix_width = if suffix.is_empty() { 0 } else { cells(suffix_gap) + cells(&suffix) };
    let marker = truncate_panel_text(row.marker, row.marker_width);
    let label = truncate_panel_text(row.label, row.label_width.saturating_sub(suffix_width));
    let label_padding = " ".repeat(row.label_width.saturating_sub(cells(&label) + suffix_width));

    let marker_color = if row.marker_width > 0 {
        if selected {
            selected_style().fg
        } else if !row.marker.is_empty() {
            row.marker_color.unwrap_or(themed(Key::Success).fg)
        } else {
            row_text
        }
    } else {
        row_text
    };
    let suffix_color = if selected { selected_style().fg } else { row.label_suffix_color.unwrap_or(themed(Key::Success).fg) };

    let mut runs: Vec<Run> = Vec::new();
    if row.index_width > 0 {
        runs.push((format!("{} ", pad_panel_cells(row.index_text, row.index_width)), on(index_color)));
    }
    if row.marker_width > 0 {
        runs.push((pad_panel_cells(&marker, row.marker_width), on(marker_color)));
    }
    runs.push((label, on(row_text)));
    if !suffix.is_empty() {
        runs.push((format!("{suffix_gap}{suffix}"), on(suffix_color)));
    }
    runs.push((label_padding, on(row_text)));
    if row.show_meta {
        let meta = match row.meta_parts {
            Some(parts) => pad_panel_cells(
                &parts
                    .iter()
                    .map(|part| {
                        let width = part.width.max(1);
                        pad_panel_cells(&truncate_panel_text(&part.text, width), width)
                    })
                    .collect::<Vec<_>>()
                    .join("  "),
                row.meta_width,
            ),
            None => pad_panel_cells(&truncate_panel_text(row.meta, row.meta_width), row.meta_width),
        };
        runs.push((format!("  {meta}"), on(row_text)));
    }
    let description = truncate_panel_text(row.description, row.description_width);
    if !description.is_empty() {
        runs.push((format!("  {description}"), on(row_text)));
    }
    runs
}

/// Paints a row on line `y` from `x`, `width` cells wide: a selected row has the selection background over its whole
/// width.
pub fn paint_item_row(painter: &mut Painter, x: i32, y: i32, width: usize, row: &ItemRow<'_>) {
    if row.selected && x >= 0 && y >= 0 {
        painter.fill(Rect::new(x as u16, y as u16, width as u16, 1), Style { bg: selected_style().bg, ..Style::default() });
    }
    paint_runs(painter, x, y, &row_runs(row));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base<'a>() -> ItemRow<'a> {
        ItemRow {
            index_text: "",
            index_width: 0,
            marker: "",
            marker_color: None,
            marker_width: 0,
            label: "Beta",
            label_suffix: "",
            label_suffix_color: None,
            meta: "",
            meta_parts: None,
            description: "second",
            label_width: 8,
            meta_width: 0,
            description_width: 20,
            show_meta: false,
            selected: false,
        }
    }

    fn text(runs: &[Run]) -> String {
        runs.iter().map(|(text, _)| text.as_str()).collect()
    }

    #[test]
    fn the_label_is_padded_to_its_column_and_the_description_follows() {
        assert_eq!(text(&row_runs(&base())), "Beta      second");
    }

    #[test]
    fn a_suffix_takes_cells_from_the_label_column() {
        let row = ItemRow { label_suffix: "S", ..base() };
        assert_eq!(text(&row_runs(&row)), "Beta S    second");
        let tight = ItemRow { label: "abcdefgh", label_suffix: "S", ..base() };
        assert_eq!(text(&row_runs(&tight)), "abcde\u{2026} S  second");
    }

    #[test]
    fn meta_parts_are_cut_and_padded_to_their_own_widths() {
        let parts = [MetaPart { text: "abcdef".to_owned(), width: 3 }];
        let row = ItemRow { show_meta: true, meta_width: 6, meta_parts: Some(&parts), description: "", ..base() };
        assert_eq!(text(&row_runs(&row)), "Beta      ab\u{2026}   ");
    }
}
