//! Address suggestions: the Host aliases of the user's ~/.ssh/config, with `Include` expanded.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::command::parse_ssh_target;
use crate::context::ConfigFiles;

/// A `Host` alias of the user's ssh config; `detail` is `user@host[:port]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshConfigHost {
    pub alias: String,
    pub detail: String,
}

/// The Host aliases of the user's ssh config (mirrors the protocol type, which the ops convert into).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SshConfigSummary {
    pub hosts: Vec<SshConfigHost>,
}

const MAX_INCLUDE_DEPTH: usize = 8;

fn regex(source: &str) -> Option<Regex> {
    Regex::new(source).ok()
}

static KEY_VALUE_LINE: LazyLock<Option<Regex>> = LazyLock::new(|| regex(r"^([A-Za-z0-9_]+)(?:\s*=\s*|\s+)(.+)$"));
static TRAILING_COMMENT: LazyLock<Option<Regex>> = LazyLock::new(|| regex(r"\s+#.*$"));
static INCLUDE_LINE: LazyLock<Option<Regex>> = LazyLock::new(|| regex(r"(?i)^\s*include(?:\s*=\s*|\s+)(.+?)\s*$"));
static INCLUDE_ARGUMENT: LazyLock<Option<Regex>> = LazyLock::new(|| regex(r#""([^"]*)"|(\S+)"#));

struct Block {
    alias: String,
    hostname: String,
    user: String,
    port: String,
}

fn flush(block: &mut Vec<Block>, hosts: &mut Vec<SshConfigHost>) {
    for entry in block.drain(..) {
        let port = if !entry.port.is_empty() && entry.port != "22" { format!(":{}", entry.port) } else { String::new() };
        let user = if entry.user.is_empty() { String::new() } else { format!("{}@", entry.user) };
        let host = if entry.hostname.is_empty() { entry.alias.as_str() } else { entry.hostname.as_str() };
        hosts.push(SshConfigHost { alias: entry.alias.clone(), detail: format!("{user}{host}{port}") });
    }
}

fn unquote(value: &str) -> &str {
    value.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')).unwrap_or(value)
}

/// Host aliases with the `user@host[:port]` they resolve to. Wildcard and negated patterns and aliases ssh could
/// not be given are skipped.
pub fn parse_config_hosts(text: &str) -> Vec<SshConfigHost> {
    let mut hosts: Vec<SshConfigHost> = Vec::new();
    let mut block: Vec<Block> = Vec::new();
    let (Some(key_value), Some(comment)) = (KEY_VALUE_LINE.as_ref(), TRAILING_COMMENT.as_ref()) else {
        return hosts;
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(captures) = key_value.captures(line) else { continue };
        let key = captures[1].to_lowercase();
        let value = comment.replace(&captures[2], "");
        let value = unquote(value.trim());
        match key.as_str() {
            "host" => {
                flush(&mut block, &mut hosts);
                for alias in value.split_whitespace() {
                    if alias.contains(['*', '?', '!'])
                        || hosts.iter().any(|host| host.alias == alias)
                        || block.iter().any(|entry| entry.alias == alias)
                        || parse_ssh_target(alias).is_err()
                    {
                        continue;
                    }
                    block.push(Block {
                        alias: alias.to_owned(),
                        hostname: String::new(),
                        user: String::new(),
                        port: String::new(),
                    });
                }
            }
            "match" => flush(&mut block, &mut hosts),
            "hostname" | "user" | "port" => {
                for entry in &mut block {
                    let slot = match key.as_str() {
                        "hostname" => &mut entry.hostname,
                        "user" => &mut entry.user,
                        _ => &mut entry.port,
                    };
                    if slot.is_empty() {
                        *slot = value.to_owned();
                    }
                }
            }
            _ => {}
        }
    }
    flush(&mut block, &mut hosts);
    hosts
}

fn is_separator(c: char) -> bool {
    c == '/' || c == '\\'
}

fn is_absolute(raw: &str) -> bool {
    let rest = match raw.as_bytes() {
        [letter, b':', ..] if letter.is_ascii_alphabetic() => &raw[2..],
        _ => raw,
    };
    rest.starts_with(is_separator)
}

/// A name with `*` and `?` as a regular expression over a file name.
fn name_pattern(name: &str) -> Option<Regex> {
    let mut source = String::from("^");
    for c in name.chars() {
        match c {
            '*' => source.push_str(".*"),
            '?' => source.push('.'),
            other => source.push_str(&regex::escape(&other.to_string())),
        }
    }
    source.push('$');
    Regex::new(&source).ok()
}

/// Node's `path.join` normalisation of a joined path: `.` and `..` segments collapse and the separators are the platform's, so the
/// same file reached by two spellings is one entry of the loop guard.
fn normalized(path: &Path) -> PathBuf {
    let mut parts: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match parts.last() {
                Some(Component::Normal(_)) => {
                    parts.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => parts.push(component),
            },
            other => parts.push(other),
        }
    }
    if parts.is_empty() { PathBuf::from(".") } else { parts.into_iter().collect() }
}

fn include_targets(argument: &str, user_dir: &Path, home: &Path, files: &dyn ConfigFiles) -> Vec<PathBuf> {
    let mut targets = Vec::new();
    let Some(arguments) = INCLUDE_ARGUMENT.as_ref() else { return targets };
    for captures in arguments.captures_iter(argument) {
        let raw = captures.get(1).or_else(|| captures.get(2)).map_or("", |part| part.as_str());
        let expanded: PathBuf = if raw == "~" || (raw.starts_with('~') && raw[1..].starts_with(is_separator)) {
            normalized(&home.join(raw[1..].trim_start_matches(is_separator)))
        } else if is_absolute(raw) {
            PathBuf::from(raw)
        } else {
            normalized(&user_dir.join(raw))
        };
        let text = expanded.to_string_lossy().into_owned();
        let split = text.rfind(is_separator);
        let (directory, name) = match split {
            Some(at) => (&text[..at], &text[at + 1..]),
            None => ("", text.as_str()),
        };
        if !name.contains(['*', '?']) {
            targets.push(expanded);
            continue;
        }
        let Some(pattern) = name_pattern(name) else { continue };
        let mut names = files.list_names(Path::new(directory));
        names.sort();
        targets.extend(names.into_iter().filter(|entry| pattern.is_match(entry)).map(|entry| Path::new(directory).join(entry)));
    }
    targets
}

/// The config text with every `Include` line replaced by the files it names (relative paths resolve against
/// ~/.ssh, wildcards in the file name expand, loops and deep chains are cut).
pub fn expand_includes(text: &str, home: &Path, files: &dyn ConfigFiles, depth: usize, active: &BTreeSet<PathBuf>) -> String {
    let user_dir = home.join(".ssh");
    let Some(include) = INCLUDE_LINE.as_ref() else { return text.to_owned() };
    let mut out: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(captures) = include.captures(line) else {
            out.push(line.to_owned());
            continue;
        };
        if depth >= MAX_INCLUDE_DEPTH {
            out.push(String::new());
            continue;
        }
        let mut parts: Vec<String> = Vec::new();
        for path in include_targets(&captures[1], &user_dir, home, files) {
            if active.contains(&path) {
                continue;
            }
            if let Some(included) = files.read_text(&path) {
                let mut inner = active.clone();
                inner.insert(path);
                parts.push(expand_includes(&included, home, files, depth + 1, &inner));
            }
        }
        out.push(parts.join("\n"));
    }
    out.join("\n")
}

/// The Host aliases of `<home>/.ssh/config` with their Includes; empty when the file is not there.
pub fn config_hosts(home: &Path, files: &dyn ConfigFiles) -> SshConfigSummary {
    let file = home.join(".ssh").join("config");
    let Some(text) = files.read_text(&file) else { return SshConfigSummary::default() };
    let active = BTreeSet::from([file]);
    SshConfigSummary { hosts: parse_config_hosts(&expand_includes(&text, home, files, 0, &active)) }
}
