//! How a spreadsheet cell's number reads: Excel stores a date as a day count and a percentage as a fraction, so a reader
//! that prints the stored value answers "46311" for a deadline of 2026-10-15 and "0.928" for 92.8%. The cell's own number
//! format says which, and these two are the ones that change the meaning of the value.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::math::round;
use mixdog_js::math::to_fixed;
use mixdog_js::string_to_number;

use crate::Failure;
use crate::scan::A;
use crate::scan::decode_xml_entities;
use crate::scan::first_element;
use crate::scan::first_group;

static NUM_FMT_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(&format!(r"<numFmt\b({A}?)/?>"), ""));
static XF_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(&format!(r"<xf\b({A}?)/?>"), ""));
static NUM_FMT_ID_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bnumFmtId="(\d+)""#, ""));
static FORMAT_CODE_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bformatCode="([^"<>]*)""#, ""));
static QUOTED_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#""[^"]*""#, "g"));
static ESCAPED_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\\.", "g"));
static BRACKETED_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\[[^\]]*\]", "g"));
static DECIMALS_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\.([0#]+)", ""));

/// `BUILTIN_NUMBER_FORMATS`.
fn builtin_number_format(id: f64) -> Option<&'static str> {
    if id.fract() != 0.0 || !(0.0..100.0).contains(&id) {
        return None;
    }
    Some(match id as u32 {
        9 => "0%",
        10 => "0.00%",
        14 => "m/d/yyyy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yyyy h:mm",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mm:ss.0",
        _ => return None,
    })
}

/// `cellNumberFormats(xml)`: the number format of each `cellXfs` entry by style index (`""` for General).
pub fn cell_number_formats(xml: &str) -> Result<Vec<String>, Failure> {
    if xml.is_empty() {
        return Ok(Vec::new());
    }
    let mut custom: HashMap<u64, String> = HashMap::new();
    for found in NUM_FMT_RE.captures_iter(xml) {
        let attributes = found.get(1).unwrap_or("");
        if let (Some(id), Some(code)) = (first_group(&NUM_FMT_ID_RE, attributes), first_group(&FORMAT_CODE_RE, attributes)) {
            custom.insert(string_to_number(id).to_bits(), decode_xml_entities(code)?);
        }
    }
    let cell_xfs = first_element(xml, "cellXfs").and_then(|element| element.inner).unwrap_or("");
    Ok(XF_RE
        .captures_iter(cell_xfs)
        .map(|found| {
            let id = string_to_number(first_group(&NUM_FMT_ID_RE, found.get(1).unwrap_or("")).unwrap_or("0"));
            match custom.get(&id.to_bits()).filter(|code| !code.is_empty()) {
                Some(code) => code.clone(),
                None => builtin_number_format(id).unwrap_or("").to_owned(),
            }
        })
        .collect())
}

/// Days from 1970-01-01 to the civil date, inverted: `(year, month, day)` of the day count.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `displayedNumber(raw, format)`: the date, time or percentage the format makes of the stored number, else the stored text.
pub fn displayed_number(raw: &str, format: &str) -> Result<String, Failure> {
    let number = string_to_number(raw);
    if !number.is_finite() || format.is_empty() {
        return Ok(raw.to_owned());
    }
    // Literals and escaped characters are text, not format tokens.
    let code = QUOTED_RE.replace_all_with(format, |_| String::new());
    let code = ESCAPED_RE.replace_all_with(&code, |_| String::new());
    let code = BRACKETED_RE.replace_all_with(&code, |_| String::new());
    let date = code.chars().any(|c| matches!(c, 'y' | 'Y' | 'd' | 'D'));
    let time = code.chars().any(|c| matches!(c, 'h' | 'H' | 's' | 'S'));
    if date || time {
        let ms = round((number - 25569.0) * 86_400_000.0);
        // `new Date(ms)` is invalid beyond +-8.64e15 ms.
        if !ms.is_finite() || ms.abs() > 8.64e15 {
            return Ok(raw.to_owned());
        }
        let ms = ms as i64;
        let (year, month, day) = civil_from_days(ms.div_euclid(86_400_000));
        let in_day = ms.rem_euclid(86_400_000);
        let (hour, minute, second) = (in_day / 3_600_000, in_day / 60_000 % 60, in_day / 1000 % 60);
        let clock = format!("{hour:02}:{minute:02}{}", if code.chars().any(|c| matches!(c, 's' | 'S')) { format!(":{second:02}") } else { String::new() });
        let day = format!("{year}-{month:02}-{day:02}");
        return Ok(if date && time {
            format!("{day} {clock}")
        } else if date {
            day
        } else {
            clock
        });
    }
    if code.contains('%') {
        let decimals = first_group(&DECIMALS_RE, &code).map_or(0, str::len);
        if decimals > 100 {
            return Err(Failure::Other("toFixed() digits argument must be between 0 and 100".into()));
        }
        return Ok(format!("{}%", to_fixed(number * 100.0, decimals)));
    }
    Ok(raw.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_civil_date_of_a_day_count() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(59), (1970, 3, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(19_554), (2023, 7, 16));
        assert_eq!(civil_from_days(-25_569), (1899, 12, 30));
        assert_eq!(civil_from_days(2_932_896), (9999, 12, 31));
        assert_eq!(civil_from_days(2_932_897), (10_000, 1, 1));
    }

    #[test]
    fn a_stored_number_reads_as_its_format_says() {
        assert_eq!(displayed_number("45123.7525", "m/d/yyyy").unwrap(), "2023-07-16");
        assert_eq!(displayed_number("45123.7525", "h:mm").unwrap(), "18:03");
        assert_eq!(displayed_number("45123.7525", "h:mm:ss").unwrap(), "18:03:36");
        assert_eq!(displayed_number("45123.7525", "m/d/yyyy h:mm").unwrap(), "2023-07-16 18:03");
        assert_eq!(displayed_number("0.928", "0%").unwrap(), "93%");
        assert_eq!(displayed_number("0.928", "0.0%").unwrap(), "92.8%");
        assert_eq!(displayed_number("-0.0004", "0%").unwrap(), "-0%");
        // Literals, escapes and brackets are not tokens.
        assert_eq!(displayed_number("0.5", "\"day\" 0").unwrap(), "0.5");
        assert_eq!(displayed_number("0.5", "\\d 0.0").unwrap(), "0.5");
        assert_eq!(displayed_number("0.5", "[Red]0").unwrap(), "0.5");
        assert_eq!(displayed_number("45123", "[$-409]m/d/yyyy").unwrap(), "2023-07-16");
        // Not a number, not a format, or a date outside the range of `Date`.
        assert_eq!(displayed_number("abc", "0%").unwrap(), "abc");
        assert_eq!(displayed_number("45123", "").unwrap(), "45123");
        assert_eq!(displayed_number("1e12", "m/d/yyyy").unwrap(), "1e12");
        assert_eq!(displayed_number("2958466", "yyyy").unwrap(), "10000-01-01");
    }

    #[test]
    fn a_percentage_of_more_than_a_hundred_decimals_is_the_range_error_of_to_fixed() {
        let format = format!("0.{}%", "0".repeat(101));
        match displayed_number("0.5", &format) {
            Err(Failure::Other(text)) => assert_eq!(text, "toFixed() digits argument must be between 0 and 100"),
            _ => panic!("expected the range error"),
        }
        assert!(displayed_number("0.5", &format!("0.{}%", "0".repeat(100))).is_ok());
    }

    #[test]
    fn the_formats_of_a_style_sheet_by_style_index() {
        let styles = r#"<styleSheet><numFmts><numFmt numFmtId="164" formatCode="0.000%"/><numFmt numFmtId="14" formatCode="yyyy/mm/dd"/><numFmt numFmtId="165" formatCode=""/></numFmts><cellStyleXfs><xf numFmtId="9"/></cellStyleXfs><cellXfs><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="10"/><xf numFmtId="165"/><xf/><xf numFmtId="999"/></cellXfs></styleSheet>"#;
        assert_eq!(cell_number_formats(styles).unwrap(), vec!["0.000%", "yyyy/mm/dd", "0.00%", "", "", ""]);
        assert!(cell_number_formats("").unwrap().is_empty());
        assert!(cell_number_formats("<styleSheet/>").unwrap().is_empty());
    }
}
