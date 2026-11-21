//! Which of the requested files `cargo fmt --all` formats, asked of cargo and rustfmt themselves.
//! cargo fmt runs rustfmt on every target root `cargo metadata` lists for the workspace and for the
//! path dependencies it goes on to, and rustfmt walks the module tree from each root, leaving out
//! what a skip attribute or its configuration says. Here the roots are collected from the same
//! `cargo metadata` the way cargo fmt collects them, and rustfmt is run on each in check mode with
//! `-v`, which names every file it formats and writes none: no module rule is re-derived. A file
//! of a package cargo can load that rustfmt does not name is not formatted, whether a skip leaves
//! it out or no target reaches it; a file outside any such package is formatted alone.
#![allow(clippy::disallowed_methods, reason = "the file work runs as durability-lane jobs")]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::shared::*;
use crate::lane::on_lane;
use crate::tidy::process::map_limit;

/// What `cargo fmt` does with a requested file.
pub enum Verdict {
    /// It formats the file, or the file lies in no package cargo can load: tidy formats it.
    Format,
    /// It does not format the file: a skip leaves it out or no target reaches it.
    NotFormatted,
    /// rustfmt could not walk a tree the file may belong to, so whether it is formatted is not known.
    Unknown(String),
}

pub struct Selection {
    /// One for each requested file, in order.
    pub verdicts: Vec<Verdict>,
    pub notes: Vec<String>,
}

fn lane_lost() -> String {
    "rustfmt could not run: its lane did not read the module tree".to_owned()
}

/// A requested file that lies in a package: its own path and its package's manifest, both canonical.
struct Located {
    file: PathBuf,
    manifest: PathBuf,
}

/// Whether a manifest is a package's: a virtual workspace's is not. One tidy cannot read is left
/// to cargo, which says why.
fn declares_package(manifest: &Path) -> bool {
    std::fs::read_to_string(manifest).ok().and_then(|text| text.parse::<toml::Table>().ok()).is_none_or(|table| table.contains_key("package"))
}

/// The requested files that lie in a package, and the canonical `cwd` they are shown relative to.
fn locate(cwd: &Path, files: &[String]) -> (PathBuf, Vec<Option<Located>>) {
    let mut packages: HashMap<PathBuf, bool> = HashMap::new();
    let mut one = |file: &String| {
        let file = std::fs::canonicalize(cwd.join(file)).ok()?;
        let manifest = file
            .ancestors()
            .skip(1)
            .map(|dir| dir.join("Cargo.toml"))
            .find(|manifest| *packages.entry(manifest.clone()).or_insert_with(|| manifest.is_file() && declares_package(manifest)))?;
        Some(Located { file, manifest })
    };
    let located = files.iter().map(&mut one).collect();
    (std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_owned()), located)
}

/// The target roots cargo fmt formats from one manifest, and the manifests of the workspace it
/// runs from (not of the path dependencies it goes on to).
#[derive(Default)]
struct Workspace {
    manifests: HashSet<PathBuf>,
    /// Each root once, with the edition of the first target that names it, as cargo fmt keeps it.
    roots: Vec<(PathBuf, String)>,
}

struct Package {
    manifest: PathBuf,
    roots: Vec<(PathBuf, String)>,
    /// Path dependencies outside this metadata, by name: cargo fmt goes on to each once.
    path_deps: Vec<(String, PathBuf)>,
}

