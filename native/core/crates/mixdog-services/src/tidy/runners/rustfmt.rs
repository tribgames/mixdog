//! rustfmt, one file at a time through stdin: given a path, rustfmt also formats, and in fix mode
//! rewrites, every out-of-line module that file declares, whether or not it was asked for, and a
//! module that does not parse fails the file that names it. On stdin it formats that text alone
//! and exits non-zero only when it could not. What stdin cannot tell it is where the file is:
//! the edition `cargo fmt` reads from the file's package manifest, and the configuration rustfmt
//! looks for from the file's directory upward. Both are read here and passed along, unless the
//! project's own arguments already say them: rustfmt refuses an option given twice.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;

use super::shared::*;
use super::stdin::{configured, format_each};
use crate::lane::on_lane;

/// A manifest by directory: `None` where there is none, the reason where it cannot be used.
type Manifests = HashMap<PathBuf, Result<Option<toml::Table>, String>>;

fn manifest(cache: &mut Manifests, dir: &Path) -> Result<Option<toml::Table>, String> {
    cache.entry(dir.to_owned()).or_insert_with(|| read_manifest(&dir.join("Cargo.toml"))).clone()
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_manifest(path: &Path) -> Result<Option<toml::Table>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => text.parse().map(Some).map_err(|e: toml::de::Error| format!("{} does not parse: {}", path.display(), e.message())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{} could not be read: {e}", path.display())),
    }
}

/// The edition `cargo fmt` would give `file`: that of its nearest package manifest, read through
/// the workspace manifest when the package inherits it. `None` leaves it to rustfmt's own
/// configuration; a manifest that cannot be read is an error, never a reason to guess.
fn package_edition(cache: &mut Manifests, file: &Path) -> Result<Option<String>, String> {
    for dir in file.ancestors().skip(1) {
        let Some(table) = manifest(cache, dir)? else { continue };
        let Some(package) = table.get("package").and_then(toml::Value::as_table) else { continue };
        let Some(edition) = package.get("edition") else { return Ok(None) };
        if let Some(edition) = edition.as_str() {
            return Ok(Some(edition.to_owned()));
        }
        if edition.get("workspace").and_then(toml::Value::as_bool) != Some(true) {
            return Ok(None);
        }
        return workspace_edition(cache, dir, package.get("workspace").and_then(toml::Value::as_str));
    }
    Ok(None)
}

/// `workspace.package.edition` of the workspace a member belongs to: the one its `package.workspace`
/// names, else the nearest manifest at or above it that has a `[workspace]` table.
fn workspace_edition(cache: &mut Manifests, member: &Path, named: Option<&str>) -> Result<Option<String>, String> {
    let roots: Vec<PathBuf> = match named {
        Some(root) => vec![member.join(root)],
        None => member.ancestors().map(Path::to_owned).collect(),
    };
    for root in roots {
        let Some(table) = manifest(cache, &root)? else { continue };
        if let Some(workspace) = table.get("workspace").and_then(toml::Value::as_table) {
            return Ok(workspace.get("package").and_then(|p| p.get("edition")).and_then(toml::Value::as_str).map(str::to_owned));
        }
    }
    Err(format!("{} inherits its edition from a workspace, and no workspace manifest was found for it", member.join("Cargo.toml").display()))
}

const CONFIG_NAMES: [&str; 2] = ["rustfmt.toml", ".rustfmt.toml"];

/// The directory of the configuration rustfmt would find from `file` and does not find from
/// `cwd`, where it runs: the nearest one below `cwd`, at or above the file, that has one.
/// Named as a directory, rustfmt picks the configuration file in it as it would on its own.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn config_dir(cwd: &Path, file: &Path) -> Option<String> {
    let dir = file.ancestors().skip(1).take_while(|dir| *dir != cwd && dir.starts_with(cwd)).find(|dir| CONFIG_NAMES.iter().any(|name| dir.join(name).is_file()))?;
    Some(to_rel(cwd, &dir.to_string_lossy()))
}

/// What rustfmt must be told about a file whose text it reads from stdin.
#[derive(Clone)]
struct Place {
    edition: Option<String>,
    config_dir: Option<String>,
}

/// What is not already said by the project's arguments (`given`: the edition, the configuration).
fn places_of(cwd: &Path, files: &[String], given: (bool, bool)) -> Vec<Result<Place, String>> {
    let mut cache = Manifests::new();
    let place = |file: &String| {
        let path = cwd.join(file);
        let edition = if given.0 { None } else { package_edition(&mut cache, &path)? };
        Ok(Place { edition, config_dir: if given.1 { None } else { config_dir(cwd, &path) } })
    };
    files.iter().map(place).collect()
}

async fn run(req: &RunRequest, write: bool) -> RunnerResult {
    let (cwd, files) = (req.cwd.clone(), req.files.clone());
    let given = (configured(req, "--edition"), configured(req, "--config-path"));
    let Ok(places) = on_lane(req.lane, move || places_of(&cwd, &files, given)).await else {
        return engine_stopped("rustfmt could not run: its lane did not read the package manifests".to_owned());
    };
    let plan = |index: usize| -> Result<Vec<String>, String> {
        let place = places[index].clone()?;
        let mut args = Vec::new();
        if let Some(edition) = place.edition {
            args.extend(["--edition".to_owned(), edition]);
        }
        if let Some(dir) = place.config_dir {
            args.extend(["--config-path".to_owned(), dir]);
        }
        args.extend(["--emit".to_owned(), "stdout".to_owned()]);
        Ok(args)
    };
    format_each(req, "rustfmt", write, &plan).await
}

pub struct Rustfmt;

