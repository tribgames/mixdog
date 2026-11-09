//! The resolution and the launch environment against Node's recording of them
//! (`fixtures/git-launch/launch.json`, `record-git-launch.mjs`): the same on-disk layouts, the same
//! PATH and base environments, the folder written as `<ROOT>` (or `<UNC>` for the administrator
//! share of its drive) on both sides.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use super::Layout;
use super::launch_environment_in;
use super::native_realpath;
use super::normalize_verbatim;
use super::resolve_layout;

fn recording() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/git-launch/launch.json")).unwrap()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

/// A scenario's folder: the real path of a fresh directory, and the administrator-share form of it.
struct Folder {
    _dir: tempfile::TempDir,
    root: String,
    unc: String,
}

impl Folder {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = native_realpath(dir.path()).unwrap();
        let unc = format!("\\\\localhost\\{}${}", &root[..1], &root[2..]);
        Self { _dir: dir, root, unc }
    }

    fn fill(&self, files: &[String], config: Option<&str>) {
        for entry in files {
            let full = Path::new(&self.root).join(entry);
            if entry.ends_with('/') {
                std::fs::create_dir_all(&full).unwrap();
            } else {
                std::fs::create_dir_all(full.parent().unwrap()).unwrap();
                std::fs::write(&full, if entry == "etc/git-bash.config" { config.unwrap() } else { "" }).unwrap();
            }
        }
    }

    fn insert(&self, text: &str) -> String {
        text.replace("<ROOT>", &self.root).replace("<UNC>", &self.unc)
    }

    fn mask(&self, text: &str) -> String {
        text.replace(&self.unc, "<UNC>").replace(&self.root, "<ROOT>")
    }
}

fn layout_json(folder: &Folder, layout: &Option<Layout>) -> Value {
    match layout {
        None => Value::Null,
        Some(l) => serde_json::json!({
            "command": folder.mask(&l.command),
            "root": folder.mask(&l.root),
            "msystem": l.msystem,
            "msysConfig": l.msys_config,
        }),
    }
}

#[test]
fn every_layout_resolves_as_nodes_does() {
    let recorded = recording();
    let cases = recorded["layouts"].as_array().unwrap();
    assert!(cases.len() >= 20);
    let mut resolved = 0;
    for case in cases {
        let folder = Folder::new();
        folder.fill(&strings(&case["files"]), case["config"].as_str());
        let layout = resolve_layout(&folder.insert(case["path"].as_str().unwrap()));
        resolved += usize::from(layout.is_some());
        assert_eq!(layout_json(&folder, &layout), case["launch"], "{}", case["id"]);
    }
    assert!(resolved >= 10 && resolved < cases.len());
}

#[test]
fn every_launch_environment_is_nodes() {
    let recorded = recording();
    let layouts = recorded["layouts"].as_array().unwrap();
    let system_root = recorded["systemRoot"].as_str().unwrap();
    let cases = recorded["environments"].as_array().unwrap();
    assert!(cases.len() >= 15);
    for case in cases {
        let definition = layouts.iter().find(|l| l["id"] == case["layout"]).unwrap();
        let folder = Folder::new();
        let mut files = strings(&definition["files"]);
        files.extend(strings(&case["dirs"]));
        folder.fill(&files, definition["config"].as_str());
        let layout = resolve_layout(&folder.insert(definition["path"].as_str().unwrap())).expect("the layout resolves");
        let system32 = format!("{system_root}\\System32");
        let system32 = if case["lowerSystem32"] == true { system32.to_lowercase() } else { system32 };
        let base: Vec<(String, String)> = case["base"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), folder.insert(v.as_str().unwrap()).replace("<SYSTEM32>", &system32)))
            .collect();
        let env: BTreeMap<String, String> = launch_environment_in(&layout, &base, system_root).into_iter().map(|(k, v)| (k, folder.mask(&v))).collect();
        let want: BTreeMap<String, String> = case["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
        assert_eq!(env, want, "{}", case["id"]);
    }
}

/// The environment SCM hands a git child: what a caller sets (`extra_env`, `GIT_*`) or removes
/// first, the launcher's transformations over the result. Node's `gitChildEnv(env)` takes the
/// whole environment, so a caller's PATH, MSYSTEM and MSYS are transformed like inherited ones.
#[test]
fn the_callers_environment_is_transformed_by_the_launcher_as_nodes_is() {
    let recorded = recording();
    let layouts = recorded["layouts"].as_array().unwrap();
    let cases = recorded["merges"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for case in cases {
        let definition = layouts.iter().find(|l| l["id"] == case["layout"]).unwrap();
        let folder = Folder::new();
        folder.fill(&strings(&definition["files"]), definition["config"].as_str());
        let pairs = |value: &Value| -> Vec<(String, String)> { value.as_object().unwrap().iter().map(|(k, v)| (k.clone(), folder.insert(v.as_str().unwrap()))).collect() };
        let process = pairs(&case["process"]);
        let mut spec = crate::exec::ExecSpec::new("git", Path::new(&folder.root));
        spec.env_set = pairs(&case["set"]);
        spec.env_remove = strings(&case["remove"]);
        let base = crate::git::child_base(&spec, process.clone());
        crate::git::apply_launch(&mut spec, super::launch_for(&base));
        let env: BTreeMap<String, String> = crate::git::child_base(&spec, process).into_iter().map(|(k, v)| (k, folder.mask(&v))).collect();
        let want: BTreeMap<String, String> = case["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
        assert_eq!(folder.mask(&spec.program), case["command"].as_str().unwrap(), "{}", case["id"]);
        assert_eq!(env, want, "{}", case["id"]);
    }
}

/// libuv's `realpath`: a UNC final path name loses `\\?\UNC\` for `\\`, a drive path its `\\?\`.
#[test]
fn a_verbatim_unc_path_is_normalized_as_libuv_does() {
    let recorded = recording();
    let unc = recorded["layouts"].as_array().unwrap().iter().find(|l| l["id"] == "unc path").unwrap();
    let folder = Folder::new();
    folder.fill(&strings(&unc["files"]), None);
    let launcher = format!("{}\\cmd\\git.exe", folder.unc);
    assert_eq!(native_realpath(Path::new(&launcher)).unwrap(), launcher);
    assert_eq!(normalize_verbatim(&format!("UNC\\{}", &launcher[2..])).unwrap(), launcher);
    assert_eq!(normalize_verbatim("C:\\x").unwrap(), "C:\\x");
    assert!(normalize_verbatim("Volume{1234}\\x").is_none());
}
