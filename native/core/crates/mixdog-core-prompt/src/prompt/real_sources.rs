//! The real [`PromptSources`]: Node's outside loaders over the Rust folders and services.
//!
//! Every method here does blocking file work, so a `RealSources` exists only inside an
//! io-interactive lane job: it borrows the lane's [`InLane`] proof (as `agents::files` and
//! `config::agent_routes` do) and the host composes the prompt inside that job.
//!
//! Three observations need a child process (`git status`, `git check-ignore`, and the POSIX
//! login-shell probe), which the process service runs and a sync composition cannot await.
//! Node itself separates them (`prewarmGitStartupProbes`): the host's async prewarm fills
//! [`StartupObservations`] and the composition reads the finished answers. An absent entry reads
//! as a probe that failed, exactly as Node renders one.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "lane job bodies: a RealSources lives inside an io-interactive job")]

use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::js_trim_end;
use mixdog_js::js_words;
use mixdog_js::locale_compare_en;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_tools::exec::session_scratch_dir;
use regex::Regex;
use serde_json::Value;

use super::probes::StartupObservations;
use super::sources::PromptSources;
use mixdog_core_config::config::bot_migration;
use mixdog_core_config::config::is_store_bot;
use mixdog_core_config::config::hidden_agents::hidden_agent_traits;
use mixdog_core_config::config::mixy_display_name;
use mixdog_core_config::config::mixy_identity_dir;
use mixdog_core_config::workflow::pack::read_document;

const MIXY_BOT_ID: &str = "mixy";
const BOTS_DIR: &str = "bots";
const PERSONA_MAX_UTF16: usize = 4000;
const PERSONA_TRUNCATION_MARKER: &str = "\n\n[persona truncated]";
const INSTRUCTION_FILE_MAX_BYTES: usize = 32 * 1024;
const TRUNCATED_MARK: &str = "\n\n[... truncated]";
const CWD_STARTUP_ENTRY_LIMIT: usize = 40;
const PART_SEPARATOR: &str = "\n\n---\n\n";
pub const SHELL_TOOL_STARTUP_NAMES: [&str; 14] =
    ["python3", "python", "py", "pip3", "node", "npm", "gcc", "g++", "make", "jq", "sqlite3", "file", "curl", "xxd"];

/// The host facts the loaders read besides the data folders.
#[derive(Debug, Clone, Copy)]
pub struct HostFacts<'a> {
    pub plugin_root: &'a Path,
    pub data_dir: &'a Path,
    /// `os.homedir()`.
    pub home_dir: &'a Path,
    /// `process.env.PATH`.
    pub path_env: &'a str,
    /// `Intl.DateTimeFormat().resolvedOptions().locale`.
    pub locale: &'a str,
    /// `featureEnvOverride('MIXDOG_BOOT_INSTRUCTION_FILES') === false`.
    pub instruction_files_forced_off: bool,
    /// `readSection('agent').instructionFiles`, the stored setting.
    pub stored_instruction_files: Option<&'a Value>,
}

pub struct RealSources<'a> {
    lane: &'a InLane<InteractiveIo>,
    host: HostFacts<'a>,
    observed: &'a StartupObservations,
}

impl<'a> RealSources<'a> {
    pub fn new(lane: &'a InLane<InteractiveIo>, host: HostFacts<'a>, observed: &'a StartupObservations) -> Self {
        Self { lane, host, observed }
    }

    fn agents_dir(&self) -> PathBuf {
        self.host.data_dir.join("agents")
    }

    /// `mixyIdentityDir(dataDir)`.
    fn mixy_dir(&self) -> PathBuf {
        mixy_identity_dir(self.lane, self.host.data_dir)
    }

    /// `storeBotDir(agent)`: the bot's own folder, `None` for an agent that is no store bot.
    fn store_bot_dir(&self, agent: &str) -> Option<PathBuf> {
        is_store_bot(self.lane, self.host.data_dir, agent).then(|| self.host.data_dir.join(BOTS_DIR).join(agent))
    }

