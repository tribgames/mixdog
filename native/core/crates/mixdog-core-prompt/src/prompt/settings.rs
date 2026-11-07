//! `promptSettingsRecord` (`prompt-settings.mjs`): what a prompt presents of the prompt-shaping
//! settings, kept in the header as `promptSettings` so a later notice can diff against it.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

/// `PROMPT_SETTING_SECTIONS`, in prompt order.
pub(crate) const SECTIONS: [&str; 7] = ["meta", "workflow", "orchestration", "skills", "instructionFiles", "coreMemory", "language"];

static SKILL_NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^- ([^:[]+?)(?::|\s\[|$)", ""));

/// The section texts a prompt carries (`''` when absent).
#[derive(Debug, Clone, Copy, Default)]
pub struct Sections<'a> {
    pub meta: &'a str,
    pub workflow: &'a str,
    pub orchestration: &'a str,
    pub orchestration_mode: &'a str,
    pub skills: &'a str,
    pub instruction_files: &'a str,
    pub core_memory: &'a str,
    pub language: &'a str,
    pub instruction_files_mode: &'a str,
}

/// `hashOf`: the first 16 hex digits of the SHA-256 of the trimmed text.
pub(crate) fn hash_of(text: &str) -> String {
    let digest = Sha256::digest(js_trim(text).as_bytes());
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// `skillNames`: the names of a skill manifest's bullet lines.
pub(crate) fn skill_names(manifest: &str) -> Vec<String> {
    manifest
        .split('\n')
        .map(js_trim)
        .filter(|line| line.starts_with("- "))
        .filter_map(|line| SKILL_NAME.captures(line).and_then(|c| c.get(1)).map(|name| js_trim(name).to_owned()))
        .filter(|name| !name.is_empty() && !name.starts_with("..."))
        .collect()
}

fn section_text<'a>(sections: &Sections<'a>, key: &str) -> &'a str {
    match key {
        "meta" => sections.meta,
        "workflow" => sections.workflow,
        "orchestration" => sections.orchestration,
        "skills" => sections.skills,
        "instructionFiles" => sections.instruction_files,
        "coreMemory" => sections.core_memory,
        _ => sections.language,
    }
}

/// `promptSettingsRecord(sections)`.
pub fn prompt_settings_record(sections: &Sections) -> Value {
    let hashes: Vec<(&str, String)> = SECTIONS.iter().map(|key| (*key, hash_of(section_text(sections, key)))).collect();
    let revision = hash_of(&hashes.iter().map(|(_, hash)| hash.as_str()).collect::<Vec<_>>().join("|"));
    let text = |value: &str| Value::String(value.to_owned());
    let mut texts = Map::new();
    texts.insert("meta".into(), text(sections.meta));
    texts.insert("orchestration".into(), text(sections.orchestration));
    texts.insert("orchestrationMode".into(), text(sections.orchestration_mode));
    texts.insert("instructionFiles".into(), text(sections.instruction_files));
    texts.insert("coreMemory".into(), text(sections.core_memory));
    texts.insert("skills".into(), Value::Array(skill_names(sections.skills).into_iter().map(Value::String).collect()));
    if !sections.instruction_files_mode.is_empty() {
        texts.insert("instructionFilesMode".into(), text(sections.instruction_files_mode));
    }
    let mut record = Map::new();
    record.insert("revision".into(), Value::String(revision));
    record.insert("hashes".into(), Value::Object(hashes.into_iter().map(|(key, hash)| (key.to_owned(), Value::String(hash))).collect()));
    record.insert("texts".into(), Value::Object(texts));
    Value::Object(record)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_skill_names_are_the_manifests_bullet_heads() {
        let manifest = "<available_skills>\n- tidy: x [tools: tidy]\n- ...and 3 more\n- plain\n  - nested\n- a [tools: b]\n</available_skills>";
        assert_eq!(skill_names(manifest), ["tidy", "plain", "nested", "a"]);
    }

    #[test]
    fn the_record_has_nodes_shape_and_hashes_the_trimmed_text() {
        let record = prompt_settings_record(&Sections { meta: " m ", instruction_files_mode: "all", ..Sections::default() });
        assert_eq!(record["hashes"]["meta"], hash_of("m"));
        assert_eq!(record["hashes"]["meta"].as_str().map(str::len), Some(16));
        assert_eq!(record["texts"]["meta"], " m ");
        assert_eq!(record["texts"]["instructionFilesMode"], "all");
        assert_eq!(record["texts"]["skills"], json!([]));
        assert!(record.get("revision").is_some());
    }
}
