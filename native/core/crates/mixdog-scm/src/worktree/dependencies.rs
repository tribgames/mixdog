//! Automatic dependency preparation for a new managed worktree (Node `dependencies.mjs`), for
//! every stack the committed files reveal. Nothing is shared with the main checkout and a
//! linked artefact is never installed through. The plan is what the session's first turn runs;
//! this module only names the commands and the notes for what it leaves alone.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use std::sync::Arc;

use mixdog_core_api::domain::command::PathIndex;
use mixdog_core_api::domain::command::spawn_form;
use mixdog_core_api::domain::command::which;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::locale_compare;
use tokio_util::sync::CancellationToken;

use crate::engine::Scm;
use crate::error::ScmFailure;
use crate::exec::ExecSpec;
use crate::git::RunOptions;
use crate::repo::on_lane;

struct Stack {
    name: &'static str,
    names: &'static [&'static str],
    globs: &'static [&'static str],
    artefact: &'static str,
    /// The artefact's whole contents come back from the install, so an automatic worktree
    /// removal may drop it. `node_modules` only, by Node's deliberate choice.
    reinstallable: bool,
}

static JS_LOCKFILES: [(&str, &str); 5] = [
    ("package-lock.json", "npm"),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
];

const STACKS: [Stack; 7] = [
    Stack {
        name: "js",
        names: &["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"],
        globs: &[],
        artefact: "node_modules",
        reinstallable: true,
    },
    Stack {
        name: "python",
        names: &["uv.lock", "poetry.lock", "Pipfile.lock"],
        globs: &["requirements*.txt"],
        artefact: ".venv",
        reinstallable: false,
    },
    Stack { name: "ruby", names: &["Gemfile.lock"], globs: &[], artefact: ".bundle", reinstallable: false },
    Stack { name: "php", names: &["composer.lock"], globs: &[], artefact: "vendor", reinstallable: false },
    Stack { name: "dotnet", names: &["packages.lock.json"], globs: &["*.csproj"], artefact: "obj", reinstallable: false },
    Stack { name: "elixir", names: &["mix.lock"], globs: &[], artefact: "deps", reinstallable: false },
    Stack { name: "dart", names: &["pubspec.lock"], globs: &[], artefact: ".dart_tool", reinstallable: false },
];

/// Every Python install builds the worktree's own `.venv`, never an inherited environment.
const PYTHON_ENV: [(&str, Option<&str>); 6] = [
    ("VIRTUAL_ENV", None),
    ("CONDA_PREFIX", None),
    ("UV_PROJECT_ENVIRONMENT", None),
    ("POETRY_VIRTUALENVS_CREATE", Some("true")),
    ("POETRY_VIRTUALENVS_IN_PROJECT", Some("true")),
    ("PIPENV_VENV_IN_PROJECT", Some("1")),
];

const VERSION_TIMEOUT: Duration = Duration::from_secs(30);