    /// `agentSectionDirs(pluginRoot)`, in precedence order.
    fn section_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = vec![self.host.plugin_root.join("agents"), self.agents_dir()];
        if bot_migration(self.lane, self.host.data_dir).is_some() {
            dirs.push(self.host.data_dir.join(BOTS_DIR));
        }
        dirs
    }

    /// `agentManifest(agent)`.
    fn manifest(&self, agent: &str) -> serde_json::Map<String, Value> {
        let parse = |dir: &Path| {
            let text = read_safe(&dir.join("agent.json")).unwrap_or_else(|| "{}".to_owned());
            serde_json::from_str::<Value>(&text).ok().and_then(|value| value.as_object().cloned()).unwrap_or_default()
        };
        if let Some(own) = self.store_bot_dir(agent) {
            return parse(&own);
        }
        for root in [self.agents_dir(), self.host.plugin_root.join("agents")] {
            let dir = root.join(agent);
            if dir.join("AGENT.md").exists() {
                return parse(&dir);
            }
        }
        serde_json::Map::new()
    }

    /// `mixyDisplayName()`.
    fn mixy_name(&self) -> String {
        mixy_display_name(self.lane, self.host.data_dir)
    }

    /// `findRepositoryRoot(startDirectory)`: the root and the git directory holding `HEAD`.
    fn repository_root(&self, start: &str) -> Option<(PathBuf, Option<PathBuf>)> {
        let mut current = std::path::absolute(if start.is_empty() { "." } else { start }).ok()?;
        for _ in 0..64 {
            let marker = current.join(".git");
            if let Ok(stats) = fs::metadata(&marker) {
                let git_dir = if stats.is_dir() { Some(marker) } else { linked_git_dir(&marker, &current) };
                return Some((current, git_dir));
            }
            current = current.parent()?.to_path_buf();
        }
        None
    }

    /// `findPathExecutable(name)` on this host: the hit text Node returns.
    fn path_executable(&self, name: &str) -> Option<String> {
        find_path_executable(name, self.host.path_env)
    }
}

/// `readSafe(path)`: the trimmed text, `None` when absent, unreadable or blank.
fn read_safe(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let text = fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&text);
    let text = js_trim(&text);
    (!text.is_empty()).then(|| text.to_owned())
}

/// `oneLine(value)` for a string: runs of white space become one space; anything else is ''.
fn one_line(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|text| js_words(text).collect::<Vec<_>>().join(" ")).unwrap_or_default()
}

/// `PERSONA_AGENT_ID.test(agent) && !agent.includes('..')`.
fn valid_agent_id(agent: &str) -> bool {
    let mut chars = agent.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !agent.contains("..")
}

fn role_section(name: &str, body: &str) -> String {
    format!("## {name}\n\n{body}")
}

fn linked_git_dir(marker: &Path, root: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(marker).ok()?;
    let target = text.lines().find_map(|line| line.strip_prefix("gitdir:"))?;
    let target = js_trim(target);
    (!target.is_empty()).then(|| std::path::absolute(root.join(target)).ok()).flatten()
}

/// `_headBranch`: the branch a `ref: refs/heads/<branch>` HEAD names.
fn head_branch(git_dir: &Path) -> Option<String> {
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let rest = js_trim(&head).strip_prefix("ref:")?.trim_start_matches(is_js_space).strip_prefix("refs/heads/")?;
    (!rest.is_empty() && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).then(|| rest.to_owned())
}

/// `_executableNames(name, platform)`.
fn executable_names(name: &str) -> Vec<String> {
    let name = js_trim(name);
    if name.is_empty() {
        return Vec::new();
    }
    let has_ext = [".exe", ".cmd", ".bat", ".com"].iter().any(|ext| name.to_ascii_lowercase().ends_with(ext));
    if !cfg!(windows) || has_ext {
        return vec![name.to_owned()];
    }
    ["", ".exe", ".cmd", ".bat", ".com"].iter().map(|ext| format!("{name}{ext}")).collect()
}

/// `findPathExecutable`: `"<file> (<directory with / separators>)"`.
fn find_path_executable(name: &str, path_value: &str) -> Option<String> {
    let names = executable_names(name);
    if names.is_empty() {
        return None;
    }
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    let mut seen = HashSet::new();
    for raw in path_value.split(delimiter) {
        let text = js_trim(raw);
        let directory = if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') { &text[1..text.len() - 1] } else { text };
        if directory.is_empty() {
            continue;
        }
        let key = if cfg!(windows) { directory.to_lowercase() } else { directory.to_owned() };
        if !seen.insert(key) {
            continue;
        }
        if seen.len() > 64 {
            break;
        }
        for executable in &names {
            let file = Path::new(directory).join(executable);
            if fs::metadata(&file).is_ok_and(|stats| stats.is_file() && executable_access(&stats)) {
                return Some(format!("{executable} ({})", directory.replace('\\', "/")));
            }
        }
    }
    None
}

