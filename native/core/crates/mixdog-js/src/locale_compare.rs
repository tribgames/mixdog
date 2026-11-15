//! `String.prototype.localeCompare(b)` with no locale or options: ICU collation at default
//! options in the process's default locale, resolved the way Node resolves it (the Windows user
//! locale, or `LC_ALL` / `LC_MESSAGES` / `LANG` elsewhere, via `sys-locale`). A locale ICU cannot
//! parse (`C`, `POSIX`) collates as the root.

use std::cmp::Ordering;
use std::sync::OnceLock;

use icu_collator::CollatorBorrowed;
use icu_collator::options::CollatorOptions;
use icu_collator::options::Strength;
use icu_locale_core::Locale;

fn collator() -> &'static CollatorBorrowed<'static> {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR.get_or_init(|| {
        let locale = crate::default_locale::default_locale_tag().parse::<Locale>().unwrap_or(Locale::UNKNOWN);
        CollatorBorrowed::try_new((&locale).into(), CollatorOptions::default()).expect("compiled collation data")
    })
}

/// `a.localeCompare(b)`, as an `Ordering`.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    collator().compare(a, b)
}

/// `a.localeCompare(b)` on raw JavaScript UTF-16. The vendored ICU extension
/// assigns each unpaired surrogate its original implicit collation weight;
/// existing valid-string locale_compare is intentionally unchanged.
pub fn locale_compare_utf16(a: &[u16], b: &[u16]) -> Ordering {
    collator().compare_raw_utf16(a, b)
}

/// `a.localeCompare(b, 'en')`: English collation at default (tertiary) strength.
pub fn locale_compare_en(a: &str, b: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            let locale: Locale = "en".parse().expect("static locale");
            CollatorBorrowed::try_new((&locale).into(), CollatorOptions::default()).expect("compiled collation data")
        })
        .compare(a, b)
}

/// `new Intl.Collator('en', { numeric: true }).compare(a, b)`: English collation in which digit
/// runs compare by value.
pub fn locale_compare_en_numeric(a: &str, b: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            let locale: Locale = "en-u-kn".parse().expect("static locale");
            CollatorBorrowed::try_new((&locale).into(), CollatorOptions::default()).expect("compiled collation data")
        })
        .compare(a, b)
}

/// `a.localeCompare(b, 'en', { sensitivity: 'base' })`: English collation that ignores case and
/// accents.
pub fn locale_compare_en_base(a: &str, b: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            let mut options = CollatorOptions::default();
            options.strength = Some(Strength::Primary);
            let locale: Locale = "en".parse().expect("static locale");
            CollatorBorrowed::try_new((&locale).into(), options).expect("compiled collation data")
        })
        .compare(a, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> serde_json::Value {
        serde_json::from_str(include_str!("../testdata/locale_compare.json")).expect("golden")
    }

    #[test]
    fn pairs_equal_node() {
        let g = golden();
        let pairs = g["pairs"].as_array().unwrap();
        assert!(pairs.len() > 1000);
        for p in pairs {
            let (a, b) = (p[0].as_str().unwrap(), p[1].as_str().unwrap());
            let want = match p[2].as_i64().unwrap() {
                -1 => Ordering::Less,
                1 => Ordering::Greater,
                _ => Ordering::Equal,
            };
            assert_eq!(locale_compare(a, b), want, "{a:?} vs {b:?}");
        }
    }

    #[test]
    fn sorts_equal_node() {
        for s in golden()["sorted"].as_array().unwrap() {
            let mut got: Vec<&str> = s["input"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            got.sort_by(|a, b| locale_compare(a, b));
            let want: Vec<&str> = s["sorted"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(got, want);
        }
    }

    #[test]
    fn case_mixed_names_interleave_by_letter() {
        assert_eq!(locale_compare("alpha", "Zed"), Ordering::Less);
        assert_eq!(locale_compare("a", "A"), Ordering::Less);
    }
}