fn escape_reg_exp(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if ".+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A glob path segment (`*` within the segment) as a regular expression source.
fn segment_pattern(glob: &str) -> String {
    escape_reg_exp(glob).replace('*', "[^/]*")
}

fn matches_segment(glob: &str, name: &str) -> bool {
    JsRegex::new_static(&format!("^{}$", segment_pattern(glob)), "i").is_match(name)
}

fn stack_reads(stack: &Stack, name: &str) -> bool {
    stack.names.contains(&name) || stack.globs.iter().any(|glob| matches_segment(glob, name))
}

fn relevant_name(name: &str) -> bool {
    STACKS.iter().any(|stack| stack_reads(stack, name))
}

fn folder_path(root: &Path, dir: &str) -> PathBuf {
    if dir.is_empty() {
        return root.to_path_buf();
    }
    dir.split('/').fold(root.to_path_buf(), |path, part| path.join(part))
}

fn folder_label(dir: &str) -> &str {
    if dir.is_empty() { "project root" } else { dir }
}

fn artefact_rel(dir: &str, artefact: &str) -> String {
    if dir.is_empty() { artefact.to_owned() } else { format!("{dir}/{artefact}") }
}

#[derive(Clone, Copy)]
struct Meta {
    symlink: bool,
    dir: bool,
}

async fn lstat(scm: &Scm, cancel: &CancellationToken, path: PathBuf) -> Result<Option<Meta>, ScmFailure> {
    on_lane(scm.lane, cancel, move || match std::fs::symlink_metadata(&path) {
        Ok(info) => Ok(Some(Meta { symlink: info.file_type().is_symlink(), dir: info.is_dir() })),
        Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => Ok(None),
        Err(error) => Err(ScmFailure::from(error)),
    })
    .await?
}

async fn read_or_none(scm: &Scm, cancel: &CancellationToken, path: PathBuf) -> Result<Option<Vec<u8>>, ScmFailure> {
    on_lane(scm.lane, cancel, move || std::fs::read(&path).ok()).await
}

/// The `packages:` list of a pnpm-workspace.yaml (block or flow style).
pub fn pnpm_workspace_patterns(text: &str) -> Vec<String> {
    let top = JsRegex::new_static(r"^packages\s*:\s*(.*)$", "");
    let flow_form = JsRegex::new_static(r"^\[(.*)\]$", "");
    let item_form = JsRegex::new_static(r"^\s+-\s*(.+)$", "");
    let comment = JsRegex::new_static(r"\s+#.*$", "");
    let indented = JsRegex::new_static(r"^\s", "");
    let quoted = JsRegex::new_static(r#"^(['"])(.*)\1$"#, "");
    let mut patterns: Vec<String> = Vec::new();
    let mut in_packages = false;
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = match comment.find(raw) {
            Some(found) => &raw[..found.start],
            None => raw,
        };
        if js_trim(line).is_empty() {
            continue;
        }
        if let Some(found) = top.captures(line) {
            let rest = js_trim(found.get(1).unwrap_or(""));
            match flow_form.captures(rest) {
                Some(flow) => {
                    patterns.extend(flow.get(1).unwrap_or("").split(',').map(str::to_owned));
                    in_packages = false;
                }
                None => in_packages = true,
            }
            continue;
        }
        if !in_packages {
            continue;
        }
        if let Some(item) = item_form.captures(line) {
            patterns.push(item.get(1).unwrap_or("").to_owned());
        } else if !indented.is_match(line) {
            in_packages = false;
        }
    }
    patterns
        .into_iter()
        .map(|pattern| {
            let trimmed = js_trim(&pattern);
            match quoted.captures(trimmed) {
                Some(found) => found.get(2).unwrap_or("").to_owned(),
                None => trimmed.to_owned(),
            }
        })
        .filter(|pattern| !pattern.is_empty())
        .collect()
}

/// A workspace glob (`*` one segment, `**` any depth, `!` excludes) as a matcher of folders.
pub fn workspace_matcher(patterns: &[String]) -> impl Fn(&str) -> bool + use<> {
    let compile = |pattern: &str| {
        let stripped = pattern.strip_prefix("./").unwrap_or(pattern).trim_end_matches('/');
        let body = stripped
            .split('/')
            .map(|part| if part == "**" { ".*".to_owned() } else { segment_pattern(part) })
            .collect::<Vec<_>>()
            .join("/");
        let body = match body.strip_suffix("/.*") {
            Some(head) => format!("{head}(?:/.*)?"),
            None => body,
        };
        let body = match body.strip_prefix(".*/") {
            Some(tail) => format!("(?:.*/){tail}"),
            None => body,
        };
        JsRegex::new_static(&format!("^{body}$"), "")
    };
    let include: Vec<JsRegex> = patterns.iter().filter(|p| !p.starts_with('!')).map(|p| compile(p)).collect();
    let exclude: Vec<JsRegex> = patterns.iter().filter(|p| p.starts_with('!')).map(|p| compile(&p[1..])).collect();
    move |dir: &str| include.iter().any(|re| re.is_match(dir)) && !exclude.iter().any(|re| re.is_match(dir))
}

async fn workspace_patterns(scm: &Scm, cancel: &CancellationToken, project: &Path) -> Result<Vec<String>, ScmFailure> {
    let mut patterns = Vec::new();
    if let Some(bytes) = read_or_none(scm, cancel, project.join("package.json")).await? {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            let list = match value.get("workspaces") {
                Some(serde_json::Value::Array(list)) => Some(list),
                Some(serde_json::Value::Object(map)) => map.get("packages").and_then(serde_json::Value::as_array),
                _ => None,
            };
            if let Some(list) = list {
                patterns.extend(list.iter().filter_map(|v| v.as_str().map(str::to_owned)));
            }
        }
    }
    if let Some(bytes) = read_or_none(scm, cancel, project.join("pnpm-workspace.yaml")).await? {
        patterns.extend(pnpm_workspace_patterns(&String::from_utf8_lossy(&bytes)));
    }
    Ok(patterns)
}

