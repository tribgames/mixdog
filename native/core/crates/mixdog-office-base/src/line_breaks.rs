//! `shared/line-breaks.mjs`: where a line of words breaks, for the writers that break lines themselves (the PDF
//! writer, a composed sheet's bands).

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim};

static UNIT_THEN_FIGURE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\d(?:분의|월|시|조|억|만)$", ""));
static FIGURE_START: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\d", ""));
static SUM_END: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\d[억만천조]?$", ""));
static WON_START: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^원", ""));

/// Two words that read as one stay on one line: a date, a fraction, or a time in two words ("10월 14일", "3분의 1",
/// "14시 30분"), a sum written in two groups ("12만 6천 원", "1억 3,500만 원"), and a sum with its unit ("24억 원").
/// Broken between them, a decision read "…을 10월 / 14일 투자심의에서" and a saving "12만 / 6천 원".
fn bound(left: &str, right: &str) -> bool {
    (UNIT_THEN_FIGURE.is_match(left) && FIGURE_START.is_match(right)) || (SUM_END.is_match(left) && WON_START.is_match(right))
}

/// `wrapUnits(words)`: a line's words with each pair that reads as one joined by its space, the units a line is
/// broken between.
pub fn wrap_units<S: AsRef<str>>(words: &[S]) -> Vec<String> {
    let mut units: Vec<String> = Vec::new();
    for word in words {
        let word = word.as_ref();
        if let Some(last) = units.last_mut() {
            let tail = last.rfind(' ').map_or(0, |at| at + 1);
            if bound(&last[tail..], word) {
                last.push(' ');
                last.push_str(word);
                continue;
            }
        }
        units.push(word.to_owned());
    }
    units
}

/// `withoutRunt(lines, width, limit)`: a paragraph's lines without a runt. A last line of one word under a line of
/// three or more takes the word before it along, when the pair fits and the line above stays the longer, as the slide
/// kit sets its text: a report's title read "…부산 허브 증설이 / 필요합니다". The line count stays. `width(text)`
/// measures one line against `limit`.
pub fn without_runt(lines: &[String], width: impl Fn(&str) -> f64, limit: f64) -> Vec<String> {
    let Some(last) = lines.last() else { return Vec::new() };
    if lines.len() < 2 || js_trim(last).is_empty() || wrap_units(&last.split(' ').collect::<Vec<_>>()).len() != 1 {
        return lines.to_vec();
    }
    let above = wrap_units(&lines[lines.len() - 2].split(' ').collect::<Vec<_>>());
    if above.len() < 3 {
        return lines.to_vec();
    }
    let moved = format!("{} {last}", above[above.len() - 1]);
    let rest = above[..above.len() - 1].join(" ");
    if width(&moved) > limit || width(&rest) < width(&moved) {
        return lines.to_vec();
    }
    let mut out = lines[..lines.len() - 2].to_vec();
    out.push(rest);
    out.push(moved);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(text: &str) -> f64 {
        text.chars().count() as f64
    }

    #[test]
    fn dates_fractions_and_sums_stay_together() {
        assert_eq!(wrap_units(&["을", "10월", "14일", "투자심의에서"]), ["을", "10월 14일", "투자심의에서"]);
        assert_eq!(wrap_units(&["12만", "6천", "원"]), ["12만 6천 원"]);
        assert_eq!(wrap_units(&["3분의", "1"]), ["3분의 1"]);
        assert_eq!(wrap_units(&["24억", "원", "예산"]), ["24억 원", "예산"]);
        assert_eq!(wrap_units(&["a", "b"]), ["a", "b"]);
    }

    #[test]
    fn a_runt_takes_the_word_before_it() {
        let lines = vec!["aaaa bbbb cc".to_owned(), "dd".to_owned()];
        assert_eq!(without_runt(&lines, chars, 20.0), ["aaaa bbbb", "cc dd"]);
        // The line above must stay the longer.
        let hangul = vec!["부산 허브 증설이".to_owned(), "필요합니다".to_owned()];
        assert_eq!(without_runt(&hangul, chars, 20.0), hangul);
    }

    #[test]
    fn a_runt_stays_when_the_pair_does_not_fit_or_the_line_above_is_short() {
        let lines = vec!["aaaa bbbb cc".to_owned(), "dd".to_owned()];
        assert_eq!(without_runt(&lines, chars, 4.0), lines);
        let short = vec!["부산 허브".to_owned(), "필요합니다".to_owned()];
        assert_eq!(without_runt(&short, chars, 20.0), short);
        let single = vec!["a b c".to_owned()];
        assert_eq!(without_runt(&single, chars, 20.0), single);
        assert!(without_runt(&[], chars, 20.0).is_empty());
    }
}
