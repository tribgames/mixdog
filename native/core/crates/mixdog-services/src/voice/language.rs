//! Whisper transcription language selection.

const KNOWN: [&str; 10] = ["ko", "ja", "en", "zh", "de", "fr", "es", "it", "pt", "ru"];

/// `None` for an empty value, `auto`, or a POSIX pseudo-locale (`C`, `POSIX`, `C.UTF-8`),
/// which carry no language signal.
pub fn normalize_whisper_language(value: Option<&str>) -> Option<String> {
    let raw = mixdog_js::js_trim(value.unwrap_or("")).to_lowercase();
    if raw.is_empty() || raw == "auto" {
        return None;
    }
    if raw == "c" || raw == "posix" || raw.starts_with("c.") || raw.starts_with("posix.") {
        return None;
    }
    for language in KNOWN {
        if raw.starts_with(language) {
            return Some(language.to_owned());
        }
    }
    Some(raw)
}

/// First candidate that names a language, else `auto`. Candidates are, in order:
/// `MIXDOG_CHANNELS_WHISPER_LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `LANG`, the system locale.
pub fn detect_device_language<'a>(candidates: impl IntoIterator<Item = Option<&'a str>>) -> String {
    candidates
        .into_iter()
        .find_map(normalize_whisper_language)
        .unwrap_or_else(|| "auto".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_known_prefixes_and_pseudo_locales() {
        assert_eq!(normalize_whisper_language(Some(" ko-KR ")), Some("ko".into()));
        assert_eq!(normalize_whisper_language(Some("en_US.UTF-8")), Some("en".into()));
        assert_eq!(normalize_whisper_language(Some("sv-SE")), Some("sv-se".into()));
        for none in [None, Some(""), Some("auto"), Some("C"), Some("C.UTF-8"), Some("POSIX")] {
            assert_eq!(normalize_whisper_language(none), None);
        }
    }

    /// Node-recorded twin `fixtures/services/voice-language-twin.json`
    /// (`benchmarks/rust-core/recorders/record-voice-language.mjs`); `MIXDOG_FIXTURES_ROOT` overrides the location.
    #[test]
    fn matches_the_node_recorded_answers() {
        let root = std::env::var("MIXDOG_FIXTURES_ROOT").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures").to_owned());
        let twin: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{root}/services/voice-language-twin.json")).unwrap()).unwrap();
        let cases = twin["cases"].as_array().unwrap();
        assert!(cases.len() > 40);
        for case in cases {
            let input = case["input"].as_str();
            let expected = case["output"].as_str().map(str::to_owned);
            assert_eq!(normalize_whisper_language(input), expected, "input {:?}", case["input"]);
        }
    }

    #[test]
    fn pseudo_locale_does_not_block_later_candidates() {
        let lang = detect_device_language([None, Some("C.UTF-8"), Some("ko_KR.UTF-8"), Some("en")]);
        assert_eq!(lang, "ko");
        assert_eq!(detect_device_language([None, Some("C")]), "auto");
    }
}
