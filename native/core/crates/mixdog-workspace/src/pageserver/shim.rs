//! The sandbox storage shim (`shared/sandbox-storage-shim.ts`). A sandboxed page runs in an opaque origin where merely touching
//! `localStorage` throws; the shim is an inline script, first in the document, that replaces a storage which throws with an in-memory one.
//! `shim.js` is byte-identical to the TypeScript copy the renderer builds `srcdoc` pages with; `page-policy-parity.test.mjs` pins both.

/// The inline script text (an IIFE); plain ES5, no `</script` inside.
pub const SHIM_SOURCE: &str = include_str!("shim.js");

/// `/\s/` of JavaScript: the Unicode space separators, the line terminators, tab, vertical tab, form feed and the byte order mark.
fn js_space(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{FEFF}'
}

fn char_at(html: &str, at: usize) -> Option<char> {
    html.get(at..)?.chars().next()
}

/// Index just past the `>` that closes the start tag whose attributes begin at `from`, skipping quoted attribute values.
fn start_tag_end(html: &str, from: usize) -> Option<usize> {
    let mut i = from;
    while let Some(ch) = char_at(html, i) {
        if ch == '>' {
            return Some(i + 1);
        }
        i += ch.len_utf8();
        if ch != '=' {
            continue;
        }
        while char_at(html, i).is_some_and(js_space) {
            i += char_at(html, i).map_or(1, char::len_utf8);
        }
        if let Some(quote @ ('"' | '\'')) = char_at(html, i) {
            let close = html[i + 1..].find(quote)?;
            i = i + 1 + close + 1;
        }
    }
    None
}

/// Where a script must go to run before any page content: just inside `<head>`; with no head before the first content, after the prelude
/// (byte order mark, comments, doctype, `<html>`), so it never precedes the doctype. Scans tag by tag, so `<head>` text in comments, in
/// script bodies or in attribute values is never mistaken for the real tag.
fn head_insertion_point(html: &str) -> usize {
    let bytes = html.as_bytes();
    let mut safe = if html.starts_with('\u{FEFF}') { '\u{FEFF}'.len_utf8() } else { 0 };
    let mut i = safe;
    while let Some(ch) = char_at(html, i) {
        if js_space(ch) {
            i += ch.len_utf8();
        } else if html[i..].starts_with("<!--") {
            // A comment ends at the first `-->` or `--!>`; `<!-->` and `<!--->` are complete (abrupt) comments in HTML parsing.
            let from = i + 4;
            let dash = html.get(from..).and_then(|rest| rest.find("-->")).map(|at| from + at);
            let bang = html.get(from..).and_then(|rest| rest.find("--!>")).map(|at| from + at);
            let mut close = match (dash, bang) {
                (Some(d), b) if b.is_none_or(|b| d < b) => Some(d + 3),
                (_, Some(b)) => Some(b + 4),
                _ => None,
            };
            if html[i..].starts_with("<!-->") {
                close = Some(i + 5);
            } else if html[i..].starts_with("<!--->") {
                close = Some(i + 6);
            }
            let Some(close) = close else { return safe };
            safe = close;
            i = close;
        } else if html[i..].starts_with("<!") || html[i..].starts_with("<?") {
            let Some(close) = html[i..].find('>').map(|at| i + at) else { return safe };
            if bytes.get(i..i + 9).is_some_and(|head| head.eq_ignore_ascii_case(b"<!doctype")) {
                safe = close + 1;
            }
            i = close + 1;
        } else if html[i..].starts_with("</") {
            let Some(close) = html[i..].find('>').map(|at| i + at) else { return safe };
            i = close + 1;
        } else if ch == '<' && bytes.get(i + 1).is_some_and(u8::is_ascii_alphabetic) {
            // The name is read from the first 39 UTF-16 units after `<`.
            let mut units = 0;
            let mut name_len = 0;
            for next in html[i + 1..].chars() {
                units += next.len_utf16();
                if units > 39 || js_space(next) || next == '/' || next == '>' {
                    break;
                }
                name_len += next.len_utf8();
            }
            let name = &html[i + 1..i + 1 + name_len];
            let Some(end) = start_tag_end(html, i + 1 + name_len) else { return safe };
            if name.eq_ignore_ascii_case("head") {
                return end;
            }
            // Anything but <html> is page content: head is missing or too late.
            if !name.eq_ignore_ascii_case("html") {
                return safe;
            }
            safe = end;
            i = end;
        } else {
            return safe;
        }
    }
    safe
}

/// `html` with `script` as an inline `<script>` placed before any page content.
pub fn with_head_script(html: &str, script: &str) -> String {
    let at = head_insertion_point(html);
    format!("{}<script>{script}</script>{}", &html[..at], &html[at..])
}

/// A sandboxed page document with the storage shim first in its head. The bytes are read as UTF-8 (a bad sequence becomes U+FFFD).
pub fn with_sandbox_storage_shim(html: &[u8]) -> Vec<u8> {
    with_head_script(&String::from_utf8_lossy(html), SHIM_SOURCE).into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct HeadScript {
        html: String,
        out: String,
    }

    #[derive(Deserialize)]
    struct Cases {
        #[serde(rename = "headScript")]
        head_script: Vec<HeadScript>,
    }

    #[test]
    fn shared_cases() {
        let cases: Cases = serde_json::from_str(include_str!("cases.json")).unwrap();
        assert!(!cases.head_script.is_empty());
        for case in cases.head_script {
            assert_eq!(with_head_script(&case.html, "S"), case.out, "{}", case.html);
        }
    }

    #[test]
    fn the_shim_is_one_script_without_a_closing_tag_inside() {
        assert!(SHIM_SOURCE.starts_with("(function () {"));
        assert!(!SHIM_SOURCE.contains("</script"));
        let out = String::from_utf8(with_sandbox_storage_shim(b"<html><head><title>x</title></head></html>")).unwrap();
        assert_eq!(out, format!("<html><head><script>{SHIM_SOURCE}</script><title>x</title></head></html>"));
    }

    #[test]
    fn invalid_utf8_is_replaced_not_refused() {
        let out = with_sandbox_storage_shim(b"<p>\xFF</p>");
        assert!(String::from_utf8(out).unwrap().ends_with("<p>\u{FFFD}</p>"));
    }
}
