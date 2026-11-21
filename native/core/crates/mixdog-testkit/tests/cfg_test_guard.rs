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
        "mixdog-core-session/src/session/store.rs",
        "pub(super) fn shape_now(",
        "a reader of the inline sensitive_carry tests alone: under `test-support` it would be unused",
    ),
    (
        "mixdog-core-session/src/session/store.rs",
        "pub(super) fn shape_and_open(",
        "a reader of the inline sensitive_carry tests alone: under `test-support` it would be unused",
    ),
    (
        "mixdog-core-session/src/session/prompt_submission.rs",
        "pub(crate) fn import_in_memory(",
        "the intake of the in-memory stores of the inline prompt_submission and phone_chat tests alone: under `test-support` it would be unused",
    ),
    (
        "mixdog-core-session/src/session/agent_registry/rows.rs",
        "pub fn total(&self) -> usize {",
        "only the inline agent_registry/tests.rs work-budget assertions call Counts::total; rows is a private module and those tests stay in the library, while moved replays use the existing individual counters",
    ),
    (
        "mixdog-core-session/src/session/secret_input/human_only.rs",
        "struct NoTakeovers;",
        "constructed only by the private free_lock fixture below, whose callers are the inline human_only/computer tests and the cfg(test) card_holds_tests/human_only_merge_tests modules",
    ),
    (
        "mixdog-core-session/src/session/secret_input/human_only.rs",
        "impl TakeoverHolds for NoTakeovers {",
        "implements only the NoTakeovers stand-in constructed by free_lock for inline secret_input tests; no production or moved replay caller can reach this private type",
    ),
    (
        "mixdog-core-session/src/session/secret_input/human_only.rs",
        "pub(super) fn free_lock() -> Arc<HumanOnlyLock> {",
        "called only by the inline human_only.rs and computer.rs tests plus card_holds_tests.rs and human_only_merge_tests.rs, both cfg(test) modules in secret_input.rs; moved replays do not call this parent-private fixture",
    ),
    (
        "mixdog-core/src/run_host/mod.rs",
        "mod grep_args;",
        "a module of its own inline tests only: nothing else calls `prepare_grep_args`, so a replay build loses nothing by not compiling it",
    ),
    (
        "mixdog-core-session/src/session/store.rs",
        "pub(super) fn of_one_read(",
        "a reader of the inline sensitive_carry_tests alone: under `test-support` it would be unused",
    ),
    (
        "mixdog-core-session/src/session/store.rs",
        "pub(super) fn of_no_log(",
        "a shape for the inline context_lens tests alone: under `test-support` it would be unused",
    ),
    (
        "mixdog-core-session/src/session/store.rs",
        "pub(super) fn tell_released(",
        "a release notice for the inline sensitive_carry_tests alone: under `test-support` it would be unused",
    ),
    (
        "mixdog-core-session/src/session/store.rs",
        "pub(super) fn context_len_kept_and_counted(",
        "a reader of the inline sensitive_carry_tests alone: under `test-support` it would be unused",
    ),
    (
        "mixdog-core-session/src/session/store.rs",
        "pub(super) fn shape_refused(",
        "a reader of the inline sensitive_carry_tests alone: under `test-support` it would be unused",
    ),
    (
        "mixdog-core-session/src/session/new_task.rs",
        "pub(super) writes: Mutex<Vec<(String, bool)>>,",
        "a record only the inline tests read (`pub(super)`): kept for a replay build it would grow for the life of its daemon, read by no one",
    ),
    ("mixdog-core-session/src/session/new_task.rs", "writes: Mutex::default(),", "the record above"),
    ("mixdog-core-session/src/session/new_task.rs", "lock(&self.writes).push(", "the record above"),
    (
        "mixdog-core-session/src/session/control.rs",
        "pub ask_marked: std::sync::atomic::AtomicBool,",
        "a turn mark only the inline tests set (`delete_idle_tests`; they write no turn rows, as Node's `markSessionAskStart` does not): a replay build has no one to set it, so it reads false there as in a release build",
    ),
    ("mixdog-core-session/src/session/directory.rs", "ask_marked: Default::default(),", "the mark above"),
    ("mixdog-core-session/src/session/actor.rs", "fn ask_marked(&self) -> bool {", "the mark above, and the release build's constant in its place"),
    ("mixdog-core-session/src/session/actor.rs", "AskEnded,", "the end of the mark above: only the inline tests send it"),
    ("mixdog-core-session/src/session/actor.rs", "Inbox::AskEnded => {", "the end of the mark above"),
    (
        "mixdog-core-session/src/session/control.rs",
        "pub fn latched_count(",
        "a read of the stop latches for the inline tests alone: under `test-support` it would be unused",
    ),
    ("mixdog-core-session/src/session/store.rs", "pub(super) fn refuse_next_projection(", "a fault injection into the projector, for the inline tests alone"),
    (
        "mixdog-core-session/src/session/store.rs",
        "fn spawn_with<P, Q, C>(project: P) -> Self",
        "a projector over a stand-in projection, for the inline projector tests alone: under `test-support` it would be unused",
    ),
    (
        "mixdog-core-session/src/session/agent_registry/mod.rs",
        "walks: std::sync::atomic::AtomicUsize,",
        "a count of the agent-session listings only the inline agent_registry/tests.rs read: kept for a replay build it would be written and read by no one",
    ),
    ("mixdog-core-session/src/session/agent_registry/mod.rs", "walks: std::sync::atomic::AtomicUsize::new(0),", "the count above"),
    ("mixdog-core-session/src/session/agent_registry/mod.rs", "self.walks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);", "the count above"),
    (
        "mixdog-core-session/src/session/agent_registry/mod.rs",
        "pub(crate) async fn idle(&self) {",
        "a wait for the writers' tasks, for the inline write_marks and release_receipt tests alone: under `test-support` it would be unused",
    ),
    (
        "mixdog-core-session/src/session/agent_registry/mod.rs",
        "pub(crate) fn ledger_len(&self) -> usize {",
        "a read of the outcome ledger, for the inline write_marks tests alone: under `test-support` it would be unused",
    ),
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
            let names_test = unwrapped.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-' || c == '"')).any(|word| word == "test");
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
