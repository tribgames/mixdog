//! JSON text `JSON.stringify` wrote, made readable by `serde_json`. `JSON.stringify` writes a lone
//! UTF-16 surrogate (half of an emoji left by a cut, or one a client sent) as its `\ud83d` escape,
//! which `JSON.parse` reads back and `serde_json` refuses. A Rust string cannot hold one, so the
//! core reads each as U+FFFD, the character every UTF-8 conversion of Node gives it.

use std::borrow::Cow;

fn hex_value(b: u8) -> Option<u16> {
    match b {
        b'0'..=b'9' => Some(u16::from(b - b'0')),
        b'a'..=b'f' => Some(u16::from(b - b'a' + 10)),
        b'A'..=b'F' => Some(u16::from(b - b'A' + 10)),
        _ => None,
    }
}

/// The code unit of a `\uXXXX` escape starting at `at` (the backslash), if well formed.
fn unit_at(text: &[u8], at: usize) -> Option<u16> {
    if text.get(at) != Some(&b'\\') || text.get(at + 1) != Some(&b'u') {
        return None;
    }
    let digits = text.get(at + 2..at + 6)?;
    digits.iter().try_fold(0u16, |acc, &b| Some(acc * 16 + hex_value(b)?))
}

/// JSON text with every lone surrogate escape (`\uD800`–`\uDFFF` not forming a pair)
/// replaced by `\ufffd`, one for one, and the number replaced. Both escapes are six
/// bytes, so offsets are unchanged. Raw text never holds a surrogate (UTF-8 cannot).
/// Text that is not JSON comes back as it is apart from those escapes, so a parse of it
/// fails as before.
pub fn without_lone_surrogates(text: &[u8]) -> (Cow<'_, [u8]>, u64) {
    let mut out: Option<Vec<u8>> = None;
    let mut count = 0u64;
    let mut in_string = false;
    let mut i = 0;
    while i < text.len() {
        let b = text[i];
        if !in_string {
            if b == b'"' {
                in_string = true;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => {
                in_string = false;
                i += 1;
            }
            b'\\' => {
                let Some(unit) = unit_at(text, i) else {
                    i += 2;
                    continue;
                };
                if (0xD800..0xDC00).contains(&unit) && unit_at(text, i + 6).is_some_and(|low| (0xDC00..0xE000).contains(&low)) {
                    i += 12;
                    continue;
                }
                if (0xD800..0xE000).contains(&unit) {
                    let buf = out.get_or_insert_with(|| text.to_vec());
                    buf[i..i + 6].copy_from_slice(b"\\ufffd");
                    count += 1;
                }
                i += 6;
            }
            _ => i += 1,
        }
    }
    match out {
        Some(buf) => (Cow::Owned(buf), count),
        None => (Cow::Borrowed(text), 0),
    }
}

/// [`without_lone_surrogates`] of JSON bytes, for `serde_json::from_slice`.
pub fn well_formed(text: &[u8]) -> Cow<'_, [u8]> {
    without_lone_surrogates(text).0
}

/// [`without_lone_surrogates`] of JSON text, for `serde_json::from_str`.
pub fn well_formed_str(text: &str) -> Cow<'_, str> {
    match without_lone_surrogates(text.as_bytes()).0 {
        Cow::Borrowed(_) => Cow::Borrowed(text),
        // Only six ASCII bytes were replaced by six others: still UTF-8.
        Cow::Owned(bytes) => Cow::Owned(String::from_utf8(bytes).expect("ASCII replaced by ASCII")),
    }
}

/// Where JSON text held an unpaired surrogate escape that [`well_formed_str`] reads as U+FFFD. Each
/// pointer (RFC 6901) names keys as the core reads them (U+FFFD in place of the lone unit).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum LoneAt {
    /// The string value at the pointer held one (named once per string).
    Value(String),
    /// One lone unit of the string value at `pointer`, beside its [`LoneAt::Value`]: `unit` stood at UTF-16 index `at` of the
    /// string, where the core reads U+FFFD (one unit too). For what Node says of the unit itself (a header value's ByteString
    /// error names it) and for a size Node measures on the serialised value (six characters each).
    Unit { pointer: String, at: usize, unit: u16 },
    /// The key the pointer ends with held one (the value under it is the key's own).
    Key(String),
    /// The key the pointer ends with held one and, read as U+FFFD, is the same key as another of its object (a second key
    /// that held one, or a real U+FFFD): two keys Node kept apart are one to the core, and one value would overwrite the other.
    MergedKey(String),
}

impl LoneAt {
    pub fn pointer(&self) -> &str {
        match self {
            Self::Value(pointer) | Self::Key(pointer) | Self::MergedKey(pointer) | Self::Unit { pointer, .. } => pointer,
        }
    }

    /// The lone units the string value at `pointer` held (`(UTF-16 index, unit)`), in order.
    pub fn units_at(lone: &[Self], pointer: &str) -> Vec<(usize, u16)> {
        lone.iter()
            .filter_map(|at| match at {
                Self::Unit { pointer: held, at, unit } if held == pointer => Some((*at, *unit)),
                _ => None,
            })
            .collect()
    }

