//! JavaScript string semantics: the white-space set `\s` and `trim` use, and `slice` by UTF-16
//! code units.

/// JavaScript `\s` (and `String.prototype.trim`): `WhiteSpace` and `LineTerminator`. Not
/// `char::is_whitespace`, which counts U+0085 and lacks U+FEFF.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `String.prototype.trimStart`.
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

/// `String.prototype.trimEnd`.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_space)
}

/// `s.split(/\s+/).filter(Boolean)`.
pub fn js_words(s: &str) -> impl Iterator<Item = &str> {
    s.split(is_js_space).filter(|w| !w.is_empty())
}

/// `value.slice(0, limit)`: the first `limit` UTF-16 units.
pub struct Utf16Cut<'a> {
    pub head: &'a str,
    /// The high surrogate left alone when the cut falls inside a surrogate pair. A JavaScript
    /// string keeps it; a Rust string cannot.
    pub dangling_high: Option<u16>,
}

pub fn cut_utf16(value: &str, limit: usize) -> Utf16Cut<'_> {
    let mut units = 0;
    for (at, c) in value.char_indices() {
        let width = c.len_utf16();
        if units + width > limit {
            let dangling_high = (width == 2 && units < limit).then(|| {
                let mut pair = [0u16; 2];
                c.encode_utf16(&mut pair);
                pair[0]
            });
            return Utf16Cut { head: &value[..at], dangling_high };
        }
        units += width;
    }
    Utf16Cut { head: value, dangling_high: None }
}

/// [`cut_utf16`] as a `String`. A dangling high surrogate becomes U+FFFD, which is what
/// JavaScript's own UTF-8 encoders write for it.
pub fn slice_utf16(value: &str, limit: usize) -> String {
    let cut = cut_utf16(value, limit);
    let mut out = cut.head.to_owned();
    if cut.dangling_high.is_some() {
        out.push('\u{fffd}');
    }
    out
}

/// `value.length`.
pub fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

#[path = "lowercase_changed.rs"]
mod lowercase_changed;

/// `String.prototype.toLowerCase()` (no locale): the Unicode full case mapping with the
/// Final_Sigma context rule, so `İ` becomes `i` + U+0307 and a word-final `Σ` becomes `ς`. This is
/// `str::to_lowercase`, except for the characters the toolchain's Unicode tables know a lowering
/// for and Node's ICU does not yet (a letter pair added in a later Unicode version, such as
/// U+A7CE): Node leaves those as they are. They are found by the recorded table of what Node
/// changes (`lowercase_changed.rs`, from `testdata/js_lowercase.json`). Node's tables do not
/// assign such a character at all, so it is neither cased nor case-ignorable and the text on
/// either side is lowered on its own, which keeps the Final_Sigma rule exact.
pub fn js_to_lowercase(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut start = 0;
    for (at, c) in value.char_indices() {
        if !lowered_by_std_only(c) {
            continue;
        }
        out.push_str(&value[start..at].to_lowercase());
        out.push(c);
        start = at + c.len_utf8();
    }
    out.push_str(&value[start..].to_lowercase());
    out
}

/// `c` is lowered by `str::to_lowercase` but not by Node.
fn lowered_by_std_only(c: char) -> bool {
    if c.is_ascii() || lowercase_changed::CHANGED.binary_search(&u32::from(c)).is_ok() {
        return false;
    }
    let mut lowered = c.to_lowercase();
    lowered.next() != Some(c) || lowered.next().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_whitespace_set_is_ecmascripts() {
        for c in ['\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2000}', '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}'] {
            assert!(is_js_space(c), "{c:?}");
        }
        for c in ['\u{85}', '\u{180e}', '\u{200b}', '\u{2060}', 'a'] {
            assert!(!is_js_space(c), "{c:?}");
        }
        assert_eq!(js_trim("\u{feff} a b\u{a0}"), "a b");
        assert_eq!(js_words(" a\u{3000}\u{3000}b  c ").collect::<Vec<_>>(), ["a", "b", "c"]);
    }

    /// Every code point `js_trim` removes is one `String.prototype.trim()` removes, and no other, against the set recorded from
    /// Node (testdata/js_trim.mjs).
    #[test]
    fn trim_removes_what_javascripts_trim_removes() {
        let golden = crate::json_parse(include_str!("../testdata/js_trim.json")).unwrap();
        let recorded: Vec<u32> = golden["trimmed"].as_array().unwrap().iter().map(|cp| cp.as_u64().unwrap() as u32).collect();
        let ours: Vec<u32> = (0..=0x10ffff_u32)
            .filter_map(char::from_u32)
            .filter(|c| {
                let inner = format!("a{c}b");
                js_trim(&format!("{c}{inner}{c}")) == inner
            })
            .map(u32::from)
            .collect();
        assert_eq!(ours, recorded, "regenerate with testdata/js_trim.mjs");
    }

    #[test]
    fn slice_counts_utf16_units() {
        let emoji = "😀".repeat(201);
        assert_eq!(slice_utf16(&emoji, 200), "😀".repeat(100));
        let cut = cut_utf16(&emoji, 201);
        assert_eq!(cut.head, "😀".repeat(100));
        assert_eq!(cut.dangling_high, Some(0xD83D));
        assert_eq!(slice_utf16(&emoji, 201), format!("{}\u{fffd}", "😀".repeat(100)));
        assert_eq!(slice_utf16(&"é".repeat(250), 200), "é".repeat(200));
        assert_eq!(cut_utf16("ab😀", 4).dangling_high, None);
        assert_eq!(utf16_len("a😀"), 3);
    }

    /// Every code point and the context cases, against `toLowerCase()` recorded from Node
    /// (testdata/js_lowercase.mjs).
    #[test]
    fn lowercasing_is_javascripts() {
        let golden = crate::json_parse(include_str!("../testdata/js_lowercase.json")).unwrap();
        let mut changed = std::collections::HashMap::new();
        for row in golden["rows"].as_array().unwrap() {
            changed.insert(row[0].as_u64().unwrap() as u32, row[1].as_str().unwrap().to_string());
        }
        let cps: Vec<u32> = golden["rows"].as_array().unwrap().iter().map(|row| row[0].as_u64().unwrap() as u32).collect();
        assert_eq!(lowercase_changed::CHANGED.as_slice(), cps.as_slice(), "regenerate with testdata/js_lowercase_table.mjs");
        for cp in 0..=0x10ffff_u32 {
            let Some(c) = char::from_u32(cp) else { continue };
            let want = changed.get(&cp).cloned().unwrap_or_else(|| c.to_string());
            assert_eq!(js_to_lowercase(&c.to_string()), want, "U+{cp:04X}");
        }
        for row in golden["strings"].as_array().unwrap() {
            let (input, want) = (row[0].as_str().unwrap(), row[1].as_str().unwrap());
            assert_eq!(js_to_lowercase(input), want, "{input:?}");
        }
    }
}
