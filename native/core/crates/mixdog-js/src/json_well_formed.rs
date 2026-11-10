//! JSON text `JSON.stringify` wrote, made readable by `serde_json`. `JSON.stringify` writes a lone
//! UTF-16 surrogate (half of an emoji left by a cut, or one a client sent) as its `\ud83d` escape,
//! which `JSON.parse` reads back and `serde_json` refuses. A Rust string cannot hold one, so the
//! core reads each as U+FFFD, the character every UTF-8 conversion of Node gives it.

use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::HashSet;

#[cfg(test)]
thread_local! {
    /// Keys looked at by [`collect`] (each read, count or lookup), for the test that bounds its work.
    static KEY_STEPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// One key looked at by [`collect`]; counted in tests only.
#[inline]
fn key_step() {
    #[cfg(test)]
    KEY_STEPS.with(|steps| steps.set(steps.get() + 1));
}

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
/// pointer (RFC 6901) names keys as the core reads them (U+FFFD in place of the lone unit). Node kept
/// the code unit, so a value or key named here equals, matches or selects nothing the core reads from
/// disk (a name, a text), and a caller refuses what Node refuses for it (`toUSVString(value) !== value`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum LoneAt {
    /// The string value at the pointer held one: the indices, in `char`s of the string as read, of every U+FFFD that was a
    /// lone unit (a real U+FFFD beside them is not listed), so a caller that splits the string (a list, a path) can tell
    /// which part held one.
    Value(String, Vec<usize>),
    /// The key the pointer ends with held one (the value under it is the key's own).
    Key(String),
    /// Two or more keys of one object, distinct in the text (Node kept each with its value), read as the
    /// one key the pointer ends with: the core's object keeps one value where Node kept several.
    MergedKey(String),
}

impl LoneAt {
    pub fn pointer(&self) -> &str {
        match self {
            Self::Value(pointer, _) | Self::Key(pointer) | Self::MergedKey(pointer) => pointer,
        }
    }

    /// For a string value, where in it (`char` indices) lone units were read as U+FFFD; empty for a key.
    pub fn units(&self) -> &[usize] {
        match self {
            Self::Value(_, units) => units,
            Self::Key(_) | Self::MergedKey(_) => &[],
        }
    }

    /// The same place relative to `prefix` (a pointer), if it is at or under it.
    pub fn under(&self, prefix: &str) -> Option<Self> {
        let rest = self.pointer().strip_prefix(prefix).filter(|rest| rest.is_empty() || rest.starts_with('/'))?.to_owned();
        Some(match self {
            Self::Value(_, units) => Self::Value(rest, units.clone()),
            Self::Key(_) => Self::Key(rest),
            Self::MergedKey(_) => Self::MergedKey(rest),
        })
    }
}

/// Every place in JSON text `text` that held a lone surrogate escape ([`LoneAt`]), in document
/// order. Empty for text that is not JSON or holds none.
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
            LoneAt::Value(pointer, _) => Some(pointer),
            _ => None,
        })
        .collect()
}