    /// The same place relative to `prefix` (a pointer), if it is at or under it.
    pub fn under(&self, prefix: &str) -> Option<Self> {
        let rest = self.pointer().strip_prefix(prefix).filter(|rest| rest.is_empty() || rest.starts_with('/'))?.to_owned();
        Some(match self {
            Self::Value(_) => Self::Value(rest),
            Self::Key(_) => Self::Key(rest),
            Self::MergedKey(_) => Self::MergedKey(rest),
            Self::Unit { at, unit, .. } => Self::Unit { pointer: rest, at: *at, unit: *unit },
        })
    }
}

/// Every place in JSON text `text` that held a lone surrogate escape ([`LoneAt`]), in document
/// order; a string value is named once, followed by each lone unit it held ([`LoneAt::Unit`]). Empty for text that is not JSON
/// or holds none.
pub fn lone_surrogates(text: &str) -> Vec<LoneAt> {
    let mut out = Vec::new();
    if without_lone_surrogates(text.as_bytes()).1 == 0 {
        return out;
    }
    if let Ok(value) = crate::json_parse::parse(text) {
        collect(&value, &mut String::new(), &mut out);
    }
    out
}

/// The pointers of the string values in `text` that held a lone surrogate escape ([`lone_surrogates`]).
pub fn lone_surrogate_pointers(text: &str) -> Vec<String> {
    lone_surrogates(text)
        .into_iter()
        .filter_map(|at| match at {
            LoneAt::Value(pointer) => Some(pointer),
            LoneAt::Key(_) | LoneAt::MergedKey(_) | LoneAt::Unit { .. } => None,
        })
        .collect()
}

/// Parsed text (json_parse.rs) as the core reads it, and the lone surrogates it held (each read as U+FFFD): their UTF-16 index
/// in the text as read, and the unit.
fn read_parsed(text: &str) -> (String, Vec<(usize, u16)>) {
    let mut out = String::with_capacity(text.len());
    let mut lone = Vec::new();
    let mut units = 0;
    let mut chars = text.char_indices();
    while let Some((at, c)) = chars.next() {
        if !crate::json_parse::is_esc(c) {
            out.push(c);
            units += c.len_utf16();
            continue;
        }
        let rest = &text[at + c.len_utf8()..];
        let (kept, len) = match crate::json_parse::escape_at(rest) {
            Some((crate::json_parse::Escape::Surrogate(unit), len)) => {
                lone.push((units, unit as u16));
                ('\u{fffd}', len)
            }
            Some((crate::json_parse::Escape::Escaped, len)) => (c, len),
            None => (c, 0),
        };
        out.push(kept);
        units += kept.len_utf16();
        let mut skipped = 0;
        while skipped < len {
            skipped += chars.next().map_or(len, |(_, c)| c.len_utf8());
        }
    }
    (out, lone)
}