type Folders = Vec<(String, BTreeSet<String>)>;

/// The folders (forward-slash, relative to `project`, "" itself) holding committed files some
/// stack reads, with those basenames; nothing inside `node_modules`. Empty when git cannot
/// list them.
async fn committed_folders(scm: &Scm, cancel: &CancellationToken, project: &Path) -> Result<Folders, ScmFailure> {
    let mut args: Vec<String> = ["-c", "core.quotePath=false", "ls-files", "-z", "--"].iter().map(|s| (*s).to_owned()).collect();
    for stack in &STACKS {
        args.extend(stack.names.iter().chain(stack.globs).map(|name| format!(":(glob)**/{name}")));
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = scm.git.outcome(cancel, project, &refs, &RunOptions::read()).await?;
    let mut folders: Folders = Vec::new();
    if !output.success() {
        return Ok(folders);
    }
    let mut index: HashMap<String, usize> = HashMap::new();
    for path in output.stdout_text().split('\0') {
        let mut parts: Vec<&str> = path.split('/').collect();
        let name = parts.pop().unwrap_or("");
        if name.is_empty() || !relevant_name(name) || parts.contains(&"node_modules") {
            continue;
        }
        let dir = parts.join("/");
        let at = *index.entry(dir.clone()).or_insert_with(|| {
            folders.push((dir, BTreeSet::new()));
            folders.len() - 1
        });
        folders[at].1.insert(name.to_owned());
    }
    Ok(folders)
}

struct Pick {
    manager: &'static str,
    lockfile: Option<&'static str>,
    requirements: Vec<String>,
}

fn pick(stack: &Stack, files: &BTreeSet<String>) -> Option<Pick> {
    let has = |name: &str| files.contains(name);
    let locked = |manager, lockfile| Some(Pick { manager, lockfile: Some(lockfile), requirements: Vec::new() });
    match stack.name {
        "js" => {
            if !has("package.json") {
                return None;
            }
            let (lockfile, manager) = *JS_LOCKFILES.iter().find(|(name, _)| has(name))?;
            locked(manager, lockfile)
        }
        "python" => {
            if has("uv.lock") {
                return locked("uv", "uv.lock");
            }
            if has("poetry.lock") {
                return locked("poetry", "poetry.lock");
            }
            if has("Pipfile.lock") {
                return locked("pipenv", "Pipfile.lock");
            }
            let pattern = JsRegex::new_static(r"^requirements.*\.txt$", "i");
            let mut requirements: Vec<String> = files.iter().filter(|name| pattern.is_match(name)).cloned().collect();
            requirements.sort_by(|a, b| {
                if a == "requirements.txt" {
                    std::cmp::Ordering::Less
                } else if b == "requirements.txt" {
                    std::cmp::Ordering::Greater
                } else {
                    locale_compare(a, b)
                }
            });
            (!requirements.is_empty()).then_some(Pick { manager: "pip", lockfile: None, requirements })
        }
        "ruby" if has("Gemfile.lock") => locked("bundler", "Gemfile.lock"),
        "php" if has("composer.lock") => locked("composer", "composer.lock"),
        "dotnet" => {
            if has("packages.lock.json") {
                return locked("dotnet", "packages.lock.json");
            }
            let csproj = JsRegex::new_static(r"\.csproj$", "i");
            files
                .iter()
                .any(|name| csproj.is_match(name))
                .then_some(Pick { manager: "dotnet", lockfile: None, requirements: Vec::new() })
        }
        "elixir" if has("mix.lock") => locked("mix", "mix.lock"),
        "dart" if has("pubspec.lock") => locked("pub", "pubspec.lock"),
        _ => None,
    }
}

/// Every installed artefact in `project` that is a link (forward-slash paths): the artefact of
/// each folder with committed files of its stack. Only the artefact itself is examined, never
/// what a link points at.
pub async fn linked_artefacts(scm: &Scm, cancel: &CancellationToken, project: &Path) -> Result<Vec<String>, ScmFailure> {
    let mut links = Vec::new();
    for (dir, files) in committed_folders(scm, cancel, project).await? {
        for stack in &STACKS {
            if !files.iter().any(|name| stack_reads(stack, name)) {
                continue;
            }
            if lstat(scm, cancel, folder_path(project, &dir).join(stack.artefact)).await?.is_some_and(|m| m.symlink) {
                links.push(artefact_rel(&dir, stack.artefact));
            }
        }
    }
    Ok(links)
}

/// The artefacts an install restores whole in `project`, wherever their folder is.
pub async fn dependency_artefacts(scm: &Scm, cancel: &CancellationToken, project: &Path) -> Result<Vec<String>, ScmFailure> {
    let mut artefacts = Vec::new();
    for (dir, files) in committed_folders(scm, cancel, project).await? {
        for stack in &STACKS {
            if stack.reinstallable && pick(stack, &files).is_some() {
                artefacts.push(artefact_rel(&dir, stack.artefact));
            }
        }
    }
    Ok(artefacts)
}

/// One project folder and stack to prepare, with the manager its committed files select.
#[derive(Clone, Debug, PartialEq)]
pub struct LockfileFolder {
    pub dir: String,
    pub stack: &'static str,
    pub artefact: &'static str,
    pub manager: &'static str,
    pub lockfile: Option<&'static str>,
    pub requirements: Vec<String>,
}

/// What to prepare, root first. `main_dir`: the same folder in the main checkout, whose
/// installed artefacts admit nested folders.
pub async fn find_lockfile_folders(
    scm: &Scm,
    cancel: &CancellationToken,
    project: &Path,
    main_dir: Option<&Path>,
) -> Result<Vec<LockfileFolder>, ScmFailure> {
    let folders = committed_folders(scm, cancel, project).await?;
    let patterns = workspace_patterns(scm, cancel, project).await?;
    let is_workspace = workspace_matcher(&patterns);
    let mut found = Vec::new();
    for (dir, files) in &folders {
        for stack in &STACKS {
            let Some(picked) = pick(stack, files) else { continue };
            let mut admitted = dir.is_empty() || is_workspace(dir);
            if !admitted {
                if let Some(main) = main_dir {
                    admitted = lstat(scm, cancel, folder_path(main, dir).join(stack.artefact))
                        .await?
                        .is_some_and(|m| m.dir && !m.symlink);
                }
            }
            if admitted {
                found.push(LockfileFolder {
                    dir: dir.clone(),
                    stack: stack.name,
                    artefact: stack.artefact,
                    manager: picked.manager,
                    lockfile: picked.lockfile,
                    requirements: picked.requirements,
                });
            }
        }
    }
    found.sort_by(|a, b| {
        a.dir.split('/').count().cmp(&b.dir.split('/').count()).then_with(|| locale_compare(&a.dir, &b.dir))
    });
    Ok(found)
}

/// A command the first turn runs, never through a shell.
#[derive(Clone, Debug, PartialEq)]
pub struct SetupCommand {
    pub command: String,
    pub file: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub label: String,
    /// Variables to set (`Some`) or remove (`None`) for the run.
    pub env: Option<Vec<(String, Option<String>)>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DependencyPlan {
    pub commands: Vec<SetupCommand>,
    pub notes: Vec<String>,
}

struct Install {
    tools: Vec<&'static str>,
    args: Vec<String>,
    follow_up: Option<(String, Vec<String>)>,
    env: Option<Vec<(String, Option<String>)>>,
}

fn quote(value: &str) -> String {
    let special = JsRegex::new_static(r#"[\s"&|<>^()]"#, "");
    if special.is_match(value) { format!("\"{}\"", value.replace('"', "\\\"")) } else { value.to_owned() }
}

fn display_line(tool: &str, args: &[String]) -> String {
    format!("{tool} {}", args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" "))
}

fn command_line(tool: &str, install: &Install) -> String {
    match &install.follow_up {
        Some((file, args)) => format!("{} && {}", display_line(tool, &install.args), display_line(&quote(file), args)),
        None => display_line(tool, &install.args),
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

/// `Number.parseInt` of the leading integer of `text`.
fn parse_int(text: &str) -> Option<i64> {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
    let value: i64 = digits[..end].parse().ok()?;
    Some(if text.starts_with('-') { -value } else { value })
}

async fn yarn_install_flag(scm: &Scm, cancel: &CancellationToken, tool: &str, cwd: &Path) -> Option<&'static str> {
    let (program, args) = spawn_form(tool, &strings(&["--version"]));
    let mut spec = ExecSpec::new(&program, cwd);
    spec.args = args;
    spec.time_limit = Some(VERSION_TIMEOUT);
    let output = scm.git.exec().run(spec, cancel).await.ok()?;
    if !output.success() {
        return None;
    }
    let major = parse_int(js_trim(&output.stdout_text()))?;
    Some(if major >= 2 { "--immutable" } else { "--frozen-lockfile" })
}

/// The install of `entry`; called without `tool` to name it, then with the resolved tool path
/// for arguments that depend on its version.
async fn install(
    scm: &Scm,
    cancel: &CancellationToken,
    entry: &LockfileFolder,
    cwd: &Path,
    tool: Option<&str>,
) -> Result<Option<Install>, ScmFailure> {
    let plain = |tools: Vec<&'static str>, args: &[&str]| Some(Install { tools, args: strings(args), follow_up: None, env: None });
    let python_env = || Some(PYTHON_ENV.iter().map(|(k, v)| ((*k).to_owned(), v.map(str::to_owned))).collect::<Vec<_>>());
    Ok(match entry.stack {
        "js" => match entry.manager {
            "npm" => plain(vec!["npm"], &["ci"]),
            "yarn" => match tool {
                None => plain(vec!["yarn"], &["install", "--frozen-lockfile"]),
                Some(tool) => yarn_install_flag(scm, cancel, tool, cwd).await.and_then(|flag| plain(vec!["yarn"], &["install", flag])),
            },
            manager => plain(vec![manager], &["install", "--frozen-lockfile"]),
        },
        "python" => {
            let env = python_env();
            let with_env = |tools: &'static str, args: &[&str]| Some(Install { tools: vec![tools], args: strings(args), follow_up: None, env: env.clone() });
            match entry.manager {
                "uv" => with_env("uv", &["sync", "--frozen"]),
                "poetry" => with_env("poetry", &["install", "--no-root"]),
                "pipenv" => with_env("pipenv", &["sync"]),
                _ => {
                    let venv_python = if cfg!(windows) { cwd.join(".venv").join("Scripts").join("python.exe") } else { cwd.join(".venv").join("bin").join("python") };
                    let mut pip = strings(&["-m", "pip", "install"]);
                    for name in &entry.requirements {
                        pip.extend(["-r".to_owned(), name.clone()]);
                    }
                    Some(Install {
                        tools: if cfg!(windows) { vec!["py", "python", "python3"] } else { vec!["python3", "python"] },
                        args: strings(&["-m", "venv", ".venv"]),
                        follow_up: Some((venv_python.to_string_lossy().into_owned(), pip)),
                        env,
                    })
                }
            }
        }
        "ruby" => plain(vec!["bundle"], &["install", "--frozen"]),
        "php" => plain(vec!["composer"], &["install", "--no-interaction"]),
        "dotnet" => {
            if entry.lockfile.is_some() { plain(vec!["dotnet"], &["restore", "--locked-mode"]) } else { plain(vec!["dotnet"], &["restore"]) }
        }
        "elixir" => plain(vec!["mix"], &["deps.get", "--check-locked"]),
        "dart" => {
            let pubspec = read_or_none(scm, cancel, cwd.join("pubspec.yaml")).await?;
            let flutter = JsRegex::new_static(r"^\s+flutter\s*:", "m");
            let is_flutter = pubspec.is_some_and(|bytes| flutter.is_match(&String::from_utf8_lossy(&bytes)));
            plain(vec![if is_flutter { "flutter" } else { "dart" }], &["pub", "get", "--enforce-lockfile"])
        }
        _ => None,
    })
}

pub struct PlanInput {
    pub worktree_dir: PathBuf,
    pub main_dir: Option<PathBuf>,
    /// Artefacts (forward-slash, relative to `worktree_dir`) that are links the user asked for
    /// in `.worktreeinclude`: never installed through or replaced.
    pub shared: Vec<String>,
    /// Where the tools are looked up; the process `PATH` when unset.
    pub path_var: Option<String>,
}

fn shared_clause(count: usize) -> String {
    format!("{} shared from the main checkout by .worktreeinclude and not installed here", if count > 1 { "are" } else { "is" })
}

/// What the first turn still has to do in the worktree folder: the installs and one note per
/// folder it leaves alone (nothing found, tool not on PATH, an artefact that is a link).
pub async fn plan_dependency_setup(scm: &Scm, cancel: &CancellationToken, input: PlanInput) -> Result<DependencyPlan, ScmFailure> {
    let path_var = input.path_var.clone().unwrap_or_else(|| {
        std::env::var("PATH").or_else(|_| std::env::var("Path")).unwrap_or_default()
    });
    let path_env = HashMap::from([("PATH".to_owned(), path_var)]);
    let path_index = Arc::new(PathIndex::new(Some(&path_env)));
    let folders = find_lockfile_folders(scm, cancel, &input.worktree_dir, input.main_dir.as_deref()).await?;
    if folders.is_empty() {
        return Ok(DependencyPlan {
            commands: Vec::new(),
            notes: vec!["No lockfile or dependency manifest found; nothing was installed.".into()],
        });
    }
    let mut plan = DependencyPlan::default();
    // While any artefact is a link nothing is installed.
    let links = linked_artefacts(scm, cancel, &input.worktree_dir).await?;
    for entry in &folders {
        let cwd = folder_path(&input.worktree_dir, &entry.dir);
        let where_ = folder_label(&entry.dir);
        let info = lstat(scm, cancel, cwd.join(entry.artefact)).await?;
        if info.is_some_and(|m| !m.symlink) {
            continue;
        }
        let Some(named) = install(scm, cancel, entry, &cwd, None).await? else { continue };
        let first = named.tools[0];
        if info.is_some() && input.shared.contains(&artefact_rel(&entry.dir, entry.artefact)) {
            plan.notes.push(format!("{} in {where_} {}.", entry.artefact, shared_clause(1)));
            continue;
        }
        if info.is_some() {
            plan.notes.push(format!(
                "{} in {where_} is a link, not an install of its own; {where_} was not prepared (replace it with `{}` there if tests need it).",
                entry.artefact,
                command_line(first, &named)
            ));
            continue;
        }
        let others: Vec<&String> = links.iter().filter(|rel| !input.shared.contains(rel)).collect();
        if !others.is_empty() {
            let list = others.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
            plan.notes.push(format!(
                "{where_} was not prepared while {list} {} an install could reach through (run `{}` there once replaced if tests need it).",
                if others.len() > 1 { "are links" } else { "is a link" },
                command_line(first, &named)
            ));
            continue;
        }
        if !links.is_empty() {
            plan.notes.push(format!("{where_} was not prepared; {} {}.", links.join(", "), shared_clause(links.len())));
            continue;
        }
        let candidates: Vec<&'static str> = named.tools.clone();
        let (lookup_env, lookup_index) = (path_env.clone(), path_index.clone());
        let located = on_lane(scm.lane, cancel, move || {
            candidates.into_iter().find_map(|candidate| {
                which(candidate, Some(&lookup_env), Some(&*lookup_index)).map(|found| (candidate, found.to_string_lossy().into_owned()))
            })
        })
        .await?;
        let Some((found, tool)) = located else {
            plan.notes.push(format!(
                "{first} is not on PATH; {where_} was not prepared (run `{}` there if tests need it).",
                command_line(first, &named)
            ));
            continue;
        };
        let Some(spec) = install(scm, cancel, entry, &cwd, Some(&tool)).await? else {
            plan.notes.push(format!("{found} could not be queried; {where_} was not prepared."));
            continue;
        };
        let label = format!("{} ({where_})", entry.manager);
        plan.commands.push(SetupCommand {
            command: display_line(&format!("\"{tool}\""), &spec.args),
            file: tool.clone(),
            args: spec.args.clone(),
            cwd: cwd.clone(),
            label: label.clone(),
            env: spec.env.clone(),
        });
        if let Some((file, args)) = &spec.follow_up {
            plan.commands.push(SetupCommand {
                command: display_line(&format!("\"{file}\""), args),
                file: file.clone(),
                args: args.clone(),
                cwd: cwd.clone(),
                label,
                env: spec.env.clone(),
            });
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pnpm_patterns_read_block_and_flow_styles() {
        let block = "packages:\n  - 'apps/*'\n  - \"libs/**\"  # c\n  - tools\nother: 1\n";
        assert_eq!(pnpm_workspace_patterns(block), ["apps/*", "libs/**", "tools"]);
        assert_eq!(pnpm_workspace_patterns("packages: [a/*, \"b\"]\r\n"), ["a/*", "b"]);
    }

    #[test]
    fn workspace_globs_follow_node_and_exclusions_win() {
        let matcher = workspace_matcher(&strings(&["packages/*", "apps/**", "!packages/skip", "./tools/"]));
        assert!(matcher("packages/a") && matcher("apps/x/y") && matcher("apps") && matcher("tools"));
        assert!(!matcher("packages/a/b") && !matcher("packages/skip") && !matcher("other"));
    }

    #[test]
    fn requirements_pick_orders_the_plain_file_first() {
        let files: BTreeSet<String> = ["requirements-dev.txt", "requirements.txt", "package.json"].iter().map(|s| (*s).to_owned()).collect();
        let picked = pick(&STACKS[1], &files).unwrap();
        assert_eq!((picked.manager, picked.requirements), ("pip", strings(&["requirements.txt", "requirements-dev.txt"])));
        assert!(pick(&STACKS[0], &files).is_none());
    }

    #[tokio::test]
    async fn folders_come_from_committed_files_and_workspaces_and_links_block_installs() {
        let dir = tempfile::tempdir().unwrap();
        let repo = std::fs::canonicalize(dir.path()).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").args(args).current_dir(&repo).output().unwrap();
            assert!(out.status.success(), "{args:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        for (path, text) in [
            ("package.json", "{\"workspaces\":[\"packages/*\"]}"),
            ("package-lock.json", "{}"),
            ("packages/a/package.json", "{}"),
            ("packages/a/package-lock.json", "{}"),
            ("fixtures/x/package.json", "{}"),
            ("fixtures/x/yarn.lock", ""),
            ("node_modules/skip/package.json", "{}"),
        ] {
            let file = repo.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        git(&["add", "-f", "."]);
        let scm = Scm::new(
            crate::testing::TestProcesses::shared(),
            mixdog_rt::testing::tokens().maintenance_io,
            dir.path().join("scratch"),
        );
        let cancel = CancellationToken::new();
        let found = find_lockfile_folders(&scm, &cancel, &repo, None).await.unwrap();
        let dirs: Vec<_> = found.iter().map(|f| (f.dir.as_str(), f.manager)).collect();
        // A test fixture is not a project unless the main checkout installed there.
        assert_eq!(dirs, [("", "npm"), ("packages/a", "npm")]);
        assert_eq!(dependency_artefacts(&scm, &cancel, &repo).await.unwrap().len(), 3);
        assert!(linked_artefacts(&scm, &cancel, &repo).await.unwrap().is_empty());
        let none = plan_dependency_setup(
            &scm,
            &cancel,
            PlanInput { worktree_dir: repo.clone(), main_dir: None, shared: Vec::new(), path_var: Some(String::new()) },
        )
        .await
        .unwrap();
        assert!(none.commands.is_empty());
        assert!(none.notes[0].starts_with("npm is not on PATH; packages/a was not prepared"), "{:?}", none.notes);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn yarn_behind_a_cmd_shim_is_versioned_through_the_interpreter() {
        let dir = tempfile::tempdir().unwrap();
        let repo = std::fs::canonicalize(dir.path()).unwrap();
        // cmd.exe cannot run a `\\?\` path, which canonicalize returns and PATH never holds.
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("yarn.cmd"), "@echo 3.6.0\r\n").unwrap();
        std::fs::write(repo.join("package.json"), "{}").unwrap();
        std::fs::write(repo.join("yarn.lock"), "").unwrap();
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git").args(args).current_dir(&repo).output().unwrap().status.success());
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["add", "-f", "package.json", "yarn.lock"]);
        let scm = Scm::new(crate::testing::TestProcesses::shared(), mixdog_rt::testing::tokens().maintenance_io, dir.path().join("scratch"));
        let cancel = CancellationToken::new();
        let plan =plan_dependency_setup(
            &scm,
            &cancel,
            PlanInput { worktree_dir: repo.clone(), main_dir: None, shared: Vec::new(), path_var: Some(bin.to_string_lossy().into_owned()) },
        )
        .await
        .unwrap();
        assert_eq!(plan.commands.len(), 1, "{:?}", plan.notes);
        assert!(plan.commands[0].args.contains(&"--immutable".to_owned()), "{:?}", plan.commands);
    }

    #[test]
    fn commands_are_quoted_the_way_the_node_display_does() {
        assert_eq!(display_line("\"/x/npm\"", &strings(&["ci", "a b"])), "\"/x/npm\" ci \"a b\"");
        assert_eq!(parse_int("2.1.0"), Some(2));
        assert_eq!(parse_int("v2"), None);
    }
}
