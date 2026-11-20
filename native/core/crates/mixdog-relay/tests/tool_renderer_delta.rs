//! `mixdog-relay renderer-delta`: manifests of a renderer tree, the delta between two trees, and applying a delta to a base,
//! including the shapes of the files and result lines the deploy scripts read.

use std::path::Path;

use mixdog_fsio::Unlaned;
use mixdog_relay::js;
use mixdog_relay::tools::renderer_delta::{CreateResult, apply_delta, build_manifest, create_delta, read_manifest, validate_manifest};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn write_tree(root: &Path, files: &[(&str, &[u8])]) {
    for (path, content) in files {
        let target = root.join(path);
        mixdog_fsio::create_dir_all(&Unlaned, target.parent().expect("a file has a parent")).expect("directory");
        mixdog_fsio::write(&Unlaned, target, content).expect("file");
    }
}

fn read_text(path: &Path) -> String {
    String::from_utf8(mixdog_fsio::read(&Unlaned, path).expect("the file exists")).expect("utf8")
}

fn exists(path: &Path) -> bool {
    mixdog_fsio::exists(&Unlaned, path).expect("exists")
}

struct Dirs {
    _guard: TempDir,
    base: std::path::PathBuf,
    current: std::path::PathBuf,
    delta: std::path::PathBuf,
    output: std::path::PathBuf,
}

fn fixture() -> Dirs {
    let guard = tempfile::tempdir().expect("tempdir");
    let root = guard.path().to_path_buf();
    let dirs = Dirs { base: root.join("base"), current: root.join("current"), delta: root.join("delta"), output: root.join("output"), _guard: guard };
    mixdog_fsio::create_dir_all(&Unlaned, &dirs.base).expect("base");
    mixdog_fsio::create_dir_all(&Unlaned, &dirs.current).expect("current");
    dirs
}

fn sample(dirs: &Dirs) {
    write_tree(&dirs.base, &[("same.js", b"same"), ("changed.js", b"before"), ("removed.js", b"removed")]);
    write_tree(&dirs.current, &[("same.js", b"same"), ("changed.js", b"after"), ("assets/new.css", b"new")]);
}

fn create_sample(dirs: &Dirs) -> (std::path::PathBuf, CreateResult) {
    let base_manifest = {
        let manifest = build_manifest(&dirs.base).expect("base manifest");
        validate_manifest(&js::parse(&manifest.compact_json()).expect("json")).expect("valid")
    };
    let manifest_path = dirs.current.join("renderer-manifest.json");
    let result = create_delta(&dirs.current, Some(&base_manifest), &dirs.delta, &manifest_path).expect("create");
    (manifest_path, result)
}

fn is_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[test]
fn renderer_delta_copies_only_changed_files_and_reconstructs_the_exact_tree() {
    let dirs = fixture();
    sample(&dirs);
    let base_hash = build_manifest(&dirs.base).expect("base manifest").tree_hash;
    let (manifest_path, result) = create_sample(&dirs);

    assert_eq!(result.changed_files, 2);
    assert_eq!(result.removed_files, 1);
    assert!(!exists(&dirs.delta.join("same.js")));
    assert_eq!(read_text(&dirs.delta.join("changed.js")), "after");
    let manifest = read_manifest(&manifest_path).expect("manifest");
    apply_delta(&dirs.base, &dirs.delta, &manifest, &dirs.output, false).expect("apply");
    let rebuilt = build_manifest(&dirs.output).expect("rebuilt");
    assert_eq!(rebuilt.tree_hash, manifest.tree_hash);
    assert_eq!(rebuilt.files, manifest.files);
    // The manifest names the base it was computed against; apply refuses any other tree, so a stale cached delta cannot
    // reconstruct an old renderer.
    assert!(is_hash(&manifest.base));
    assert_eq!(manifest.base, base_hash);
    assert!(!exists(&dirs.output.join("removed.js")));
}

