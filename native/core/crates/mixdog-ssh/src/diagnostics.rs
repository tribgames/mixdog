//! Diagnostics for SSH connections: a small in-memory ring buffer per server (ssh argv without secrets, stderr, the
//! probe / bootstrap results, timings, tunnel starts and exits), the text a user can copy to report a problem, and
//! the redaction both go through. Nothing here is written to disk.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use regex::Regex;

use crate::command::SshTarget;

pub const DIAGNOSTICS_MAX_ENTRIES: usize = 400;
const MAX_TEXT: usize = 600;
const MAX_ARG: usize = 160;
const UNSCOPED: &str = "*";
/// A name of this many characters or fewer is only replaced next to an `@`.
const SHORT_NAME_MAX: usize = 3;
const MAX_RESULT_BUFFER: usize = 65_536;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagnosticKind {
    Ssh,
    Stderr,
    Result,
    Exit,
    Tunnel,
    Phase,
    Log,
}

impl DiagnosticKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ssh => "ssh",
            Self::Stderr => "stderr",
            Self::Result => "result",
            Self::Exit => "exit",
            Self::Tunnel => "tunnel",
            Self::Phase => "phase",
            Self::Log => "log",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiagnosticEntry {
    /// Milliseconds since the Unix epoch.
    pub at: u64,
    pub kind: DiagnosticKind,
    pub text: String,
}

/// Which server's ring an ssh of this target writes to.
pub fn diagnostics_key_for(target: &SshTarget) -> String {
    target.key()
}

// Daemon tokens, bearer headers, passwords, pairing codes and long secret-looking values.
static SECRET_PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (
            r#"(?i)(?-u:\b)([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY)[A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)"#,
            "${1}=<redacted>",
        ),
        (
            r#"(?i)(?-u:\b)(token|secret|password|passphrase|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+"#,
            "${1}${2}<redacted>",
        ),
        (r"(?i)(?-u:\b)Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer <redacted>"),
        (r"(?-u:\b)[A-Fa-f0-9]{32,}(?-u:\b)", "<redacted>"),
        (r"(?-u:\b)[A-Za-z0-9_-]{40,}(?-u:\b)", "<redacted>"),
    ]
    .into_iter()
    .filter_map(|(source, replacement)| Regex::new(source).ok().map(|regex| (regex, replacement)))
    .collect()
});

