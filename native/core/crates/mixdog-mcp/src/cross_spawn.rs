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
    Shell { file: String, args: Vec<String> },
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
    lane: &InLane<SpawnIo>,
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Launch {
    parse_host(lane, &Host::current(), command, args, cwd, env)
}

/// [`parse`] for the given process facts.
pub fn parse_host(
    lane: &InLane<SpawnIo>,
    host: &Host,
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Launch {
    if cfg!(windows) {
        parse_windows(lane, host, command, args, cwd, env)
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
    lane: &InLane<SpawnIo>,
    host: &Host,
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Launch {
    let mut command = command.to_owned();
    let mut args = args.to_vec();
    // detectShebang
    let mut file = resolve_command(lane, host, &command, cwd, env);
    if let Some(found) = file.clone()
        && let Some(shebang) = read_shebang(lane, &found)
    {
        args.insert(0, found);
        command = shebang;
        file = resolve_command(lane, host, &command, cwd, env);
    }
    if let Some(file) = file.as_deref().filter(|f| is_executable(f)) {
        return Launch::Direct { shown: command, program: file.to_owned(), args };
    }
    let double = file.as_deref().is_some_and(is_cmd_shim);
    let command = escape_command(&normalize_win32(&command));
    let mut parts = vec![command];
    parts.extend(args.iter().map(|arg| escape_argument(arg, double)));
    let file = host.comspec.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| "cmd.exe".to_owned());
    Launch::Shell { file, args: ["/d", "/s", "/c"].map(str::to_owned).into_iter().chain([format!("\"{}\"", parts.join(" "))]).collect() }
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
fn read_shebang(lane: &InLane<SpawnIo>, file: &str) -> Option<String> {
    let head = mixdog_statefile::read_range(lane, Path::new(file), 0, 150).unwrap_or_default();
    shebang_command(&String::from_utf8_lossy(&head))
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
fn resolve_command(lane: &InLane<SpawnIo>, host: &Host, command: &str, cwd: Option<&str>, env: &BTreeMap<String, String>) -> Option<String> {
    // `path-key` on win32: the last key that spells PATH in any case; `which` falls back to the
    // process's own PATH when that value is empty.
    let from_env = env.iter().rev().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v.as_str());
    let path = from_env.filter(|p| !p.is_empty()).or(host.path.as_deref().filter(|p| !p.is_empty())).unwrap_or_default();
    // A custom cwd becomes the process's for the search when it can be entered.
    let entered = cwd.map(|c| host.process_cwd.join(c)).filter(|dir| is_dir(lane, dir));
    let base = entered.unwrap_or_else(|| host.process_cwd.clone());
    let found = [false, true].into_iter().find_map(|without_pathext| which(lane, host, command, path, &base, without_pathext))?;
    let root = match cwd {
        Some(c) => host.process_cwd.join(c),
        None => host.process_cwd.clone(),
    };
    Some(normalize_win32(&root.join(found).to_string_lossy()))
}

/// `which.sync`'s search; `without_pathext` is the second attempt (`pathExt: path.delimiter`).
fn which(lane: &InLane<SpawnIo>, host: &Host, command: &str, path: &str, base: &Path, without_pathext: bool) -> Option<String> {
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
            if is_exe(lane, base, &current, &exe_list) {
                return Some(current);
            }
        }
    }
    None
}

/// `isexe/windows.js`: a file whose name ends with one of `pathext`.
fn is_exe(lane: &InLane<SpawnIo>, base: &Path, candidate: &str, pathext: &str) -> bool {
    if !is_file(lane, &base.join(candidate)) {
        return false;
    }
    if pathext.is_empty() {
        return true;
    }
    let lower = candidate.to_lowercase();
    let list: Vec<&str> = pathext.split(';').collect();
    list.contains(&"") || list.iter().any(|p| lower.ends_with(&p.to_lowercase()))
}

fn is_file(lane: &InLane<SpawnIo>, path: &Path) -> bool {
    mixdog_statefile::metadata(lane, path).is_ok_and(|m| m.is_file())
}

fn is_dir(lane: &InLane<SpawnIo>, path: &Path) -> bool {
    mixdog_statefile::metadata(lane, path).is_ok_and(|m| m.is_dir())
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
