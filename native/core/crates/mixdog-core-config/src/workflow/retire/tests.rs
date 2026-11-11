//! The retirement pass against Node's recording (`fixtures/shipped-retirement/twin.json`, recorded by
//! `benchmarks/rust-core/recorders/record-shipped-retirement.mjs` from Node's real `ensureStandaloneEnvironment`): over each recorded
//! state the data dir the pass leaves (every file's bytes, the backup folders under their recorded names, on Linux every permission bit), what it throws, and that it logs nothing.

use std::path::Path;

use mixdog_rt::CancellationToken;
use serde_json::Value;

use super::*;

/// `windows`: the states recorded on Windows (junctions, a second volume, open handles); `linux`: the states recorded on Linux
/// (symbolic links through the native copy), with Node v22.20.0 on Alpine (musl) and a tmpfs as the second mount.
fn twin(set: &str) -> Value {
    let text = match set {
        "linux" => mixdog_testkit::fixture!("../../fixtures/shipped-retirement-linux/twin.json"),
        _ => mixdog_testkit::fixture!("../../fixtures/shipped-retirement/twin.json"),
    };
    serde_json::from_str(text).expect("twin.json")
}

fn bytes_of(encoded: &Value) -> Vec<u8> {
    match encoded {
        Value::String(text) => text.as_bytes().to_vec(),
        other => {
            let hex = other["hex"].as_str().expect("hex");
            (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).expect("hex digit")).collect()
        }
    }
}

fn lay(dir: &Path, files: &serde_json::Map<String, Value>) {
    for (rel, encoded) in files {
        if encoded.is_null() {
            continue;
        }
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
        std::fs::write(path, bytes_of(encoded)).expect("file");
    }
}

/// A link entry of a snapshot, and a file another process holds without sharing (its bytes cannot be read), as the content they compare by.
fn link_content(target: &str) -> Vec<u8> {
    format!("\0link:{target}").into_bytes()
}
const UNREADABLE: &[u8] = b"\0unreadable:EBUSY";

/// Node's `portable`: a link target relative to the data dir (`<data>/x`) or the second-volume folder (`<external>/x`).
fn portable(target: &Path, data: &Path, external: Option<&Path>) -> String {
    let text = target.to_string_lossy().replace('\\', "/");
    let text = text.trim_start_matches("//?/").trim_start_matches("/??/").to_owned();
    let under = |root: &Path| {
        let root = root.to_string_lossy().replace('\\', "/");
        (text == root || text.starts_with(&format!("{root}/"))).then(|| text[root.len()..].to_owned())
    };
    if let Some(rest) = under(data) {
        return format!("<data>{rest}");
    }
    if let Some(rest) = external.and_then(under) {
        return format!("<external>{rest}");
    }
    // Linux: a link a rename kept (its text as written) and one to a path that does not exist (`/nonexistent-dir/..`).
    if !text.starts_with('/') {
        return format!("<text>{text}");
    }
    if text.starts_with("/nonexistent-dir/") {
        return format!("<abs>{text}");
    }
    panic!("link target {text}");
}

/// Node's `snapshot`: folders as `path/`, files with their bytes, links as links, sorted by UTF-16 code units.
/// `(path, bytes, permission bits)`: the bits are recorded on Linux only (`None` elsewhere, and for links).
type Entry = (String, Option<Vec<u8>>, Option<u32>);