fn canonical(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

/// The packages of one `cargo metadata --no-deps` and the workspace manifest they share.
fn packages(json: &str) -> Result<(PathBuf, Vec<Package>), String> {
    let metadata: Value = serde_json::from_str(json).map_err(|e| format!("cargo metadata printed something other than its JSON: {e}"))?;
    let listed = metadata["packages"].as_array().map(Vec::as_slice).unwrap_or_default();
    let manifests: HashSet<PathBuf> = listed.iter().filter_map(|p| p["manifest_path"].as_str()).map(canonical).collect();
    let package = |p: &Value| {
        let roots = p["targets"].as_array().into_iter().flatten().filter_map(|t| Some((canonical(t["src_path"].as_str()?), t["edition"].as_str()?.to_owned())));
        let path_deps = p["dependencies"].as_array().into_iter().flatten().filter_map(|d| {
            let manifest = std::fs::canonicalize(Path::new(d["path"].as_str()?).join("Cargo.toml")).ok()?;
            (!manifests.contains(&manifest)).then(|| (d["name"].as_str().unwrap_or_default().to_owned(), manifest))
        });
        Package { manifest: canonical(p["manifest_path"].as_str().unwrap_or_default()), roots: roots.collect(), path_deps: path_deps.collect() }
    };
    let root = canonical(&format!("{}/Cargo.toml", metadata["workspace_root"].as_str().unwrap_or_default()));
    Ok((root, listed.iter().map(package).collect()))
}

/// The cargo beside the rustfmt that runs, so both come from one toolchain.
fn cargo(bin: &str) -> String {
    match Path::new(bin).parent().filter(|dir| !dir.as_os_str().is_empty()) {
        Some(dir) => dir.join(format!("cargo{}", std::env::consts::EXE_SUFFIX)).to_string_lossy().into_owned(),
        None => "cargo".to_owned(),
    }
}

/// What cargo says about a manifest.
enum Load {
    Workspace(Workspace),
    /// cargo cannot load it: cargo fmt formats nothing from it.
    CannotLoad(String),
    /// What cargo said could not be read whole, so what cargo fmt formats from it is not known.
    Unknown(String),
}

/// What `cargo fmt --all --manifest-path <manifest>` formats from; `Err` is why nothing could be asked.
async fn load(req: &RunRequest, manifest: &Path) -> Result<Load, String> {
    let mut workspace = Workspace::default();
    let (mut visited, mut seen) = (HashSet::new(), HashSet::new());
    let mut pending = vec![manifest.to_owned()];
    let mut own = true;
    while let Some(manifest) = pending.pop() {
        let args: Vec<String> = ["metadata", "--no-deps", "--format-version", "1", "--manifest-path"]
            .into_iter()
            .map(str::to_owned)
            .chain([manifest.to_string_lossy().into_owned()])
            .collect();
        let r = req.spawn.run(&cargo(&req.bin), &args, &req.cwd, req.timeout, req.cancel.as_ref(), None, None).await;
        if let Some(why) = stopped(req, "cargo", &r) {
            return Err(why);
        }
        if r.truncated {
            return Ok(Load::Unknown(format!("cargo metadata for {} printed more than tidy captures", manifest.display())));
        }
        if r.code != 0 {
            return Ok(Load::CannotLoad(format!("cargo metadata {}", said(&r))));
        }
        let stdout = r.stdout;
        let (root, packages) = match on_lane(req.lane, move || packages(&stdout)).await.map_err(|_| lane_lost())? {
            Ok(read) => read,
            Err(why) => return Ok(Load::Unknown(why)),
        };
        if own {
            workspace.manifests.insert(root);
            workspace.manifests.extend(packages.iter().map(|package| package.manifest.clone()));
            own = false;
        }
        for package in packages {
            workspace.roots.extend(package.roots.into_iter().filter(|(root, _)| seen.insert(root.clone())));
            pending.extend(package.path_deps.into_iter().filter(|(name, _)| visited.insert(name.clone())).map(|(_, manifest)| manifest));
        }
    }
    Ok(Load::Workspace(workspace))
}

/// The files rustfmt formats from a set of roots, and why one of its walks did not complete.
#[derive(Default)]
struct Tree {
    files: HashSet<PathBuf>,
    failure: Option<String>,
}

/// rustfmt's own warnings (a configuration option it does not take) are not a failed walk.
fn only_warnings(stderr: &str) -> bool {
    stderr.lines().map(str::trim).all(|line| line.is_empty() || line.get(..7).is_some_and(|word| word.eq_ignore_ascii_case("warning")))
}

async fn walk(req: &RunRequest, root: PathBuf, edition: String) -> Result<Tree, String> {
    let args: Vec<String> = ["--check", "-l", "-v", "--edition"].into_iter().map(str::to_owned).chain([edition, root.to_string_lossy().into_owned()]).collect();
    let r = req.spawn.run(&req.bin, &args, &req.cwd, req.timeout, req.cancel.as_ref(), None, None).await;
    if let Some(why) = stopped(req, "rustfmt", &r) {
        return Err(why);
    }
    let named: Vec<PathBuf> = r.stdout.lines().filter_map(|line| line.strip_prefix("Formatting ")).map(PathBuf::from).collect();
    let files =
        on_lane(req.lane, move || named.into_iter().map(|path| std::fs::canonicalize(&path).unwrap_or(path)).collect()).await.map_err(|_| lane_lost())?;
    // `--check` exits 1 for a file it would change as well as for a walk it could not finish; any
    // other code (a crash, a signal) is no exit of rustfmt's own.
    let complete = !r.truncated && (r.code == 0 || (r.code == 1 && only_warnings(&r.stderr)));
    Ok(Tree { files, failure: (!complete).then(|| format!("rustfmt did not walk the modules of {}: {}", root.display(), said(&r))) })
}

/// The trees of `count` workspaces from the roots in `jobs`, each tagged with its workspace.
async fn walk_all(req: &RunRequest, jobs: Vec<(usize, PathBuf, String)>, count: usize) -> Result<Vec<Tree>, String> {
    let at_once = std::thread::available_parallelism().map_or(1, usize::from);
    let walks = map_limit(jobs, at_once, |(index, root, edition)| async move { (index, walk(req, root, edition).await) }).await;
    let mut trees: Vec<Tree> = (0..count).map(|_| Tree::default()).collect();
    for (index, walk) in walks {
        let walk = walk?;
        let tree = &mut trees[index];
        tree.files.extend(walk.files);
        tree.failure = tree.failure.take().or(walk.failure);
    }
    Ok(trees)
}

/// What `cargo fmt --all`, run from each file's package, does with each of `req.files`. `Err` is
/// why cargo or rustfmt could not be asked at all.
pub async fn select(req: &RunRequest) -> Result<Selection, String> {
    let (cwd, files) = (req.cwd.clone(), req.files.clone());
    let (cwd, located) = on_lane(req.lane, move || locate(&cwd, &files)).await.map_err(|_| lane_lost())?;
    let shown =
        |path: &Path| path.strip_prefix(&cwd).map_or_else(|_| to_rel(&req.cwd, &path.to_string_lossy()), |rel| rel.to_string_lossy().replace('\\', "/"));
    let mut notes = Vec::new();
    let (workspaces, owners) = load_owners(req, &located, &shown, &mut notes).await?;
    let used: HashSet<usize> = owners.iter().flatten().copied().collect();
    let jobs = workspaces
        .iter()
        .enumerate()
        .filter(|(index, _)| used.contains(index))
        .filter_map(|(index, w)| match w {
            Load::Workspace(w) => Some((index, w)),
            _ => None,
        })
        .flat_map(|(index, w)| w.roots.iter().map(move |(root, edition)| (index, root.clone(), edition.clone())))
        .collect();
    let trees = walk_all(req, jobs, workspaces.len()).await?;
    let verdict = |found: &Located, index: usize| match &workspaces[index] {
        Load::CannotLoad(_) => Verdict::Format,
        Load::Unknown(why) => Verdict::Unknown(why.clone()),
        Load::Workspace(_) if trees[index].files.contains(&found.file) => Verdict::Format,
        Load::Workspace(_) => trees[index].failure.clone().map_or(Verdict::NotFormatted, Verdict::Unknown),
    };
    let verdicts: Vec<Verdict> = located
        .iter()
        .zip(&owners)
        .map(|(found, owner)| match (found, owner) {
            (Some(found), Some(index)) => verdict(found, *index),
            _ => Verdict::Format,
        })
        .collect();
    if verdicts.iter().any(|verdict| matches!(verdict, Verdict::NotFormatted)) {
        notes.push("cargo fmt does not format the ignored files: a skip attribute leaves them out or no target reaches them".to_owned());
    }
    Ok(Selection { verdicts, notes })
}

/// One workspace load per manifest cargo fmt runs from, and for each located file the index of
/// the load that decides it; a file's verdict comes only from its own.
async fn load_owners(
    req: &RunRequest,
    located: &[Option<Located>],
    shown: &impl Fn(&Path) -> String,
    notes: &mut Vec<String>,
) -> Result<(Vec<Load>, Vec<Option<usize>>), String> {
    let mut workspaces: Vec<Load> = Vec::new();
    let mut by_manifest: HashMap<PathBuf, usize> = HashMap::new();
    let mut owners = Vec::with_capacity(located.len());
    for found in located {
        let Some(found) = found else {
            owners.push(None);
            continue;
        };
        let known = by_manifest
            .get(&found.manifest)
            .copied()
            .or_else(|| workspaces.iter().position(|w| matches!(w, Load::Workspace(w) if w.manifests.contains(&found.manifest))));
        let index = match known {
            Some(index) => index,
            None => {
                let loaded = load(req, &found.manifest).await?;
                if let Load::CannotLoad(why) = &loaded {
                    notes.push(format!("cargo cannot load {}, so its files are formatted alone: {why}", shown(&found.manifest)));
                }
                workspaces.push(loaded);
                workspaces.len() - 1
            }
        };
        by_manifest.insert(found.manifest.clone(), index);
        owners.push(Some(index));
    }
    Ok((workspaces, owners))
}