/// Text with every secret-looking value removed.
pub fn redact_secrets(text: &str) -> String {
    let mut out = text.to_owned();
    for (pattern, replacement) in SECRET_PATTERNS.iter() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// The server's user and host names, in the forms they appear in. Names of 3 characters or fewer are only replaced
/// next to an `@` (see [`redact_server`]): on their own they would hit ordinary words.
pub fn server_names(target: &SshTarget, extra: &[String]) -> Vec<String> {
    let destination = target.destination.as_str();
    let at = destination.rfind('@');
    let user = at.map_or("", |index| &destination[..index]);
    let host = at.map_or(destination, |index| &destination[index + 1..]);
    let mut seen = BTreeSet::new();
    let mut names: Vec<String> = [target.display.as_str(), destination, user, host]
        .into_iter()
        .chain(extra.iter().map(String::as_str))
        .map(str::trim)
        .filter(|name| !name.is_empty() && seen.insert(name.to_owned()))
        .map(str::to_owned)
        .collect();
    names.sort_by_key(|name| std::cmp::Reverse(name.chars().count()));
    names
}

fn same_char(a: char, b: char) -> bool {
    a == b || a.to_lowercase().eq(b.to_lowercase())
}

fn name_at(chars: &[char], at: usize, name: &[char]) -> bool {
    chars.len() >= at + name.len() && chars[at..at + name.len()].iter().zip(name).all(|(a, b)| same_char(*a, *b))
}

fn name_before(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn name_after(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// Text with the server's user and host replaced by `<server>`, for text that leaves this PC. A short name is
/// replaced only as the user or the host of a `user@host` pair.
pub fn redact_server(text: &str, names: &[String]) -> String {
    let mut current = text.to_owned();
    for name in names {
        let name: Vec<char> = name.chars().collect();
        if name.is_empty() {
            continue;
        }
        let chars: Vec<char> = current.chars().collect();
        let short = name.len() <= SHORT_NAME_MAX;
        let mut out = String::with_capacity(current.len());
        let mut index = 0;
        while index < chars.len() {
            let end = index + name.len();
            let before = index.checked_sub(1).map(|i| chars[i]);
            let after = chars.get(end).copied();
            let hit = name_at(&chars, index, &name)
                && if short {
                    let user_side = !name_before(before) && after == Some('@') && chars.get(end + 1).is_some_and(|c| c.is_ascii_alphanumeric());
                    let host_side = before == Some('@')
                        && index.checked_sub(2).map(|i| chars[i]).is_some_and(|c| name_before(Some(c)))
                        && !name_after(after);
                    user_side || host_side
                } else {
                    !name_before(before) && !name_after(after)
                };
            if hit {
                out.push_str("<server>");
                index = end;
            } else {
                out.push(chars[index]);
                index += 1;
            }
        }
        current = out;
    }
    current
}

fn clip(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count > max { format!("{}…({count} chars)", text.chars().take(max).collect::<String>()) } else { text.to_owned() }
}

/// The argument list of an ssh run, without anything long (the remote script) or secret.
pub fn describe_argv(command: &str, args: &[String]) -> String {
    let name = command.rsplit(['/', '\\']).next().unwrap_or(command);
    std::iter::once(name.to_owned()).chain(args.iter().map(|arg| clip(&redact_secrets(arg), MAX_ARG))).collect::<Vec<_>>().join(" ")
}

fn stamp(at: u64) -> String {
    let day_ms = at % 86_400_000;
    format!("{:02}:{:02}:{:02}.{:03}", day_ms / 3_600_000, day_ms / 60_000 % 60, day_ms / 1_000 % 60, day_ms % 1_000)
}

/// What the report of a server needs besides the ring.
pub struct DiagnosticsInput<'a> {
    pub key: &'a str,
    pub target: &'a SshTarget,
    pub app_version: &'a str,
    pub ssh_version: &'a str,
    /// The OS line, see [`os_label`].
    pub os: &'a str,
    /// What `ssh -G` resolved, as `key value` lines worth showing.
    pub config: &'a [String],
    /// Host names that appear only after config resolution (HostName, jump hosts).
    pub extra_names: &'a [String],
    /// How many log lines; None: 100.
    pub lines: Option<usize>,
}

/// `win32 10.0.26100 (x64)`: the operating system as the report names it.
pub fn os_label(release: &str) -> String {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    format!("{os} {release} ({arch})")
}

/// The in-memory rings of all servers.
#[derive(Default)]
pub struct Diagnostics {
    rings: Mutex<HashMap<String, VecDeque<DiagnosticEntry>>>,
}

impl Diagnostics {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a text to a server's ring, one entry per line (secrets are removed on the way in).
    pub fn record(&self, key: Option<&str>, kind: DiagnosticKind, text: &str, at: u64) {
        let mut rings = self.rings.lock().unwrap_or_else(PoisonError::into_inner);
        let ring = rings.entry(key.unwrap_or(UNSCOPED).to_owned()).or_default();
        for line in text.split('\n') {
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                continue;
            }
            ring.push_back(DiagnosticEntry { at, kind, text: clip(&redact_secrets(trimmed), MAX_TEXT) });
        }
        while ring.len() > DIAGNOSTICS_MAX_ENTRIES {
            ring.pop_front();
        }
    }

    pub fn entries(&self, key: &str) -> Vec<DiagnosticEntry> {
        let rings = self.rings.lock().unwrap_or_else(PoisonError::into_inner);
        rings.get(key).map(|ring| ring.iter().cloned().collect()).unwrap_or_default()
    }

    /// The ring as log lines: `12:00:01.234 stderr message`.
    pub fn lines(&self, key: &str, last: usize) -> Vec<String> {
        let entries = self.entries(key);
        entries[entries.len().saturating_sub(last)..]
            .iter()
            .map(|entry| format!("{} {:<6} {}", stamp(entry.at), entry.kind.as_str(), entry.text))
            .collect()
    }

    /// The report a user can copy: environment, the resolved config summary and the last log lines, with the
    /// server's user and host replaced by `<server>` and no secrets.
    pub fn report(&self, input: &DiagnosticsInput<'_>) -> String {
        let last = input.lines.unwrap_or(100);
        let ssh = if input.ssh_version.is_empty() { "unknown" } else { input.ssh_version };
        let mut parts = vec![
            "Mixdog SSH diagnostics".to_owned(),
            format!("App: {}", input.app_version),
            format!("OS: {}", input.os),
            format!("ssh: {ssh}"),
            "Config:".to_owned(),
        ];
        parts.extend(input.config.iter().map(|line| format!("  {line}")));
        parts.push(format!("Log (last {last} lines):"));
        parts.extend(self.lines(input.key, last));
        let text = parts.join("\n");
        redact_server(&redact_secrets(&text), &server_names(input.target, input.extra_names))
    }

    /// Starts recording one spawned ssh tool; the returned trace takes its output and exit.
    pub fn trace_spawn(self: &Arc<Self>, command: &str, args: &[String], key: Option<&str>, now: u64) -> SpawnTrace {
        let tunnel = args.iter().any(|arg| arg == "-N");
        let prefix = if tunnel { "start " } else { "" };
        self.record(key, if tunnel { DiagnosticKind::Tunnel } else { DiagnosticKind::Ssh }, &format!("{prefix}{}", describe_argv(command, args)), now);
        SpawnTrace { diagnostics: Arc::clone(self), key: key.map(str::to_owned), tunnel, started: now, results: String::new() }
    }
}

/// The recording of one spawned ssh tool: its stderr, the bootstrap result lines, its exit and duration, and the
/// tunnel's starts and exits.
pub struct SpawnTrace {
    diagnostics: Arc<Diagnostics>,
    key: Option<String>,
    tunnel: bool,
    started: u64,
    results: String,
}

impl SpawnTrace {
    fn record(&self, kind: DiagnosticKind, text: &str, at: u64) {
        self.diagnostics.record(self.key.as_deref(), kind, text, at);
    }

    /// Output on stdout: lines that start with `MIXDOG_` are the bootstrap results.
    pub fn stdout(&mut self, chunk: &[u8], now: u64) {
        if self.results.len() > MAX_RESULT_BUFFER {
            return;
        }
        self.results.push_str(&String::from_utf8_lossy(chunk));
        let buffered = std::mem::take(&mut self.results);
        let mut lines: Vec<&str> = buffered.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
        let rest = lines.pop().unwrap_or("");
        for line in lines {
            if line.starts_with("MIXDOG_") {
                self.record(DiagnosticKind::Result, line, now);
            }
        }
        self.results = rest.to_owned();
    }

    pub fn stderr(&self, chunk: &[u8], now: u64) {
        self.record(DiagnosticKind::Stderr, &String::from_utf8_lossy(chunk), now);
    }

    /// The tool could not be started.
    pub fn start_failed(&self, message: &str, now: u64) {
        self.record(DiagnosticKind::Exit, &format!("could not start: {message}"), now);
    }

    /// The tool ended; a result line still open is kept.
    pub fn closed(&mut self, code: Option<i32>, signal: Option<&str>, now: u64) {
        if self.results.starts_with("MIXDOG_") {
            let open = std::mem::take(&mut self.results);
            self.record(DiagnosticKind::Result, &open, now);
        }
        let ended = match signal {
            Some(signal) => format!("signal {signal}"),
            None => format!("code {}", code.map_or("null".to_owned(), |code| code.to_string())),
        };
        let prefix = if self.tunnel { "exited " } else { "" };
        let kind = if self.tunnel { DiagnosticKind::Tunnel } else { DiagnosticKind::Exit };
        self.record(kind, &format!("{prefix}{ended} after {} ms", now.saturating_sub(self.started)), now);
    }
}
