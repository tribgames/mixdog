//! The real [`PromptSources`]: the outside loaders over the folders and services.
//!
//! The reads and the composition run apart. [`SourceFacts::read`], in an io-interactive lane job,
//! reads through a [`FileReads`] what the composition's source calls ([`SourceWants`]) ask of the
//! disk and takes the facts they need from the lane (the bot store, Mixy's folder and name, the PATH
//! lookups); a `RealSources` answers from the [`FileSnapshot`] and the facts, so the composition runs
//! on a compute lane. A file or fact the assembly asks for that was not read is a gap, which fails it.
//!
//! Three observations need a child process (`git status`, `git check-ignore`, and the POSIX
//! login-shell probe), which the process service runs and a sync composition cannot await.
//! The host's async prewarm fills [`StartupObservations`] and the composition reads the finished
//! answers. An absent entry reads as a probe that failed.
//!
//! [`FileReads`]: super::source_files::FileReads
//! [`FileSnapshot`]: super::source_files::FileSnapshot
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the PATH lookups run in SourceFacts::read, an io-interactive lane job")]

use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;

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
use sha2::Digest;
use sha2::Sha256;

use super::probes::StartupObservations;
use super::source_files::Entry;
use super::source_files::InstructionHead;
use super::source_files::PromptFiles;
use super::sources::PromptSources;
use mixdog_core_config::config::bot_migration;
use mixdog_core_config::config::hidden_agents::hidden_agent_traits;
use mixdog_core_config::config::is_store_bot;
use mixdog_core_config::config::mixy_display_name;
use mixdog_core_config::config::mixy_identity_dir;
use mixdog_core_config::workflow::pack::read_document;

const MIXY_BOT_ID: &str = "mixy";
/// `CODING_LEAD_PROFILE_REVISION`: the stamp of a session whose prompt embeds no profile file.
pub const CODING_LEAD_PROFILE_REVISION: &str = "coding-lead";
/// The files an agent's prompt sections are read from.
const PROFILE_FILES: [&str; 3] = ["agent.json", "AGENT.md", "PERSONA.md"];
const BOTS_DIR: &str = "bots";
const PERSONA_MAX_UTF16: usize = 4000;
const PERSONA_TRUNCATION_MARKER: &str = "\n\n[persona truncated]";
pub(super) const INSTRUCTION_FILE_MAX_BYTES: usize = 32 * 1024;
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

/// The source calls one composition makes, each with the arguments it makes it with: what its read step reads for.
#[derive(Debug, Clone, Default)]
pub struct SourceWants {
    /// `role_catalog(..)`.
    pub role_catalog: bool,
    /// `mixy_role_section()`.
    pub mixy_role: bool,
    /// `persona_section(agent)`.
    pub persona: Option<String>,
    /// `agent_mode_identity_line(agent)`.
    pub identity: Option<String>,
    /// `agent_profile_revision(agent, mixy)`.
    pub profile_revision: Option<(String, bool)>,
    /// `shell_tools_line()`.
    pub shell_tools: bool,
    /// `git_line(cwd)`.
    pub git: Option<Option<String>>,
    /// `cwd_entries(cwd)`.
    pub cwd_entries: Option<String>,
    /// `instruction_files(config_mode, cwd)`.
    pub instruction_files: Option<(Option<Value>, Option<String>)>,
}

/// The answers a composition needs that only the lane can give, taken by [`SourceFacts::read`] as its reads ask
/// for them. A fact the assembly asks for and the read step did not take is a gap ([`SourceFacts::gap`]).
#[derive(Debug, Default)]
pub struct SourceFacts {
    /// `readBotMigration(dataDir)` found the finished split: the bot store is active.
    bot_store: OnceLock<bool>,
    /// `mixyIdentityDir(dataDir)`.
    mixy_dir: OnceLock<PathBuf>,
    /// `mixyDisplayName()`.
    mixy_name: OnceLock<String>,
    /// `isStoreBot(agent)` per agent asked about.
    store_bots: Mutex<HashMap<String, bool>>,
    /// `gitExecutablePresent`.
    git_present: OnceLock<bool>,
    /// The shell-tools line (`describeShellToolsStartupState`).
    shell_tools: OnceLock<String>,
    gap: OnceLock<String>,
}

