//! The path strings `read` refuses before it stats anything, and the host spellings it normalizes
//! (`shared/device-paths.mjs`, `posixPathToWindowsPath` / `windowsPathToPosixPath` of `path-utils.mjs`).

const BLOCKED_DEVICE_PATHS: [&str; 11] = [
    "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full", "/dev/stdin", "/dev/tty", "/dev/console", "/dev/stdout",
    "/dev/stderr", "/dev/fd/0", "/dev/fd/1",
];

const WIN_RESERVED_BASENAMES: [&str; 32] = [
    "CON", "NUL", "PRN", "AUX", "CONIN$", "CONOUT$", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "COM\u{b9}", "COM\u{b2}",
    "COM\u{b3}", "LPT\u{b9}", "LPT\u{b2}", "LPT\u{b3}",
];

/// BOM, zero-width joiners and bidi controls, which Win32 path opens ignore.
fn ignored_invisible(c: char) -> bool {
    matches!(c, '\u{feff}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

pub(super) fn is_blocked_device_path(p: &str) -> bool {
    BLOCKED_DEVICE_PATHS.contains(&p) || p == "/dev/fd/2" || (p.starts_with("/proc/") && (p.ends_with("/fd/0") || p.ends_with("/fd/1") || p.ends_with("/fd/2")))
}

/// `\\server\share` or `//server/share`.
pub(super) fn is_unc_path(p: &str) -> bool {
    p.starts_with("\\\\") || p.starts_with("//")
}

pub(super) fn is_windows_device_path(p: &str) -> bool {
    if p.is_empty() {
        return false;
    }
    if p.starts_with("\\\\.\\") || p.starts_with("\\\\?\\") || p.starts_with("//./") || p.starts_with("//?/") {
        return true;
    }
    if !cfg!(windows) {
        return false;
    }
    let base = p.rfind(['\\', '/']).map_or(p, |i| &p[i + 1..]);
    let cut = base.find(['.', ':']).unwrap_or(base.len());
    let stem: String = base[..cut].chars().filter(|c| !ignored_invisible(*c)).collect();
    let stem = stem.trim_end_matches(['.', ' ']).to_uppercase();
    WIN_RESERVED_BASENAMES.contains(&stem.as_str()) && cut >= base.len()
}

/// A component ending in a dot or space, or holding a colon after the drive: Win32 resolves a
/// different path, or an alternate data stream.
pub(super) fn has_unsafe_win32_component(p: &str) -> bool {
    if !cfg!(windows) || p.is_empty() {
        return false;
    }
    let bytes = p.as_bytes();
    let rest = if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() { &p[2..] } else { p };
    rest.split(['\\', '/']).filter(|part| !part.is_empty()).any(|raw| {
        let part: String = raw.chars().filter(|c| !ignored_invisible(*c)).collect();
        if part.is_empty() || part == "." || part == ".." {
            return false;
        }
        part.ends_with(['.', ' ']) || part.contains(':')
    })
}

/// The refusal a path string earns, in Node's order: UNC, device, ADS, blocked device.
pub(super) fn string_guard(p: &str) -> Option<&'static str> {
    if is_unc_path(p) {
        Some("cannot read UNC / SMB path (network credential leak risk)")
    } else if is_windows_device_path(p) {
        Some("cannot read Windows device path (reserved name or raw-device namespace)")
    } else if has_unsafe_win32_component(p) {
        Some("cannot read Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard)")
    } else if is_blocked_device_path(p) {
        Some("cannot read device file (would block or produce infinite output)")
    } else {
        None
    }
}

/// `posixPathToWindowsPath`: `/c/x`, `/cygdrive/c/x`, `/mnt/c/x` and `//host/x` on Windows.
pub(super) fn posix_path_to_windows(p: &str, host: Host) -> String {
    static CYG: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static MNT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static DRIVE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    if host != Host::Windows {
        return p.to_owned();
    }
    let re = |cell: &'static std::sync::OnceLock<regex::Regex>, pattern: &str| -> &'static regex::Regex {
        cell.get_or_init(|| regex::Regex::new(pattern).expect("a fixed pattern"))
    };
    if let Some(m) = re(&CYG, r"^/cygdrive/([a-zA-Z])/").captures(p) {
        return format!("{}:\\{}", &m[1], p[11..].replace('/', "\\"));
    }
    if let Some(m) = re(&MNT, r"^/mnt/([a-zA-Z])/").captures(p) {
        return format!("{}:\\{}", &m[1], p[7..].replace('/', "\\"));
    }
    if let Some(m) = re(&DRIVE, r"^/([a-zA-Z])/").captures(p) {
        return format!("{}:\\{}", &m[1], p[3..].replace('/', "\\"));
    }
    if p.starts_with("//") {
        return p.replace('/', "\\");
    }
    p.to_owned()
}

/// `windowsPathToPosixPath`: a Windows-host drive path under WSL is `/mnt/<drive>/…`.
pub(super) fn windows_path_to_posix(p: &str) -> String {
    let b = p.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        return format!("/mnt/{}/{}", (b[0] as char).to_ascii_lowercase(), p[3..].replace('\\', "/"));
    }
    if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return format!("/mnt/{}/", (b[0] as char).to_ascii_lowercase());
    }
    p.to_owned()
}

/// What `normalizeInputPath` branches on: the host's path conventions.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Host {
    Windows,
    Wsl,
    Other,
}

