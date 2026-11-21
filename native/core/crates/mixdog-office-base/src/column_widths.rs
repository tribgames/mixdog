//! `shared/column-widths.mjs`: column widths for a table the caller gave no widths, across `available` (the unit
//! `measure` answers in).
//!
//! Equal columns while every cell fits its column on one line (a stat strip, a table of short figures), otherwise the
//! automatic table layout: each column gets its longest line when all of them fit, the extra shared evenly; when they
//! do not, each column keeps its longest word, a column whose whole line costs no more than an even share of what is
//! left takes it (cheapest first), and the rest of the width goes where the text is longest.

use mixdog_js::{js_sort_by, js_words, math};

/// The lines of a cell: `split(/\r?\n/)`.
fn cell_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }
    lines
}

fn total(list: &[f64]) -> f64 {
    list.iter().sum()
}

/// `naturalColumnWidths(rows, measure, available)`: `measure(text, row_index, column)` is one line's printed width
/// in the table's own face, padding included. `None` when the table has no column or nothing is available.
pub fn natural_column_widths<R, S>(rows: &[R], mut measure: impl FnMut(&str, usize, usize) -> f64, available: f64) -> Option<Vec<f64>>
where
    R: AsRef<[S]>,
    S: AsRef<str>,
{
    let columns = rows.iter().map(|row| row.as_ref().len()).max().unwrap_or(0);
    if columns == 0 || available.is_nan() || available <= 0.0 {
        return None;
    }
    let (longest, widest_word) = column_extents(rows, &mut measure, columns);
    let share = available / columns as f64;
    if longest.iter().all(|width| *width <= share) {
        return Some(vec![share; columns]);
    }
    if total(&longest) <= available {
        let extra = (available - total(&longest)) / columns as f64;
        return Some(longest.iter().map(|width| width + extra).collect());
    }
    let words_total = total(&widest_word);
    if words_total >= available {
        return Some(widest_word.iter().map(|width| (width * available) / words_total).collect());
    }
    Some(share_beyond_words(&longest, &widest_word, available - words_total))
}

/// The longest line and the longest word of each column.
fn column_extents<R, S>(rows: &[R], measure: &mut impl FnMut(&str, usize, usize) -> f64, columns: usize) -> (Vec<f64>, Vec<f64>)
where
    R: AsRef<[S]>,
    S: AsRef<str>,
{
    let mut longest = vec![0.0_f64; columns];
    let mut widest_word = vec![0.0_f64; columns];
    for (row_index, row) in rows.iter().enumerate() {
        for (column, value) in row.as_ref().iter().enumerate() {
            for line in cell_lines(value.as_ref()) {
                longest[column] = math::max(longest[column], measure(line, row_index, column));
                for word in js_words(line) {
                    widest_word[column] = math::max(widest_word[column], measure(word, row_index, column));
                }
            }
        }
    }
    (longest, widest_word)
}

/// Every column keeps its longest word; `room` is what is left: a column whose whole line costs no more than an even
/// share of it takes it (cheapest first), and the rest goes where the text is longest.
fn share_beyond_words(longest: &[f64], widest_word: &[f64], room: f64) -> Vec<f64> {
    let columns = longest.len();
    let mut room = room;
    let mut widths = widest_word.to_vec();
    let mut open: Vec<usize> = (0..columns).collect();
    let need = |column: usize| longest[column] - widest_word[column];
    let mut by_need = open.clone();
    js_sort_by(&mut by_need, |a, b| need(*a) - need(*b));
    for column in by_need {
        if need(column) > room / open.len() as f64 {
            break;
        }
        widths[column] = longest[column];
        room -= need(column);
        open.retain(|other| *other != column);
    }
    let flexible: f64 = open.iter().map(|column| need(*column)).sum();
    for column in open.iter().copied() {
        widths[column] += if flexible > 0.0 { (room * need(column)) / flexible } else { room / open.len() as f64 };
    }
    widths
}

#[cfg(test)]
mod tests {
    use super::*;

    fn by_chars(text: &str, _row: usize, _column: usize) -> f64 {
        text.chars().count() as f64
    }

    #[test]
    fn short_cells_get_equal_columns() {
        let rows = [vec!["a", "bb"], vec!["c", "d"]];
        assert_eq!(natural_column_widths(&rows, by_chars, 20.0), Some(vec![10.0, 10.0]));
    }

    #[test]
    fn everything_fitting_shares_the_extra() {
        let rows = [vec!["abcdefgh", "ab"]];
        assert_eq!(natural_column_widths(&rows, by_chars, 14.0), Some(vec![10.0, 4.0]));
    }

    #[test]
    fn long_text_keeps_each_columns_longest_word() {
        let rows = [vec!["name", "a long description of the row that wraps"]];
        let widths = natural_column_widths(&rows, by_chars, 20.0).expect("widths");
        assert!((widths[0] - 4.0).abs() < 1e-9, "{widths:?}");
        assert!((total(&widths) - 20.0).abs() < 1e-9, "{widths:?}");
    }

    #[test]
    fn words_wider_than_the_table_scale_down() {
        let rows = [vec!["abcdefghij", "abcdefghij"]];
        assert_eq!(natural_column_widths(&rows, by_chars, 10.0), Some(vec![5.0, 5.0]));
    }

    #[test]
    fn no_columns_or_no_room() {
        let none: [Vec<&str>; 0] = [];
        assert_eq!(natural_column_widths(&none, by_chars, 10.0), None);
        assert_eq!(natural_column_widths(&[vec!["a"]], by_chars, 0.0), None);
        assert_eq!(natural_column_widths(&[vec!["a"]], by_chars, f64::NAN), None);
    }

    #[test]
    fn cell_lines_split_on_crlf_and_lf() {
        assert_eq!(cell_lines("a\r\nb\nc\r"), ["a", "b", "c\r"]);
    }
}
