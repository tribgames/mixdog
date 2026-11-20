//! The quota auto-resume switch. 1.4.5 reads and writes it at `quotaResume.autoResume` (`quota-resume-store.mjs`:
//! `readSection('quotaResume')?.autoResume !== false`); the desktop protocol publishes and writes the registered key
//! `quotaAutoResume`. The 1.4.5 key is authoritative, read straight from the file with no migration step in between, and
//! every writer keeps the two equal, so "off" set in either version is off in the other.

use serde_json::Map;
use serde_json::Value;

use super::Config;

type Doc = Map<String, Value>;

const KEY: &str = "quotaAutoResume";
const SECTION: &str = "quotaResume";
const LEGACY_KEY: &str = "autoResume";

fn legacy(doc: &Doc) -> Option<bool> {
    doc.get(SECTION)?.as_object()?.get(LEGACY_KEY)?.as_bool()
}

/// `quotaAutoResumeEnabled()`: on unless the 1.4.5 key is `false`; without that key, unless the registered key is `false`.
pub fn auto_resume_enabled_in(doc: &Doc) -> bool {
    legacy(doc).unwrap_or_else(|| doc.get(KEY) != Some(&Value::Bool(false)))
}

/// Stores the switch under both keys, leaving the rest of `quotaResume` where it is.
pub fn set_auto_resume(doc: &mut Doc, enabled: bool) {
    doc.insert(KEY.into(), Value::Bool(enabled));
    set_legacy(doc, Some(enabled));
}

fn set_legacy(doc: &mut Doc, enabled: Option<bool>) {
    match enabled {
        Some(enabled) => {
            let section = doc.entry(SECTION.to_owned()).or_insert_with(|| Value::Object(Map::new()));
            if !section.is_object() {
                *section = Value::Object(Map::new());
            }
            if let Some(map) = section.as_object_mut() {
                map.insert(LEGACY_KEY.into(), Value::Bool(enabled));
            }
        }
        None => {
            if let Some(map) = doc.get_mut(SECTION).and_then(Value::as_object_mut) {
                map.shift_remove(LEGACY_KEY);
            }
        }
    }
}

/// After a `config/value/write` of `quotaAutoResume`: the 1.4.5 key follows the registered one (a reset drops it).
pub(super) fn mirror_key_into_legacy(doc: &mut Doc) {
    match doc.get(KEY) {
        Some(Value::Bool(enabled)) => set_legacy(doc, Some(*enabled)),
        None => set_legacy(doc, None),
        Some(_) => {}
    }
}

/// For every document that becomes the config (cold open, reload, install, edit), before it is stored or published: the 1.4.5
/// key decides and both keys say it. Without a 1.4.5 key, a registered `false` is written to it, so a 1.4.5 build reading the
/// same document sees "off" too.
pub(super) fn make_keys_agree(doc: &mut Doc) {
    match legacy(doc) {
        Some(enabled) => {
            if (doc.get(KEY) == Some(&Value::Bool(false))) == enabled {
                doc.insert(KEY.into(), Value::Bool(enabled));
            }
        }
        None => {
            if doc.get(KEY) == Some(&Value::Bool(false)) {
                set_legacy(doc, Some(false));
            }
        }
    }
}

