//! The operation-name registry fixture (`tests/fixtures/registry/operations.json`, written by
//! `recorder/record-office-com.mjs --area registry` from `office-com-host.ps1`) held to the PowerShell source text: the
//! names are re-extracted with the same regex between the same markers as `office-runtime-com.test.mjs` uses, from the
//! script this crate embeds (`assets/office-com-host.ps1`, always present) and, when the reference checkout is on this
//! machine, from `C:/Project/mixdog` too. The Rust registry of each edit task is later compared against the same fixture
//! in its own test file.
//!
//! The manifest check is the one every fixture gets: each file `tests/fixtures/MANIFEST.json` lists is there and has the
//! sha256 it lists (line endings normalised, as the other fixture sets' tests do).

use std::path::Path;
use std::path::PathBuf;

use regex::Regex;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

const REFERENCE_TREE: &str = "C:/Project/mixdog";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn json(path: &Path) -> Value {
    serde_json::from_str(&mixdog_testkit::read_string(path)).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn hex(text: &str) -> String {
    let normalised = text.replace("\r\n", "\n");
    Sha256::digest(normalised.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn names_of(value: &Value) -> Vec<String> {
    value.as_array().expect("an array of names").iter().map(|name| name.as_str().expect("a name").to_owned()).collect()
}

/// The operation names of each format in `source`: the regex over the text between the section's markers, sorted.
fn extract(spec: &Value, source: &str) -> Vec<(String, Vec<String>)> {
    let pattern = spec["regex"].as_str().expect("regex");
    assert_eq!(spec["flags"], "gm", "the extraction runs with the m flag");
    let regex = Regex::new(&format!("(?m){pattern}")).expect("the registry regex compiles");
    spec["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .map(|section| {
            let format = section["format"].as_str().expect("format").to_owned();
            let start_marker = section["start"].as_str().expect("start");
            let end_marker = section["end"].as_str().expect("end");
            let start = source.find(start_marker).unwrap_or_else(|| panic!("{format}: no {start_marker:?}"));
            let after = start + start_marker.len();
            let end = after + source[after..].find(end_marker).unwrap_or_else(|| panic!("{format}: no {end_marker:?} after the start"));
            let mut names: Vec<String> = regex.captures_iter(&source[start..end]).map(|captures| captures[1].to_owned()).collect();
            names.sort();
            (format, names)
        })
        .collect()
}

fn spec() -> Value {
    json(&crate_dir().join("recorder").join("scenarios").join("registry.json"))
}

fn fixture() -> Value {
    json(&crate_dir().join("tests").join("fixtures").join("registry").join("operations.json"))
}

fn assert_fixture_matches(source: &str, origin: &str) {
    let spec = spec();
    let fixture = fixture();
    for (format, names) in extract(&spec, source) {
        assert_eq!(names, names_of(&fixture["operations"][format.as_str()]), "{format}: the fixture and {origin} disagree");
        assert_eq!(fixture["counts"][format.as_str()].as_u64(), Some(names.len() as u64), "{format}: the fixture's count");
    }
}

#[test]
fn the_fixture_equals_the_names_in_the_embedded_host_script() {
    let source = mixdog_testkit::read_string(crate_dir().join("assets").join("office-com-host.ps1"));
    assert_fixture_matches(&source, "assets/office-com-host.ps1");
}

#[test]
fn the_fixture_equals_the_names_in_the_reference_checkout_when_it_is_here() {
    let path = Path::new(REFERENCE_TREE).join("src").join("runtime").join("office").join("com").join("office-com-host.ps1");
    if !mixdog_testkit::exists(&path) {
        return;
    }
    assert_fixture_matches(&mixdog_testkit::read_string(&path), REFERENCE_TREE);
    let digest: String = Sha256::digest(mixdog_testkit::read(&path)).iter().map(|byte| format!("{byte:02x}")).collect();
    assert_eq!(fixture()["sourceSha256"].as_str(), Some(digest.as_str()), "the fixture was recorded from another version of the script");
}

#[test]
fn the_registry_has_the_counts_the_contract_names_and_no_name_twice() {
    let spec = spec();
    let fixture = fixture();
    for (format, expected) in spec["expectedCounts"].as_object().expect("expectedCounts") {
        let names = names_of(&fixture["operations"][format.as_str()]);
        assert_eq!(Some(names.len() as u64), expected.as_u64(), "{format}");
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted, names, "{format}: sorted and unique");
    }
    assert_eq!(fixture["counts"]["docx"], 41);
    assert_eq!(fixture["counts"]["xlsx"], 46);
    assert_eq!(fixture["counts"]["pptx"], 46);
}

#[test]
fn every_fixture_the_manifest_lists_is_there_with_its_hash() {
    let fixtures = crate_dir().join("tests").join("fixtures");
    let manifest = json(&fixtures.join("MANIFEST.json"));
    let listed = manifest["fixtures"].as_array().expect("fixtures");
    assert!(!listed.is_empty());
    for entry in listed {
        let relative = entry["path"].as_str().expect("path");
        let text = mixdog_testkit::read_string(fixtures.join(relative));
        assert_eq!(entry["sha256"].as_str(), Some(hex(&text).as_str()), "{relative}: the file is not the recorded one");
    }
    let sources = manifest["sources"].as_object().expect("sources");
    for name in ["office-com-host.ps1", "office-com-session-host.ps1", "office-com-cleanup.ps1", "office-word-formatting.ps1"] {
        assert!(sources[name].as_str().is_some_and(|digest| digest.len() == 64), "{name}: the manifest names the script's sha256");
    }
}
