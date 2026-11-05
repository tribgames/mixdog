#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup; git and node are the references")]
//! DS-WS-7 (folder zip): the file list and ignored count of 20 generated folders equal what
//! today's Node `scanFolder` (zip-folder.ts) keeps, run live. The test needs `node` and a
//! desktop tree with `node_modules` (`MIXDOG_NODE_TREE`, default `C:\Project\mixdog`); it
//! skips, loudly, when either is missing. Directory links are junctions on Windows (file
//! symlinks need privileges this machine's test account lacks) and symlinks elsewhere.

use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use mixdog_workspace::lanes::Lanes;
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::zip::TrackedFiles;
use mixdog_workspace::zip::scan_folder;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

struct GitCli;

fn git_lines(root: &Path, args: &[&str]) -> Option<Vec<String>> {
    let out = Command::new("git").args(args).current_dir(root).output().ok()?;
    out.status.success().then(|| out.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()).map(|r| String::from_utf8_lossy(r).into_owned()).collect())
}

#[async_trait::async_trait]
impl TrackedFiles for GitCli {
    async fn files(&self, root: &Path, _: &CancellationToken) -> Option<Vec<String>> {
        git_lines(root, &["ls-files", "-z", "-c", "-o", "--exclude-standard"])
    }
    async fn ignored(&self, root: &Path, _: &CancellationToken) -> Option<u64> {
        git_lines(root, &["ls-files", "-z", "-o", "-i", "--exclude-standard"]).map(|l| l.len() as u64)
    }
}

fn put(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(status.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&status.stderr));
}

fn init_repo(root: &Path) {
    std::fs::create_dir_all(root).unwrap();
    git(root, &["init", "-q"]);
}

fn commit_all(root: &Path) {
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "x"]);
}

/// A directory link: a junction on Windows, a symlink elsewhere. `false` when it cannot be made.
fn link_dir(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().is_ok_and(|o| o.status.success())
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

fn repos(base: &Path) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    let mut add = |name: &str, root: PathBuf| out.push((name.to_owned(), root));

    // 1 plain repo: tracked, untracked, ignored files and folders.
    let r = base.join("r01");
    init_repo(&r);
    put(&r, ".gitignore", "build/\n*.log\n");
    put(&r, "src/a.ts", "a");
    put(&r, "src/b.ts", "b");
    put(&r, "README.md", "r");
    commit_all(&r);
    put(&r, "src/new.ts", "n");
    put(&r, "build/out.js", "o");
    put(&r, "debug.log", "l");
    add("plain git repo", r);

    // 2 nested repository: judged by its own rules.
    let r = base.join("r02");
    init_repo(&r);
    put(&r, ".gitignore", "*.tmp\n");
    put(&r, "top.txt", "t");
    commit_all(&r);
    let inner = r.join("vendor/inner");
    init_repo(&inner);
    put(&inner, ".gitignore", "secret/\n");
    put(&inner, "lib.rs", "l");
    put(&inner, "secret/key", "k");
    put(&inner, "x.tmp", "t");
    add("nested repository", r);

    // 3 no git: generated folders are left out.
    let r = base.join("r03");
    for rel in ["src/a.js", "node_modules/x/i.js", "dist/o.js", "build/b.js", "target/t", ".cache/c", "venv/v", "__pycache__/p.pyc", "README"] {
        put(&r, rel, "x");
    }
    add("no git, generated folders", r);

    // 4 no git, the folder is itself a generated name: zipped whole.
    let r = base.join("r04").join("dist");
    put(&r, "bundle.js", "b");
    put(&r, "node_modules/m.js", "m");
    add("generated name asked for", r);

    // 5 an ignored folder asked for: only tracked files stay.
    let r = base.join("r05");
    init_repo(&r);
    put(&r, ".gitignore", "out/\n");
    put(&r, "keep.txt", "k");
    commit_all(&r);
    put(&r, "out/untracked.txt", "u");
    add("ignored folder asked for", r.join("out"));

    // 6 a subfolder of a repo.
    let r = base.join("r06");
    init_repo(&r);
    put(&r, ".gitignore", "*.log\n");
    put(&r, "pkg/a.rs", "a");
    put(&r, "pkg/deep/b.rs", "b");
    put(&r, "other/c.rs", "c");
    commit_all(&r);
    put(&r, "pkg/x.log", "l");
    put(&r, "pkg/u.rs", "u");
    add("subfolder of a repo", r.join("pkg"));

    // 7 a directory link inside the folder to a folder inside it.
    let r = base.join("r07");
    put(&r, "real/a.txt", "a");
    put(&r, "real/sub/b.txt", "b");
    if link_dir(&r.join("real"), &r.join("alias")) {
        add("link to a folder inside", r);
    }

    // 8 a directory link out of the folder: left out.
    let r = base.join("r08");
    put(&r, "own.txt", "o");
    let outside = base.join("r08-outside");
    put(&outside, "secret.txt", "s");
    if link_dir(&outside, &r.join("leak")) {
        add("link out of the folder", r);
    }

    // 9 a link back to an ancestor: not followed.
    let r = base.join("r09");
    put(&r, "a/f.txt", "f");
    if link_dir(&r, &r.join("a").join("up")) {
        add("link to an ancestor", r);
    }

    // 10 a repo with a directory link tracked as an entry.
    let r = base.join("r10");
    init_repo(&r);
    put(&r, "real/x.txt", "x");
    commit_all(&r);
    if link_dir(&r.join("real"), &r.join("alias")) {
        add("repo with a link", r);
    }

    // 11 only empty folders.
    let r = base.join("r11");
    std::fs::create_dir_all(r.join("a/b/c")).unwrap();
    std::fs::create_dir_all(r.join("d")).unwrap();
    add("empty folders", r);

    // 12 unicode names.
    let r = base.join("r12");
    for rel in ["한글/파일.txt", "é/ü.txt", "日本語.md", "emoji-😀.txt"] {
        put(&r, rel, "x");
    }
    add("unicode names", r);

    // 13 deep nesting.
    let r = base.join("r13");
    put(&r, "a/b/c/d/e/f/g/h/i.txt", "x");
    put(&r, "a/b/c/z.txt", "z");
    add("deep nesting", r);

    // 14 spaces and awkward names.
    let r = base.join("r14");
    for rel in ["with space/a b.txt", "hash#/c#d.txt", "dot.dir/.hidden", "a.b.c.txt", ".dotfile"] {
        put(&r, rel, "x");
    }
    add("awkward names", r);

    // 15 nested .gitignore files.
    let r = base.join("r15");
    init_repo(&r);
    put(&r, "a/.gitignore", "*.gen\n");
    put(&r, "a/keep.txt", "k");
    put(&r, "a/b/.gitignore", "!keep.gen\n");
    commit_all(&r);
    put(&r, "a/x.gen", "g");
    put(&r, "a/b/keep.gen", "g");
    put(&r, "a/b/y.gen", "g");
    add("nested gitignore", r);

    // 16 negated patterns.
    let r = base.join("r16");
    init_repo(&r);
    put(&r, ".gitignore", "*.dat\n!important.dat\ncache/\n");
    put(&r, "keep.txt", "k");
    commit_all(&r);
    put(&r, "important.dat", "i");
    put(&r, "other.dat", "o");
    put(&r, "cache/c", "c");
    add("negated patterns", r);

    // 17 two levels of nested repositories.
    let r = base.join("r17");
    init_repo(&r);
    put(&r, "root.txt", "r");
    commit_all(&r);
    let mid = r.join("mid");
    init_repo(&mid);
    put(&mid, "mid.txt", "m");
    let leaf = mid.join("leaf");
    init_repo(&leaf);
    put(&leaf, ".gitignore", "x\n");
    put(&leaf, "leaf.txt", "l");
    put(&leaf, "x", "ignored");
    add("two nested repositories", r);

    // 18 no git, python-ish trees.
    let r = base.join("r18");
    for rel in ["app/main.py", "app/__pycache__/m.pyc", ".venv/bin/python", "venv/lib/x", "docs/index.md", ".next/cache/z"] {
        put(&r, rel, "x");
    }
    add("no git, python-like", r);

    // 19 a repo holding only ignored and untracked files.
    let r = base.join("r19");
    init_repo(&r);
    put(&r, ".gitignore", "ign/\n");
    put(&r, "ign/a", "a");
    put(&r, "free.txt", "f");
    add("only untracked and ignored", r);

    // 20 a repo inside a plain parent folder.
    let parent = base.join("r20");
    put(&parent, "plain.txt", "p");
    put(&parent, "node_modules/n.js", "n");
    let inner = parent.join("project");
    init_repo(&inner);
    put(&inner, ".gitignore", "tmp/\n");
    put(&inner, "p.txt", "p");
    put(&inner, "tmp/t", "t");
    add("repo inside a plain folder", parent);
    out
}

