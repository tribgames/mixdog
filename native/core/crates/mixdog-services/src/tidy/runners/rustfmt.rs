//! rustfmt, one file at a time through stdin: given a path, rustfmt also formats, and in fix mode
//! rewrites, every out-of-line module that file declares, whether or not it was asked for, and a
//! module that does not parse fails the file that names it. On stdin it formats that text alone
//! and exits non-zero only when it could not. What stdin cannot tell it is where the file is:
//! the edition `cargo fmt` reads from the file's package manifest, and the configuration rustfmt
//! looks for from the file's directory upward. Both are read here and passed along, unless the
//! project's own arguments already say them: rustfmt refuses an option given twice. Nor can it
//! tell whether `cargo fmt` formats the file at all; [`select`] asks cargo and rustfmt that.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;

use super::rustfmt_modules::{Verdict, select};
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
    let dir =
        file.ancestors().skip(1).take_while(|dir| *dir != cwd && dir.starts_with(cwd)).find(|dir| CONFIG_NAMES.iter().any(|name| dir.join(name).is_file()))?;
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

/// Formats the files `cargo fmt` formats; the others of its packages are the engine's ignored.
async fn run(req: &RunRequest, write: bool) -> RunnerResult {
    let selection = match select(req).await {
        Ok(selection) => selection,
        Err(why) => return engine_stopped(why),
    };
    let (mut files, mut ignored, mut unknown) = (Vec::new(), Vec::new(), Vec::new());
    for (file, verdict) in req.files.iter().cloned().zip(selection.verdicts) {
        match verdict {
            Verdict::Format => files.push(file),
            Verdict::NotFormatted => ignored.push(file),
            Verdict::Unknown(why) => unknown.push((file, why)),
        }
    }
    let req = RunRequest {
        files,
        cwd: req.cwd.clone(),
        bin: req.bin.clone(),
        args: req.args.clone(),
        timeout: req.timeout,
        cancel: req.cancel.clone(),
        module_path: req.module_path.clone(),
        spawn: req.spawn.clone(),
        files_per_spawn: req.files_per_spawn,
        lane: req.lane,
    };
    let mut result = format_files(&req, write).await;
    result.ignored.extend(ignored);
    result.unprocessed.extend(unknown);
    if !selection.notes.is_empty() {
        result.note = Some(selection.notes.join("; "));
    }
    result
}

