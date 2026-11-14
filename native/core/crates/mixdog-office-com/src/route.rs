//! Which host program serves a format: Windows PowerShell with the embedded scripts, or the Rust host, which is the
//! service binary started as `<program> office-com-host` (one-shot) or `<program> office-com-host --session`, with the
//! same stdio line protocol. The list of formats the Rust host serves is code, not configuration; a format that is
//! not on it, and a payload with no format, go to PowerShell.

use std::ffi::OsString;

/// The formats served by the Rust host. Empty until the Rust host implements one; `detect` follows `docx`.
pub(crate) const RUST_HOST_FORMATS: &[&str] = &[];

/// The first argument of the Rust host, for both kinds of host.
const HOST_ARG: &str = "office-com-host";

/// The second argument of the Rust host when it is a session host.
const SESSION_ARG: &str = "--session";

/// Whether `format` (a payload's `format`, compared as the hosts compare it: trimmed, case-insensitive) is in `list`.
pub(crate) fn serves<'a>(list: impl IntoIterator<Item = &'a str>, format: Option<&str>) -> bool {
    let Some(format) = format.map(str::trim).filter(|format| !format.is_empty()) else {
        return false;
    };
    list.into_iter().any(|served| served.eq_ignore_ascii_case(format))
}

/// The arguments the Rust host program is started with.
pub(crate) fn rust_host_args(session: bool) -> Vec<OsString> {
    let mut args = vec![OsString::from(HOST_ARG)];
    if session {
        args.push(OsString::from(SESSION_ARG));
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_format_is_served_only_when_it_is_listed() {
        assert!(serves(["docx"], Some("docx")));
        assert!(serves(["docx"], Some(" DOCX ")));
        assert!(!serves(["docx"], Some("xlsx")));
        assert!(!serves(["docx"], Some("")));
        assert!(!serves(["docx"], None));
    }

    #[test]
    fn the_shipped_list_serves_nothing() {
        for format in ["docx", "xlsx", "pptx"] {
            assert!(!serves(RUST_HOST_FORMATS.iter().copied(), Some(format)));
        }
    }

    #[test]
    fn the_host_arguments_name_the_kind_of_host() {
        assert_eq!(rust_host_args(false), [OsString::from("office-com-host")]);
        assert_eq!(rust_host_args(true), [OsString::from("office-com-host"), OsString::from("--session")]);
    }
}
