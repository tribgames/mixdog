//! Which host program serves a format: Windows PowerShell with the embedded scripts, or the Rust host, which is the
//! service binary started as `<program> office-com-host` (one-shot) or `<program> office-com-host --session`, with the
//! same stdio line protocol. The list of formats the Rust host serves is code, not configuration; a format that is
//! not on it, and a payload with no format, go to PowerShell. A one-shot `detect`, whatever format it probes, goes
//! where `docx` goes.

use std::ffi::OsString;

use serde_json::Value;

/// The formats served by the Rust host. Empty until the Rust host implements one.
pub(crate) const RUST_HOST_FORMATS: &[&str] = &[];

/// The format whose host serves `detect`.
const DETECT_FOLLOWS: &str = "docx";

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

/// The format a one-shot payload is routed by: its `format`, or [`DETECT_FOLLOWS`] for `detect` (the action compared
/// as the host compares it, case-insensitive).
pub(crate) fn one_shot_format(payload: &Value) -> Option<&str> {
    if payload.get("action").and_then(Value::as_str).is_some_and(|action| action.eq_ignore_ascii_case("detect")) {
        return Some(DETECT_FOLLOWS);
    }
    payload.get("format").and_then(Value::as_str)
}

/// The argument that carries the data directory the host keeps its record of the application under.
const DATA_DIR_ARG: &str = crate::host::ledger::DATA_DIR_FLAG;

/// The arguments the Rust host program is started with.
pub(crate) fn rust_host_args(session: bool, data_dir: &std::path::Path) -> Vec<OsString> {
    let mut args = vec![OsString::from(HOST_ARG)];
    if session {
        args.push(OsString::from(SESSION_ARG));
    }
    args.push(OsString::from(DATA_DIR_ARG));
    args.push(data_dir.as_os_str().to_owned());
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
    fn detect_is_routed_by_the_docx_entry() {
        assert_eq!(one_shot_format(&serde_json::json!({"action": "detect", "format": "xlsx"})), Some("docx"));
        assert_eq!(one_shot_format(&serde_json::json!({"action": "Detect", "format": "pptx"})), Some("docx"));
        assert_eq!(one_shot_format(&serde_json::json!({"action": "snapshot", "format": "xlsx"})), Some("xlsx"));
        assert_eq!(one_shot_format(&serde_json::json!({"action": "snapshot"})), None);
    }

    #[test]
    fn the_host_arguments_name_the_kind_of_host_and_the_data_directory() {
        let dir = std::path::Path::new("D:\\data");
        assert_eq!(rust_host_args(false, dir), ["office-com-host", "--data-dir", "D:\\data"].map(OsString::from));
        assert_eq!(rust_host_args(true, dir), ["office-com-host", "--session", "--data-dir", "D:\\data"].map(OsString::from));
    }
}
