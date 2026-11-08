//! How Node's MCP SDK starts a stdio server: `cross-spawn` 7.0.6 (`lib/parse.js` and its `util/`),
//! with `which` 2.0.2, `path-key`, `shebang-command` and `isexe` 2.0.0 as it uses them. Off Windows
//! it is a plain spawn. On Windows a command that does not resolve to a `.exe`/`.com` (including one
//! that does not resolve at all) runs as `%COMSPEC% /d /s /c "<escaped command line>"`, so a server
//! that cannot start is a shell that prints to stderr and exits, never a spawn error.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::InLane;
use mixdog_rt::SpawnIo;

/// What to start.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Launch {
    /// `program` with `args`. `shown` is the command as cross-spawn hands it to `child_process.spawn`
    /// (what Node names in a failed spawn: `spawn <shown> ENOENT`); `program` is where it resolved.
    Direct { shown: String, program: String, args: Vec<String> },
    /// Windows: `file /d /s /c "<line>"`, the arguments verbatim (`windowsVerbatimArguments`).
    Shell { file: String, line: String },
}

/// The process facts cross-spawn reads from Node's `process`.
pub struct Host {
    pub process_cwd: PathBuf,
    /// `process.env.PATH`, the fallback when the server's environment names none.
    pub path: Option<String>,
    /// `process.env.PATHEXT`.
    pub pathext: Option<String>,
    /// `process.env.comspec`.
    pub comspec: Option<String>,
}

impl Host {
    fn current() -> Self {
        Self {
            process_cwd: std::env::current_dir().unwrap_or_default(),
            path: std::env::var("PATH").ok(),
            pathext: std::env::var("PATHEXT").ok(),
            comspec: std::env::var("COMSPEC").ok(),
        }
    }
}

/// `cross-spawn`'s `parse(command, args, { env, cwd })` for `shell: false`.
pub fn parse(
    _lane: &InLane<SpawnIo>,
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Launch {
    if cfg!(windows) {
        parse_windows(&Host::current(), command, args, cwd, env)
    } else {
        Launch::Direct { shown: command.to_owned(), program: command.to_owned(), args: args.to_vec() }
    }
}

fn is_executable(file: &str) -> bool {
    let lower = file.to_ascii_lowercase();
    lower.ends_with(".com") || lower.ends_with(".exe")
}

/// `/node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i`: the `.` after `node_modules[\\/]` matches any character.
fn is_cmd_shim(file: &str) -> bool {
    let lower = file.to_ascii_lowercase();
    let Some(name) = lower.strip_suffix(".cmd") else { return false };
    let bytes = name.as_bytes();
    let is_sep = |b: u8| b == b'\\' || b == b'/';
    (0..bytes.len()).any(|at| {
        let rest = &bytes[at..];
        let Some(rest) = rest.strip_prefix(b"node_modules") else { return false };
        let [sep, _any, b'b', b'i', b'n', sep2, base @ ..] = rest else { return false };
        is_sep(*sep) && is_sep(*sep2) && !base.is_empty() && !base.iter().any(|b| is_sep(*b))
    })
}

/// The Windows branch of cross-spawn's `parseNonShell`.
pub fn parse_windows(
    host: &Host,
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Launch {
    let mut command = command.to_owned();
    let mut args = args.to_vec();
    // detectShebang
    let mut file = resolve_command(host, &command, cwd, env);
    if let Some(found) = file.clone()
        && let Some(shebang) = read_shebang(&found)
    {
        args.insert(0, found);
        command = shebang;
        file = resolve_command(host, &command, cwd, env);
    }
    if let Some(file) = file.as_deref().filter(|f| is_executable(f)) {
        return Launch::Direct { shown: command, program: file.to_owned(), args };
    }
    let double = file.as_deref().is_some_and(is_cmd_shim);
    let command = escape_command(&normalize_win32(&command));
    let mut parts = vec![command];
    parts.extend(args.iter().map(|arg| escape_argument(arg, double)));
    let file = host.comspec.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| "cmd.exe".to_owned());
    Launch::Shell { file, line: format!("\"{}\"", parts.join(" ")) }
}

const META: &str = "()][%!^\"`<>&|;, *?";

fn caret(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if META.contains(c) {
            out.push('^');
        }
        out.push(c);
    }
    out
}

/// `escape.command`.
pub fn escape_command(arg: &str) -> String {
    caret(arg)
}

/// `escape.argument`, with its regular expressions exactly as cross-spawn 7.0.6 spells them:
/// `/(?=(\\+?)?)\1"/g` (a lookahead is atomic, so it holds ONE backslash: that backslash and a
/// quote become three backslashes and the quote, a bare quote a backslash and the quote) and
/// `/(?=(\\+?)?)\1$/` (only a last backslash is doubled).
pub fn escape_argument(arg: &str, double: bool) -> String {
    let chars: Vec<char> = arg.chars().collect();
    let mut quoted = String::with_capacity(arg.len() + 2);
    let mut at = 0;
    while at < chars.len() {
        match (chars[at], chars.get(at + 1)) {
            ('\\', Some('"')) => {
                quoted.push_str("\\\\\\\"");
                at += 2;
            }
            ('"', _) => {
                quoted.push_str("\\\"");
                at += 1;
            }
            (c, _) => {
                quoted.push(c);
                at += 1;
            }
        }
    }
    if quoted.ends_with('\\') {
        quoted.push('\\');
    }
    let mut out = caret(&format!("\"{quoted}\""));
    if double {
        out = caret(&out);
    }
    out
}

