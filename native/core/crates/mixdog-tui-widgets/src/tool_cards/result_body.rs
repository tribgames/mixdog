//! The multi-line result body under the `└` gutter (`tool-execution/ResultBody.jsx`): the collapsed fitted summary or the
//! expanded raw body.

use mixdog_termtext::truncate::{TruncatePosition, truncate};
use mixdog_termtext::{StringWidthOptions, string_width};
use mixdog_tui_style::Key;
use mixdog_tui_style::theme::{RESULT_GUTTER, RESULT_GUTTER_CONT};

use super::output_format::{format_expanded_result, wrap_expanded_result_lines};
use super::text_format::{delta_text_runs, fit_result_line};
use crate::{Line, runs_to_ansi, themed};

/// What a result body shows.
pub struct ResultBody<'a> {
    /// The collapsed lines (used when `raw` is off).
    pub lines: &'a [String],
    /// The text the expanded body is made of (used when `raw` is on).
    pub raw_text: &'a str,
    /// The read/grep path (language inference of the expanded body).
    pub path_arg: &'a str,
    pub is_shell: bool,
    pub columns: usize,
    /// The colour of the collapsed lines.
    pub color: Key,
    /// The expanded raw body, not the collapsed fitted summary.
    pub raw: bool,
    /// The cap of physical rows an expanded body mounts (0 disables it).
    pub max_render_lines: usize,
}

/// The rows of the body: `└` on the first, `│` on every following one, the text in the column beside the rail so a row
/// never wraps. None when there is nothing to show.
pub fn render_result_body(body: &ResultBody) -> Vec<Line> {
    let rows: Vec<String> = if body.raw {
        wrap_expanded_result_lines(&format_expanded_result(body.raw_text, body.path_arg, body.is_shell), body.columns, body.is_shell, body.max_render_lines)
    } else {
        body.lines.to_vec()
    };
    let text_width = body.columns.saturating_sub(string_width(RESULT_GUTTER, StringWidthOptions::default()));
    rows.iter()
        .enumerate()
        .map(|(at, row)| {
            let rail = runs_to_ansi(&[((if at == 0 { RESULT_GUTTER } else { RESULT_GUTTER_CONT }).to_owned(), themed(Key::Subtle))]);
            let text = if body.raw {
                if row.is_empty() { " ".to_owned() } else { row.clone() }
            } else {
                let line = if row.is_empty() { " " } else { row.as_str() };
                runs_to_ansi(&delta_text_runs(&fit_result_line(line, body.columns), body.color))
            };
            Line(format!("{rail}{}", truncate(&text, text_width, TruncatePosition::End)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use mixdog_termtext::strip_ansi;

    use super::*;

    fn plain(lines: &[Line]) -> Vec<String> {
        lines.iter().map(|line| strip_ansi(&line.0).into_owned()).collect()
    }

    #[test]
    fn a_collapsed_body_is_one_fitted_row_under_the_gutter() {
        let lines = vec!["Edited a.rs (+3 Lines, -1 Lines)".to_owned()];
        let body = ResultBody { lines: &lines, raw_text: "", path_arg: "", is_shell: false, columns: 80, color: Key::Text, raw: false, max_render_lines: 600 };
        assert_eq!(plain(&render_result_body(&body)), vec![format!("{RESULT_GUTTER}Edited a.rs (+3 Lines, -1 Lines)")]);
    }

    #[test]
    fn an_expanded_body_hangs_every_row_under_one_rail() {
        let body = ResultBody { lines: &[], raw_text: "first\nsecond", path_arg: "", is_shell: true, columns: 80, color: Key::Text, raw: true, max_render_lines: 600 };
        assert_eq!(plain(&render_result_body(&body)), vec![format!("{RESULT_GUTTER}first"), format!("{RESULT_GUTTER_CONT}second")]);
    }

    #[test]
    fn no_lines_is_no_body() {
        let body = ResultBody { lines: &[], raw_text: "", path_arg: "", is_shell: false, columns: 80, color: Key::Text, raw: false, max_render_lines: 600 };
        assert!(render_result_body(&body).is_empty());
    }
}