fn node_tree() -> Option<PathBuf> {
    let tree = PathBuf::from(std::env::var("MIXDOG_NODE_TREE").unwrap_or_else(|_| r"C:\Project\mixdog".into()));
    (tree.join("node_modules").is_dir() && Command::new("node").arg("--version").output().is_ok()).then_some(tree)
}

#[tokio::test(flavor = "multi_thread")]
async fn zip_file_lists_equal_node_scan_folder_on_20_folders() {
    let Some(tree) = node_tree() else {
        eprintln!("SKIPPED: node or the desktop tree (MIXDOG_NODE_TREE) is missing");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let base = canonical(dir.path()).unwrap();
    let cases = repos(&base);
    assert!(cases.len() >= 16, "only {} folders could be built", cases.len());
    let folders: Vec<String> = cases.iter().map(|(_, p)| p.to_string_lossy().into_owned()).collect();

    let recorder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../benchmarks/rust-core/recorders/zip-list-node.mjs");
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let output = Command::new("node")
        .current_dir(&repo_root)
        .args(["--experimental-transform-types", "--import", "./benchmarks/rust-core/recorders/lib/ts-register.mjs"])
        .arg(&recorder)
        .arg("--tree")
        .arg(&tree)
        .env("ZIP_FOLDERS", serde_json::to_string(&folders).unwrap())
        .output()
        .unwrap();
    assert!(output.status.success(), "node: {}", String::from_utf8_lossy(&output.stderr));
    let node: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();

    let tokens = mixdog_rt::testing::tokens();
    let lanes = Lanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io, cpu_bulk: tokens.cpu_bulk };
    let cancel = CancellationToken::new();
    let mut failures = Vec::new();
    for ((name, root), expected) in cases.iter().zip(&node) {
        let real = canonical(root).unwrap();
        let scan = scan_folder(&GitCli, lanes, &cancel, &real, 1 << 40, 1_000_000, None).await.unwrap();
        let got: Vec<String> = scan.files.iter().map(|f| f.rel.clone()).collect();
        let want: Vec<String> = expected["files"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
        if got != want || scan.ignored != expected["ignored"].as_u64().unwrap() {
            failures.push(format!("{name}: node {want:?} ignored {}, rust {got:?} ignored {}", expected["ignored"], scan.ignored));
        }
    }
    assert!(failures.is_empty(), "{} of {} folders differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
    eprintln!("compared {} folders against node {}", cases.len(), String::from_utf8_lossy(&Command::new("node").arg("--version").output().unwrap().stdout).trim());
}