#[async_trait]
impl Runner for Rustfmt {
    fn id(&self) -> &'static str {
        "rustfmt"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        run(req, false).await
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        run(req, true).await
    }
}

#[cfg(test)]
mod tests {
    use super::super::stdin::tests::{clean, project};
    use super::*;

    /// The arguments rustfmt got for each file, by the file's text.
    async fn flags(files: &[(&str, &str)], sources: &[&str]) -> Vec<(String, String)> {
        let (_dir, spawn, req) = project(files, sources, clean);
        assert_eq!(Rustfmt.check(&req).await.files_checked, Some(sources.len()));
        let mut calls: Vec<(String, String)> = spawn.0.lock().unwrap().iter().map(|(args, _, source)| (source.clone(), args.join(" "))).collect();
        calls.sort();
        calls
    }

    fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
        expected.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect()
    }

    #[tokio::test]
    async fn each_file_is_formatted_under_its_packages_edition() {
        let tree = [
            ("old/Cargo.toml", "[package]\nname = \"o\"\nedition = \"2021\"\n"),
            ("old/a.rs", "a"),
            ("new/Cargo.toml", "[package]\nname = \"n\"\nedition = \"2024\"\n"),
            ("new/src/b.rs", "b"),
            ("loose.rs", "c"),
            ("plain/Cargo.toml", "[package]\nname = \"p\"\n"),
            ("plain/d.rs", "d"),
        ];
        let calls = flags(&tree, &["old/a.rs", "new/src/b.rs", "loose.rs", "plain/d.rs"]).await;
        assert_eq!(calls, pairs(&[("a", "--edition 2021 --emit stdout"), ("b", "--edition 2024 --emit stdout"), ("c", "--emit stdout"), ("d", "--emit stdout")]));
    }

    #[tokio::test]
    async fn a_configuration_below_the_project_is_named_and_what_the_project_already_says_is_not_said_twice() {
        let tree = [("rustfmt.toml", ""), ("a.rs", "a"), ("sub/.rustfmt.toml", ""), ("sub/Cargo.toml", "[package]\nname = \"s\"\nedition = \"2021\"\n"), ("sub/src/deep/b.rs", "b")];
        // rustfmt finds the project's own configuration from where it runs; only the nested one needs naming.
        assert_eq!(flags(&tree, &["a.rs", "sub/src/deep/b.rs"]).await, pairs(&[("a", "--emit stdout"), ("b", "--edition 2021 --config-path sub --emit stdout")]));
        let (_dir, spawn, mut req) = project(&tree, &["sub/src/deep/b.rs"], clean);
        req.args = ["--edition=2018", "--config-path", "rustfmt.toml"].map(String::from).to_vec();
        assert_eq!(Rustfmt.check(&req).await.files_checked, Some(1));
        assert_eq!(spawn.0.lock().unwrap()[0].0.join(" "), "--edition=2018 --config-path rustfmt.toml --emit stdout");
        // An edition the project gives is not looked for: a manifest tidy cannot read does not stand in the way.
        let (_dir, _spawn, mut req) = project(&[("bad/Cargo.toml", "[package\n"), ("bad/a.rs", "a")], &["bad/a.rs"], clean);
        req.args = vec!["--edition".to_owned(), "2021".to_owned()];
        let out = Rustfmt.check(&req).await;
        assert_eq!((out.files_checked, out.unprocessed.len()), (Some(1), 0));
    }

    #[tokio::test]
    async fn an_inherited_edition_is_read_from_the_workspace_the_member_names_or_sits_under() {
        let tree = [
            ("Cargo.toml", "[workspace]\nmembers = [\"m\", \"n\"]\n[workspace.package]\nedition = \"2024\"\n"),
            ("m/Cargo.toml", "[package]\nname = \"m\"\nedition.workspace = true\n"),
            ("m/a.rs", "a"),
            ("n/Cargo.toml", "[package]\nname = \"n\"\nedition = { workspace = true }\n"),
            ("n/b.rs", "b"),
            ("other/Cargo.toml", "[workspace]\n[workspace.package]\nedition = \"2018\"\n"),
            ("far/Cargo.toml", "[package]\nname = \"f\"\nworkspace = \"../other\"\nedition.workspace = true\n"),
            ("far/c.rs", "c"),
        ];
        let calls = flags(&tree, &["m/a.rs", "n/b.rs", "far/c.rs"]).await;
        assert_eq!(calls, pairs(&[("a", "--edition 2024 --emit stdout"), ("b", "--edition 2024 --emit stdout"), ("c", "--edition 2018 --emit stdout")]));
    }

    #[tokio::test]
    async fn a_manifest_that_cannot_be_used_leaves_its_files_unformatted_and_the_rest_checked() {
        let tree = [("bad/Cargo.toml", "[package\n"), ("bad/a.rs", "a"), ("orphan/Cargo.toml", "[package]\nname = \"o\"\nedition.workspace = true\n"), ("orphan/b.rs", "b"), ("ok.rs", "c")];
        let (_dir, spawn, req) = project(&tree, &["bad/a.rs", "orphan/b.rs", "ok.rs"], clean);
        let out = Rustfmt.check(&req).await;
        assert_eq!((out.files_checked, out.error.clone()), (Some(1), None));
        let unprocessed: Vec<&str> = out.unprocessed.iter().map(|(f, _)| f.as_str()).collect();
        assert_eq!(unprocessed, ["bad/a.rs", "orphan/b.rs"]);
        assert!(out.unprocessed[0].1.contains("does not parse") && out.unprocessed[1].1.contains("no workspace manifest"), "{:?}", out.unprocessed);
        assert_eq!(spawn.0.lock().unwrap().len(), 1, "rustfmt is not run on a file whose edition is unknown");
    }
}