impl SourceFacts {
    /// Reads, through `files`, what the source calls of `wants` ask of the disk, and takes the facts they need.
    pub fn read(lane: &InLane<InteractiveIo>, files: &dyn PromptFiles, host: HostFacts<'_>, observed: &StartupObservations, wants: &SourceWants) -> Self {
        let facts = Self::default();
        RealSources { files, facts: &facts, host, observed, lane: Some(lane) }.read_files(wants);
        facts
    }

    /// The first fact asked for that the read step did not take.
    pub fn gap(&self) -> Option<&str> {
        self.gap.get().map(String::as_str)
    }
}

pub struct RealSources<'a> {
    files: &'a dyn PromptFiles,
    facts: &'a SourceFacts,
    host: HostFacts<'a>,
    observed: &'a StartupObservations,
    /// Set in the read step only: a fact not taken yet is taken on it.
    lane: Option<&'a InLane<InteractiveIo>>,
}

impl<'a> RealSources<'a> {
    pub fn new(files: &'a dyn PromptFiles, facts: &'a SourceFacts, host: HostFacts<'a>, observed: &'a StartupObservations) -> Self {
        Self { files, facts, host, observed, lane: None }
    }

    /// The reads of [`SourceFacts::read`]: what each wanted source call asks of the files.
    fn read_files(&self, wants: &SourceWants) {
        if wants.role_catalog {
            for dir in self.section_dirs() {
                for entry in self.files.entries(&dir).unwrap_or_default() {
                    if let Some((_, file)) = role_file(&dir, &entry) {
                        self.files.read(&file);
                    }
                }
            }
            let rules_dir = self.hidden_rules_dir();
            for file in self.hidden_rule_files() {
                self.files.read(&rules_dir.join(file));
            }
        }
        if wants.mixy_role {
            self.files.read(&self.mixy_dir().join("AGENT.md"));
        }
        if let Some(dir) = wants.persona.as_deref().filter(|agent| valid_agent_id(agent)).and_then(|agent| self.profile_dir(agent)) {
            self.files.read(&dir.join("PERSONA.md"));
        }
        match wants.identity.as_deref() {
            Some("lead") => {
                self.mixy_name();
            }
            Some(agent) if valid_agent_id(agent) => {
                if let Some(dir) = self.profile_dir(agent) {
                    self.files.read(&dir.join("agent.json"));
                }
            }
            _ => {}
        }
        if let Some((agent, mixy)) = &wants.profile_revision {
            for (_, dir) in self.revision_dirs(agent, *mixy) {
                for file in PROFILE_FILES {
                    self.files.read(&dir.join(file));
                }
            }
        }
        if wants.shell_tools {
            self.shell_tools();
        }
        if let Some(cwd) = &wants.git
            && self.git_present()
            && let Some((_, Some(git_dir))) = self.files.repository_root(&shown_cwd(cwd.as_deref()))
        {
            self.files.read(&git_dir.join("HEAD"));
        }
        if let Some(directory) = wants.cwd_entries.as_deref().and_then(listing_dir)
            && let Some(entries) = self.files.entries(&directory)
            && entries.iter().any(|entry| entry.name != ".git")
        {
            self.files.repository_root(&directory.to_string_lossy());
        }
        if let Some((config_mode, cwd)) = &wants.instruction_files {
            for (path, root) in self.instruction_candidates(self.instruction_kinds(config_mode.as_ref()), cwd.as_deref()) {
                self.files.instruction_head(&path, root.as_deref());
            }
        }
    }

