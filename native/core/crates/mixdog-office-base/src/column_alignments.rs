//! `shared/column-alignments.mjs`: figures are compared down the column, so they are set against the right edge and
//! the header sits over them. A currency sign may lead the figure (₩2,400,000, $120): an invoice's amounts are figures
//! too, and so is a Korean amount whose unit is spaced from its multiplier (2.6억 원), and a change in percentage
//! points (+13%p, 22%p), which set left of the percentages beside it.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_to_lowercase, js_trim, value_to_string};
use serde_json::Value;

use crate::values::truthy;

static NUMERIC_CELL: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^[(\-+−]?[₩$€£¥]?\s?[\d,.\s]+(?:%p?|(?:\s?[A-Za-z가-힣원$€£¥]{1,3}){0,2})\)?$", ""));
/// A first column of 1호, 2호 is a row label with a digit in it, not a figure to compare down the column: it stays
/// left unless every entry is a bare number.
static BARE_NUMBER_CELL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[(\-+]?[\d,.\s]+%?\)?$", ""));
static DIGIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\d", ""));

fn numeric(text: &str) -> bool {
    DIGIT.is_match(text) && NUMERIC_CELL.is_match(js_trim(text))
}

fn bare_number(text: &str) -> bool {
    DIGIT.is_match(text) && BARE_NUMBER_CELL.is_match(js_trim(text))
}

/// `figureColumnAlignments(rows, columns, declared, header)`: the text alignment of each column of a table given as
/// rows of strings. A declared alignment is kept (lower-cased), a column of figures sets right, everything else left.
/// The PDF writer and a Word table that declares none read their columns the same way.
pub fn figure_column_alignments<R, S>(rows: &[R], columns: usize, declared: &[Value], header: bool) -> Vec<String>
where
    R: AsRef<[S]>,
    S: AsRef<str>,
{
    (0..columns)
        .map(|column| {
            if let Some(stated) = declared.get(column).filter(|stated| truthy(stated)) {
                return js_to_lowercase(&value_to_string(stated));
            }
            let body: Vec<&str> = rows
                .iter()
                .skip(usize::from(header))
                .map(|row| row.as_ref().get(column).map_or("", AsRef::as_ref))
                .map(js_trim)
                .filter(|cell| !cell.is_empty())
                .collect();
            if body.is_empty() {
                return "left".to_owned();
            }
            let right = if column == 0 {
                body.iter().all(|cell| bare_number(cell))
            } else {
                body.iter().filter(|cell| numeric(cell)).count() as f64 / body.len() as f64 >= 0.6
            };
            String::from(if right { "right" } else { "left" })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A column of figures sets right, words left; amounts with a currency or a Korean unit, and percentage-point
    // changes, are figures (a %p column set left beside its percentages in the round-7 survey PDF).
    #[test]
    fn figure_columns_set_right_including_currency_units_and_percentage_points() {
        let rows = [
            ["규모", "응답자", "생산성 유지", "이직 의향 감소", "예산", "메모"],
            ["300인 미만", "620", "81%", "22%p", "2.6억 원", "확인 필요"],
            ["1,000인 이상", "510", "79%", "+24%p", "₩600,000", "보류"],
        ];
        assert_eq!(figure_column_alignments(&rows, 6, &[], true), ["left", "right", "right", "right", "right", "left"]);
        // A row label with a digit in it stays left; a declared alignment is kept.
        let labelled = [["호", "n"], ["1호", "3"], ["2호", "4"]];
        assert_eq!(figure_column_alignments(&labelled, 2, &[json!("center")], true), ["center", "right"]);
    }

    #[test]
    fn a_first_column_of_bare_numbers_sets_right() {
        let rows = [["no", "name"], ["1", "a"], ["2", "b"]];
        assert_eq!(figure_column_alignments(&rows, 2, &[], true), ["right", "left"]);
        assert_eq!(figure_column_alignments(&rows, 2, &[json!(""), json!("RIGHT")], false), ["left", "right"]);
    }

    #[test]
    fn an_empty_body_is_left() {
        let rows = [["h", "h"]];
        assert_eq!(figure_column_alignments(&rows, 3, &[], true), ["left", "left", "left"]);
    }
}