/// `readShebang` + `shebang-command`: the interpreter a script's first line names, `None` for none.
#[allow(clippy::disallowed_methods, reason = "runs as a spawn-lane job (InLane proof of `parse`)")]
fn read_shebang(file: &str) -> Option<String> {
    use std::io::Read;
    let mut buffer = [0u8; 150];
    let read = std::fs::File::open(file).and_then(|mut f| f.read(&mut buffer)).unwrap_or(0);
    shebang_command(&String::from_utf8_lossy(&buffer[..read]))
}

fn shebang_command(text: &str) -> Option<String> {
    let line = text.strip_prefix("#!")?;
    let line = line.split(['\n', '\r', '\u{2028}', '\u{2029}']).next().unwrap_or_default();
    let line = line.strip_prefix(' ').unwrap_or(line);
    let mut words = line.split(' ');
    let path = words.next().unwrap_or_default();
    let argument = words.next().unwrap_or_default();
    let binary = path.rsplit('/').next().unwrap_or_default();
    let command = if binary == "env" {
        argument.to_owned()
    } else if argument.is_empty() {
        binary.to_owned()
    } else {
        format!("{binary} {argument}")
    };
    Some(command).filter(|c| !c.is_empty())
}

const DEFAULT_PATHEXT: &str = ".EXE;.CMD;.BAT;.COM";

/// `resolveCommand`: the command as an absolute path, trying the environment's `PATHEXT` and then none.
fn resolve_command(host: &Host, command: &str, cwd: Option<&str>, env: &BTreeMap<String, String>) -> Option<String> {
    // `path-key` on win32: the last key that spells PATH in any case; `which` falls back to the
    // process's own PATH when that value is empty.
    let from_env = env.iter().rev().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v.as_str());
    let path = from_env.filter(|p| !p.is_empty()).or(host.path.as_deref().filter(|p| !p.is_empty())).unwrap_or_default();
    // A custom cwd becomes the process's for the search when it can be entered.
    let entered = cwd.map(|c| host.process_cwd.join(c)).filter(|dir| is_dir(dir));
    let base = entered.unwrap_or_else(|| host.process_cwd.clone());
    let found = [false, true].into_iter().find_map(|without_pathext| which(host, command, path, &base, without_pathext))?;
    let root = match cwd {
        Some(c) => host.process_cwd.join(c),
        None => host.process_cwd.clone(),
    };
    Some(normalize_win32(&root.join(found).to_string_lossy()))
}

/// `which.sync`'s search; `without_pathext` is the second attempt (`pathExt: path.delimiter`).
fn which(host: &Host, command: &str, path: &str, base: &Path, without_pathext: bool) -> Option<String> {
    let has_slash = command.contains('/') || command.contains('\\');
    let dirs: Vec<String> = if has_slash {
        vec![String::new()]
    } else {
        std::iter::once(base.to_string_lossy().into_owned()).chain(path.split(';').map(str::to_owned)).collect()
    };
    let exe_list = if without_pathext {
        ";".to_owned()
    } else {
        host.pathext.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| DEFAULT_PATHEXT.to_owned())
    };
    let mut extensions: Vec<&str> = exe_list.split(';').collect();
    if command.contains('.') && !extensions[0].is_empty() {
        extensions.insert(0, "");
    }
    for dir in &dirs {
        let part = match dir.strip_prefix('"').and_then(|d| d.strip_suffix('"')) {
            Some(inner) => inner,
            None => dir,
        };
        let joined = if part.is_empty() { normalize_win32(command) } else { normalize_win32(&format!("{part}\\{command}")) };
        let candidate = if part.is_empty() && (command.starts_with(".\\") || command.starts_with("./")) {
            format!("{}{}", &command[..2], joined)
        } else {
            joined
        };
        for extension in &extensions {
            let current = format!("{candidate}{extension}");
            if is_exe(base, &current, &exe_list) {
                return Some(current);
            }
        }
    }
    None
}

/// `isexe/windows.js`: a file whose name ends with one of `pathext`.
#[allow(clippy::disallowed_methods, reason = "runs as a spawn-lane job (InLane proof of `parse`)")]
fn is_exe(base: &Path, candidate: &str, pathext: &str) -> bool {
    if !base.join(candidate).is_file() {
        return false;
    }
    if pathext.is_empty() {
        return true;
    }
    let lower = candidate.to_lowercase();
    let list: Vec<&str> = pathext.split(';').collect();
    list.contains(&"") || list.iter().any(|p| lower.ends_with(&p.to_lowercase()))
}

#[allow(clippy::disallowed_methods, reason = "runs as a spawn-lane job (InLane proof of `parse`)")]
fn is_dir(path: &Path) -> bool {
    path.is_dir()
}