    /// A fact: the one the read step took, else taken now in the read step; asked for in the assembly without having
    /// been taken, it is a gap.
    fn fact<T: Clone + Default>(&self, cell: &OnceLock<T>, what: &str, take: impl FnOnce(&InLane<InteractiveIo>) -> T) -> T {
        if let Some(value) = cell.get() {
            return value.clone();
        }
        match self.lane {
            Some(lane) => cell.get_or_init(|| take(lane)).clone(),
            None => {
                self.facts.gap.get_or_init(|| what.to_owned());
                T::default()
            }
        }
    }

    fn bot_store(&self) -> bool {
        self.fact(&self.facts.bot_store, "whether the bot store is active", |lane| bot_migration(lane, self.host.data_dir).is_some())
    }

    fn git_present(&self) -> bool {
        self.fact(&self.facts.git_present, "whether git is on PATH", |_| {
            self.observed.git_present(self.host.path_env, || find_path_executable("git", self.host.path_env).is_some())
        })
    }

    fn shell_tools(&self) -> String {
        self.fact(&self.facts.shell_tools, "the shell-tools line", |_| {
            self.observed.shell_tools(self.host.path_env, || windows_shell_tools_line(self.host.path_env))
        })
    }

    fn agents_dir(&self) -> PathBuf {
        self.host.data_dir.join("agents")
    }

    /// `mixyIdentityDir(dataDir)`.
    fn mixy_dir(&self) -> PathBuf {
        self.fact(&self.facts.mixy_dir, "Mixy's folder", |lane| mixy_identity_dir(lane, self.host.data_dir))
    }

    /// `storeBotDir(agent)`: the bot's own folder, `None` for an agent that is no store bot.
    fn store_bot_dir(&self, agent: &str) -> Option<PathBuf> {
        let mut store_bots = self.facts.store_bots.lock().unwrap_or_else(PoisonError::into_inner);
        let store_bot = match (store_bots.get(agent), self.lane) {
            (Some(store_bot), _) => *store_bot,
            (None, Some(lane)) => *store_bots.entry(agent.to_owned()).or_insert_with(|| is_store_bot(lane, self.host.data_dir, agent)),
            (None, None) => {
                self.facts.gap.get_or_init(|| format!("whether {agent} is a store bot"));
                false
            }
        };
        store_bot.then(|| self.host.data_dir.join(BOTS_DIR).join(agent))
    }

    /// The folder an agent's persona and manifest are read from: its own (Mixy's, a store bot's), else the first
    /// profile root holding its `AGENT.md`.
    fn profile_dir(&self, agent: &str) -> Option<PathBuf> {
        let own = if agent == "lead" { Some(self.mixy_dir()) } else { self.store_bot_dir(agent) };
        own.or_else(|| {
            [self.agents_dir(), self.host.plugin_root.join("agents")]
                .into_iter()
                .map(|root| root.join(agent))
                .find(|dir| self.files.exists(&dir.join("AGENT.md")))
        })
    }

    /// The `(root, folder)` pairs a profile stamp hashes; none where the stamp reads no file.
    fn revision_dirs(&self, agent: &str, mixy: bool) -> Vec<(PathBuf, PathBuf)> {
        if !valid_agent_id(agent) || (agent == "lead" && !mixy) {
            return Vec::new();
        }
        let roots = [self.agents_dir(), self.host.plugin_root.join("agents")];
        let mut dirs: Vec<(PathBuf, PathBuf)> = roots.iter().map(|root| (root.clone(), root.join(agent))).collect();
        let own = if agent == "lead" { Some(self.mixy_dir()) } else { self.store_bot_dir(agent) };
        if let Some(own) = own.filter(|own| *own != roots[0].join(agent)) {
            dirs.push((own.clone(), own));
        }
        dirs
    }