/// Parsed text (json_parse.rs) as the core reads it, and the `char` indices in it of each lone surrogate read as U+FFFD.
fn read_parsed(text: &str) -> (String, Vec<usize>) {
    let mut out = String::with_capacity(text.len());
    let mut lone = Vec::new();
    let mut read = 0;
    let mut chars = text.char_indices();
    while let Some((at, c)) = chars.next() {
        read += 1;
        if !crate::json_parse::is_esc(c) {
            out.push(c);
            continue;
        }
        let rest = &text[at + c.len_utf8()..];
        let (kept, len) = match crate::json_parse::escape_at(rest) {
            Some((crate::json_parse::Escape::Surrogate(_), len)) => {
                lone.push(read - 1);
                ('\u{fffd}', len)
            }
            Some((crate::json_parse::Escape::Escaped, len)) => (c, len),
            None => (c, 0),
        };
        out.push(kept);
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
            let units = read_parsed(text).1;
            if !units.is_empty() {
                out.push(LoneAt::Value(pointer.clone(), units));
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
            // The map's keys are the parsed text's (a lone unit kept apart from U+FFFD): keys equal in the
            // text are already one, as in Node; keys that differ there but read the same are merged here.
            // Only a key that held a lone unit reads differently from its text, so two keys can read as one
            // only when one of them held one: the replaced keys are counted first, and every key is then
            // looked up among them once (linear in the keys).
            let mut replaced: HashMap<String, usize> = HashMap::new();
            for key in map.keys() {
                key_step();
                let (as_read, lone) = read_parsed(key);
                if !lone.is_empty() {
                    *replaced.entry(as_read).or_default() += 1;
                }
            }
            // (merged, key as read) already named: a place is named once.
            let mut named: HashSet<(bool, String)> = HashSet::new();
            for (key, item) in map {
                pointer.push('/');
                if replaced.is_empty() {
                    pointer.push_str(&key.replace('~', "~0").replace('/', "~1"));
                } else {
                    key_step();
                    let (as_read, lone) = read_parsed(key);
                    pointer.push_str(&as_read.replace('~', "~0").replace('/', "~1"));
                    // Read as a replaced key and not the only key read so: a lone key beside another, or a key
                    // whose text holds a real U+FFFD where a replaced one has the lone unit.
                    let merged = replaced.get(&as_read).is_some_and(|&count| count + usize::from(lone.is_empty()) > 1);
                    if !lone.is_empty() && named.insert((false, as_read.clone())) {
                        out.push(LoneAt::Key(pointer.clone()));
                    }
                    if merged && named.insert((true, as_read)) {
                        out.push(LoneAt::MergedKey(pointer.clone()));
                    }
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

    /// A key that held a lone unit is named as a key, apart from a value at the same place; keys distinct in the text that
    /// read as one are named as merged (Node kept each); keys equal in the text are one key to Node too.
    #[test]
    fn lone_surrogate_keys_are_named_and_merged_keys_told() {
        let text = r#"{"\ud800":"\ud800","k":{"\ud83d":1,"\udc00":2,"\ufffd":3},"d":{"a":1,"a":2},"s":{"\ud83d":1,"\ud83d":2}}"#;
        let r = "\u{fffd}";
        let mut found = lone_surrogates(text);
        found.sort();
        let mut expected = vec![
                LoneAt::Key(format!("/{r}")),
                LoneAt::Value(format!("/{r}"), vec![0]),
                LoneAt::Key(format!("/k/{r}")),
                LoneAt::MergedKey(format!("/k/{r}")),
                LoneAt::Key(format!("/s/{r}")),
        ];
        expected.sort();
        // A set of places: the order is the map's, which no consumer reads.
        assert_eq!(found, expected);
        assert_eq!(LoneAt::Key("/params/a".into()).under("/params"), Some(LoneAt::Key("/a".into())));
        assert_eq!(LoneAt::Value("/paramsx".into(), vec![0]).under("/params"), None);
    }

    /// Only the lone units are listed, by `char` index in the string as read: a real U+FFFD and the characters before
    /// (an astral one is one `char`) are not.
    #[test]
    fn a_value_names_where_its_lone_units_were() {
        let text = r#"{"a":"\ufffd,\ud800,\ud83d\ude00x,\udc00"}"#;
        assert_eq!(lone_surrogates(text), [LoneAt::Value("/a".into(), vec![2, 7])]);
    }

    /// The merged-key check looks at each key a bounded number of times: a wide object (50,000 distinct keys, one of them
    /// replaced, one replaced value) costs work linear in its keys, not a comparison of every pair.
    #[test]
    fn a_wide_object_is_checked_in_work_linear_in_its_keys() {
        let keys = 50_000;
        let mut text = String::from(r#"{"v":"\ud800","\udbff":1"#);
        for index in 0..keys {
            text.push_str(&format!(",\"k{index}\":{index}"));
        }
        text.push('}');
        KEY_STEPS.with(|steps| steps.set(0));
        let found = lone_surrogates(&text);
        let steps = KEY_STEPS.with(std::cell::Cell::get);
        assert_eq!(found, [LoneAt::Value("/v".into(), vec![0]), LoneAt::Key("/\u{fffd}".into())]);
        assert!(steps <= 2 * (keys + 2), "{steps} key steps for {} keys", keys + 2);
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
