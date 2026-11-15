//! `components/SlashCommandPalette.jsx`: the live slash command palette. Display only: the prompt owns the keyboard and
//! forwards the arrow, enter and escape decisions, so the caret stays anchored while the palette updates above it.
//!
//! The panel always has the same height (a title row, three rows of rhythm and [`MAX_VISIBLE`] rows of list or
//! blanks), so a slash session never changes the size of the panel per keystroke.

use mixdog_term::frame::{Rect, Style};
use mixdog_term::paint::{Painter, RoundBorder, TextWrap};
use mixdog_tui_style::Key;

use crate::panel_cell_text::{cells, pad_panel_cells, truncate_panel_text};
use crate::{Justify, Run, paint_runs, selected_style, split_row, themed};

pub const MAX_VISIBLE: usize = 8;
const COMMAND_LABEL_WIDTH: usize = 18;
pub const SLASH_HELP: &str = "\u{2191}/\u{2193} select \u{b7} \u{2190}/\u{2192} change \u{b7} Enter run \u{b7} Esc cancel";
pub const SLASH_DESCRIPTION: &str = "Type to filter \u{b7} Enter runs the highlighted command.";

/// The rows of the panel: border, title, blank, description, blank and the list rows.
pub const PALETTE_ROWS: u16 = 2 + 4 + MAX_VISIBLE as u16;

/// A command as the palette shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: String,
    pub label: String,
    pub usage: String,
    pub aliases: Vec<String>,
    pub alias_usage: Vec<String>,
    /// `showAliasUsage !== false`: the alias usage shows when the query is an alias prefix.
    pub show_alias_usage: bool,
    pub description: String,
}

impl SlashCommand {
    pub fn new(name: &str, description: &str) -> Self {
        Self { name: name.to_owned(), description: description.to_owned(), show_alias_usage: true, ..Self::default() }
    }
}

/// The props of the palette.
#[derive(Clone, Debug)]
pub struct PaletteProps {
    pub commands: Vec<SlashCommand>,
    pub selected_index: usize,
    pub title: String,
    pub columns: usize,
    pub query: String,
    pub description: String,
    pub help: String,
}

impl PaletteProps {
    pub fn new(commands: Vec<SlashCommand>) -> Self {
        Self {
            commands,
            selected_index: 0,
            title: "Commands".to_owned(),
            columns: 80,
            query: String::new(),
            description: SLASH_DESCRIPTION.to_owned(),
            help: SLASH_HELP.to_owned(),
        }
    }
}

fn query_matches_alias(command: &SlashCommand, query: &str) -> bool {
    let needle = query.to_lowercase();
    !needle.is_empty() && command.aliases.iter().any(|alias| alias.to_lowercase().starts_with(&needle))
}

/// `commandDisplayLabel(command, query)`: the command's own label, else its usage with the first letter in capitals
/// (`mcp` is an acronym) and the alias usage when the query is an alias prefix.
fn command_display_label(command: &SlashCommand, query: &str) -> String {
    if !command.label.is_empty() {
        return command.label.clone();
    }
    let source = if command.usage.is_empty() { &command.name } else { &command.usage };
    let usage = source.trim_start_matches('/');
    let alias_text = if command.show_alias_usage && query_matches_alias(command, query) && !command.alias_usage.is_empty() {
        format!(" ({})", command.alias_usage.join(", "))
    } else {
        String::new()
    };
    let label = if usage.to_lowercase() == "mcp" {
        "MCP".to_owned()
    } else {
        let mut chars = usage.chars();
        chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
    };
    format!("{label}{alias_text}")
}

/// The first and last command shown: a window centred on the selected row.
fn scroll_window(total: usize, selected: usize) -> (usize, usize) {
    let mut start = selected.saturating_sub(MAX_VISIBLE / 2);
    let end = total.min(start + MAX_VISIBLE);
    if end < start + MAX_VISIBLE && start > 0 {
        start = end.saturating_sub(MAX_VISIBLE);
    }
    (start, end.max(start))
}