    /// The files an agent's prompt sections are read
    /// from (its `agent.json`, `AGENT.md` and `PERSONA.md` in the data folder and the shipped tree, and a store bot's or
    /// Mixy's own folder) as one hash, so an edit of any of them is another stamp. A coding Lead (`lead` outside Mixy's
    /// own thread) embeds no profile file, so its stamp is a constant. Empty for an invalid id.
    pub fn agent_profile_revision(&self, agent: &str, mixy: bool) -> String {
        if !valid_agent_id(agent) {
            return String::new();
        }
        if agent == "lead" && !mixy {
            return CODING_LEAD_PROFILE_REVISION.to_owned();
        }
        let mut hash = Sha256::new();
        for (root, dir) in self.revision_dirs(agent, mixy) {
            for file in PROFILE_FILES {
                let text = read_safe(self.files, &dir.join(file)).unwrap_or_else(|| "\u{1}".to_owned());
                hash.update(format!("{}\0{file}\0{text}\0", root.display()));
            }
        }
        hash.finalize().iter().take(12).map(|byte| format!("{byte:02x}")).collect()
    }

    /// `agentSectionDirs(pluginRoot)`, in precedence order.
    fn section_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = vec![self.host.plugin_root.join("agents"), self.agents_dir()];
        if self.bot_store() {
            dirs.push(self.host.data_dir.join(BOTS_DIR));
        }
        dirs
    }

    /// `agentManifest(agent)`.
    fn manifest(&self, agent: &str) -> serde_json::Map<String, Value> {
        let Some(dir) = self.profile_dir(agent) else { return serde_json::Map::new() };
        let text = read_safe(self.files, &dir.join("agent.json")).unwrap_or_else(|| "{}".to_owned());
        // A name or job a phone sent cut inside an emoji is stored by Node with half of it: U+FFFD here.
        serde_json::from_str::<Value>(&mixdog_js::json_well_formed_str(&text)).ok().and_then(|value| value.as_object().cloned()).unwrap_or_default()
    }

    /// `mixyDisplayName()`.
    fn mixy_name(&self) -> String {
        self.fact(&self.facts.mixy_name, "Mixy's name", |lane| mixy_display_name(lane, self.host.data_dir))
    }

    /// The shipped hidden-agent rules folder.
    fn hidden_rules_dir(&self) -> PathBuf {
        self.host.plugin_root.join("rules").join("agent")
    }

    /// The hidden-agent rule files of [`Self::hidden_rules_dir`], in file-name order.
    fn hidden_rule_files(&self) -> Vec<String> {
        let mut files: Vec<String> = self
            .files
            .entries(&self.hidden_rules_dir())
            .map(|entries| entries.into_iter().map(|e| e.name.to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        files.retain(|file| file.ends_with(".md") && file != "AGENT.md");
        files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        files
    }

    /// The instruction-file kinds the mode reads: none when they are off.
    fn instruction_kinds(&self, config_mode: Option<&Value>) -> &'static [&'static str] {
        let mode = if self.host.instruction_files_forced_off { "off".to_owned() } else { self.instruction_files_mode(config_mode) };
        match mode.as_str() {
            "all" => &["agents", "claude"],
            "agents" => &["agents"],
            "claude" => &["claude"],
            _ => &[],
        }
    }

    /// The instruction files `kinds` name, in the home folder and in `cwd`, with the root each must stay inside.
    fn instruction_candidates(&self, kinds: &[&str], cwd: Option<&str>) -> Vec<(PathBuf, Option<PathBuf>)> {
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
        candidates
    }
}

/// The role a section folder's entry defines and the file its text is in: a folder's `AGENT.md`, or a `.md` file itself.
fn role_file(dir: &Path, entry: &Entry) -> Option<(String, PathBuf)> {
    let kind = entry.kind?;
    let file_name = entry.name.to_string_lossy().into_owned();
    if kind.dir {
        let path = dir.join(&entry.name).join("AGENT.md");
        Some((file_name, path))
    } else if kind.file && file_name.ends_with(".md") {
        Some((file_name.strip_suffix(".md").unwrap_or(&file_name).to_owned(), dir.join(&entry.name)))
    } else {
        None
    }
}

/// The folder `git_line` describes: `cwd`, else the process's own.
fn shown_cwd(cwd: Option<&str>) -> String {
    cwd.map_or_else(|| std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(), str::to_owned)
}

