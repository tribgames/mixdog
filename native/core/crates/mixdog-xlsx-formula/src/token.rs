//! The tokenizer of the formula engine (`tokenize`, `formulaReferences` and `translateSharedFormula` of
//! `portable/xlsx-formula-engine.mjs`): the scanners are tried in the Node order at every position and the first that
//! matches wins.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, is_js_space};
use mixdog_office_base::a1::{column_label, column_number};

use crate::value::UnsupportedFormula;

/// A sheet a reference names: quoted when Excel quotes it (a doubled quote is one quote of the name), bare otherwise,
/// and a bare name is any letters.
const SHEET_PREFIX: &str = r"(?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!";
/// A cell or cell range first, then the whole-column (`A:A`) and whole-row (`1:1`) forms.
const REFERENCE_BODY: &str =
    r"\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d{1,7}:\$?\d{1,7}";

/// An error literal: after the sheet name when it named another sheet (`Data!#REF!`), and one whose sheet was deleted
/// as `#REF!` before the cells it named (`#REF!B2:B4`).
static ERROR: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        &format!("^(?:{SHEET_PREFIX})?#(?:REF!(?:{REFERENCE_BODY})?|DIV/0!|VALUE!|NAME\\?|N/A|NUM!|NULL!)"),
        "u",
    )
});
static REFERENCE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(&format!("^(?:{SHEET_PREFIX})?(?:{REFERENCE_BODY})"), "u"));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TokenKind {
    String,
    Error,
    Call,
    Reference,
    Number,
    Name,
    Operator,
    Open,
    Close,
    Comma,
}

#[derive(Debug, Clone)]
pub(crate) struct Token {
    pub kind: TokenKind,
    pub text: String,
    /// Offset of the token in the formula text, in bytes.
    pub start: usize,
    /// Offset of the token in the formula text, in UTF-16 units (the `start` of the Node token).
    pub utf16_start: usize,
}

fn is_name_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_name_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.'
}

/// Byte length of the leading run of `rest` whose characters satisfy `keep`.
fn run(rest: &str, keep: impl Fn(char) -> bool) -> usize {
    rest.char_indices().find(|(_, c)| !keep(*c)).map_or(rest.len(), |(at, _)| at)
}