static WSL: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Records `isWSL` once: Linux, and `WSL_DISTRO_NAME` / `WSL_INTEROP` set, or `/proc/version`
/// (`proc_version`, read by the caller) naming Microsoft or WSL.
pub(super) fn set_wsl(proc_version: Option<&str>) {
    let found = cfg!(target_os = "linux")
        && (std::env::var_os("WSL_DISTRO_NAME").is_some_and(|v| !v.is_empty())
            || std::env::var_os("WSL_INTEROP").is_some_and(|v| !v.is_empty())
            || proc_version.is_some_and(|v| {
                let v = v.to_lowercase();
                v.contains("microsoft") || v.contains("wsl")
            }));
    let _ = WSL.set(found);
}

/// Whether `isWSL` has been settled, so the caller reads `/proc/version` only once.
pub(super) fn wsl_known() -> bool {
    WSL.get().is_some()
}

impl Host {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if WSL.get().copied().unwrap_or(false) {
            Self::Wsl
        } else {
            Self::Other
        }
    }
}

/// `os.homedir()`: `USERPROFILE` on Windows, `HOME` elsewhere, else the account's home.
pub(super) fn home_dir() -> Option<String> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(key).ok().filter(|v| !v.is_empty()).or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().into_owned()))
}

/// The host-specific part of `normalizeInputPath`, after trim and `~`: the POSIX spellings of a
/// drive on Windows, the Windows drive spelling under WSL.
pub(super) fn host_spelling(out: &str, host: Host) -> String {
    static POSIX_DRIVE_COLON: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static POSIX_SHAPES: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = |cell: &'static std::sync::OnceLock<regex::Regex>, pattern: &str| -> &'static regex::Regex {
        cell.get_or_init(|| regex::Regex::new(pattern).expect("a fixed pattern"))
    };
    match host {
        Host::Windows => {
            if re(&POSIX_SHAPES, r"^(?:/[a-zA-Z]/|/cygdrive/[a-zA-Z]/|/mnt/[a-zA-Z]/|//)").is_match(out) {
                return posix_path_to_windows(out, host);
            }
            if re(&POSIX_DRIVE_COLON, r"^/[a-zA-Z]:[\\/]").is_match(out) {
                return format!("{}:\\{}", &out[1..2], out[4..].replace('/', "\\"));
            }
            out.to_owned()
        }
        Host::Wsl => windows_path_to_posix(out),
        Host::Other => out.to_owned(),
    }
}
/// The order Node lists a directory in: the file system's own on Windows (NTFS keeps names in
/// upper-cased UTF-16 order), libuv's `alphasort` (bytes) everywhere else.
pub(super) fn dir_order_key(name: &str) -> Vec<u16> {
    if cfg!(windows) { name.to_uppercase().encode_utf16().collect() } else { name.bytes().map(u16::from).collect() }
}
/// `normalizeErrorMessage`'s `redact` of one absolute path (forward slashes): relative to `cwd`
/// when under it, else behind the runtime, data, root or home prefix it lies under.
pub(super) fn redact(raw: &str, cwd: Option<&str>) -> String {
    let fwd = raw.replace('\\', "/");
    let under = |root: &str, path: &str| -> Option<String> {
        let (r, p) = if cfg!(windows) { (root.to_lowercase(), path.to_lowercase()) } else { (root.to_owned(), path.to_owned()) };
        if p == r {
            Some(String::new())
        } else {
            p.strip_prefix(&format!("{r}/")).map(|_| path[root.len()..].to_owned())
        }
    };
    if let Some(cwd) = cwd.map(|c| c.replace('\\', "/")).filter(|c| !c.is_empty())
        && let Some(rest) = under(cwd.trim_end_matches('/'), &fwd)
        && let Some(rel) = rest.strip_prefix('/')
        && !rel.is_empty()
    {
        return rel.to_owned();
    }
    let env = |key: &str| std::env::var(key).ok().map(|v| v.replace('\\', "/")).filter(|v| !v.is_empty());
    let home = home_dir().map(|h| h.replace('\\', "/"));
    let mixdog_home = env("MIXDOG_HOME").or_else(|| home.as_ref().map(|h| format!("{h}/.mixdog")));
    let data = env("MIXDOG_DATA_DIR").or_else(|| mixdog_home.map(|h| format!("{h}/data")));
    for (prefix, label) in [(env("MIXDOG_RUNTIME_ROOT"), "<runtime>"), (data, "<mixdog-data>"), (env("MIXDOG_ROOT"), "<mixdog-root>"), (home, "~")] {
        if let Some(prefix) = prefix
            && let Some(rest) = under(&prefix, &fwd)
        {
            return format!("{label}{rest}");
        }
    }
    fwd
}
/// `normalizeErrorMessage`'s pass over quoted absolute paths: each is redacted as `redact` does.
pub(super) fn normalize_error_message(msg: &str, cwd: Option<&str>) -> String {
    static QUOTED: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let quoted = QUOTED.get_or_init(|| {
        regex::Regex::new(r#"'([A-Za-z]:[\\/][^'"]+|/[^'"]+)'|"([A-Za-z]:[\\/][^'"]+|/[^'"]+)""#).expect("a fixed pattern")
    });
    static FILE_URI: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let file_uri = FILE_URI.get_or_init(|| regex::Regex::new(r#"file:///([A-Za-z]:/[^\s'"<>)\]]+|/[^\s'"<>)\]]+)"#).expect("a fixed pattern"));
    let msg = file_uri.replace_all(msg, |c: &regex::Captures| redact(&c[1], cwd));
    quoted
        .replace_all(&msg, |c: &regex::Captures| match (c.get(1), c.get(2)) {
            (Some(p), _) => format!("'{}'", redact(p.as_str(), cwd)),
            (None, Some(p)) => format!("\"{}\"", redact(p.as_str(), cwd)),
            (None, None) => c[0].to_owned(),
        })
        .into_owned()
}