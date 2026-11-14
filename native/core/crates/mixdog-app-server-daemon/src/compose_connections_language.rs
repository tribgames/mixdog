//! The desktop's UI language for the texts the connections service puts in front of the person: the errors of a pair code and the
//! fixed texts of a server's notifications (the attachment word of a toast title among them).
//!
//! The language is what the desktop publishes in `host/state/set` key `displayPreferences` (`language`: one of its supported tags).
//! The catalogs are the desktop's native ones (`apps/desktop/src/shared/native-ui-catalogs.json`, written by `i18n:sync` from the
//! phrases of `scripts/i18n/core-native-keys.json`), built into the binary: a phrase is looked up by its English text, and the English
//! text itself is the answer where the language is not known, is English, or has no entry.

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use mixdog_connections::notifier::{AttachmentKind, NotifyTexts};
use mixdog_core_base::state::SectionFeedState;
use mixdog_core_api::state::SectionChange;
use mixdog_protocol::SectionName;

type Catalogs = BTreeMap<String, BTreeMap<String, String>>;

const CATALOGS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../apps/desktop/src/shared/native-ui-catalogs.json"));

fn catalogs() -> &'static Catalogs {
    static PARSED: OnceLock<Catalogs> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(CATALOGS).unwrap_or_default())
}

/// `key` in `language`, or `key` itself.
fn translated(catalogs: &Catalogs, language: Option<&str>, key: &str) -> String {
    language
        .and_then(|language| catalogs.get(language))
        .and_then(|catalog| catalog.get(key))
        .filter(|text| !text.is_empty())
        .map_or_else(|| key.to_owned(), Clone::clone)
}

/// Translates through the language the desktop host last published.
#[derive(Clone)]
pub struct UiLanguage {
    read: Arc<dyn Fn() -> Option<String> + Send + Sync>,
}

impl UiLanguage {
    pub fn new(read: Arc<dyn Fn() -> Option<String> + Send + Sync>) -> Self {
        Self { read }
    }

    /// Over the app feed's sections: the `language` of the host state's `displayPreferences`.
    pub fn over_sections(sections: Arc<SectionFeedState>) -> Self {
        Self::new(Arc::new(move || {
            let SectionChange::Set(bytes) = sections.current(SectionName::HostState, Some("displayPreferences"))?.1 else { return None };
            serde_json::from_slice::<serde_json::Value>(&bytes).ok()?.get("language")?.as_str().map(str::to_owned)
        }))
    }

    pub fn translate(&self, key: &str) -> String {
        translated(catalogs(), (self.read)().as_deref(), key)
    }
}

/// The fixed texts of a server's notifications, in the desktop's language.
pub struct CatalogTexts(pub UiLanguage);

impl NotifyTexts for CatalogTexts {
    fn approval_waiting(&self) -> String {
        self.0.translate("A tool is waiting for your approval.")
    }

    fn turn_failed(&self) -> String {
        self.0.translate("The turn stopped with an error.")
    }

    fn lost_title(&self) -> String {
        self.0.translate("Connection to {{name}} lost")
    }

    fn lost_reconnecting(&self) -> String {
        self.0.translate("Mixdog is reconnecting automatically.")
    }

    fn lost_stopped(&self) -> String {
        self.0.translate("Open the server window to reconnect.")
    }

    fn restored_title(&self) -> String {
        self.0.translate("Reconnected to {{name}}")
    }

    fn restored_body(&self) -> String {
        self.0.translate("The server window is working again.")
    }

    fn attachment_label(&self, kind: AttachmentKind) -> String {
        self.0.translate(match kind {
            AttachmentKind::Image => "Image",
            AttachmentKind::Video => "Video",
            AttachmentKind::File => "File",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The phrases the core asks the catalogs for, which `core-native-keys.json` lists for the desktop's sync.
    const ASKED: [&str; 14] = [
        "A tool is waiting for your approval.",
        "Codes are not available on this connection server yet. Use the QR code.",
        "Connection to {{name}} lost",
        "Enter the 6-digit code shown on your PC.",
        "File",
        "Image",
        "Mixdog is reconnecting automatically.",
        "Open the server window to reconnect.",
        "Reconnected to {{name}}",
        "The code is wrong or has expired.",
        "The server window is working again.",
        "The turn stopped with an error.",
        "Too many attempts. Try again in {{seconds}} seconds.",
        "Video",
    ];

    fn language(tag: Option<&'static str>) -> UiLanguage {
        UiLanguage::new(Arc::new(move || tag.map(str::to_owned)))
    }

    #[test]
    fn every_phrase_the_core_asks_for_has_an_entry_in_every_language() {
        let catalogs = catalogs();
        assert!(!catalogs.is_empty(), "the built-in catalogs parse");
        for (tag, catalog) in catalogs {
            for key in ASKED {
                assert!(catalog.get(key).is_some_and(|text| !text.is_empty()), "{tag} has no entry for {key}");
            }
        }
    }

    #[test]
    fn a_published_language_translates_and_an_unknown_one_leaves_the_english_text() {
        assert_eq!(language(Some("de")).translate("Video"), catalogs()["de"]["Video"]);
        assert_eq!(language(Some("ko")).translate("Image"), catalogs()["ko"]["Image"]);
        assert_ne!(language(Some("ko")).translate("Image"), "Image");
        assert_eq!(language(None).translate("Image"), "Image");
        assert_eq!(language(Some("en")).translate("Image"), "Image");
        assert_eq!(language(Some("xx")).translate("Image"), "Image");
        assert_eq!(language(Some("ko")).translate("A phrase no catalog has"), "A phrase no catalog has");
    }

    #[test]
    fn the_attachment_word_and_the_server_name_slot_follow_the_language() {
        let texts = CatalogTexts(language(Some("ja")));
        assert_eq!(texts.attachment_label(AttachmentKind::File), catalogs()["ja"]["File"]);
        assert_eq!(texts.attachment_label(AttachmentKind::Video), catalogs()["ja"]["Video"]);
        assert!(texts.lost_title().contains("{{name}}"));
        assert!(texts.restored_title().contains("{{name}}"));
        let english = CatalogTexts(language(None));
        assert_eq!(english.attachment_label(AttachmentKind::Image), "Image");
        assert_eq!(english.turn_failed(), "The turn stopped with an error.");
    }

    #[test]
    fn a_pair_code_error_is_in_the_desktops_language_with_the_wait_filled_in() {
        use mixdog_connections::remote_hosts::PairRedeemError;
        let ja = language(Some("ja"));
        let error = PairRedeemError::TooManyAttempts { retry_after_seconds: "7".to_owned() };
        let text = error.message(&|key| ja.translate(key));
        assert!(text.contains('7') && !text.contains("{{seconds}}"));
        assert_ne!(text, error.message(&|key| key.to_owned()));
        assert_eq!(PairRedeemError::WrongOrExpired.message(&|key| ja.translate(key)), catalogs()["ja"]["The code is wrong or has expired."]);
    }
}
