//! Device and network path guards, ported exactly from `src/runtime/shared/device-paths.mjs`.
//!
//! Reading these paths would hang (waiting for stdin / a tty), produce infinite output
//! (`/dev/zero`), or make Windows authenticate to an attacker's SMB host. The string checks run
//! before any stat; the stat-based [`is_special_file`] catches arbitrary inodes behind them.
//! `process.platform === 'win32'` in the Node source is `cfg!(windows)` here.

const BLOCKED_DEVICE_PATHS: [&str; 12] = [
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
    "/dev/full",
    "/dev/stdin",
    "/dev/tty",
    "/dev/console",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/fd/0",
    "/dev/fd/1",
    "/dev/fd/2",
];

/// POSIX pseudo-files a user-allowed path can still hit, plus the Linux stdio aliases
/// `/proc/self/fd/0-2` and `/proc/<pid>/fd/0-2`.
pub fn is_blocked_device_path(p: &str) -> bool {
    BLOCKED_DEVICE_PATHS.contains(&p) || (p.starts_with("/proc/") && (p.ends_with("/fd/0") || p.ends_with("/fd/1") || p.ends_with("/fd/2")))
}

/// UNC / SMB share paths (`\\server\share` or `//server/share`). Reading them makes Windows
/// authenticate to the remote host, leaking the user's NTLM hash. Both slash leaders count, so a
/// normalize that picked either form is caught.
pub fn is_unc_path(p: &str) -> bool {
    let mut chars = p.chars();
    matches!((chars.next(), chars.next()), (Some('\\'), Some('\\')) | (Some('/'), Some('/')))
}

/// Windows reserved device names. The Latin-1 superscript digits are listed literally because
/// Win32 normalizes them to 1/2/3 when resolving device names and upper-casing leaves them alone.
fn is_reserved_stem(stem: &str) -> bool {
    matches!(stem, "CON" | "NUL" | "PRN" | "AUX" | "CONIN$" | "CONOUT$")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|n| {
                let mut c = n.chars();
                matches!((c.next(), c.next()), (Some('0'..='9' | '\u{B9}' | '\u{B2}' | '\u{B3}'), None))
            })
        })
}

