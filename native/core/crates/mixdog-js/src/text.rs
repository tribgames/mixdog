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
}