/// `/"(?:[^"]|"")*"/y`: a string literal, a doubled quote being one quote of the text. When the closing quote is
/// missing the match backs off to the first quote of the last doubled pair, as the regular expression does.
fn scan_string(rest: &str) -> Option<usize> {
    if !rest.starts_with('"') {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut at = 1;
    let mut last_pair: Option<usize> = None;
    while at < bytes.len() {
        if bytes[at] == b'"' {
            if bytes.get(at + 1) == Some(&b'"') {
                last_pair = Some(at);
                at += 2;
            } else {
                return Some(at + 1);
            }
        } else {
            at += 1;
        }
    }
    last_pair.map(|pair| pair + 1)
}

/// `/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+/y`.
fn scan_number(rest: &str) -> Option<usize> {
    let bytes = rest.as_bytes();
    let digits = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let mut at = 0;
    if bytes.first().is_some_and(u8::is_ascii_digit) {
        at += digits(0);
        if bytes.get(at) == Some(&b'.') && digits(at + 1) > 0 {
            at += 1 + digits(at + 1);
        }
        if matches!(bytes.get(at), Some(b'e' | b'E')) {
            let sign = usize::from(matches!(bytes.get(at + 1), Some(b'+' | b'-')));
            let exponent = digits(at + 1 + sign);
            if exponent > 0 {
                at += 1 + sign + exponent;
            }
        }
        return Some(at);
    }
    if bytes.first() == Some(&b'.') && digits(1) > 0 {
        return Some(1 + digits(1));
    }
    None
}

/// `/[A-Za-z_][A-Za-z0-9_.]*/y`.
fn scan_name(rest: &str) -> Option<usize> {
    rest.chars().next().filter(|c| is_name_start(*c))?;
    Some(run(rest, is_name_part))
}

/// `/[A-Za-z_][A-Za-z0-9_.]*(?=\s*\()/y`: a name followed by `(` is a call, which keeps `LOG10(` from reading as a
/// cell.
fn scan_call(rest: &str) -> Option<usize> {
    let length = scan_name(rest)?;
    let after = &rest[length..];
    let spaces = run(after, is_js_space);
    after[spaces..].starts_with('(').then_some(length)
}

/// `/<>|<=|>=|[-+*\/^&=<>%]/y`.
fn scan_operator(rest: &str) -> Option<usize> {
    if rest.starts_with("<>") || rest.starts_with("<=") || rest.starts_with(">=") {
        return Some(2);
    }
    rest.chars().next().filter(|c| "-+*/^&=<>%".contains(*c)).map(|_| 1)
}

/// The anchored match of a Unicode pattern at the start of `rest`; `first` is the characters a match can begin with.
fn scan_pattern(regex: &JsRegex, rest: &str, first: impl Fn(char) -> bool) -> Option<usize> {
    if !rest.chars().next().is_some_and(first) {
        return None;
    }
    regex.find(rest).filter(|found| found.start == 0).map(|found| found.end)
}

// regress searches later positions even for an anchored pattern that cannot match.
// Reject impossible token starts before invoking it; otherwise repeated numbers or calls
// make tokenization scan the remaining formula once per token (quadratic work).
fn sheet_body(rest: &str) -> &str {
    let end = run(rest, |c| c.is_alphanumeric() || c == '_' || c == '.');
    rest[end..].strip_prefix('!').unwrap_or(rest)
}

fn error_might_match(rest: &str) -> bool {
    rest.starts_with('\'') || sheet_body(rest).starts_with('#')
}

fn reference_might_match(rest: &str) -> bool {
    // The existing regex remains authoritative for quoted sheet names and all Unicode details.
    if rest.starts_with('\'') { return true; }
    let body = sheet_body(rest);
    let body = body.strip_prefix('$').unwrap_or(body);
    let letters = run(body, |c| c.is_ascii_alphabetic());
    if (1..=3).contains(&letters) {
        let tail = &body[letters..];
        return tail.starts_with(':') || tail.strip_prefix('$').unwrap_or(tail).starts_with(|c: char| c.is_ascii_digit());
    }
    if letters != 0 { return false; }
    let digits = run(body, |c| c.is_ascii_digit());
    (1..=7).contains(&digits) && body[digits..].starts_with(':')
}

fn scan(rest: &str) -> Option<(Option<TokenKind>, usize)> {
    let space = run(rest, is_js_space);
    if space > 0 {
        return Some((None, space));
    }
    if let Some(length) = scan_string(rest) {
        return Some((Some(TokenKind::String), length));
    }
    let sheet_or_letter = |c: char| c == '\'' || c == '_' || c.is_alphabetic();
    if let Some(length) = scan_pattern(&ERROR, rest, |c| (c == '#' || sheet_or_letter(c)) && error_might_match(rest)) {
        return Some((Some(TokenKind::Error), length));
    }
    if let Some(length) = scan_call(rest) {
        return Some((Some(TokenKind::Call), length));
    }
    if let Some(length) = scan_pattern(&REFERENCE, rest, |c| (c == '$' || c.is_ascii_digit() || sheet_or_letter(c)) && reference_might_match(rest)) {
        return Some((Some(TokenKind::Reference), length));
    }
    if let Some(length) = scan_number(rest) {
        return Some((Some(TokenKind::Number), length));
    }
    if let Some(length) = scan_name(rest) {
        return Some((Some(TokenKind::Name), length));
    }
    if let Some(length) = scan_operator(rest) {
        return Some((Some(TokenKind::Operator), length));
    }
    let kind = match rest.chars().next()? {
        '(' => TokenKind::Open,
        ')' => TokenKind::Close,
        ',' => TokenKind::Comma,
        _ => return None,
    };
    Some((Some(kind), 1))
}

/// `tokenize(formula)`.
pub(crate) fn tokenize(formula: &str) -> Result<Vec<Token>, UnsupportedFormula> {
    let mut tokens = Vec::new();
    let mut at = 0;
    let mut utf16_at = 0;
    while at < formula.len() {
        let rest = &formula[at..];
        let Some((kind, length)) = scan(rest) else {
            // `formula[index]` is one UTF-16 unit: half of a surrogate pair stands for itself no better than U+FFFD.
            let unit = rest.chars().next().filter(|c| c.len_utf16() == 1).unwrap_or(char::REPLACEMENT_CHARACTER);
            return Err(UnsupportedFormula { reason: format!("unreadable character \"{unit}\"") });
        };
        let text = &rest[..length];
        if let Some(kind) = kind {
            tokens.push(Token { kind, text: text.to_owned(), start: at, utf16_start: utf16_at });
        }
        at += length;
        utf16_at += text.encode_utf16().count();
    }
    Ok(tokens)
}

/// A cell, range, whole-row or whole-column reference of a formula, with the sheet it names when it names one: a
/// deleted one that still names its sheet (`Data!#REF!`) included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormulaReference {
    pub text: String,
    /// Where it starts in the formula text, in bytes (to rewrite the reference in place).
    pub start: usize,
    /// Where it starts in UTF-16 units: the `start` of `formulaReferences`.
    pub utf16_start: usize,
}