#[test]
fn renderer_reconstruction_rejects_a_mismatched_reused_base_file() {
    let dirs = fixture();
    write_tree(&dirs.base, &[("same.js", b"same")]);
    write_tree(&dirs.current, &[("same.js", b"same")]);
    let (manifest_path, _) = create_sample(&dirs);
    write_tree(&dirs.base, &[("same.js", b"corrupted")]);

    let manifest = read_manifest(&manifest_path).expect("manifest");
    let error = apply_delta(&dirs.base, &dirs.delta, &manifest, &dirs.output, false).expect_err("a changed base is refused");
    assert!(error.to_string().contains("failed verification"), "{error}");
}

#[test]
fn hardlinked_reconstruction_never_mutates_the_installed_base() {
    let dirs = fixture();
    write_tree(&dirs.base, &[("same.js", b"same"), ("changed.js", b"before")]);
    write_tree(&dirs.current, &[("same.js", b"same"), ("changed.js", b"after")]);
    let (manifest_path, _) = create_sample(&dirs);

    let manifest = read_manifest(&manifest_path).expect("manifest");
    apply_delta(&dirs.base, &dirs.delta, &manifest, &dirs.output, true).expect("apply");

    assert_eq!(read_text(&dirs.base.join("changed.js")), "before");
    assert_eq!(read_text(&dirs.output.join("changed.js")), "after");
    assert_eq!(read_text(&dirs.output.join("same.js")), "same");
}

fn manifest_value(files: &[(&str, u64, &str)]) -> Value {
    let mut hash = Sha256::new();
    for (path, size, sha256) in files {
        hash.update(format!("{path}\0{size}\0{sha256}\0").as_bytes());
    }
    let tree_hash: String = hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    json!({
        "schemaVersion": 1,
        "treeHash": tree_hash,
        "files": files.iter().map(|(path, size, sha256)| json!({"path": path, "size": size, "sha256": sha256})).collect::<Vec<_>>(),
    })
}

#[test]
fn renderer_manifests_reject_traversal_paths() {
    let zeros = "0".repeat(64);
    let value = json!({
        "schemaVersion": 1,
        "treeHash": zeros,
        "files": [{"path": "../escape.js", "size": 1, "sha256": zeros}],
    });
    let error = validate_manifest(&value).expect_err("a traversal path is refused");
    assert!(error.to_string().contains("Unsafe renderer manifest path"), "{error}");
}

#[test]
fn renderer_manifests_reject_every_unsafe_path_shape() {
    let zeros = "0".repeat(64);
    for path in ["", "/abs.js", "a\\b.js", "a/../b.js", "a//b.js", "./a.js", "a/.", "a/"] {
        let value = json!({"schemaVersion": 1, "treeHash": zeros, "files": [{"path": path, "size": 1, "sha256": zeros}]});
        let error = validate_manifest(&value).expect_err(path);
        assert!(error.to_string().contains("Unsafe renderer manifest path"), "{path}: {error}");
    }
    let missing = json!({"schemaVersion": 1, "treeHash": zeros, "files": [{"size": 1, "sha256": zeros}]});
    assert_eq!(validate_manifest(&missing).expect_err("no path").to_string(), "Unsafe renderer manifest path: undefined");
}