/// The folder `cwd_entries` lists.
fn listing_dir(cwd: &str) -> Option<PathBuf> {
    std::path::absolute(if cwd.is_empty() { "." } else { cwd }).ok()
}

/// The Windows shell-tools line, from PATH; POSIX waits for the host's login-shell probe to be recorded.
fn windows_shell_tools_line(path_env: &str) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let found: HashSet<&str> =
        SHELL_TOOL_STARTUP_NAMES.iter().copied().filter(|name| find_path_executable(name, path_env).is_some_and(|hit| !store_stub(&hit))).collect();
    let list = |present: bool| {
        let names: Vec<&str> = SHELL_TOOL_STARTUP_NAMES.iter().copied().filter(|n| found.contains(n) == present).collect();
        if names.is_empty() { "(none)".to_owned() } else { names.join(" ") }
    };
    Some(format!("- Shell tools at startup: {}; absent: {}.", list(true), list(false)))
}

/// `readSafe(path)`: the trimmed text, `None` when absent, unreadable or blank. A file of nothing but NUL bytes and
/// blanks, what a crash leaves of data that never reached disk (`holdsNoData`), is no text either.
fn read_safe(files: &dyn PromptFiles, path: &Path) -> Option<String> {
    let text = files.read(path)?;
    if text.iter().all(|byte| matches!(byte, 0 | b' ' | b'\t' | b'\n' | b'\r')) {
        return None;
    }
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
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric()) && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) && !agent.contains("..")
}

fn role_section(name: &str, body: &str) -> String {
    format!("## {name}\n\n{body}")
}

/// `_headBranch`: the branch a `ref: refs/heads/<branch>` HEAD names.
fn head_branch(files: &dyn PromptFiles, git_dir: &Path) -> Option<String> {
    let head = String::from_utf8(files.read(&git_dir.join("HEAD"))?).ok()?;
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
fn skipped(path: &Path, kind: std::io::ErrorKind, message: &str) {
    use std::io::ErrorKind::IsADirectory;
    use std::io::ErrorKind::NotADirectory;
    use std::io::ErrorKind::NotFound;
    if !matches!(kind, NotFound | NotADirectory | IsADirectory) {
        // Node's reason is `error.code`; libuv names a refused open `EACCES` on Unix and `EPERM` on Windows. Any other fault has no
        // code name here and shows its message.
        let reason = match kind {
            std::io::ErrorKind::PermissionDenied if cfg!(windows) => "EPERM",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            _ => message,
        };
        mixdog_rt::node_stderr!("[instruction-files] skipped {}: {reason}", path.display());
    }
}

fn read_instruction_file(files: &dyn PromptFiles, path: &Path, root: Option<&Path>) -> String {
    match files.instruction_head(path, root) {
        InstructionHead::Bytes(head) => bounded_text(&head),
        InstructionHead::NotAFile => String::new(),
        InstructionHead::Outside => {
            mixdog_rt::node_stderr!("[instruction-files] skipped {}: resolves outside its root", path.display());
            String::new()
        }
        InstructionHead::Failed { kind, message } => {
            skipped(path, kind, &message);
            String::new()
        }
    }
}

#[cfg(all(test, unix))]
#[allow(clippy::disallowed_methods, reason = "test setup: a real FIFO")]
mod fifo_tests {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    use super::super::source_files::LiveFiles;
    use super::read_instruction_file;

    /// A FIFO named like an instruction file has no content and does not block the composition
    /// (`instruction-files.mjs`: the type is checked before the open, which is non-blocking).
    #[test]
    fn a_fifo_instruction_file_is_skipped_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("AGENTS.md");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert_eq!(read_instruction_file(&LiveFiles, &fifo, Some(dir.path())), "");
    }
}