/// `formulaReferences(formula)`: every reference in a formula, for a caller that rewrites references in place.
/// String literals are not read into.
pub fn formula_references(formula: &str) -> Result<Vec<FormulaReference>, UnsupportedFormula> {
    Ok(tokenize(formula)?
        .into_iter()
        .filter(|token| {
            token.kind == TokenKind::Reference || (token.kind == TokenKind::Error && !token.text.starts_with('#'))
        })
        .map(|token| FormulaReference { text: token.text, start: token.start, utf16_start: token.utf16_start })
        .collect())
}

/// `/^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/`: the column lock, the letters, the row lock and the row digits.
fn split_cell(part: &str) -> Option<(&str, &str, &str, &str)> {
    let (column_lock, rest) = part.strip_prefix('$').map_or(("", part), |rest| ("$", rest));
    let letters = run(rest, |c| c.is_ascii_alphabetic());
    if !(1..=3).contains(&letters) {
        return None;
    }
    let (column, rest) = rest.split_at(letters);
    let (row_lock, digits) = rest.strip_prefix('$').map_or(("", rest), |rest| ("$", rest));
    ((1..=7).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit()))
        .then_some((column_lock, column, row_lock, digits))
}

fn off_the_sheet() -> UnsupportedFormula {
    UnsupportedFormula { reason: "a shared formula that moves off the sheet".to_owned() }
}

fn shift_reference_part(part: &str, row_delta: i64, column_delta: i64) -> Result<String, UnsupportedFormula> {
    if let Some((column_lock, column, row_lock, row)) = split_cell(part) {
        let row_number = row.parse::<i64>().unwrap_or(i64::MAX);
        let moved_column = column_number(&column.to_uppercase()) + column_delta as f64;
        let moved_row = row_number.saturating_add(row_delta);
        if (column_lock.is_empty() && moved_column < 1.0) || (row_lock.is_empty() && moved_row < 1) {
            return Err(off_the_sheet());
        }
        let column_text = if column_lock.is_empty() { column_label(moved_column) } else { column.to_owned() };
        let row_text = if row_lock.is_empty() { moved_row } else { row_number };
        return Ok(format!("{column_lock}{column_text}{row_lock}{row_text}"));
    }
    let (lock, body) = part.strip_prefix('$').map_or(("", part), |rest| ("$", rest));
    if (1..=3).contains(&body.len()) && body.bytes().all(|b| b.is_ascii_alphabetic()) {
        if !lock.is_empty() {
            return Ok(part.to_owned());
        }
        let moved = column_number(&body.to_uppercase()) + column_delta as f64;
        if moved < 1.0 {
            return Err(off_the_sheet());
        }
        return Ok(column_label(moved));
    }
    if (1..=7).contains(&body.len()) && body.bytes().all(|b| b.is_ascii_digit()) {
        if !lock.is_empty() {
            return Ok(part.to_owned());
        }
        let moved = body.parse::<i64>().unwrap_or(i64::MAX).saturating_add(row_delta);
        if moved < 1 {
            return Err(off_the_sheet());
        }
        return Ok(moved.to_string());
    }
    Ok(part.to_owned())
}

fn shift_reference(text: &str, row_delta: i64, column_delta: i64) -> Result<String, UnsupportedFormula> {
    let (sheet, body) = text.rfind('!').map_or(("", text), |bang| text.split_at(bang + 1));
    let parts: Result<Vec<String>, _> =
        body.split(':').map(|part| shift_reference_part(part, row_delta, column_delta)).collect();
    Ok(format!("{sheet}{}", parts?.join(":")))
}

/// `translateSharedFormula(formula, rowDelta, columnDelta)`: the same formula as the cell it was shared from, seen from
/// `row_delta` rows and `column_delta` columns away: every relative reference moves with the cell and every one
/// pinned with `$` stays where it is. Fails when the move would leave the sheet, or the formula is outside what this
/// engine reads.
pub fn translate_shared_formula(
    formula: &str,
    row_delta: i64,
    column_delta: i64,
) -> Result<String, UnsupportedFormula> {
    let text = formula.strip_prefix('=').unwrap_or(formula);
    if row_delta == 0 && column_delta == 0 {
        return Ok(text.to_owned());
    }
    // Spliced in place: a space between two ranges is Excel's intersection operator, not layout.
    let mut translated = String::with_capacity(text.len());
    let mut at = 0;
    for token in formula_references(text)? {
        translated.push_str(&text[at..token.start]);
        translated.push_str(&shift_reference(&token.text, row_delta, column_delta)?);
        at = token.start + token.text.len();
    }
    translated.push_str(&text[at..]);
    Ok(translated)
}

