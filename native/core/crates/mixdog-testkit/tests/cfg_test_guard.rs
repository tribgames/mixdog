//! A replay in `crates/<lib>-replays` runs against its library compiled without `cfg(test)` but with the feature
//! `test-support`. So in a library whose replays moved out, a bare `test` cfg predicate on anything but a module of
//! tests would make the replay exercise other code than the same test did inside the library: such a site is written
//! `any(test, feature = "test-support")`. This guard fails on any other bare `test` predicate, unless it is listed in
//! [`ALLOWED`] with its reason.
//!
//! `cfg(test)` is per crate: the crates below these libraries were compiled without it for the library's own tests
//! too, so moving a test out of the library changes nothing for them.

use std::path::Path;

/// The libraries whose replays run from a separate package.
const LIBRARIES: &[&str] = &["mixdog-core", "mixdog-core-session"];

/// `(file under the crates dir, the item the predicate is on, why it may stay bare)`.
const ALLOWED: &[(&str, &str, &str)] = &[
    (
        "mixdog-core/src/run_host/mod.rs",
        "mod compaction_node_harness",
        "the harness of the node tests left in the library because they call crate-private items (`CompactionRows`, `NoApprovals`, `manual_compaction::offload_candidates`); nothing else uses it",
    ),
    (
        "mixdog-core/src/run_host/side_question_store.rs",
        "pub(crate) fn tests_material()",
        "builds its value with the inline `tests` module's helper; crate-private, so no replay package can reach it",
    ),
    (
        "mixdog-core-session/src/session/new_task.rs",
        "pub(super) writes: Mutex<Vec<(String, bool)>>,",
        "a record only the inline tests read (`pub(super)`): kept for a replay build it would grow for the life of its daemon, read by no one",
    ),
    ("mixdog-core-session/src/session/new_task.rs", "writes: Mutex::default(),", "the record above"),
    ("mixdog-core-session/src/session/new_task.rs", "lock(&self.writes).push(", "the record above"),
];

/// The item an attribute applies to: the next line that is not itself an attribute or a comment.
fn item_after(lines: &[&str], at: usize) -> String {
    lines[at + 1..]
        .iter()
        .map(|line| line.trim())
        .find(|line| !line.is_empty() && !line.starts_with("#[") && !line.starts_with("//"))
        .unwrap_or_default()
        .to_owned()
}

fn is_test_module(item: &str) -> bool {
    let item = item.trim_start_matches("pub(crate) ").trim_start_matches("pub(super) ").trim_start_matches("pub ");
    let Some(name) = item.strip_prefix("mod ") else { return false };
    let name: String = name.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    ["tests", "test", "golden", "goldens"].iter().any(|end| name.ends_with(end))
}

/// A site on one line, as rustfmt writes a short one: a predicate split over lines reads the same as one that is not.
fn one_line(site: &str) -> String {
    site.split_whitespace().collect::<Vec<_>>().join(" ").replace("( ", "(").replace(", )", ")").replace(" )", ")")
}

/// The `cfg`, `cfg_attr` and `cfg!` sites of a file that name `test` outside `any(test, feature = "test-support")`,
/// each with the index of the line it ends on.
fn bare_sites(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    for start in ["#[cfg(", "#![cfg(", "#[cfg_attr(", "#![cfg_attr(", "cfg!("] {
        let mut from = 0;
        while let Some(at) = text[from..].find(start) {
            let begin = from + at;
            let mut depth = 0;
            let mut end = text.len();
            for (i, c) in text[begin..].char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            end = begin + i + 1;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            // An attribute ends at its closing bracket.
            let end = if text[end..].starts_with(']') { end + 1 } else { end };
            let site = one_line(&text[begin..end]);
            let unwrapped = site.replace(r#"any(test, feature = "test-support")"#, "");
            let names_test = unwrapped
                .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-' || c == '"'))
                .any(|word| word == "test");
            // `cfg_attr(not(test), allow(..))` only silences lints of the test-support build.
            let lint_only = site.starts_with("#![cfg_attr(not(test), allow(") || site.starts_with("#[cfg_attr(not(test), allow(");
            if names_test && !lint_only {
                out.push((text[..end].matches('\n').count(), site));
            }
            from = end;
        }
    }
    out
}

fn scan(dir: &Path, crates: &Path, found: &mut Vec<String>) {
    for entry in mixdog_testkit::entry_names(dir) {
        let path = dir.join(&entry);
        if mixdog_testkit::is_dir(&path) {
            scan(&path, crates, found);
            continue;
        }
        if path.extension().is_none_or(|ext| ext != "rs") {
            continue;
        }
        let text = mixdog_testkit::read_string(&path);
        let rel = path.strip_prefix(crates).expect("under the crates dir").to_string_lossy().replace('\\', "/");
        let lines: Vec<&str> = text.lines().collect();
        for (at, site) in bare_sites(&text) {
            let item = item_after(&lines, at);
            if site == "#[cfg(test)]" && is_test_module(&item) {
                continue;
            }
            if ALLOWED.iter().any(|(file, allowed, _)| *file == rel && item.starts_with(allowed)) {
                continue;
            }
            found.push(format!("{rel}:{}: {site} on `{item}`", at + 1));
        }
    }
}

#[test]
fn a_predicate_split_over_lines_is_read_as_one() {
    let split = "#[cfg(\n    any(\n        test,\n        feature = \"crash-gates\",\n    )\n)]\nfn gate() {}\n";
    assert_eq!(bare_sites(split), vec![(5, r#"#[cfg(any(test, feature = "crash-gates"))]"#.to_owned())]);
    let guarded = "#[cfg(\n    any(\n        test,\n        feature = \"test-support\",\n    )\n)]\nfn hook() {}\n";
    assert_eq!(bare_sites(guarded), vec![]);
}

#[test]
fn the_libraries_with_moved_replays_put_test_behaviour_behind_test_support() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("the crates dir");
    let mut found = Vec::new();
    for library in LIBRARIES {
        scan(&crates.join(library).join("src"), crates, &mut found);
    }
    assert!(
        found.is_empty(),
        "a bare `test` cfg in a library whose replays run from its replay package (write `any(test, feature = \"test-support\")`, or list it in ALLOWED with the reason):\n{}",
        found.join("\n")
    );
}

#[test]
fn every_allowed_site_still_exists() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("the crates dir");
    for (file, item, _) in ALLOWED {
        let text = mixdog_testkit::read_string(crates.join(file));
        assert!(text.contains(item), "{file}: `{item}` is gone; remove its entry");
    }
}
