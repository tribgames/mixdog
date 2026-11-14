//! One ICU-equivalent process default locale, shared by Date names and collation.
//! Uses the regional locale, not the application's UI language or preferred UI
//! language list. Source: Node 22.20.0 ICU77 putil.cpp/uloc.cpp/uloc_tag.cpp and
//! V8 Isolate::DefaultLocale. Source notices live in js-date-string/reference.
// ICU portions: copyright Unicode, Inc. and others, under LICENSE.icu.
// V8 portions: copyright the V8 project authors, under LICENSE.v8.
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::LazyLock;

static TABLES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("default_locale/data/icu77-locale.json"))
        .expect("pinned locale maps")
});
static ID: LazyLock<String> = LazyLock::new(|| canonical_id(&read_system_locale()));

/// ICU-style ID, cached once as ICU caches the process default.
pub fn default_locale_id() -> &'static str {
    &ID
}

/// V8's BCP47 default locale. C/en_US_POSIX is deliberately en-US here, whereas
/// Date display names retain the original ICU ID through default_locale_id.
pub fn default_locale_tag() -> String {
    language_tag(default_locale_id())
}

fn mapped(table: &str, value: &str) -> String {
    TABLES[table]
        .get(value)
        .and_then(Value::as_str)
        .unwrap_or(value)
        .to_owned()
}
fn split_id(input: &str) -> (String, String, String, Vec<String>) {
    let mut pieces = input.split(['_', '-']).peekable();
    let mut language = pieces.next().unwrap_or("").to_lowercase();
    if language == "root" || language == "und" {
        language.clear()
    }
    language = mapped("language3", &language);
    let mut script = String::new();
    if pieces
        .peek()
        .is_some_and(|p| p.len() == 4 && p.bytes().all(|b| b.is_ascii_alphabetic()))
    {
        let s = pieces.next().unwrap();
        script = s[..1].to_uppercase() + &s[1..].to_lowercase()
    }
    let mut region = String::new();
    if pieces
        .peek()
        .is_some_and(|p| p.is_empty() || p.len() == 2 || p.len() == 3)
    {
        region = mapped("region3", &pieces.next().unwrap().to_uppercase())
    }
    let variants = pieces
        .filter(|p| !p.is_empty())
        .map(str::to_uppercase)
        .collect();
    (language, script, region, variants)
}
fn canonical_id(input: &str) -> String {
    if !input.contains('@') && input.split(['_', '-']).any(|p| p.len() == 1) {
        let tag = input.replace('_', "-").to_lowercase();
        let tag = TABLES["legacy"]
            .get(&tag)
            .and_then(Value::as_str)
            .unwrap_or(&tag);
        let pieces: Vec<_> = tag.split('-').collect();
        if let Some(start) = pieces.iter().position(|p| p.len() == 1) {
            let base = canonical_id(&pieces[..start].join("_"));
            let mut keywords = BTreeMap::new();
            let mut i = start;
            while i < pieces.len() {
                let key = pieces[i];
                i += 1;
                let begin = i;
                if key == "x" {
                    i = pieces.len()
                } else {
                    while i < pieces.len() && pieces[i].len() != 1 {
                        i += 1
                    }
                }
                let body = &pieces[begin..i];
                if key == "u" {
                    let mut j = 0;
                    while j < body.len() && body[j].len() > 2 {
                        j += 1
                    }
                    if j > 0 {
                        let mut attributes = body[..j].to_vec();
                        attributes.sort_unstable();
                        attributes.dedup();
                        keywords.insert("attribute".to_owned(), attributes.join("-"));
                    }
                    while j < body.len() {
                        let bcp_key = body[j];
                        j += 1;
                        let first = j;
                        while j < body.len() && body[j].len() > 2 {
                            j += 1
                        }
                        let value = if first == j {
                            "true".into()
                        } else {
                            body[first..j].join("-")
                        };
                        let legacy_key = TABLES["keys"]
                            .as_object()
                            .unwrap()
                            .iter()
                            .find(|(_, v)| v.as_str() == Some(bcp_key))
                            .map_or(bcp_key, |(k, _)| k.as_str());
                        let legacy_value = TABLES["reverseTypes"][legacy_key]
                            .get(&value)
                            .and_then(Value::as_str)
                            .unwrap_or(&value);
                        keywords.insert(legacy_key.to_owned(), legacy_value.to_owned());
                    }
                } else {
                    keywords.insert(key.to_owned(), body.join("-"));
                }
            }
            return with_keywords(base, keywords);
        } else {
            return canonical_id(tag);
        }
    }
    let (input, keyword_text) = input.split_once('@').unwrap_or((input, ""));
    let input = input.split('.').next().unwrap_or(input);
    let (language, script, region, variants) = split_id(input);
    let mut result = language;
    if !script.is_empty() {
        result.push('_');
        result.push_str(&script)
    }
    if !region.is_empty() || !variants.is_empty() {
        result.push('_');
        result.push_str(&region)
    }
    for variant in variants {
        result.push('_');
        result.push_str(&variant)
    }
    let result = mapped("canonical", &result);
    let keywords = keyword_text
        .split(';')
        .filter_map(|s| s.split_once('='))
        .map(|(k, v)| (k.to_lowercase(), v.to_lowercase()))
        .collect();
    with_keywords(result, keywords)
}
fn with_keywords(mut base: String, keywords: BTreeMap<String, String>) -> String {
    if !keywords.is_empty() {
        base.push('@');
        base.push_str(
            &keywords
                .into_iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(";"),
        )
    }
    base
}
fn language_tag(id: &str) -> String {
    if matches!(id, "en_US_POSIX" | "c") {
        return "en-US".into();
    }
    let (base, keyword_text) = id.split_once('@').unwrap_or((id, ""));
    let (language, script, region, variants) = split_id(base);
    let language = mapped("languageTags", &language);
    let mut result =
        if (2..=8).contains(&language.len()) && language.bytes().all(|b| b.is_ascii_alphabetic()) {
            language
        } else {
            "und".into()
        };
    if !script.is_empty() {
        result.push('-');
        result.push_str(&script)
    }
    if !region.is_empty() {
        result.push('-');
        result.push_str(&mapped("regionTags", &region))
    }
    let mut private = Vec::new();
    let mut posix = false;
    for variant in variants {
        let v = variant.to_lowercase();
        if v == "posix" {
            posix = true;
            continue;
        }
        let valid =
            (5..=8).contains(&v.len()) || (v.len() == 4 && v.as_bytes()[0].is_ascii_digit());
        if valid && v.bytes().all(|b| b.is_ascii_alphanumeric()) {
            result.push('-');
            result.push_str(&v)
        } else if (1..=8).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric()) {
            private.push(v)
        }
    }
    let mut extensions = BTreeMap::new();
    let mut unicode = BTreeMap::new();
    let mut attributes = String::new();
    for (key, value) in keyword_text.split(';').filter_map(|s| s.split_once('=')) {
        if key == "attribute" {
            attributes = value.into();
            continue;
        }
        if key.len() == 1 {
            extensions.insert(key.to_owned(), value.to_lowercase());
            continue;
        }
        let bcp_key = TABLES["keys"]
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or(key);
        if bcp_key.len() != 2 {
            continue;
        }
        let value = value.to_lowercase();
        let bcp_value = TABLES["types"][key]
            .get(&value)
            .and_then(Value::as_str)
            .unwrap_or(&value);
        unicode.insert(
            bcp_key.to_owned(),
            if bcp_value == "true" {
                String::new()
            } else {
                bcp_value.into()
            },
        );
    }
    if posix {
        unicode.entry("va".into()).or_insert_with(|| "posix".into());
    }
    let mut u = Vec::new();
    if !attributes.is_empty() {
        u.push(attributes)
    }
    for (k, v) in unicode {
        u.push(k);
        if !v.is_empty() {
            u.push(v)
        }
    }
    if !u.is_empty() {
        extensions.insert("u".into(), u.join("-"));
    }
    let mut private_extension = extensions.remove("x").unwrap_or_default();
    if !private.is_empty() {
        if !private_extension.is_empty() {
            private_extension.push('-')
        }
        private_extension.push_str("lvariant-");
        private_extension.push_str(&private.join("-"));
    }
    for (k, v) in extensions {
        result.push('-');
        result.push_str(&k);
        if !v.is_empty() {
            result.push('-');
            result.push_str(&v)
        }
    }
    if !private_extension.is_empty() {
        result.push_str("-x-");
        result.push_str(&private_extension)
    }
    result
}

