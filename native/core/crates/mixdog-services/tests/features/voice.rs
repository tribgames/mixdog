//! Whisper language choice.

use mixdog_services::voice::language::{detect_device_language, normalize_whisper_language};

#[test]
fn a_locale_names_its_language_when_it_is_one_of_the_known_ten() {
    for (locale, language) in [
        ("ko_KR.UTF-8", "ko"),
        ("ja-JP", "ja"),
        ("EN-us", "en"),
        ("zh_CN", "zh"),
        ("de", "de"),
        ("fr_CA", "fr"),
        ("es-MX", "es"),
        ("it", "it"),
        ("pt_BR", "pt"),
        ("ru-RU", "ru"),
    ] {
        assert_eq!(normalize_whisper_language(Some(locale)).as_deref(), Some(language), "{locale}");
    }
}

#[test]
fn an_unknown_language_is_kept_lowercased_and_trimmed() {
    assert_eq!(normalize_whisper_language(Some("  SV-se ")).as_deref(), Some("sv-se"));
}

#[test]
fn auto_empty_and_posix_pseudo_locales_carry_no_language() {
    for value in [None, Some(""), Some("  "), Some("auto"), Some("AUTO"), Some("C"), Some("POSIX"), Some("c.utf-8"), Some("posix.utf8")] {
        assert_eq!(normalize_whisper_language(value), None, "{value:?}");
    }
}

#[test]
fn the_first_candidate_that_names_a_language_wins_and_none_means_auto() {
    assert_eq!(detect_device_language([Some("auto"), Some("C"), Some("ja_JP"), Some("en")]), "ja");
    assert_eq!(detect_device_language([None, Some("")]), "auto");
    assert_eq!(detect_device_language(std::iter::empty()), "auto");
}
