//! `git ls-files` without a process: the file list the workspace zip asks of the SCM engine
//! (`mixdog_workspace::zip::TrackedFiles`). Paths are relative to the folder asked for, the
//! tracked entries of the index followed by the untracked files no ignore rule hides; a nested
//! repository is listed as `name/`.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashSet;
use std::path::Path;

use async_trait::async_trait;
use gix::bstr::BString;
use gix::bstr::ByteSlice;
use gix::dir::walk::EmissionMode;
use gix::dir::entry::Kind;
use gix::dir::entry::Status;
use mixdog_rt::MaintenanceIo;
use mixdog_workspace::zip::TrackedFiles;
use tokio_util::sync::CancellationToken;

use crate::repo::on_lane;

pub struct GixTrackedFiles {
    lane: MaintenanceIo,
}

impl GixTrackedFiles {
    pub fn new(lane: MaintenanceIo) -> Self {
        Self { lane }
    }
}

struct Opened {
    repo: gix::Repository,
    /// `/`-terminated prefix of the asked folder inside the work tree; empty at its root.
    prefix: String,
}

fn open(root: &Path) -> Option<Opened> {
    let repo = gix::discover(root).ok()?;
    let workdir = std::fs::canonicalize(repo.workdir()?).ok()?;
    let asked = std::fs::canonicalize(root).ok()?;
    let relative = asked.strip_prefix(&workdir).ok()?;
    let mut prefix = relative.to_string_lossy().replace('\\', "/");
    if !prefix.is_empty() {
        prefix.push('/');
    }
    Some(Opened { repo, prefix })
}

fn tracked_paths(opened: &Opened) -> Option<Vec<String>> {
    let index = opened.repo.index_or_empty().ok()?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in index.entries() {
        let path = entry.path(&index).to_str_lossy().into_owned();
        if let Some(rest) = path.strip_prefix(opened.prefix.as_str()) {
            // A conflicted path has one entry per stage; it is listed once.
            if seen.insert(path.clone()) {
                out.push(rest.to_owned());
            }
        }
    }
    Some(out)
}

fn walk(opened: &Opened, ignored: bool) -> Option<Vec<gix::dirwalk::iter::Item>> {
    let index = opened.repo.index_or_empty().ok()?;
    let options = opened
        .repo
        .dirwalk_options()
        .ok()?
        .emit_untracked(EmissionMode::Matching)
        .emit_ignored(ignored.then_some(EmissionMode::Matching))
        .emit_tracked(false)
        .recurse_repositories(false);
    let patterns: Vec<BString> = if opened.prefix.is_empty() {
        Vec::new()
    } else {
        vec![BString::from(opened.prefix.trim_end_matches('/'))]
    };
    let iter = opened
        .repo
        .dirwalk_iter(index, patterns, Default::default(), options)
        .ok()?;
    iter.collect::<Result<Vec<_>, _>>().ok()
}

fn count_files(dir: &Path, tracked: &HashSet<String>, workdir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            mixdog_rt::job_progress();
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => count_files(&path, tracked, workdir),
                Ok(_) => {
                    let rel = path
                        .strip_prefix(workdir)
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_default();
                    u64::from(!tracked.contains(&rel))
                }
                Err(_) => 0,
            }
        })
        .sum()
}

fn list_files(root: &Path) -> Option<Vec<String>> {
    let opened = open(root)?;
    let mut files = tracked_paths(&opened)?;
    for item in walk(&opened, false)? {
        if !matches!(item.entry.status, Status::Untracked) {
            continue;
        }
        let rel = item.entry.rela_path.to_str_lossy().into_owned();
        let Some(rest) = rel.strip_prefix(opened.prefix.as_str()) else {
            continue;
        };
        match item.entry.disk_kind {
            Some(Kind::Repository) => files.push(format!("{}/", rest.trim_end_matches('/'))),
            Some(Kind::Directory) => {}
            _ => files.push(rest.to_owned()),
        }
    }
    Some(files)
}

fn count_ignored(root: &Path) -> Option<u64> {
    let opened = open(root)?;
    let workdir = std::fs::canonicalize(opened.repo.workdir()?).ok()?;
    let tracked: HashSet<String> = {
        let index = opened.repo.index_or_empty().ok()?;
        index.entries().iter().map(|e| e.path(&index).to_str_lossy().into_owned()).collect()
    };
    let mut total = 0;
    for item in walk(&opened, true)? {
        if !matches!(item.entry.status, Status::Ignored(_)) {
            continue;
        }
        match item.entry.disk_kind {
            // An ignored folder is ignored whole: its files are counted from disk.
            Some(Kind::Directory | Kind::Repository) => {
                let dir = workdir.join(item.entry.rela_path.to_str_lossy().as_ref());
                total += count_files(&dir, &tracked, &workdir);
            }
            _ => total += 1,
        }
    }
    Some(total)
}

#[async_trait]
impl TrackedFiles for GixTrackedFiles {
    async fn files(&self, root: &Path, cancel: &CancellationToken) -> Option<Vec<String>> {
        let root = root.to_path_buf();
        on_lane(self.lane, cancel, move || list_files(&root)).await.ok().flatten()
    }

    async fn ignored(&self, root: &Path, cancel: &CancellationToken) -> Option<u64> {
        let root = root.to_path_buf();
        on_lane(self.lane, cancel, move || count_ignored(&root)).await.ok().flatten()
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::*;

    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn listed(cwd: &Path, args: &[&str]) -> Vec<String> {
        let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        let mut names: Vec<String> = out
            .stdout
            .split(|b| *b == 0)
            .filter(|r| !r.is_empty())
            .map(|r| String::from_utf8_lossy(r).into_owned())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn the_list_and_the_ignored_count_equal_git_ls_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::create_dir_all(root.join("build/out")).unwrap();
        std::fs::create_dir_all(root.join("nested/.git")).unwrap();
        std::fs::write(root.join("nested/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(root.join("nested/f.txt"), "x").unwrap();
        std::fs::write(root.join(".gitignore"), "build/\n*.log\n").unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        std::fs::write(root.join("src/b.rs"), "b").unwrap();
        std::fs::write(root.join("src/deep/c.rs"), "c").unwrap();
        std::fs::write(root.join("build/out/o.bin"), "o").unwrap();
        std::fs::write(root.join("build/p.bin"), "p").unwrap();
        std::fs::write(root.join("debug.log"), "l").unwrap();
        std::fs::write(root.join("new.txt"), "n").unwrap();
        git(&root, &["add", "a.txt", "src/b.rs", ".gitignore"]);
        let tracked = GixTrackedFiles::new(mixdog_rt::testing::tokens().maintenance_io);
        let cancel = CancellationToken::new();
        for folder in [root.clone(), root.join("src")] {
            let mut got = tracked.files(&folder, &cancel).await.unwrap();
            got.sort();
            assert_eq!(got, listed(&folder, &["ls-files", "-z", "-c", "-o", "--exclude-standard"]), "{folder:?}");
        }
        assert_eq!(
            tracked.ignored(&root, &cancel).await.unwrap(),
            listed(&root, &["ls-files", "-z", "-o", "-i", "--exclude-standard"]).len() as u64
        );
        let outside = tempfile::tempdir().unwrap();
        assert!(tracked.files(outside.path(), &cancel).await.is_none());
    }
}