#[cfg(any(unix, test))]
fn posix_id(raw: &str) -> String {
    let base = raw.split(['.', '@']).next().unwrap_or("");
    let mut out = if matches!(base, "C" | "POSIX") {
        "en_US_POSIX".into()
    } else {
        base.to_owned()
    };
    if let Some((_, variant)) = raw.rsplit_once('@') {
        out.push_str(if out.contains('_') { "_" } else { "__" });
        let variant = variant.split('.').next().unwrap_or("");
        out.push_str(if variant == "nynorsk" { "NY" } else { variant });
    }
    out
}
#[cfg(windows)]
fn read_system_locale() -> String {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLocaleInfoEx(locale: *const u16, kind: u32, result: *mut u16, capacity: i32) -> i32;
    }
    let mut buffer = [0_u16; 85];
    // SAFETY: null requests the user's regional locale, LOCALE_SNAME. The
    // supplied capacity bounds writes, and the returned string includes NUL.
    let count = unsafe {
        GetLocaleInfoEx(
            std::ptr::null(),
            0x5c,
            buffer.as_mut_ptr(),
            buffer.len() as i32,
        )
    };
    if count > 0 {
        String::from_utf16_lossy(&buffer[..count as usize - 1])
    } else {
        "en_US".into()
    }
}
#[cfg(unix)]
fn read_system_locale() -> String {
    // SAFETY: nullptr queries without mutating libc's process locale. Copy the
    // returned string immediately; no pointer survives this expression.
    let current = unsafe {
        let p = libc::setlocale(libc::LC_MESSAGES, std::ptr::null());
        if p.is_null() {
            None
        } else {
            Some(std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned())
        }
    };
    // ICU checks existence, not nonemptiness, of these variables (except Solaris).
    let raw = current
        .filter(|s| s != "C" && s != "POSIX")
        .or_else(|| std::env::var("LC_ALL").ok())
        .or_else(|| std::env::var("LC_MESSAGES").ok())
        .or_else(|| std::env::var("LANG").ok())
        .unwrap_or_else(|| "en_US_POSIX".into());
    posix_id(&raw)
}
#[cfg(not(any(windows, unix)))]
fn read_system_locale() -> String {
    "en_US_POSIX".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn posix_rules_do_not_use_preferred_ui_languages() {
        for (input, expected) in [
            ("C", "en_US_POSIX"),
            ("C.UTF-8", "en_US_POSIX"),
            ("POSIX", "en_US_POSIX"),
            ("ko_KR.UTF-8", "ko_KR"),
            ("sr_RS.UTF-8@latin", "sr_RS_latin"),
            ("no@nynorsk", "no__NY"),
            ("aa@ZZ.EF@GH.IJ", "aa__GH"),
            ("", ""),
        ] {
            assert_eq!(posix_id(input), expected)
        }
        assert_eq!(canonical_id("eng-USA"), "en_US");
        assert_eq!(canonical_id("zh-Hant-TW"), "zh_Hant_TW");
        assert_eq!(language_tag("en_US_POSIX"), "en-US");
        assert_eq!(language_tag("iw_IL"), "he-IL");
        assert_eq!(language_tag("ko_KR"), "ko-KR");
        assert_eq!(canonical_id("en-US-u-nu-arab"), "en_US@numbers=arab");
        assert_eq!(language_tag("en_US@numbers=arab"), "en-US-u-nu-arab");
        assert_eq!(
            canonical_id("de-DE-u-co-phonebk"),
            "de_DE@collation=phonebook"
        );
        assert_eq!(
            language_tag("de_DE@collation=phonebook"),
            "de-DE-u-co-phonebk"
        );
        assert_eq!(canonical_id("i-klingon"), "tlh");
    }
}