fn collect(value: &serde_json::Value, pointer: &mut String, out: &mut Vec<LoneAt>) {
    let len = pointer.len();
    match value {
        serde_json::Value::String(text) => {
            let lone = read_parsed(text).1;
            if !lone.is_empty() {
                out.push(LoneAt::Value(pointer.clone()));
                out.extend(lone.into_iter().map(|(at, unit)| LoneAt::Unit { pointer: pointer.clone(), at, unit }));
            }
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                pointer.push('/');
                pointer.push_str(&index.to_string());
                collect(item, pointer, out);
                pointer.truncate(len);
            }
        }
        serde_json::Value::Object(map) => {
            // The map's keys are the parsed text's (escape markers and all, json_parse.rs): every key is
            // named as the core reads it. Keys equal in the text are one key already (the last value, as
            // Node's); keys that differ in the text but are read alike merge only through a lone unit.
            let read: Vec<(String, bool)> = map.keys().map(|key| read_parsed(key)).map(|(key, lone)| (key, !lone.is_empty())).collect();
            let mut seen = std::collections::HashMap::<&str, usize>::with_capacity(read.len());
            for (as_read, _) in &read {
                *seen.entry(as_read.as_str()).or_default() += 1;
            }
            for ((as_read, lone), item) in read.iter().zip(map.values()) {
                pointer.push('/');
                pointer.push_str(&as_read.replace('~', "~0").replace('/', "~1"));
                if *lone {
                    out.push(if seen[as_read.as_str()] > 1 { LoneAt::MergedKey(pointer.clone()) } else { LoneAt::Key(pointer.clone()) });
                }
                collect(item, pointer, out);
                pointer.truncate(len);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lone_surrogate_pointers_name_the_strings_that_held_one() {
        let text = r#"{"a":"x\ud83dy","b":"\ud83d\ude00","c":["ok","\udc00"],"d":"\\ud800","\udc00/~":{"e":"\ufffd","f":"\uDE00"},"g":"\u{F0000}"}"#;
        let text = text.replace("\\u{F0000}", "\u{F0000}\u{F0000}d800");
        assert_eq!(lone_surrogate_pointers(&text), ["/a", "/c/1", "/\u{fffd}~1~0/f"]);
        assert!(lone_surrogate_pointers(r#"{"a":"\ud83d\ude00","b":"\ufffd"}"#).is_empty());
        assert!(lone_surrogate_pointers(r#"{"a":"\ud800"#).is_empty());
    }

    /// A string is named once, with each lone unit it held at its UTF-16 index (a real U+FFFD and a pair before it count as
    /// one and two units); a key once.
    #[test]
    fn a_string_is_named_once_with_each_lone_unit() {
        let found = lone_surrogates(r#"{"a":"\ud83d\ufffd\udc00x\ud83d\ude00\ud800","\ud800\udc01\udc02":"\ud83d\ude00"}"#);
        let unit = |at, unit| LoneAt::Unit { pointer: "/a".into(), at, unit };
        assert_eq!(found, [LoneAt::Value("/a".into()), unit(0, 0xd83d), unit(2, 0xdc00), unit(6, 0xd800), LoneAt::Key("/\u{10001}\u{fffd}".into())]);
        assert_eq!(LoneAt::units_at(&found, "/a"), [(0, 0xd83d), (2, 0xdc00), (6, 0xd800)]);
    }

    /// A key that held a lone unit is named as a key, apart from a value at the same place; keys equal in the text are one
    /// key to Node too.
    #[test]
    fn lone_surrogate_keys_are_named_apart_from_values() {
        let text = r#"{"\ud800":"\ud800","k":{"\ufffd":3},"s":{"\ud83d":1,"\ud83d":2}}"#;
        let r = "\u{fffd}";
        let mut found = lone_surrogates(text);
        found.sort();
        let mut expected = vec![
            LoneAt::Key(format!("/{r}")),
            LoneAt::Value(format!("/{r}")),
            LoneAt::Unit { pointer: format!("/{r}"), at: 0, unit: 0xd800 },
            LoneAt::Key(format!("/s/{r}")),
        ];
        expected.sort();
        // A set of places: the order is the map's, which no consumer reads.
        assert_eq!(found, expected);
        assert_eq!(LoneAt::Key("/params/a".into()).under("/params"), Some(LoneAt::Key("/a".into())));
        assert_eq!(LoneAt::Value("/paramsx".into()).under("/params"), None);
    }

    /// Two keys Node kept apart that the core reads as one (two different lone units, or a lone unit beside a real U+FFFD)
    /// are named as merged; a lone key alone in its reading is a plain key.
    #[test]
    fn keys_that_read_alike_are_named_as_merged() {
        let r = "\u{fffd}";
        let mut found = lone_surrogates(r#"{"a\ud800":1,"a\udc00":2,"b\ud800":3,"c\ufffd":4,"c\udc00":5}"#);
        found.sort();
        let mut expected = vec![
            LoneAt::MergedKey(format!("/a{r}")),
            LoneAt::MergedKey(format!("/a{r}")),
            LoneAt::Key(format!("/b{r}")),
            LoneAt::MergedKey(format!("/c{r}")),
        ];
        expected.sort();
        assert_eq!(found, expected);
    }

    /// A key holding a character the parser marks (U+F0000, json_parse.rs) is named as the core reads it, whether or not
    /// any key of its object held a lone unit.
    #[test]
    fn a_key_holding_the_parsers_marker_is_named_as_read() {
        let e = '\u{F0000}';
        let text = format!(r#"{{"{e}":{{"x":"\ud800"}},"a{e}":{{"\udc00":1}}}}"#);
        let mut found = lone_surrogates(&text);
        found.sort();
        let mut expected = vec![
            LoneAt::Key(format!("/a{e}/\u{fffd}")),
            LoneAt::Value(format!("/{e}/x")),
            LoneAt::Unit { pointer: format!("/{e}/x"), at: 0, unit: 0xd800 },
        ];
        expected.sort();
        assert_eq!(found, expected);
    }

    #[test]
    fn lone_surrogates_become_replacement_characters() {
        let text = br#"{"a":"x\ud83dy","b":"\ud83d\ude00","c":"\udc00","d":"\\ud800","\udc00\ud800":"\ude00 \\ud83d \ud83d!"}"#;
        let (fixed, count) = without_lone_surrogates(text);
        assert_eq!(count, 6);
        assert_eq!(
            std::str::from_utf8(&fixed).unwrap(),
            r#"{"a":"x\ufffdy","b":"\ud83d\ude00","c":"\ufffd","d":"\\ud800","\ufffd\ufffd":"\ufffd \\ud83d \ufffd!"}"#
        );
        assert_eq!(well_formed_str("{\"a\":\"\\ud800\"}"), "{\"a\":\"\\ufffd\"}");
        assert!(matches!(well_formed_str("{\"a\":\"\\ud83d\\ude00\"}"), Cow::Borrowed(_)));
    }
}