async fn format_files(req: &RunRequest, write: bool) -> RunnerResult {
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
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};

    use tokio_util::sync::CancellationToken;

    use super::super::stdin::tests::Spawned;
    use super::*;
    use crate::tidy::process::{ProcessResult, Processes};

    /// What a real run of a program answered, as the test lets it reach the runner.
    type Answer = fn(&str, ProcessResult) -> ProcessResult;

    /// The real cargo and rustfmt, their answers passed through the test's [`Answer`], for
    /// everything but a text to format, which is recorded and answered as already formatted.
    struct Toolchain(Mutex<Vec<Spawned>>, Answer);

    #[async_trait]
    impl Spawn for Toolchain {
        async fn run(
            &self,
            bin: &str,
            args: &[String],
            cwd: &Path,
            timeout: std::time::Duration,
            cancel: Option<&CancellationToken>,
            env: Option<&HashMap<String, String>>,
            input: Option<Vec<u8>>,
        ) -> ProcessResult {
            let Some(input) = input else {
                return (self.1)(bin, SystemSpawn(Processes::for_tests()).run(bin, args, cwd, timeout, cancel, env, None).await);
            };
            let source = String::from_utf8(input).unwrap();
            self.0.lock().unwrap().push((args.to_vec(), cwd.to_owned(), source.clone()));
            ProcessResult { stdout: source, ..Default::default() }
        }
    }

    /// A tree of `files` (path, text) and rustfmt asked about `sources` in it.
    fn project(files: &[(&str, &str)], sources: &[&str]) -> (tempfile::TempDir, Arc<Toolchain>, RunRequest) {
        answered(files, sources, |_, r| r)
    }

    /// [`project`], with cargo's and rustfmt's own answers passed through `answer`.
    fn answered(files: &[(&str, &str)], sources: &[&str], answer: Answer) -> (tempfile::TempDir, Arc<Toolchain>, RunRequest) {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let full = dir.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        }
        let spawn = Arc::new(Toolchain(Mutex::default(), answer));
        let files = sources.iter().map(|f| (*f).to_owned()).collect();
        let req = RunRequest::new(dir.path(), "rustfmt", files, spawn.clone(), mixdog_rt::testing::tokens().durability_io);
        (dir, spawn, req)
    }

    /// The arguments rustfmt got for each file, by the file's text.
    async fn flags(files: &[(&str, &str)], sources: &[&str]) -> Vec<(String, String)> {
        let (_dir, spawn, req) = project(files, sources);
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
        assert_eq!(
            calls,
            pairs(&[("a", "--edition 2021 --emit stdout"), ("b", "--edition 2024 --emit stdout"), ("c", "--emit stdout"), ("d", "--emit stdout")])
        );
    }

    #[tokio::test]
    async fn a_configuration_below_the_project_is_named_and_what_the_project_already_says_is_not_said_twice() {
        let tree = [
            ("rustfmt.toml", ""),
            ("a.rs", "a"),
            ("sub/.rustfmt.toml", ""),
            ("sub/Cargo.toml", "[package]\nname = \"s\"\nedition = \"2021\"\n"),
            ("sub/src/deep/b.rs", "b"),
        ];
        // rustfmt finds the project's own configuration from where it runs; only the nested one needs naming.
        assert_eq!(
            flags(&tree, &["a.rs", "sub/src/deep/b.rs"]).await,
            pairs(&[("a", "--emit stdout"), ("b", "--edition 2021 --config-path sub --emit stdout")])
        );
        let (_dir, spawn, mut req) = project(&tree, &["sub/src/deep/b.rs"]);
        req.args = ["--edition=2018", "--config-path", "rustfmt.toml"].map(String::from).to_vec();
        assert_eq!(Rustfmt.check(&req).await.files_checked, Some(1));
        assert_eq!(spawn.0.lock().unwrap()[0].0.join(" "), "--edition=2018 --config-path rustfmt.toml --emit stdout");
        // An edition the project gives is not looked for: a manifest tidy cannot read does not stand in the way.
        let (_dir, _spawn, mut req) = project(&[("bad/Cargo.toml", "[package\n"), ("bad/a.rs", "a")], &["bad/a.rs"]);
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

    const PACKAGE: &str = "[package]\nname = \"p\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[workspace]\n";

    /// The files `cargo fmt --all -- --check` formats from the manifest in `dir`, as it names them.
    async fn cargo_fmt_formats(dir: &Path) -> HashSet<PathBuf> {
        let manifest = dir.join("Cargo.toml").to_string_lossy().into_owned();
        let args = ["fmt", "--all", "--manifest-path", &manifest, "--", "--check", "-l", "-v"].map(str::to_owned);
        let r = SystemSpawn(Processes::for_tests()).run("cargo", &args, dir, DEFAULT_ENGINE_TIMEOUT, None, None, None).await;
        assert!(r.stderr.trim().is_empty(), "cargo fmt did not complete: {}", r.stderr);
        r.stdout.lines().filter_map(|line| line.strip_prefix("Formatting ")).map(|path| std::fs::canonicalize(path).unwrap()).collect()
    }

    /// What a check does with `sources` in `tree`: the texts it formats and the files it leaves out.
    /// A file is left out exactly when `cargo fmt` run from `package` does not format it.
    async fn decided(tree: &[(&str, &str)], sources: &[&str], package: &str) -> (Vec<String>, Vec<String>) {
        let (dir, spawn, req) = project(tree, sources);
        let out = Rustfmt.check(&req).await;
        assert_eq!((out.error.as_deref(), out.unprocessed.as_slice()), (None, &[][..]));
        let why = "cargo fmt does not format the ignored files: a skip attribute leaves them out or no target reaches them";
        assert_eq!(out.note.as_deref(), (!out.ignored.is_empty()).then_some(why));
        let by_cargo = cargo_fmt_formats(&dir.path().join(package)).await;
        for source in sources {
            let formatted_by_cargo = by_cargo.contains(&std::fs::canonicalize(dir.path().join(source)).unwrap());
            assert_eq!(formatted_by_cargo, !out.ignored.iter().any(|f| f == source), "{source}");
        }
        let mut formatted: Vec<String> = spawn.0.lock().unwrap().iter().map(|c| c.2.clone()).collect();
        formatted.sort();
        let mut ignored = out.ignored;
        ignored.sort();
        (formatted, ignored)
    }

    #[tokio::test]
    async fn a_file_is_formatted_exactly_when_cargo_fmt_formats_it() {
        let lib = concat!(
            "fn body() {\n    #![rustfmt::skip]\n}\nmod child;\n",
            "#[rustfmt::skip]\n// why\npub mod table;\n#[doc = \"rustfmt::skip\"]\nmod visible;\n#[rustfmt::skip]\nmod group;\n",
            "#[cfg_attr(rustfmt, rustfmt::skip)]\nmod attr;\n#[rustfmt::skip]\n#[path = r\"elsewhere/raw.rs\"]\nmod raw;\n",
            "#[path = \"relocated\"]\nmod inline {\n    #[rustfmt::skip]\n    mod leaf;\n    mod kept;\n}\n",
            "#[rustfmt::skip]\nmod shared;\nmod quiet;\n#[rustfmt::skip]\nmod rustfmt_tables;\n",
        );
        let tree = [
            ("Cargo.toml", PACKAGE),
            ("src/lib.rs", lib),
            ("src/main.rs", "mod shared;\n"),
            ("src/child.rs", "// child\n"),
            ("src/table.rs", "// table\n"),
            ("src/visible.rs", "// visible\n"),
            ("src/group/mod.rs", "mod leaf;\n"),
            ("src/group/leaf.rs", "// group leaf\n"),
            ("src/attr.rs", "// attr\n"),
            ("src/elsewhere/raw.rs", "// raw\n"),
            ("src/relocated/leaf.rs", "// relocated leaf\n"),
            ("src/relocated/kept.rs", "// relocated kept\n"),
            ("src/shared.rs", "// shared\n"),
            ("src/quiet.rs", "#![rustfmt::skip]\nmod inner;\n"),
            ("src/quiet/inner.rs", "// quiet inner\n"),
            ("src/rustfmt_tables.rs", "// tables\n"),
            ("src/stray.rs", "// stray\n"),
            ("tests/fixtures/sample.rs", "// fixture\n"),
        ];
        let sources: Vec<&str> =
            tree.iter().map(|(path, _)| *path).filter(|path| path.ends_with(".rs") && !path.starts_with("src/lib") && !path.starts_with("src/main")).collect();
        let (formatted, ignored) = decided(&tree, &sources, ".").await;
        // A skip inside a function is not the file's; one on a `mod` line covers the file and all below it.
        // A file no target reaches is not formatted either.
        assert_eq!(formatted, ["// child\n", "// relocated kept\n", "// shared\n", "// visible\n"]);
        assert_eq!(
            ignored,
            [
                "src/attr.rs",
                "src/elsewhere/raw.rs",
                "src/group/leaf.rs",
                "src/group/mod.rs",
                "src/quiet.rs",
                "src/quiet/inner.rs",
                "src/relocated/leaf.rs",
                "src/rustfmt_tables.rs",
                "src/stray.rs",
                "src/table.rs",
                "tests/fixtures/sample.rs"
            ]
        );
    }

    #[tokio::test]
    async fn the_roots_are_the_targets_cargo_lists_and_a_path_from_another_member_counts() {
        let manifest = "[package]\nname = \"p\"\nversion = \"0.1.0\"\nedition = \"2021\"\nautobins = false\nbuild = \"make.rs\"\n\n[workspace]\n";
        let tree = [
            ("Cargo.toml", manifest),
            ("src/lib.rs", "#[rustfmt::skip]\nmod shared;\n"),
            ("src/main.rs", "mod shared;\n"),
            ("src/shared.rs", "// shared\n"),
            ("make.rs", "mod helper;\n#[rustfmt::skip]\nmod generated;\nfn main() {}\n"),
            ("helper.rs", "// helper\n"),
            ("generated.rs", "// generated\n"),
        ];
        // With `autobins = false` src/main.rs is no target: nothing it declares is formatted for it.
        let (formatted, ignored) = decided(&tree, &["src/main.rs", "src/shared.rs", "helper.rs", "generated.rs"], ".").await;
        assert_eq!(
            (formatted, ignored),
            (vec!["// helper\n".to_owned()], vec!["generated.rs".to_owned(), "src/main.rs".to_owned(), "src/shared.rs".to_owned()])
        );
        let member = |name: &str| format!("[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
        let (a, b) = (member("a"), member("b"));
        let tree = [
            ("Cargo.toml", "[workspace]\nmembers = [\"a\", \"b\"]\nresolver = \"2\"\n"),
            ("a/Cargo.toml", a.as_str()),
            ("a/src/lib.rs", "// a\n"),
            ("a/src/gen.rs", "// gen\n"),
            ("a/src/stray.rs", "// stray\n"),
            ("b/Cargo.toml", b.as_str()),
            ("a/src/borrowed.rs", "// borrowed\n"),
            ("b/Cargo.toml", b.as_str()),
            ("b/src/lib.rs", "#[rustfmt::skip]\n#[path = \"../../a/src/gen.rs\"]\nmod gen;\n#[path = \"../../a/src/borrowed.rs\"]\nmod borrowed;\n"),
        ];
        // Of package a, only what member b declares unskipped is formatted.
        let (formatted, ignored) = decided(&tree, &["a/src/gen.rs", "a/src/stray.rs", "a/src/borrowed.rs"], ".").await;
        assert_eq!((formatted, ignored), (vec!["// borrowed\n".to_owned()], vec!["a/src/gen.rs".to_owned(), "a/src/stray.rs".to_owned()]));
    }

    #[tokio::test]
    async fn a_package_cargo_cannot_load_has_its_files_formatted_alone() {
        let manifest = format!("{PACKAGE}\n[dependencies]\nmissing = {{ path = \"../missing\" }}\n");
        let tree = [("broken/Cargo.toml", manifest.as_str()), ("broken/src/lib.rs", "#[rustfmt::skip]\nmod table;\n"), ("broken/src/table.rs", "// table\n")];
        let (_dir, spawn, req) = project(&tree, &["broken/src/table.rs"]);
        let out = Rustfmt.check(&req).await;
        assert_eq!((out.files_checked, out.ignored.len()), (Some(1), 0));
        assert!(out.note.as_deref().is_some_and(|note| note.starts_with("cargo cannot load broken/Cargo.toml")), "{:?}", out.note);
        assert_eq!(spawn.0.lock().unwrap()[0].2, "// table\n");
    }

    fn member(name: &str, more: &str) -> String {
        format!("[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n{more}")
    }

    #[tokio::test]
    async fn a_file_is_decided_by_cargo_fmt_from_its_own_workspace_whatever_the_order() {
        let (a, b) = (member("a", "\n[dependencies]\nb = { path = \"../b\" }\n\n[workspace]\n"), member("b", "\n[workspace]\n"));
        // From a, cargo fmt formats b's gen.rs through the path; from b, the workspace that holds it, it does not.
        let tree = [
            ("a/Cargo.toml", a.as_str()),
            ("a/src/lib.rs", "#[path = \"../../b/src/gen.rs\"]\nmod gen;\n"),
            ("b/Cargo.toml", b.as_str()),
            ("b/src/lib.rs", "#[rustfmt::skip]\nmod gen;\n"),
            ("b/src/gen.rs", "// gen\n"),
        ];
        for sources in [["a/src/lib.rs", "b/src/gen.rs"], ["b/src/gen.rs", "a/src/lib.rs"]] {
            let (_dir, _spawn, req) = project(&tree, &sources);
            let out = Rustfmt.check(&req).await;
            assert_eq!((out.files_checked, out.ignored.clone(), out.unprocessed.len()), (Some(1), vec!["b/src/gen.rs".to_owned()], 0), "{sources:?}");
        }
    }

    #[tokio::test]
    async fn a_file_beside_the_members_of_a_virtual_workspace_is_in_no_package() {
        let m = member("m", "");
        let tree = [
            ("Cargo.toml", "[workspace]\nmembers = [\"m\"]\nresolver = \"2\"\n"),
            ("m/Cargo.toml", m.as_str()),
            ("m/src/lib.rs", "// m\n"),
            ("tools/loose.rs", "// loose\n"),
        ];
        let (_dir, spawn, req) = project(&tree, &["tools/loose.rs", "m/src/lib.rs"]);
        let out = Rustfmt.check(&req).await;
        assert_eq!((out.files_checked, out.ignored.len(), out.unprocessed.len(), out.note), (Some(2), 0, 0, None));
        assert!(spawn.0.lock().unwrap().iter().any(|c| c.2 == "// loose\n"));
    }

    #[tokio::test]
    async fn metadata_cut_off_at_the_capture_limit_leaves_the_files_unprocessed() {
        let tree = [("Cargo.toml", PACKAGE), ("src/lib.rs", "#[rustfmt::skip]\nmod table;\n"), ("src/table.rs", "// table\n")];
        let (_dir, spawn, req) = answered(&tree, &["src/table.rs"], |bin, r| if bin.contains("cargo") { ProcessResult { truncated: true, ..r } } else { r });
        let out = Rustfmt.check(&req).await;
        assert_eq!((out.files_checked, out.ignored.len(), out.note.clone()), (Some(0), 0, None));
        assert!(out.unprocessed.len() == 1 && out.unprocessed[0].1.contains("printed more than tidy captures"), "{:?}", out.unprocessed);
        assert!(spawn.0.lock().unwrap().is_empty(), "a file whose selection is not known is not formatted");
    }

    #[tokio::test]
    async fn a_walk_that_ends_in_no_exit_of_rustfmts_own_leaves_the_files_unprocessed() {
        let tree = [("Cargo.toml", PACKAGE), ("src/lib.rs", "mod child;\n"), ("src/child.rs", "// child\n")];
        // Killed by a signal: no code of rustfmt's, nothing said, nothing named.
        let killed = |bin: &str, r: ProcessResult| {
            if bin == "rustfmt" {
                ProcessResult { code: -1, stdout: String::new(), stderr: String::new(), error: String::new(), timed_out: false, ..r }
            } else {
                r
            }
        };
        let (_dir, _spawn, req) = answered(&tree, &["src/child.rs"], killed);
        let out = Rustfmt.check(&req).await;
        assert_eq!((out.files_checked, out.ignored.len()), (Some(0), 0));
        assert!(out.unprocessed.len() == 1 && out.unprocessed[0].1.contains("rustfmt did not walk"), "{:?}", out.unprocessed);
    }

    #[tokio::test]
    async fn a_manifest_that_cannot_be_used_leaves_its_files_unformatted_and_the_rest_checked() {
        let tree = [
            ("bad/Cargo.toml", "[package\n"),
            ("bad/a.rs", "a"),
            ("orphan/Cargo.toml", "[package]\nname = \"o\"\nedition.workspace = true\n"),
            ("orphan/b.rs", "b"),
            ("ok.rs", "c"),
        ];
        let (_dir, spawn, req) = project(&tree, &["bad/a.rs", "orphan/b.rs", "ok.rs"]);
        let out = Rustfmt.check(&req).await;
        assert_eq!((out.files_checked, out.error.clone()), (Some(1), None));
        let unprocessed: Vec<&str> = out.unprocessed.iter().map(|(f, _)| f.as_str()).collect();
        assert_eq!(unprocessed, ["bad/a.rs", "orphan/b.rs"]);
        assert!(out.unprocessed[0].1.contains("does not parse") && out.unprocessed[1].1.contains("no workspace manifest"), "{:?}", out.unprocessed);
        assert_eq!(spawn.0.lock().unwrap().len(), 1, "rustfmt is not run on a file whose edition is unknown");
    }
}
