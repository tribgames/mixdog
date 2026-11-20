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

    #[test]
    fn case_mixed_names_interleave_by_letter() {
        assert_eq!(locale_compare("alpha", "Zed"), Ordering::Less);
        assert_eq!(locale_compare("a", "A"), Ordering::Less);
    }

    fn sorted(compare: fn(&str, &str) -> Ordering, words: &[&str]) -> Vec<String> {
        let mut out: Vec<String> = words.iter().map(|w| (*w).to_owned()).collect();
        out.sort_by(|a, b| compare(a, b));
        out
    }

    #[test]
    fn english_collation_orders_letters_before_case_and_case_before_nothing_else() {
        // UCA: primary letters first, then accents (secondary), then case (tertiary, lower before upper).
        let words = ["b", "A", "a", "B", "á", "Á", "c"];
        assert_eq!(sorted(locale_compare_en, &words), ["a", "A", "á", "Á", "b", "B", "c"]);
        assert_eq!(locale_compare_en("résumé", "resume"), Ordering::Greater);
        assert_eq!(locale_compare_en("resume", "résumé"), Ordering::Less);
        assert_eq!(locale_compare_en("same", "same"), Ordering::Equal);
    }

    #[test]
    fn punctuation_and_digits_sort_before_letters_and_digits_compare_character_by_character() {
        assert_eq!(sorted(locale_compare_en, &["b", "_a", "1", "a", "-a", "9"]), ["_a", "-a", "1", "9", "a", "b"]);
        assert_eq!(locale_compare_en("10", "9"), Ordering::Less);
    }

    #[test]
    fn numeric_collation_compares_digit_runs_by_value() {
        assert_eq!(locale_compare_en_numeric("a10", "a9"), Ordering::Greater);
        assert_eq!(sorted(locale_compare_en_numeric, &["file10", "file2", "file1"]), ["file1", "file2", "file10"]);
    }

    #[test]
    fn base_sensitivity_ignores_case_and_accents() {
        assert_eq!(locale_compare_en_base("a", "A"), Ordering::Equal);
        assert_eq!(locale_compare_en_base("a", "á"), Ordering::Equal);
        assert_eq!(locale_compare_en_base("a", "b"), Ordering::Less);
    }

    #[test]
    fn unpaired_surrogates_collate_without_failing() {
        let lone: [u16; 1] = [0xd800];
        let a: [u16; 1] = [u16::from(b'a')];
        assert_eq!(locale_compare_utf16(&lone, &lone), Ordering::Equal);
        assert_ne!(locale_compare_utf16(&lone, &a), Ordering::Equal);
    }
}