/// BOM, zero-width joiners and bidi controls that Win32 path-open codepaths collapse or ignore.
fn is_ignored_invisible(c: char) -> bool {
    matches!(c, '\u{FEFF}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

fn strip_invisibles(s: &str) -> String {
    s.chars().filter(|c| !is_ignored_invisible(*c)).collect()
}

/// Raw-device namespaces (`\\.\`, `\\?\`, both slash forms), then, on Windows only, reserved
/// basenames (CON/NUL/PRN/AUX/COM0-9/LPT0-9). A dotted extension means a normal file
/// (`dir/nul.bin`); an NTFS stream suffix (`NUL:stream`) or trailing dots/spaces (`CON. `) do not
/// hide the device.
pub fn is_windows_device_path(p: &str) -> bool {
    if p.is_empty() {
        return false;
    }
    if p.starts_with("\\\\.\\") || p.starts_with("\\\\?\\") || p.starts_with("//./") || p.starts_with("//?/") {
        return true;
    }
    if !cfg!(windows) {
        return false;
    }
    let base = p.rsplit(['\\', '/']).next().unwrap_or(p);
    let chars: Vec<char> = base.chars().collect();
    let cut = chars.iter().position(|c| *c == '.' || *c == ':').unwrap_or(chars.len());
    let stem: String = chars[..cut].iter().collect();
    let stem = strip_invisibles(&stem);
    let stem = stem.trim_end_matches(['.', ' ']).to_uppercase();
    is_reserved_stem(&stem) && cut >= chars.len()
}

/// Windows path-component guard: a component ending in `.` or space (Win32 strips them, so the
/// kernel opens a different path than the guard saw) or containing `:` after an optional drive
/// prefix (an NTFS Alternate Data Stream). `.` and `..` are exempt.
pub fn has_unsafe_win32_component(p: &str) -> bool {
    if !cfg!(windows) || p.is_empty() {
        return false;
    }
    let b = p.as_bytes();
    let rest = if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() { &p[2..] } else { p };
    rest.split(['\\', '/']).filter(|part| !part.is_empty()).any(|raw| {
        let part = strip_invisibles(raw);
        if part.is_empty() || part == "." || part == ".." {
            return false;
        }
        part.ends_with(['.', ' ']) || part.contains(':')
    })
}

/// FIFOs, character devices, block devices and sockets pass a normal stat, but reading them hangs
/// or produces unbounded output. Call it on the metadata of the path about to be read.
pub fn is_special_file(meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        let t = meta.file_type();
        t.is_fifo() || t.is_char_device() || t.is_block_device() || t.is_socket()
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_posix_pseudo_files_and_proc_stdio_aliases() {
        for p in ["/dev/zero", "/dev/fd/2", "/proc/self/fd/0", "/proc/1234/fd/2"] {
            assert!(is_blocked_device_path(p), "{p}");
        }
        for p in ["/dev/null", "/dev/fd/3", "/proc/self/fd/3", "/proc/1/status", "dev/zero", ""] {
            assert!(!is_blocked_device_path(p), "{p}");
        }
    }

    #[test]
    fn unc_paths_need_two_leading_separators_of_either_form() {
        for p in ["\\\\server\\share", "//server/share", "\\\\?\\C:\\x", "\\/x"] {
            assert_eq!(is_unc_path(p), p != "\\/x", "{p}");
        }
        assert!(!is_unc_path("/x") && !is_unc_path("C:\\x") && !is_unc_path("\\") && !is_unc_path(""));
    }

    #[test]
    fn raw_device_namespaces_are_rejected_on_every_host() {
        for p in ["\\\\.\\PhysicalDrive0", "\\\\?\\C:\\x", "//./CON", "//?/C:/x"] {
            assert!(is_windows_device_path(p), "{p}");
        }
        assert!(!is_windows_device_path("") && !is_windows_device_path("/home/u/file"));
    }

    #[test]
    fn reserved_basenames_are_devices_on_windows_only() {
        let reserved = ["con", "NUL", "dir\\prn", "C:/x/aux", "COM1", "lpt9", "CONIN$", "NUL ", "COM\u{B9}", "\u{FEFF}CON", "CON\u{200B}"];
        for p in reserved {
            assert_eq!(is_windows_device_path(p), cfg!(windows), "{p:?}");
        }
        // A stream suffix cuts the stem, so `nul:stream` is not a bare alias in the Node code either.
        // Node parity: any '.' or ':' cuts the stem and the cut means "has an extension", so a
        // trailing dot does not make `con.` a bare alias even though the stem is reserved.
        assert!(!is_windows_device_path("nul:stream") && !is_windows_device_path("con."));
        for p in ["nul.bin", "dir/con.txt", "console", "COM10", "COMX", "com"] {
            assert!(!is_windows_device_path(p), "{p}");
        }
    }

    #[test]
    fn win32_components_with_trailing_dots_spaces_or_streams_are_unsafe_on_windows_only() {
        let unsafe_paths = ["C:\\repo\\name.\\a.ts", "a\\b ", "a/b:stream", "C:\\x\\f.txt:hidden", "a\\b \u{200B}", "name\u{FEFF}:s"];
        for p in unsafe_paths {
            assert_eq!(has_unsafe_win32_component(p), cfg!(windows), "{p:?}");
        }
        for p in ["C:\\repo\\..\\a.ts", "src/./a.ts", "c:", "C:\\", "a\\\\b", "", "."] {
            assert!(!has_unsafe_win32_component(p), "{p:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn special_inodes_are_found_by_metadata() {
        assert!(is_special_file(&std::fs::metadata("/dev/null").unwrap()));
        assert!(!is_special_file(&std::fs::metadata(std::env::temp_dir()).unwrap()));
    }

    #[test]
    fn regular_files_and_directories_are_not_special() {
        let file = std::env::temp_dir().join(format!("mixdog-js-device-paths-{}", std::process::id()));
        std::fs::write(&file, "x").unwrap();
        let regular = is_special_file(&std::fs::metadata(&file).unwrap());
        std::fs::remove_file(&file).unwrap();
        assert!(!regular && !is_special_file(&std::fs::metadata(std::env::temp_dir()).unwrap()));
    }
}