/// Paints the palette with its top-left cell at `(x, y)`. Returns its rows, always [`PALETTE_ROWS`].
pub fn paint_palette(painter: &mut Painter, x: i32, y: i32, props: &PaletteProps) -> u16 {
    let columns = props.columns;
    let inner = columns.saturating_sub(4);
    let cx = x + 2;
    let total = props.commands.len();
    let (start, end) = scroll_window(total, props.selected_index);
    let label_width = COMMAND_LABEL_WIDTH.min(12.max((columns as f64 * 0.45).floor() as usize));
    let description_width = columns.saturating_sub(label_width + 12);
    let description = truncate_panel_text(&props.description, inner);
    let help = truncate_panel_text(&props.help, columns.saturating_sub(cells(&props.title) + 7));

    if x >= 0 && y >= 0 {
        painter.border(Rect::new(x as u16, y as u16, columns as u16, PALETTE_ROWS), &RoundBorder::all(themed(Key::PromptBorder)));
    }
    // Both texts truncate at their end when they do not fit.
    let split = split_row(&props.title, &help, inner, (TextWrap::TruncateEnd, TextWrap::TruncateEnd), Justify::Between);
    painter.text(cx, y + 1, &props.title, themed(Key::PanelTitle), split.left_cells, TextWrap::TruncateEnd);
    painter.text(cx + split.right_x as i32, y + 1, &help, themed(Key::Subtle), split.right_cells, TextWrap::TruncateEnd);
    painter.line(cx, y + 3, if description.is_empty() { " " } else { &description }, themed(Key::Subtle));

    let top = y + 5;
    if total == 0 {
        painter.text(cx, top, "No matching commands", themed(Key::Subtle), inner, TextWrap::TruncateEnd);
        return PALETTE_ROWS;
    }
    for (offset, index) in (start..end).enumerate() {
        let row = top + offset as i32;
        let command = &props.commands[index];
        let selected = index == props.selected_index;
        let label = truncate_panel_text(&command_display_label(command, &props.query), label_width);
        let detail = truncate_panel_text(&command.description, description_width);
        let background = if selected { selected_style().bg } else { Default::default() };
        let text_style = Style { fg: if selected { selected_style().fg } else { themed(Key::Text).fg }, bg: background, ..Style::default() };
        if selected && cx >= 0 && row >= 0 {
            painter.fill(Rect::new(cx as u16, row as u16, inner as u16, 1), Style { bg: background, ..Style::default() });
        }
        let mut runs: Vec<Run> = vec![(pad_panel_cells(&label, label_width), text_style)];
        if !detail.is_empty() {
            runs.push((format!("  {detail}"), text_style));
        }
        paint_runs(painter, cx, row, &runs);
    }
    PALETTE_ROWS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_capitalised_and_mcp_is_an_acronym() {
        let model = SlashCommand::new("model", "Pick a model");
        assert_eq!(command_display_label(&model, ""), "Model");
        assert_eq!(command_display_label(&SlashCommand::new("mcp", ""), ""), "MCP");
        let mut usage = SlashCommand::new("x", "");
        usage.usage = "/resume".to_owned();
        assert_eq!(command_display_label(&usage, ""), "Resume");
        usage.label = "Custom".to_owned();
        assert_eq!(command_display_label(&usage, ""), "Custom");
    }

    #[test]
    fn the_alias_usage_shows_only_for_an_alias_prefix_query() {
        let mut command = SlashCommand::new("settings", "");
        command.aliases = vec!["config".to_owned()];
        command.alias_usage = vec!["/config".to_owned(), "/cfg".to_owned()];
        assert_eq!(command_display_label(&command, "co"), "Settings (/config, /cfg)");
        assert_eq!(command_display_label(&command, "se"), "Settings");
        command.show_alias_usage = false;
        assert_eq!(command_display_label(&command, "co"), "Settings");
    }

    #[test]
    fn the_window_is_centred_on_the_selected_command() {
        assert_eq!(scroll_window(20, 10), (6, 14));
        assert_eq!(scroll_window(20, 19), (12, 20));
        assert_eq!(scroll_window(0, 0), (0, 0));
    }
}