impl RealSources<'_> {
    /// One `## name` section per agent folder or `.md` file of the section folders, by name.
    fn agent_role_sections(&self) -> Vec<String> {
        let mut by_name: HashMap<String, String> = HashMap::new();
        for dir in self.section_dirs() {
            let Some(entries) = self.files.entries(&dir) else { continue };
            for entry in entries {
                let Some((name, file)) = role_file(&dir, &entry) else { continue };
                let Some(raw) = read_safe(self.files, &file) else { continue };
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
        names.into_iter().map(|name| by_name[name].clone()).collect()
    }

    /// The shipped hidden-agent rule files as `(name, body)`, in file-name order.
    fn hidden_rule_bodies(&self) -> Vec<(String, String)> {
        let rules_dir = self.hidden_rules_dir();
        let mut hidden: Vec<(String, String)> = Vec::new();
        for file in self.hidden_rule_files() {
            let Some(raw) = read_safe(self.files, &rules_dir.join(&file)) else { continue };
            let (_, body) = read_document(&raw);
            if body.is_empty() {
                continue;
            }
            let stem = file.trim_start_matches(|c: char| c.is_ascii_digit());
            let stem = if stem.len() < file.len() && stem.starts_with('-') { &stem[1..] } else { file.as_str() };
            hidden.push((stem.strip_suffix(".md").unwrap_or(stem).to_owned(), body));
        }
        hidden
    }
}

impl PromptSources for RealSources<'_> {
    fn role_catalog(&self, agent: Option<&str>, _provider: Option<&str>) -> String {
        let agent = agent.filter(|agent| !agent.is_empty());
        let sections = self.agent_role_sections();
        let hidden = self.hidden_rule_bodies();
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
        let raw = read_safe(self.files, &self.mixy_dir().join("AGENT.md")).unwrap_or_default();
        let (_, body) = read_document(&raw);
        let text = js_trim(&body);
        if text.is_empty() { String::new() } else { format!("# Agent Role Catalog\n\n{}", role_section("lead", text)) }
    }

    fn persona_section(&self, agent: &str) -> String {
        if !valid_agent_id(agent) {
            return String::new();
        }
        let Some(dir) = self.profile_dir(agent) else { return String::new() };
        let persona = truncate_persona(&read_safe(self.files, &dir.join("PERSONA.md")).unwrap_or_default());
        if persona.is_empty() { String::new() } else { persona_section(&persona) }
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
        self.shell_tools()
    }
    fn git_line(&self, cwd: Option<&str>) -> String {
        if !self.git_present() {
            return "- Git startup state: git is not installed here; git tool calls fail until something installs it.".to_owned();
        }
        let shown = shown_cwd(cwd);
        let Some((root, git_dir)) = self.files.repository_root(&shown) else {
            return format!(
                "- Git startup state: {shown} was not inside a git repository at startup; git commands that require one fail until a repository exists."
            );
        };
        let branch = git_dir.as_deref().and_then(|git_dir| head_branch(self.files, git_dir));
        let root_text = root.to_string_lossy().into_owned();
        let state = self.observed.change_state(&root_text).map(|state| format!("; {state}")).unwrap_or_default();
        let branch = branch.map_or_else(|| " with a detached HEAD".to_owned(), |b| format!(" on branch {b}"));
        format!("- Git startup state: repository root {root_text}{branch}{state}.")
    }

    fn cwd_entries(&self, cwd: &str) -> String {
        let Some(directory) = listing_dir(cwd) else { return String::new() };
        let Some(read) = self.files.entries(&directory) else { return String::new() };
        let entries: Vec<(String, bool)> = read.into_iter().map(|e| (e.name.to_string_lossy().into_owned(), e.kind.is_some_and(|kind| kind.dir))).collect();
        if entries.is_empty() {
            return "- Cwd entries at startup: none (empty directory).".to_owned();
        }
        let candidates: Vec<&(String, bool)> = entries.iter().filter(|(name, _)| name != ".git").collect();
        let directory_text = directory.to_string_lossy().into_owned();
        let ignored = if candidates.is_empty() || self.files.repository_root(&directory_text).is_none() {
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
        let mut seen = HashSet::new();
        let mut sections = Vec::new();
        for (path, root) in self.instruction_candidates(self.instruction_kinds(config_mode), cwd) {
            let content = read_instruction_file(self.files, &path, root.as_deref());
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