fn mode_of(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return Some(std::fs::symlink_metadata(path).expect("mode").permissions().mode() & 0o777);
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

fn snapshot(dir: &Path, data: &Path, external: Option<&Path>, with_modes: bool) -> Vec<Entry> {
    fn walk(current: &Path, prefix: &str, data: &Path, external: Option<&Path>, with_modes: bool, out: &mut Vec<Entry>) {
        for entry in std::fs::read_dir(current).expect("read_dir") {
            let entry = entry.expect("entry");
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            let kind = entry.file_type().expect("type");
            let mode = if with_modes { mode_of(&entry.path()) } else { None };
            if kind.is_symlink() {
                let target = std::fs::read_link(entry.path()).expect("link");
                out.push((rel, Some(link_content(&portable(&target, data, external))), None));
            } else if kind.is_dir() {
                out.push((format!("{rel}/"), None, mode));
                walk(&entry.path(), &rel, data, external, with_modes, out);
            } else {
                out.push((rel, Some(std::fs::read(entry.path()).unwrap_or_else(|_| UNREADABLE.to_vec())), mode));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, "", data, external, with_modes, &mut out);
    out.sort_by_key(|(path, _, _)| path.encode_utf16().collect::<Vec<u16>>());
    out
}

fn recorded(snapshot: &Value) -> Vec<Entry> {
    snapshot
        .as_array()
        .expect("snapshot")
        .iter()
        .map(|entry| {
            let content = match (entry.get("link"), entry.get("content")) {
                (Some(target), _) => Some(link_content(target.as_str().expect("link"))),
                (None, Some(content)) if content.get("unreadable").is_some() => Some(UNREADABLE.to_vec()),
                (None, content) => content.map(bytes_of),
            };
            let mode = entry.get("mode").map(|mode| u32::from_str_radix(mode.as_str().expect("mode"), 8).expect("octal mode"));
            (entry["path"].as_str().expect("path").to_owned(), content, mode)
        })
        .collect()
}

/// A junction `link` -> `target` (creating a symbolic link needs a privilege; Node's recorder used junctions too).
#[cfg(windows)]
fn junction(link: &Path, target: &Path) {
    // `mklink` takes backslash paths only.
    let backslashed = |path: &Path| path.to_string_lossy().replace('/', "\\");
    let made = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(backslashed(link)).arg(backslashed(target)).output().expect("mklink");
    assert!(made.status.success(), "mklink: {}{}", String::from_utf8_lossy(&made.stdout), String::from_utf8_lossy(&made.stderr));
}

/// The files another process held open while Node ran: open for reading, `Read` sharing others may read but not delete or rename,
/// `None` sharing nobody may open.
#[cfg(windows)]
fn hold(path: &Path, share: &str) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    let mode = match share {
        "Read" => 1, // FILE_SHARE_READ
        "None" => 0,
        other => panic!("share {other}"),
    };
    std::fs::OpenOptions::new().read(true).share_mode(mode).open(path).expect("lock")
}

const CHILD: &str = "MIXDOG_RETIRE_REPLAY_CHILD";
const THIS_TEST: &str = "workflow::retire::tests::every_recorded_state_leaves_the_data_dir_node_left";
const LINUX_TEST: &str = "workflow::retire::tests::every_recorded_linux_state_leaves_the_data_dir_node_left";

/// What Node's recorded `logs` of a state wrote to each stream: `console.log`/`info`/`debug` print a line to stdout,
/// `warn`/`error` to stderr, `process.stdout/stderr.write` chunks as they are.
fn recorded_streams(state: &Value) -> (String, String) {
    let (mut out, mut err) = (String::new(), String::new());
    for entry in state["logs"].as_array().expect("logs") {
        let entry = entry.as_str().expect("log");
        let (level, text) = entry.split_once(": ").expect("level");
        match level {
            "stdout" => out.push_str(text),
            "stderr" => err.push_str(text),
            "log" | "info" | "debug" => out.push_str(&format!("{text}\n")),
            _ => err.push_str(&format!("{text}\n")),
        }
    }
    (out, err)
}

/// The states replayed in a child process of this very test binary, so that everything the pass writes to the real stdout and
/// stderr is captured: per state, between its `STATE`/`DONE` marker lines, must equal what Node wrote (recorded `logs`), and the
/// child's whole stderr what Node wrote to stderr. The child itself asserts every tree, marker and error.
#[tokio::test]
async fn every_recorded_state_leaves_the_data_dir_node_left() {
    replay_in_child("windows", THIS_TEST).await;
}

#[cfg(unix)]
#[tokio::test]
async fn every_recorded_linux_state_leaves_the_data_dir_node_left() {
    replay_in_child("linux", LINUX_TEST).await;
}

async fn replay_in_child(set: &str, this_test: &str) {
    if std::env::var_os(CHILD).is_some() {
        return replay_all(set).await;
    }
    let child = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args(["--exact", this_test, "--nocapture", "--test-threads=1"])
        .env(CHILD, "1")
        .output()
        .expect("child");
    let (stdout, stderr) = (String::from_utf8_lossy(&child.stdout).into_owned(), String::from_utf8_lossy(&child.stderr).into_owned());
    assert!(child.status.success(), "child replay failed:\n{stdout}\n{stderr}");
    let (mut expected_err, mut seen) = (String::new(), 0);
    for state in twin(set)["states"].as_array().expect("states") {
        let name = state["name"].as_str().expect("name");
        let (begin, end) = (format!("\u{1}STATE {name}\n"), format!("\u{1}DONE {name}\n"));
        let from = stdout.find(&begin).unwrap_or_else(|| panic!("{name}: no marker")) + begin.len();
        let to = from + stdout[from..].find(&end).unwrap_or_else(|| panic!("{name}: no end marker"));
        let (out, err) = recorded_streams(state);
        assert_eq!(&stdout[from..to], out, "{name}: what the pass writes to stdout");
        expected_err.push_str(&err);
        seen += 1;
    }
    assert!(seen > if set == "linux" { 10 } else { 60 }, "{seen} states");
    assert_eq!(stderr, expected_err, "what the pass writes to stderr");
}

async fn replay_all(set: &str) {
    let twin = twin(set);
    let world = twin["world"].as_object().expect("world");
    let states = twin["states"].as_array().expect("states");
    for state in states {
        let name = state["name"].as_str().expect("name");
        println!("\u{1}STATE {name}");
        let dir = tempfile::tempdir().expect("dir");
        let (root, data) = (dir.path().join("package"), dir.path().join("data"));
        lay(&root, world);
        for (rel, encoded) in state["root"].as_object().expect("root") {
            if encoded.is_null() {
                std::fs::remove_file(root.join(rel)).expect("removed");
            }
        }
        lay(&root, &state["root"].as_object().expect("root").iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect());
        if state["noDataDir"] != true {
            std::fs::create_dir_all(&data).expect("data");
        }
        lay(&data, state["before"].as_object().expect("before"));
        let windows_only = set != "linux" && (!state["links"].as_array().expect("links").is_empty() || state["crossVolume"] == true || !state["locks"].as_array().expect("locks").is_empty());
        if windows_only && cfg!(not(windows)) {
            // Recorded with junctions, a second volume and open handles of Windows: nothing to replay them on here.
            println!("\u{1}DONE {name}");
            continue;
        }
        #[cfg(windows)]
        let (external, _holds) = {
            for link in state["links"].as_array().expect("links") {
                let (path, target) = (link[0].as_str().expect("path"), link[1].as_str().expect("target"));
                junction(&data.join(path), &data.join(target));
            }
            // `backups` on another volume: the rename into it fails with EXDEV. That volume is the system drive's (its Public
            // profile), or, when the test's own temp dir is on the system drive, the one of the folder
            // `MIXDOG_TEST_OTHER_VOLUME` names.
            let external = (state["crossVolume"] == true).then(|| {
                let drive = |path: &Path| path.to_string_lossy().chars().take(2).collect::<String>().to_lowercase();
                let public = Path::new(&std::env::var_os("SystemDrive").expect("SystemDrive")).join("\\Users\\Public");
                let other = if drive(&public) != drive(&data) { public } else { std::env::var_os("MIXDOG_TEST_OTHER_VOLUME").map(std::path::PathBuf::from).unwrap_or(public) };
                assert_ne!(drive(&other), drive(&data), "{name}: needs a second volume (the recording renames across two); MIXDOG_TEST_OTHER_VOLUME names a folder of one");
                let folder = tempfile::Builder::new().prefix("mixdog-retire-").tempdir_in(other).expect("external");
                junction(&data.join("backups"), folder.path());
                folder
            });
            let holds: Vec<std::fs::File> = state["locks"].as_array().expect("locks").iter().map(|lock| hold(&data.join(lock[0].as_str().expect("path")), lock[1].as_str().expect("share"))).collect();
            (external, holds)
        };
        // Linux: the symbolic links as written, then `backups` linked to a folder of another mount (/dev/shm, a tmpfs), where the
        // rename fails with EXDEV and the native copy runs.
        #[cfg(unix)]
        let external: Option<tempfile::TempDir> = {
            use std::os::unix::fs::MetadataExt;
            for link in state["symlinks"].as_array().into_iter().flatten() {
                let (path, text) = (link[0].as_str().expect("path"), link[1].as_str().expect("text"));
                std::fs::create_dir_all(data.join(path).parent().expect("parent")).expect("link folder");
                std::os::unix::fs::symlink(text, data.join(path)).expect("symlink");
            }
            // The permission bits the recording laid (deepest first, as Node's recorder did).
            let mut modes: Vec<(&str, u32)> = state["modes"].as_array().into_iter().flatten().map(|mode| (mode[0].as_str().expect("path"), mode[1].as_u64().expect("mode") as u32)).collect();
            modes.sort_by_key(|(path, _)| std::cmp::Reverse(path.len()));
            for (path, mode) in modes {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(data.join(path), std::fs::Permissions::from_mode(mode)).expect("chmod");
            }
            (state["crossVolume"] == true).then(|| {
                let folder = tempfile::Builder::new().prefix("mixdog-retire-").tempdir_in("/dev/shm").expect("external");
                assert_ne!(std::fs::metadata(folder.path()).expect("shm").dev(), std::fs::metadata(&data).expect("data").dev(), "{name}: needs a second mount");
                std::os::unix::fs::symlink(folder.path(), data.join("backups")).expect("backups link");
                folder
            })
        };
        #[cfg(all(not(windows), not(unix)))]
        let external: Option<tempfile::TempDir> = None;
        let mut error = None;
        for (run, after) in state["after"].as_array().expect("after").iter().enumerate() {
            let paths = WorkflowPaths { root: root.clone(), data: data.clone() };
            // The recorded pinned clock (`new Date()` of the pass), an input of every state: it names the backup folder.
            let clock = state["clock"].as_str().unwrap_or_else(|| panic!("{name}: no recorded clock")).to_owned();
            let outcome = mixdog_core_base::support::on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| retire_seeded_copies(lane, &paths, &|| clock.clone()))
            .await
            .expect("lane job");
            error = outcome.err();
            let outside = external.as_ref().map(|folder| folder.path());
            let with_modes = set == "linux";
            assert_eq!(snapshot(&data, &data, outside, with_modes), recorded(after), "{name}: run {run}");
            if let Some(folder) = outside {
                assert_eq!(snapshot(folder, &data, outside, with_modes), recorded(&state["externalAfter"][run]), "{name}: run {run}, the other volume");
            }
        }
        let node = state["error"].as_str().map(|text| text.strip_prefix("TypeError: ").unwrap_or(text).to_owned());
        assert_eq!(error, node, "{name}: what the pass throws");
        println!("\u{1}DONE {name}");
    }
}