#[test]
fn a_manifest_that_is_not_well_formed_is_refused() {
    let zeros = "0".repeat(64);
    let one = "1".repeat(64);
    let valid = manifest_value(&[("a.js", 1, &zeros), ("b.js", 2, &one)]);
    assert!(validate_manifest(&valid).is_ok());

    let mut wrong_version = valid.clone();
    wrong_version["schemaVersion"] = json!(2);
    assert_eq!(validate_manifest(&wrong_version).expect_err("version").to_string(), "Renderer manifest is missing or incompatible.");
    assert_eq!(validate_manifest(&json!({"schemaVersion": 1})).expect_err("no files").to_string(), "Renderer manifest is missing or incompatible.");

    let duplicate = manifest_value(&[("a.js", 1, &zeros), ("a.js", 1, &zeros)]);
    assert_eq!(validate_manifest(&duplicate).expect_err("duplicate").to_string(), "Duplicate renderer manifest path: a.js");

    for size in [json!(-1), json!(1.5), json!("1"), json!(9_007_199_254_740_992u64)] {
        let mut value = valid.clone();
        value["files"][0]["size"] = size;
        assert_eq!(validate_manifest(&value).expect_err("size").to_string(), "Invalid renderer manifest size: a.js");
    }
    for hash in [json!("ABCDEF"), json!("0".repeat(63)), json!(7), Value::Null] {
        let mut value = valid.clone();
        value["files"][0]["sha256"] = hash;
        assert_eq!(validate_manifest(&value).expect_err("hash").to_string(), "Invalid renderer manifest hash: a.js");
    }

    let mut tampered = valid.clone();
    tampered["files"][1]["size"] = json!(3);
    assert_eq!(validate_manifest(&tampered).expect_err("tree hash").to_string(), "Renderer manifest tree hash does not match its file list.");

    for base in [json!("nothex"), json!(12), json!(true)] {
        let mut value = valid.clone();
        value["base"] = base;
        assert_eq!(validate_manifest(&value).expect_err("base").to_string(), "Renderer manifest base hash is invalid.");
    }
    for base in [Value::Null, json!("")] {
        let mut value = valid.clone();
        value["base"] = base;
        assert_eq!(validate_manifest(&value).expect("no base").base, "");
    }
    let mut based = valid;
    based["base"] = json!(one);
    assert_eq!(validate_manifest(&based).expect("base").base, one);
}

#[test]
fn a_manifest_is_sorted_the_way_the_file_list_is_hashed() {
    // Out of order in the file: validation sorts by localeCompare before the tree hash is checked.
    let zeros = "0".repeat(64);
    let sorted = manifest_value(&[("a.js", 1, &zeros), ("b.js", 1, &zeros)]);
    let mut shuffled = sorted.clone();
    shuffled["files"] = json!([sorted["files"][1], sorted["files"][0]]);
    let manifest = validate_manifest(&shuffled).expect("valid");
    assert_eq!(manifest.files[0].path, "a.js");
}

#[test]
fn a_delta_with_a_file_the_manifest_does_not_list_is_refused() {
    let dirs = fixture();
    sample(&dirs);
    let (manifest_path, _) = create_sample(&dirs);
    write_tree(&dirs.delta, &[("extra.js", b"extra")]);
    let manifest = read_manifest(&manifest_path).expect("manifest");
    let error = apply_delta(&dirs.base, &dirs.delta, &manifest, &dirs.output, false).expect_err("unlisted");
    assert_eq!(error.to_string(), "Renderer delta contains an unlisted file: extra.js");
}

#[test]
fn a_delta_file_that_does_not_match_its_manifest_entry_is_refused() {
    let dirs = fixture();
    sample(&dirs);
    let (manifest_path, _) = create_sample(&dirs);
    write_tree(&dirs.delta, &[("changed.js", b"AFTER")]);
    let manifest = read_manifest(&manifest_path).expect("manifest");
    let error = apply_delta(&dirs.base, &dirs.delta, &manifest, &dirs.output, false).expect_err("tampered");
    assert_eq!(error.to_string(), "Renderer delta file failed verification: changed.js");
}

#[test]
fn only_the_exact_base_is_accepted() {
    let dirs = fixture();
    sample(&dirs);
    let (manifest_path, _) = create_sample(&dirs);
    let manifest = read_manifest(&manifest_path).expect("manifest");
    let other = dirs.output.with_file_name("other");
    write_tree(&other, &[("same.js", b"same"), ("changed.js", b"before"), ("removed.js", b"removed"), ("stray.js", b"stray")]);
    let error = apply_delta(&other, &dirs.delta, &manifest, &dirs.output, false).expect_err("another base");
    assert!(error.to_string().starts_with("Renderer delta base failed verification: expected "), "{error}");
    assert!(!exists(&dirs.output), "nothing is rebuilt on a refused base");
}