impl Config {
    /// The one reader of the switch, for every consumer.
    pub fn quota_auto_resume_enabled(&self) -> bool {
        auto_resume_enabled_in(&self.shared.doc.load())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn doc(value: Value) -> Doc {
        value.as_object().cloned().unwrap()
    }

    /// Round trip through both keys' readers: what either version writes, the other reads.
    #[test]
    fn off_set_in_either_version_is_off_in_the_other() {
        // 1.4.5 wrote off (`quotaResume.autoResume`): honoured with no migration, the registered key follows on install.
        let mut file = doc(json!({ "quotaResume": { "autoResume": false, "note": 1 } }));
        assert!(!auto_resume_enabled_in(&file));
        make_keys_agree(&mut file);
        assert_eq!(file["quotaAutoResume"], json!(false));
        // 1.5.0 turns it on, then off, through the registered key: 1.4.5's reader (`autoResume !== false`) agrees each time.
        for enabled in [true, false] {
            file.insert(KEY.into(), Value::Bool(enabled));
            mirror_key_into_legacy(&mut file);
            assert_eq!(file["quotaResume"]["autoResume"] != json!(false), enabled);
            assert_eq!(auto_resume_enabled_in(&file), enabled);
        }
        assert_eq!(file["quotaResume"]["note"], json!(1), "the rest of the section stays");
        // The setup action writes both keys.
        let mut fresh = Doc::new();
        set_auto_resume(&mut fresh, false);
        assert_eq!(Value::Object(fresh.clone()), json!({ "quotaAutoResume": false, "quotaResume": { "autoResume": false } }));
        // 1.4.5 turns it back on over 1.5.0's off: on in both.
        fresh.insert("quotaResume".into(), json!({ "autoResume": true }));
        assert!(auto_resume_enabled_in(&fresh));
        make_keys_agree(&mut fresh);
        assert_eq!(fresh["quotaAutoResume"], json!(true));
        // Only the registered key off: the 1.4.5 key follows.
        let mut registered = doc(json!({ "quotaAutoResume": false }));
        make_keys_agree(&mut registered);
        assert_eq!(registered["quotaResume"]["autoResume"], json!(false));
    }

    /// Cold open of each combination: the backend's reader, the document it holds and the published `quotaAutoResume` (what the
    /// desktop's `getQuotaAutoResume()` reads) all say what the 1.4.5 key says, and where it is absent, what the registered one says.
    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test setup writes the fixture file")]
    async fn a_cold_open_publishes_and_holds_the_keys_in_agreement() {
        use std::sync::Arc;

        use mixdog_core_api::mock::MockStatePublisher;
        use mixdog_core_api::state::SectionChange;

        let tokens = mixdog_rt::testing::tokens();
        let lanes = crate::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let off = |held: Option<&Value>| held == Some(&json!(false));
        for (file, enabled) in [
            (json!({ "quotaResume": { "autoResume": false } }), false),
            (json!({ "quotaAutoResume": false }), false),
            (json!({ "quotaResume": { "autoResume": false }, "quotaAutoResume": true }), false),
            (json!({ "quotaResume": { "autoResume": true }, "quotaAutoResume": false }), true),
            (json!({ "quotaResume": { "autoResume": true } }), true),
            (json!({}), true),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("mixdog-config.json");
            std::fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
            let publisher = Arc::new(MockStatePublisher::default());
            let (config, _) = Config::open(path, publisher.clone(), lanes).await.unwrap();
            assert_eq!(config.quota_auto_resume_enabled(), enabled, "{file}");
            let published = publisher.published().into_iter().filter(|(_, key, _)| key.as_deref() == Some(KEY)).map(|(_, _, change)| change).last();
            let published_off = matches!(&published, Some(SectionChange::Set(bytes)) if bytes.as_ref() == b"false");
            assert_eq!(published_off, !enabled, "{file}: published quotaAutoResume");
            assert_eq!(off(config.get(KEY).as_ref()), !enabled, "{file}: held quotaAutoResume");
            if !enabled {
                assert!(off(config.get("quotaResume.autoResume").as_ref()), "{file}: held 1.4.5 key");
            }
        }
    }

    /// What a 1.4.5 build reads of the file: `readSection('quotaResume')?.autoResume !== false`.
    fn read_as_1_4_5(path: &std::path::Path) -> bool {
        let file: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        file.get("quotaResume").and_then(|section| section.get("autoResume")) != Some(&json!(false))
    }

    async fn open_over(file: &Value) -> (Config, tempfile::TempDir, std::path::PathBuf) {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = crate::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixdog-config.json");
        std::fs::write(&path, serde_json::to_vec(file).unwrap()).unwrap();
        let (config, _) = Config::open(path.clone(), std::sync::Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.unwrap();
        (config, dir, path)
    }

    /// A file holding only the registered key off: any later save by this build, whatever it edits, leaves the 1.4.5 key off on
    /// disk too, so 1.4.5 reads what this build reads.
    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test setup writes and reads the fixture file")]
    async fn an_unrelated_save_persists_the_alias_only_off_as_the_1_4_5_key() {
        let (config, _dir, path) = open_over(&json!({ "quotaAutoResume": false })).await;
        assert!(!config.quota_auto_resume_enabled());
        assert!(read_as_1_4_5(&path), "nothing written yet: the file is as it was");
        config.write("desktop.keepAwake", json!(false), mixdog_protocol::ConfigWriteMode::Replace).await.unwrap();
        assert!(!read_as_1_4_5(&path), "the save carries the 1.4.5 key");
        let file: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(file["quotaAutoResume"], json!(false));
        // A typed update (any other writer) too.
        let (config, _dir, path) = open_over(&json!({ "quotaAutoResume": false })).await;
        config
            .update_agent(|agent| {
                agent.insert("instructionFiles".into(), json!("claude"));
                Ok(())
            })
            .await
            .unwrap();
        assert!(!read_as_1_4_5(&path));
        assert!(!config.quota_auto_resume_enabled());
    }

    /// The same through the boot separation, which writes from the disk baseline.
    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test setup writes and reads the fixture file")]
    async fn the_separation_persists_the_alias_only_off_as_the_1_4_5_key() {
        let (config, _dir, path) = open_over(&json!({ "quotaAutoResume": false, "agent": { "autoClear": { "enabled": false } } })).await;
        config.separate_defaults(1_800_000_000_123).await.unwrap();
        assert!(!read_as_1_4_5(&path), "the separation's file carries the 1.4.5 key");
        assert!(!config.quota_auto_resume_enabled());
    }

    #[test]
    fn a_document_with_only_the_registered_key_or_none_reads_as_before() {
        assert!(auto_resume_enabled_in(&Doc::new()));
        assert!(!auto_resume_enabled_in(&doc(json!({ "quotaAutoResume": false }))));
        assert!(auto_resume_enabled_in(&doc(json!({ "quotaResume": { "autoResume": null } }))));
    }
}