#[cfg(test)]
mod tests {
    #[test]
    fn token_start_filters_preserve_anchored_reference_and_error_matches() {
        for prefix in ["", "Sheet!", "_sheet.2!", "Σ1!", "'a b'!", "'a''b'!"] {
            for body in ["A1", "$A$1", "ABC12345678", "A:B", "$A:$C", "1:2", "$1:$2", "#REF!A1", "#DIV/0!", "#N/A", "#NAME?", "SUM", "1.5", "ABS("] {
                let text = format!("{prefix}{body}+SUM(1,2)");
                if super::ERROR.find(&text).is_some_and(|m| m.start == 0) {
                    assert!(super::error_might_match(&text), "{text}");
                }
                if super::REFERENCE.find(&text).is_some_and(|m| m.start == 0) {
                    assert!(super::reference_might_match(&text), "{text}");
                }
            }
        }
    }

    use super::*;

    fn kinds(formula: &str) -> Vec<(TokenKind, String)> {
        tokenize(formula).expect("tokens").into_iter().map(|token| (token.kind, token.text)).collect()
    }

    #[test]
    fn a_name_before_a_parenthesis_is_a_call_not_a_cell() {
        assert_eq!(kinds("LOG10(A1)")[0], (TokenKind::Call, "LOG10".to_owned()));
        assert_eq!(kinds("LOG10 (1)")[0].0, TokenKind::Call);
        assert_eq!(kinds("A1")[0], (TokenKind::Reference, "A1".to_owned()));
        assert_eq!(kinds("TaxRate")[0], (TokenKind::Name, "TaxRate".to_owned()));
    }

    #[test]
    fn references_read_sheets_quoted_bare_and_in_any_script() {
        for text in ["'Raw Data'!B2", "'It''s'!A1:B2", "Data!$A$1", "데이터!A1", "Sheet1!A:A", "Sheet1!2:3", "A:A", "1:1", "A1:B2"] {
            assert_eq!(kinds(text), vec![(TokenKind::Reference, text.to_owned())], "{text}");
        }
    }

    #[test]
    fn deleted_references_are_error_tokens() {
        for text in ["#REF!", "Data!#REF!", "#REF!B2:B4", "'Raw Data'!#REF!A1", "#DIV/0!", "#N/A", "#NAME?", "#NULL!"] {
            assert_eq!(kinds(text), vec![(TokenKind::Error, text.to_owned())], "{text}");
        }
        assert!(tokenize("#GETTING_DATA").is_err());
    }

    #[test]
    fn numbers_and_operators() {
        let texts: Vec<String> = kinds("1.5e3<=.5 1e 2").into_iter().map(|(_, text)| text).collect();
        assert_eq!(texts, ["1.5e3", "<=", ".5", "1", "e", "2"]);
        assert_eq!(tokenize("2.").expect_err("refused").reason, "unreadable character \".\"");
    }

    #[test]
    fn a_string_without_its_closing_quote_backs_off_to_the_last_doubled_pair() {
        assert_eq!(scan_string(r#""a"" b"#), Some(3));
        assert_eq!(scan_string(r#""abc"#), None);
        assert_eq!(scan_string(r#""a""b"x"#), Some(6));
        assert_eq!(scan_string(r#""""#), Some(2));
        assert_eq!(scan_string(r#""""""#), Some(4));
    }

    #[test]
    fn an_unreadable_character_is_named() {
        assert_eq!(tokenize("1+@").expect_err("refused").reason, "unreadable character \"@\"");
        assert_eq!(tokenize("{1}").expect_err("refused").reason, "unreadable character \"{\"");
    }

    #[test]
    fn references_report_their_offsets_in_both_units() {
        let found = formula_references("\"x\"&가!A1+B2").expect("references");
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].text.as_str(), found[0].start, found[0].utf16_start), ("가!A1", 4, 4));
        assert_eq!((found[1].text.as_str(), found[1].start, found[1].utf16_start), ("B2", 11, 9));
    }

    #[test]
    fn shared_formulas_move_relative_references_only() {
        assert_eq!(translate_shared_formula("=A1*$C$1", 2, 0).as_deref(), Ok("A3*$C$1"));
        assert_eq!(translate_shared_formula("SUM(A1:B2)+Data!C3", 1, 1).as_deref(), Ok("SUM(B2:C3)+Data!D4"));
        assert_eq!(translate_shared_formula("SUM(A:A)+SUM(2:3)+SUM($A:$A)", 4, 1).as_deref(), Ok("SUM(B:B)+SUM(6:7)+SUM($A:$A)"));
        assert_eq!(translate_shared_formula("\"A1\"&A1", 1, 0).as_deref(), Ok("\"A1\"&A2"));
        assert_eq!(translate_shared_formula("A$1+$A1", 5, 5).as_deref(), Ok("F$1+$A6"));
        assert_eq!(translate_shared_formula("A1+1", 0, 0).as_deref(), Ok("A1+1"));
        assert_eq!(translate_shared_formula("A1", -1, 0).expect_err("off").reason, "a shared formula that moves off the sheet");
        assert_eq!(translate_shared_formula("B1", 0, -2).expect_err("off").reason, "a shared formula that moves off the sheet");
    }
}
