//! How the live client versions are read from what the update sources answer: npm's registry document, Cursor's
//! installer script, Antigravity's update manifest, and which of two versions wins.

use mixdog_ai::client_versions::cursor_build_newer;
use mixdog_ai::client_versions::is_semver;
use mixdog_ai::client_versions::max_semver;
use mixdog_ai::client_versions::parse_antigravity_manifest_version;
use mixdog_ai::client_versions::parse_cursor_install_build;
use mixdog_ai::client_versions::parse_npm_latest;

#[test]
fn a_version_is_three_dot_separated_numbers_and_nothing_else() {
    for good in ["1.2.3", "0.0.0", "10.20.30", "01.2.3"] {
        assert!(is_semver(good), "{good}");
    }
    for bad in ["", "1.2", "1.2.3.4", "1.2.x", " 1.2.3", "1.2.3 ", "1.2.3-beta", "v1.2.3", "1..3", "1.2.3\n"] {
        assert!(!is_semver(bad), "{bad:?}");
    }
}

#[test]
fn the_highest_valid_version_wins_by_number_not_by_text_and_the_invalid_are_ignored() {
    assert_eq!(max_semver(&[Some("1.9.9"), Some("1.10.0")]).as_deref(), Some("1.10.0"));
    assert_eq!(max_semver(&[Some("2.0.0"), Some("10.0.0"), Some("9.9.9")]).as_deref(), Some("10.0.0"));
    assert_eq!(max_semver(&[None, Some(""), Some("nope"), Some(" 1.2.3 "), Some("1.2")]).as_deref(), Some("1.2.3"), "candidates are trimmed first");
    assert_eq!(max_semver(&[Some("1.2.3"), Some("1.2.3")]).as_deref(), Some("1.2.3"));
    assert_eq!(max_semver(&[Some("1.0.0"), Some("1.0.1"), Some("0.9.9")]).as_deref(), Some("1.0.1"));
    assert_eq!(max_semver(&[None, Some("x")]), None);
    assert_eq!(max_semver(&[]), None);
}

#[test]
fn npms_latest_is_the_registry_documents_version_when_it_is_a_plain_version() {
    assert_eq!(parse_npm_latest(r#"{"name": "x", "version": "2.1.5"}"#).as_deref(), Some("2.1.5"));
    assert_eq!(parse_npm_latest(r#"{"version": " 2.1.5 "}"#).as_deref(), Some("2.1.5"));
    for body in [r#"{"version": "2.1"}"#, r#"{"version": "2.1.5-rc.1"}"#, r#"{"version": 215}"#, r#"{"version": null}"#, r#"{"version": ""}"#, r#"{"name": "x"}"#, "not json", "", "[]"] {
        assert_eq!(parse_npm_latest(body), None, "{body}");
    }
}

#[test]
fn cursors_installer_script_names_the_build_in_its_download_url() {
    let script = "#!/bin/sh\nURL=https://downloads.cursor.com/lab/2025.08.12-0a1b2c3d4e/linux/x64/agent-cli.tar.gz\n";
    assert_eq!(parse_cursor_install_build(script).as_deref(), Some("cli-2025.08.12-0a1b2c3d4e"));
    let twice = "x downloads.cursor.com/lab/2025.01.01-aaaaaa/ y downloads.cursor.com/lab/2026.01.01-bbbbbb/";
    assert_eq!(parse_cursor_install_build(twice).as_deref(), Some("cli-2025.01.01-aaaaaa"), "the first build named");
    for body in [
        "",
        "downloads.cursor.com/lab/2025.08.12-ABCDEF/",
        "downloads.cursor.com/lab/2025.08.12-abcde/",
        "downloads.cursor.com/lab/2025.8.12-abcdef/",
        "downloads.cursor.com/lab/2025.08.12-abcdef",
        "downloads.example.com/lab/2025.08.12-abcdef/",
    ] {
        assert_eq!(parse_cursor_install_build(body), None, "{body}");
    }
}

#[test]
fn a_cursor_build_replaces_another_only_when_both_are_builds_and_it_is_not_dated_earlier() {
    let current = "cli-2025.08.12-abc123";
    assert!(cursor_build_newer("cli-2025.09.01-abcdef", current));
    assert!(cursor_build_newer("cli-2025.08.12-def456", current), "the same day, a different build");
    assert!(!cursor_build_newer(current, current), "the same build");
    assert!(!cursor_build_newer("cli-2025.07.01-abcdef", current), "dated earlier");
    assert!(!cursor_build_newer("2025.09.01-abcdef", current), "not a build id");
    assert!(!cursor_build_newer("cli-2025.09.01-abcdef", "pinned"), "nothing comparable held");
    assert!(!cursor_build_newer("", ""));
}

#[test]
fn antigravitys_manifest_gives_the_version_of_its_first_version_line() {
    assert_eq!(parse_antigravity_manifest_version("version: 1.2.3\npath: Antigravity.exe\n").as_deref(), Some("1.2.3"));
    assert_eq!(parse_antigravity_manifest_version("files:\n  - url: a.exe\nversion: 2.0.0\n").as_deref(), Some("2.0.0"), "a list entry is not the version line");
    assert_eq!(parse_antigravity_manifest_version("  version : \"1.4.0\"  \n").as_deref(), Some("1.4.0"));
    assert_eq!(parse_antigravity_manifest_version("version: '1.4.1'\n").as_deref(), Some("1.4.1"));
    assert_eq!(parse_antigravity_manifest_version("version: 1.4.2 # latest\n").as_deref(), Some("1.4.2"));
    assert_eq!(parse_antigravity_manifest_version("version: 1.4.3\r\npath: x\r\n").as_deref(), Some("1.4.3"));
    for text in ["version: nightly\nversion: 1.2.3\n", "version: 1.2\n", "releaseVersion: 1.2.3\n", "path: x\n", ""] {
        assert_eq!(parse_antigravity_manifest_version(text), None, "{text:?}");
    }
}