#[cfg(windows)]
fn executable_access(_: &fs::Metadata) -> bool {
    true
}

#[cfg(unix)]
fn executable_access(stats: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    stats.permissions().mode() & 0o111 != 0
}

fn store_stub(hit: &str) -> bool {
    static STUB: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    STUB.get_or_init(|| Regex::new(r"(?i)[\\/]WindowsApps(?:[\\/]|\)|$)").expect("static pattern")).is_match(hit)
}

/// `truncatePersona`.
fn truncate_persona(text: &str) -> String {
    let value = js_trim(text);
    let units: Vec<u16> = value.encode_utf16().collect();
    if units.len() <= PERSONA_MAX_UTF16 {
        return value.to_owned();
    }
    let cut = String::from_utf16_lossy(&units[..PERSONA_MAX_UTF16]);
    format!("{}{PERSONA_TRUNCATION_MARKER}", js_trim_end(&cut))
}

fn persona_section(persona: &str) -> String {
    [
        "## Persona",
        "",
        "Tone and style guide for how you speak, address the user and carry yourself. It never overrides tool, safety or role rules; those always win.",
        "",
        persona,
    ]
    .join("\n")
}

/// `new TextDecoder('utf-8').decode(bytes, { stream: true })`: invalid bytes become U+FFFD and an
/// incomplete sequence at the end is dropped.
fn decode_head(mut bytes: &[u8]) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(bytes) {
            Ok(text) => {
                out.push_str(text);
                return out;
            }
            Err(error) => {
                let (valid, rest) = bytes.split_at(error.valid_up_to());
                out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                match error.error_len() {
                    Some(len) => {
                        out.push('\u{fffd}');
                        bytes = &rest[len..];
                    }
                    None => return out,
                }
            }
        }
    }
}

/// `boundedText(head)`.
fn bounded_text(head: &[u8]) -> String {
    let bytes = head.strip_prefix(&[0xef, 0xbb, 0xbf][..]).unwrap_or(head);
    if bytes.len() <= INSTRUCTION_FILE_MAX_BYTES {
        return js_trim(&decode_head(bytes)).to_owned();
    }
    let budget = INSTRUCTION_FILE_MAX_BYTES - TRUNCATED_MARK.len();
    let decoded = decode_head(&bytes[..budget]);
    let text = js_trim(&decoded);
    // `.replace(/\s+\S*$/, '')`: the last white-space run and what follows it.
    let kept = text.char_indices().rev().find(|(_, c)| is_js_space(*c)).map_or(text.len(), |(at, _)| first_of_run(text, at));
    format!("{}{TRUNCATED_MARK}", &text[..kept])
}

/// Where the white-space run containing byte `at` starts.
fn first_of_run(text: &str, at: usize) -> usize {
    let mut start = at;
    for (index, c) in text[..at].char_indices().rev() {
        if !is_js_space(c) {
            break;
        }
        start = index;
    }
    start
}

/// `skipNote(path, reason)`: Node writes it to stderr; here it is a log line. A file that is
/// absent, or a path through a file or onto a directory, is silent.
fn skipped(path: &Path, error: &std::io::Error) {
    use std::io::ErrorKind::IsADirectory;
    use std::io::ErrorKind::NotADirectory;
    use std::io::ErrorKind::NotFound;
    if !matches!(error.kind(), NotFound | NotADirectory | IsADirectory) {
        // Node's reason is `error.code`; libuv names a refused open `EACCES` on Unix and `EPERM` on Windows. Any other fault has no
        // code name here and shows its message.
        let reason = match error.kind() {
            std::io::ErrorKind::PermissionDenied if cfg!(windows) => "EPERM".to_owned(),
            std::io::ErrorKind::PermissionDenied => "EACCES".to_owned(),
            _ => error.to_string(),
        };
        mixdog_rt::node_stderr!("[instruction-files] skipped {}: {reason}", path.display());
    }
}

