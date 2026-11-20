//! `portable/portable-xlsx-cell-values.mjs`: what a cell of a sheet shows. A date serial as its date number format prints
//! it, a cell's label (a date-formatted number reads as its date text, any other cell as its value), and a cell's value
//! by column and row (a formula's last computed result, or a literal's own value). A pivot source and a chart's series
//! both read the sheet this way.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, math, number_to_string};
use mixdog_office_base::a1::column_label;
use serde_json::Value;

use crate::cells::{CellRecord, CellValue, cell_records, shared_strings};
use crate::sheet_styles::resolve_cell_styles;
use crate::zipio::Package;

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// `Date.UTC(1899, 11, 30)`: the day serial 0 of a workbook, in milliseconds since 1970.
const SERIAL_ORIGIN_MS: f64 = -2_209_161_600_000.0;
const DAY_MS: f64 = 86_400_000.0;
/// The largest time value a Date holds.
const MAX_TIME_MS: f64 = 8.64e15;

static QUOTED_OR_ESCAPED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#""[^"]*"|\\."#, "g"));
static HAS_DATE_LETTER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[yd]|m", "i"));
static HAS_OTHER_LETTER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[hs0#?]", "i"));
static QUOTED_LITERAL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"^"([^"]*)""#, ""));
static ESCAPED_LITERAL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\\(.)", ""));
static DATE_TOKEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(yyyy|yy|mmmm|mmm|mm|m|dd|d)", "i"));

/// The civil date (year, month 1-12, day) of a day count since 1970-01-01, in the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = if month_part < 10 { month_part + 3 } else { month_part - 9 };
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

/// `formattedDateText(serial, code)`: a date serial as a date number format shows it (`yyyy`, `yy`, `mmmm`, `mmm`, `mm`,
/// `m`, `dd`, `d`, quoted and escaped literals); `None` when the format is not a date's. A chart cached a month column
/// formatted `m"월"` as its serials (46174), and Excel kept that cache.
///
/// A serial past the range of a JavaScript Date (about 100 million days) has no year or month, and Node throws on the
/// first token it formats; the same message is the error here.
pub fn formatted_date_text(serial: f64, code: &str) -> Result<Option<String>, String> {
    let format = code.split(';').next().unwrap_or("");
    let bare = QUOTED_OR_ESCAPED.replace_all_with(format, |_| String::new());
    if !HAS_DATE_LETTER.is_match(&bare) || HAS_OTHER_LETTER.is_match(&bare) {
        return Ok(None);
    }
    if !serial.is_finite() {
        return Ok(None);
    }
    let time = SERIAL_ORIGIN_MS + math::round(serial * DAY_MS);
    let date = (time.abs() <= MAX_TIME_MS).then(|| civil_from_days((time as i64).div_euclid(86_400_000)));
    let mut out = String::new();
    let mut rest = format;
    while let Some(first) = rest.chars().next() {
        let literal = QUOTED_LITERAL.captures(rest).or_else(|| ESCAPED_LITERAL.captures(rest));
        if let Some(literal) = literal {
            out.push_str(literal.get(1).unwrap_or(""));
            rest = &rest[literal.range().end..];
            continue;
        }
        if let Some(token) = DATE_TOKEN.captures(rest).and_then(|found| found.get(1)) {
            let Some((year, month, day)) = date else {
                return Err("Cannot read properties of undefined (reading 'slice')".to_owned());
            };
            let month_name = MONTHS[(month - 1) as usize];
            match token.to_ascii_lowercase().as_str() {
                "yyyy" => out.push_str(&year.to_string()),
                "yy" => {
                    let text = year.to_string();
                    let characters: Vec<char> = text.chars().collect();
                    out.extend(characters[characters.len().saturating_sub(2)..].iter());
                }
                "mmmm" => out.push_str(month_name),
                "mmm" => out.push_str(&month_name[..3]),
                "mm" => out.push_str(&format!("{month:02}")),
                "m" => out.push_str(&month.to_string()),
                "dd" => out.push_str(&format!("{day:02}")),
                _ => out.push_str(&day.to_string()),
            }
            rest = &rest[token.len()..];
            continue;
        }
        out.push(first);
        rest = &rest[first.len_utf8()..];
    }
    Ok(Some(out))
}

/// A dated cell: its serial and the date format it is shown in.
#[derive(Debug, Clone, PartialEq)]
pub struct DatedCell {
    pub serial: f64,
    pub format: String,
}

fn grid_key(column: f64, row: f64) -> String {
    format!("{}{}", column_label(column), number_to_string(row))
}

fn grid_of(records: Vec<CellRecord>) -> HashMap<String, CellRecord> {
    // A later cell of the same reference replaces an earlier one, as a Map built from the list does.
    records.into_iter().map(|record| (record.reference.clone(), record)).collect()
}

/// What a formula cell's last result or a literal cell's own value is (`record.formula ? record.cachedValue : record.value`).
fn shown_value(record: &CellRecord) -> Option<CellValue> {
    match &record.formula {
        Some(formula) => formula.cached_value.clone(),
        None => Some(record.value.clone()),
    }
}

/// `sheetCellLabelReader(zip, xml)`: what a cell shows as a label.
#[derive(Debug)]
pub struct SheetCellLabels {
    grid: HashMap<String, CellRecord>,
}

impl SheetCellLabels {
    pub fn new(zip: &Package, xml: &str) -> Self {
        let styles = resolve_cell_styles(&zip.text("xl/styles.xml"));
        Self { grid: grid_of(cell_records(xml, &shared_strings(zip), Some(&styles))) }
    }

    /// `dated(column, row)`: a dated cell's serial and format, `None` for any other cell.
    pub fn dated(&self, column: f64, row: f64) -> Result<Option<DatedCell>, String> {
        let Some(record) = self.grid.get(&grid_key(column, row)) else { return Ok(None) };
        let Some(CellValue::Number(serial)) = shown_value(record) else { return Ok(None) };
        let format = match record.style.as_ref().and_then(|style| style.get("numberFormat")) {
            Some(Value::String(format)) if !format.is_empty() => format.clone(),
            _ => return Ok(None),
        };
        Ok(formatted_date_text(serial, &format)?.map(|_| DatedCell { serial, format }))
    }

    /// `label(column, row)`: a date-formatted number as its date text and anything else as its value; `None` when the
    /// sheet holds no such cell (or a formula without a cached result).
    pub fn label(&self, column: f64, row: f64) -> Result<Option<CellValue>, String> {
        let Some(record) = self.grid.get(&grid_key(column, row)) else { return Ok(None) };
        if let Some(date) = self.dated(column, row)? {
            return Ok(formatted_date_text(date.serial, &date.format)?.map(CellValue::Text));
        }
        Ok(shown_value(record))
    }
}

/// `sheetCellReader(zip, xml)`: what a cell of the sheet shows, by column and row: a formula's last computed result, or a
/// literal's own value.
#[derive(Debug)]
pub struct SheetCellValues {
    grid: HashMap<String, CellRecord>,
}

impl SheetCellValues {
    pub fn new(zip: &Package, xml: &str) -> Self {
        Self { grid: grid_of(cell_records(xml, &shared_strings(zip), None)) }
    }

    pub fn value(&self, column: f64, row: f64) -> Option<CellValue> {
        shown_value(self.grid.get(&grid_key(column, row))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_date_serial_reads_as_its_date_format_shows_it_and_a_number_format_is_not_a_date() {
        let text = |code: &str| formatted_date_text(46174.0, code).unwrap();
        assert_eq!(text("m\"월\""), Some("6월".to_owned()));
        assert_eq!(text("yyyy-mm"), Some("2026-06".to_owned()));
        assert_eq!(text("yyyy-mm-dd"), Some("2026-06-01".to_owned()));
        assert_eq!(text("mmm yy"), Some("Jun 26".to_owned()));
        assert_eq!(text("#,##0"), None);
        assert_eq!(text("0\"분\""), None);
        assert_eq!(text("h:mm"), None);
    }

    #[test]
    fn the_first_section_and_escapes_decide_and_the_1900_serials_are_node_dates() {
        assert_eq!(formatted_date_text(1.0, "d\\/mmmm;@").unwrap(), Some("31/December".to_owned()));
        assert_eq!(formatted_date_text(61.0, "yyyy-mm-dd").unwrap(), Some("1900-03-01".to_owned()));
        assert_eq!(formatted_date_text(59.0, "yyyy-mm-dd").unwrap(), Some("1900-02-27".to_owned()));
        assert_eq!(formatted_date_text(0.0, "yyyy-mm-dd").unwrap(), Some("1899-12-30".to_owned()));
        assert_eq!(formatted_date_text(-1.0, "mmmm d, yyyy").unwrap(), Some("December 29, 1899".to_owned()));
        assert_eq!(formatted_date_text(f64::NAN, "yyyy").unwrap(), None);
        assert_eq!(formatted_date_text(1e12, "yyyy").unwrap_err(), "Cannot read properties of undefined (reading 'slice')");
        assert_eq!(formatted_date_text(1e12, "\"x\"y").unwrap(), Some("xy".to_owned()));
    }
}