/// `path.win32.normalize`.
pub fn normalize_win32(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let path = path.replace('/', "\\");
    let (root, rest) = split_root(&path);
    let absolute = root.ends_with('\\');
    let mut kept: Vec<&str> = Vec::new();
    for segment in rest.split('\\').filter(|s| !s.is_empty() && *s != ".") {
        if segment == ".." {
            match kept.last() {
                Some(last) if *last != ".." => {
                    kept.pop();
                }
                _ if absolute => {}
                _ => kept.push(".."),
            }
        } else {
            kept.push(segment);
        }
    }
    let mut tail = kept.join("\\");
    if tail.is_empty() && !absolute {
        tail.push('.');
    }
    if !tail.is_empty() && path.ends_with('\\') {
        tail.push('\\');
    }
    format!("{root}{tail}")
}

/// The device/root prefix of a win32 path and what follows it.
fn split_root(path: &str) -> (String, &str) {
    let bytes = path.as_bytes();
    if let Some(unc) = path.strip_prefix("\\\\") {
        let mut parts = unc.splitn(3, '\\');
        if let (Some(server), Some(share)) = (parts.next(), parts.next())
            && !server.is_empty()
            && !share.is_empty()
        {
            let root = format!("\\\\{server}\\{share}\\");
            return (root, parts.next().unwrap_or_default());
        }
    }
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return if bytes.get(2) == Some(&b'\\') {
            (path[..3].to_owned(), &path[3..])
        } else {
            (path[..2].to_owned(), &path[2..])
        };
    }
    if bytes.first() == Some(&b'\\') {
        return ("\\".to_owned(), &path[1..]);
    }
    (String::new(), path)
}

/// cross-spawn's `_parse` as recorded from Node (`fixtures/stdio-spawn/golden.json`, `record-stdio-spawn.mjs`) over the same
/// fixture tree, PATHEXT, COMSPEC and process directory.
#[cfg(all(test, windows))]
#[allow(clippy::disallowed_methods, reason = "test fixtures are written directly")]
mod replay {
    use super::*;
    use serde_json::Value;

    const GOLDEN: &str = include_str!("../../../fixtures/stdio-spawn/golden.json");

    #[test]
    fn every_recorded_parse_is_reproduced() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        for file in golden["files"].as_array().unwrap() {
            let full = dir.path().join(file["path"].as_str().unwrap());
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, file["text"].as_str().unwrap()).unwrap();
        }
        let expand = |text: &str| text.replace("<ROOT>", &root);
        let mask = |text: &str| text.replace(&root, "<ROOT>");
        for case in golden["parse"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let host = Host {
                process_cwd: PathBuf::from(expand(golden["host"]["processCwd"].as_str().unwrap())),
                path: case["processPath"].as_str().map(expand),
                pathext: golden["host"]["pathext"].as_str().map(str::to_owned),
                comspec: golden["host"]["comspec"].as_str().map(str::to_owned),
            };
            let env = BTreeMap::from([("PATH".to_owned(), expand(case["path"].as_str().unwrap()))]);
            let args: Vec<String> = case["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect();
            let cwd = case["cwd"].as_str().map(expand);
            let launch = parse_windows(&host, &expand(case["command"].as_str().unwrap()), &args, cwd.as_deref(), &env);
            let want = &case["launch"];
            let strings = |value: &Value| -> Vec<String> { value.as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect() };
            match launch {
                Launch::Shell { file, line } => {
                    assert_eq!(want["kind"], "shell", "{name}");
                    assert_eq!(file, want["file"].as_str().unwrap(), "{name}");
                    assert_eq!(strings(&want["args"]), ["/d", "/s", "/c", mask(&line).as_str()], "{name}");
                }
                Launch::Direct { shown, program, args } => {
                    assert_eq!(want["kind"], "direct", "{name}");
                    assert_eq!(mask(&shown), want["shown"].as_str().unwrap(), "{name}");
                    assert_eq!(args.iter().map(|a| mask(a)).collect::<Vec<_>>(), strings(&want["args"]), "{name}");
                    if let Some(recorded) = want["program"].as_str() {
                        assert_eq!(mask(&program), recorded, "{name}");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shebang_words() {
        assert_eq!(shebang_command("#!/usr/bin/env node\nx"), Some("node".to_owned()));
        assert_eq!(shebang_command("#! /bin/sh -e\n"), Some("sh -e".to_owned()));
        assert_eq!(shebang_command("#!/usr/bin/env\n"), None);
        assert_eq!(shebang_command("echo hi"), None);
    }

    #[test]
    fn normalize_matches_node_win32() {
        assert_eq!(normalize_win32("a/b/../c"), "a\\c");
        assert_eq!(normalize_win32("./x"), "x");
        assert_eq!(normalize_win32("C:\\a\\..\\..\\b\\"), "C:\\b\\");
        assert_eq!(normalize_win32(""), ".");
        assert_eq!(normalize_win32("..\\..\\x"), "..\\..\\x");
    }
}