/// `openSync(path, O_RDONLY | O_NONBLOCK)`.
fn open_nonblocking(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    options.open(path)
}
/// `readInstructionFile({ path, root })`.
fn read_instruction_file(path: &Path, root: Option<&Path>) -> String {
    let real = match fs::canonicalize(path) {
        Ok(real) => real,
        Err(error) => {
            skipped(path, &error);
            return String::new();
        }
    };
    if let Some(root) = root {
        let real_root = match fs::canonicalize(root) {
            Ok(real_root) => real_root,
            Err(error) => {
                skipped(path, &error);
                return String::new();
            }
        };
        if !real.starts_with(&real_root) {
            mixdog_rt::node_stderr!("[instruction-files] skipped {}: resolves outside its root", path.display());
            return String::new();
        }
    }
    // The type is checked before the open: opening a FIFO for reading blocks until a writer
    // appears. The open itself is non-blocking and the opened file's type is checked once more.
    match fs::metadata(&real) {
        Ok(stats) if !stats.is_file() => return String::new(),
        Ok(_) => {}
        Err(error) => {
            skipped(path, &error);
            return String::new();
        }
    }
    let file = match open_nonblocking(&real) {
        Ok(file) => file,
        Err(error) => {
            skipped(path, &error);
            return String::new();
        }
    };
    match file.metadata() {
        Ok(stats) if !stats.is_file() => return String::new(),
        Ok(_) => {}
        Err(error) => {
            skipped(path, &error);
            return String::new();
        }
    }    let mut head = Vec::new();
    if let Err(error) = file.take((INSTRUCTION_FILE_MAX_BYTES + 3 + 1) as u64).read_to_end(&mut head) {
        skipped(path, &error);
        return String::new();
    }
    bounded_text(&head)
}
impl PromptSources for RealSources<'_> {
    fn role_catalog(&self, agent: Option<&str>, _provider: Option<&str>) -> String {
        let agent = agent.filter(|agent| !agent.is_empty());
        let mut by_name: HashMap<String, String> = HashMap::new();
        for dir in self.section_dirs() {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let file_name = entry.file_name().to_string_lossy().into_owned();
                let Ok(kind) = entry.file_type() else { continue };
                let (name, raw) = if kind.is_dir() {
                    (file_name.clone(), read_safe(&entry.path().join("AGENT.md")))
                } else if kind.is_file() && file_name.ends_with(".md") {
                    (file_name.strip_suffix(".md").unwrap_or(&file_name).to_owned(), read_safe(&entry.path()))
                } else {
                    (String::new(), None)
                };
                let Some(raw) = raw else { continue };
                if name.is_empty() || name == "lead" {
                    continue;
                }
                if name == MIXY_BOT_ID && dir.file_name().is_some_and(|base| base == BOTS_DIR) {
                    continue;
                }
                let (_, body) = read_document(&raw);
                if !body.is_empty() {
                    by_name.insert(name.clone(), role_section(&name, &body));
                }
            }
        }
        let mut names: Vec<&String> = by_name.keys().collect();
        names.sort();
        let sections: Vec<String> = names.into_iter().map(|name| by_name[name].clone()).collect();

        let rules_dir = self.host.plugin_root.join("rules").join("agent");
        let mut files: Vec<String> = fs::read_dir(&rules_dir)
            .map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        files.retain(|file| file.ends_with(".md") && file != "AGENT.md");
        files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let mut hidden: Vec<(String, String)> = Vec::new();
        for file in files {
            let Some(raw) = read_safe(&rules_dir.join(&file)) else { continue };
            let (_, body) = read_document(&raw);
            if body.is_empty() {
                continue;
            }
            let stem = file.trim_start_matches(|c: char| c.is_ascii_digit());
            let stem = if stem.len() < file.len() && stem.starts_with('-') { &stem[1..] } else { file.as_str() };
            hidden.push((stem.strip_suffix(".md").unwrap_or(stem).to_owned(), body));
        }

        let (rules, roles): (Vec<String>, Vec<String>) = match agent {
            None => (hidden.iter().map(|(n, b)| role_section(n, b)).collect(), sections),
            Some(agent) if hidden_agent_traits(agent).is_some_and(|(kind, _)| kind.as_deref() == Some("maintenance")) => {
                let own: Vec<String> = hidden.iter().find(|(n, _)| n == agent).map(|(n, b)| role_section(n, b)).into_iter().collect();
                let fallback: Vec<String> = sections.iter().find(|s| s.starts_with(&format!("## {agent}\n"))).cloned().into_iter().collect();
                (if own.is_empty() { fallback } else { own }, Vec::new())
            }
            Some(agent) => (Vec::new(), sections.into_iter().filter(|s| s.starts_with(&format!("## {agent}\n"))).collect()),
        };
        let mut blocks = Vec::new();
        if !roles.is_empty() {
            blocks.push(format!("# Agent Role Catalog\n\n{}", roles.join(PART_SEPARATOR)));
        }
        if !rules.is_empty() {
            blocks.push(format!("# Agent Role Rules\n\n{}", rules.join(PART_SEPARATOR)));
        }
        blocks.join(PART_SEPARATOR)
    }

    fn mixy_role_section(&self) -> String {
        let raw = read_safe(&self.mixy_dir().join("AGENT.md")).unwrap_or_default();
        let (_, body) = read_document(&raw);
        let text = js_trim(&body);
        if text.is_empty() { String::new() } else { format!("# Agent Role Catalog\n\n{}", role_section("lead", text)) }
    }

    fn persona_section(&self, agent: &str) -> String {
        if !valid_agent_id(agent) {
            return String::new();
        }
        let is_lead = agent == "lead";
        let own = if is_lead { Some(self.mixy_dir()) } else { self.store_bot_dir(agent) };
        let persona_of = |dir: &Path| truncate_persona(&read_safe(&dir.join("PERSONA.md")).unwrap_or_default());
        if let Some(own) = own {
            let persona = persona_of(&own);
            return if persona.is_empty() { String::new() } else { persona_section(&persona) };
        }
        for root in [self.agents_dir(), self.host.plugin_root.join("agents")] {
            let dir = root.join(agent);
            if !dir.join("AGENT.md").exists() {
                continue;
            }
            let persona = persona_of(&dir);
            return if persona.is_empty() { String::new() } else { persona_section(&persona) };
        }
        String::new()
    }

    fn agent_mode_identity_line(&self, agent: &str) -> String {
        if agent == "lead" {
            return format!("You are {}, the user's assistant in Mixdog.", self.mixy_name());
        }
        if !valid_agent_id(agent) {
            return String::new();
        }
        let manifest = self.manifest(agent);
        let name = one_line(manifest.get("name"));
        let name = if name.is_empty() { agent.to_owned() } else { name };
        let role = one_line(manifest.get("description"));
        let role = role.trim_end_matches(['.', '。']);
        if role.is_empty() { format!("You are {name}.") } else { format!("You are {name}. Your role: {role}.") }
    }

    fn shell_name(&self) -> &'static str {
        if cfg!(windows) { "PowerShell" } else { "Bash" }
    }

    fn scratch_dir(&self, session_id: &str) -> Option<String> {
        session_scratch_dir(self.host.data_dir, session_id).map(|dir| dir.to_string_lossy().into_owned())
    }

    fn shell_tools_line(&self) -> String {
        // Windows walks PATH here; POSIX waits for the host's login-shell probe to be recorded.
        self.observed.shell_tools(self.host.path_env, || {
            if !cfg!(windows) {
                return None;
            }
            let found: HashSet<&str> = SHELL_TOOL_STARTUP_NAMES
                .iter()
                .copied()
                .filter(|name| self.path_executable(name).is_some_and(|hit| !store_stub(&hit)))
                .collect();
            let list = |present: bool| {
                let names: Vec<&str> = SHELL_TOOL_STARTUP_NAMES.iter().copied().filter(|n| found.contains(n) == present).collect();
                if names.is_empty() { "(none)".to_owned() } else { names.join(" ") }
            };
            Some(format!("- Shell tools at startup: {}; absent: {}.", list(true), list(false)))
        })
    }
    fn git_line(&self, cwd: Option<&str>) -> String {
        if !self.observed.git_present(self.host.path_env, || self.path_executable("git").is_some()) {
            return "- Git startup state: git is not installed here; git tool calls fail until something installs it.".to_owned();
        }
        let shown = cwd.map_or_else(|| std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(), str::to_owned);
        let Some((root, git_dir)) = self.repository_root(&shown) else {
            return format!("- Git startup state: {shown} was not inside a git repository at startup; git commands that require one fail until a repository exists.");
        };
        let branch = git_dir.as_deref().and_then(head_branch);
        let root_text = root.to_string_lossy().into_owned();
        let state = self.observed.change_state(&root_text).map(|state| format!("; {state}")).unwrap_or_default();
        let branch = branch.map_or_else(|| " with a detached HEAD".to_owned(), |b| format!(" on branch {b}"));
        format!("- Git startup state: repository root {root_text}{branch}{state}.")
    }

    fn cwd_entries(&self, cwd: &str) -> String {
        let Ok(directory) = std::path::absolute(if cwd.is_empty() { "." } else { cwd }) else { return String::new() };
        let Ok(read) = fs::read_dir(&directory) else { return String::new() };
        let entries: Vec<(String, bool)> = read
            .flatten()
            .map(|e| (e.file_name().to_string_lossy().into_owned(), e.file_type().is_ok_and(|t| t.is_dir())))
            .collect();
        if entries.is_empty() {
            return "- Cwd entries at startup: none (empty directory).".to_owned();
        }
        let candidates: Vec<&(String, bool)> = entries.iter().filter(|(name, _)| name != ".git").collect();
        let directory_text = directory.to_string_lossy().into_owned();
        let ignored = if candidates.is_empty() || self.repository_root(&directory_text).is_none() {
            HashSet::new()
        } else {
            let listed: Vec<String> = candidates.iter().map(|(name, _)| name.clone()).collect();
            self.observed.ignored(&directory_text, &listed)
        };
        let mut kept: Vec<&(String, bool)> = candidates.into_iter().filter(|(name, _)| !ignored.contains(name)).collect();
        if kept.is_empty() {
            return "- Cwd entries at startup: none besides gitignored entries.".to_owned();
        }
        kept.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_compare_en(&a.0, &b.0)));
        let names: Vec<String> = kept.iter().map(|(name, dir)| if *dir { format!("{name}/") } else { name.clone() }).collect();
        let omitted = names.len().saturating_sub(CWD_STARTUP_ENTRY_LIMIT);
        let more = if omitted > 0 { format!(" … +{omitted} more (list for the rest)") } else { String::new() };
        format!("- Cwd entries at startup: {}{more}", names[..names.len() - omitted].join(" "))
    }

    fn instruction_files(&self, config_mode: Option<&Value>, cwd: Option<&str>) -> String {
        let mode = if self.host.instruction_files_forced_off { "off".to_owned() } else { self.instruction_files_mode(config_mode) };
        let kinds: &[&str] = match mode.as_str() {
            "all" => &["agents", "claude"],
            "agents" => &["agents"],
            "claude" => &["claude"],
            _ => &[],
        };
        let file = |kind: &str| if kind == "agents" { "AGENTS.md" } else { "CLAUDE.md" };
        let global_dir = |kind: &str| if kind == "agents" { ".codex" } else { ".claude" };
        let mut candidates: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
        if !self.host.home_dir.as_os_str().is_empty() {
            let home = std::path::absolute(self.host.home_dir).unwrap_or_else(|_| self.host.home_dir.to_path_buf());
            candidates.extend(kinds.iter().map(|kind| (home.join(global_dir(kind)).join(file(kind)), None)));
        }
        if let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) {
            let root = std::path::absolute(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
            candidates.extend(kinds.iter().map(|kind| (root.join(file(kind)), Some(root.clone()))));
        }
        let mut seen = HashSet::new();
        let mut sections = Vec::new();
        for (path, root) in candidates {
            let content = read_instruction_file(&path, root.as_deref());
            if content.is_empty() || !seen.insert(content.clone()) {
                continue;
            }
            sections.push(format!("## {}\n\n{content}", path.to_string_lossy()));
        }
        if sections.is_empty() {
            return String::new();
        }
        let mut parts = vec![
            "# Instruction Files".to_owned(),
            "The user's instruction files. Project files take precedence over global ones when they conflict.".to_owned(),
        ];
        parts.extend(sections);
        parts.join("\n\n")
    }

    fn instruction_files_mode(&self, config_mode: Option<&Value>) -> String {
        // `normalizeInstructionFilesMode`: anything but the four modes is the default, off.
        match config_mode.or(self.host.stored_instruction_files).and_then(Value::as_str) {
            Some(mode @ ("all" | "agents" | "claude" | "off")) => mode.to_owned(),
            _ => "off".to_owned(),
        }
    }

    fn system_locale(&self) -> String {
        self.host.locale.to_owned()
    }
}

#[cfg(all(test, unix))]
#[allow(clippy::disallowed_methods, reason = "test setup: a real FIFO")]
mod fifo_tests {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    use super::read_instruction_file;

    /// A FIFO named like an instruction file has no content and does not block the composition
    /// (`instruction-files.mjs`: the type is checked before the open, which is non-blocking).
    #[test]
    fn a_fifo_instruction_file_is_skipped_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("AGENTS.md");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert_eq!(read_instruction_file(&fifo, Some(dir.path())), "");
    }
}