#[test]
fn a_full_delta_without_a_base_rebuilds_from_nothing() {
    let dirs = fixture();
    sample(&dirs);
    let manifest_path = dirs.current.join("renderer-manifest.json");
    let result = create_delta(&dirs.current, None, &dirs.delta, &manifest_path).expect("create");
    assert_eq!((result.changed_files, result.removed_files, result.total_files), (3, 0, 3));
    let manifest = read_manifest(&manifest_path).expect("manifest");
    // The base recorded is the tree hash of an empty tree, so apply over a missing base directory passes the gate.
    let missing = dirs.output.with_file_name("no-base");
    let applied = apply_delta(&missing, &dirs.delta, &manifest, &dirs.output, true).expect("apply");
    assert_eq!(applied.tree_hash, manifest.tree_hash);
    assert_eq!(applied.files, 3);
}

#[test]
fn a_missing_root_is_an_empty_tree() {
    let dirs = fixture();
    let manifest = build_manifest(&dirs.output).expect("missing root");
    assert!(manifest.files.is_empty());
    assert_eq!(manifest.compact_json(), format!("{{\"schemaVersion\":1,\"treeHash\":\"{}\",\"files\":[]}}", manifest.tree_hash));
    assert_eq!(manifest.tree_hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_in_a_tree_is_refused() {
    let dirs = fixture();
    write_tree(&dirs.current, &[("real.js", b"real")]);
    mixdog_fsio::symlink_file(&Unlaned, dirs.current.join("real.js"), dirs.current.join("link.js")).expect("symlink");
    let error = build_manifest(&dirs.current).expect_err("a link");
    assert!(error.to_string().starts_with("Renderer tree contains a symbolic link: "), "{error}");
}

#[test]
fn the_manifest_line_and_the_manifest_file_have_the_shapes_the_deploy_scripts_read() {
    let dirs = fixture();
    sample(&dirs);
    let line = build_manifest(&dirs.current).expect("manifest").compact_json();
    assert!(!line.contains('\n') && !line.contains(": "), "the printed line is compact: {line}");
    let document = js::parse(&line).expect("json");
    assert_eq!(document["schemaVersion"], 1);
    assert!(is_hash(document["treeHash"].as_str().expect("treeHash")));
    let files: Vec<(&str, u64)> =
        document["files"].as_array().expect("files").iter().map(|f| (f["path"].as_str().expect("path"), f["size"].as_u64().expect("size"))).collect();
    assert_eq!(files, [("assets/new.css", 3), ("changed.js", 5), ("same.js", 4)]);
    let changed = &document["files"][1];
    assert_eq!(changed["sha256"], format!("{:x}", Sha256::digest(b"after")));

    let (manifest_path, _) = create_sample(&dirs);
    let file = read_text(&manifest_path);
    assert!(file.starts_with("{\n  \"schemaVersion\": 1,\n  \"treeHash\": \""), "{file}");
    assert!(file.ends_with("}\n"), "{file}");
    assert_eq!(js::parse(&file).expect("json")["base"], build_manifest(&dirs.base).expect("base").tree_hash);
}

#[test]
fn creating_and_applying_a_delta_report_their_counts_as_one_json_line() {
    let dirs = fixture();
    sample(&dirs);
    let current_hash = build_manifest(&dirs.current).expect("current").tree_hash;
    let (manifest_path, created) = create_sample(&dirs);
    assert_eq!(
        created.json(),
        format!("{{\"totalFiles\":3,\"totalBytes\":12,\"changedFiles\":2,\"changedBytes\":8,\"removedFiles\":1,\"treeHash\":\"{current_hash}\"}}")
    );
    let manifest = read_manifest(&manifest_path).expect("manifest");
    let applied = apply_delta(&dirs.base, &dirs.delta, &manifest, &dirs.output, false).expect("apply");
    assert_eq!(applied.json(), format!("{{\"files\":3,\"bytes\":12,\"treeHash\":\"{current_hash}\"}}"));
    let linked = dirs.output.with_file_name("linked");
    let applied = apply_delta(&dirs.base, &dirs.delta, &manifest, &linked, true).expect("apply with hardlinks");
    assert_eq!(applied.json(), format!("{{\"files\":3,\"bytes\":12,\"treeHash\":\"{current_hash}\"}}"));
    assert_eq!(build_manifest(&linked).expect("rebuilt").tree_hash, current_hash);
}
