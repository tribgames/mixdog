//! libuv's Windows error table (`uv_translate_sys_error`, `src/win/error.c`) against the entries of
//! libuv's own source (`fixtures/plugins-status/uv-win32-errors.json`: every `case` with the value
//! windows-sys gives its constant, built by `tmp/gen-uv.mjs` from the libuv version Node reports in
//! `process.versions.uv`).

use std::collections::HashSet;

use mixdog_mcp::uv_error::error_code;
use mixdog_mcp::uv_error::win32_error_name;
use serde_json::Value;

const TABLE: &str = include_str!("../../../../fixtures/plugins-status/uv-win32-errors.json");

#[test]
fn every_entry_of_the_libuv_table_is_translated() {
    let table: Value = serde_json::from_str(TABLE).unwrap();
    let rows = table["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 100);
    for row in rows {
        let code = u32::try_from(row["code"].as_i64().unwrap()).unwrap();
        assert_eq!(win32_error_name(code), row["uv"].as_str().unwrap(), "{} ({code})", row["constant"]);
    }
}

#[test]
fn an_error_libuv_has_no_entry_for_is_unknown() {
    let table: Value = serde_json::from_str(TABLE).unwrap();
    let listed: HashSet<i64> = table["rows"].as_array().unwrap().iter().map(|row| row["code"].as_i64().unwrap()).collect();
    for code in (0..=12_000_u32).filter(|code| !listed.contains(&i64::from(*code))) {
        assert_eq!(win32_error_name(code), "UNKNOWN", "{code}");
    }
}

#[cfg(windows)]
#[test]
fn a_system_error_carries_the_name_node_gives_it() {
    // ERROR_FILE_NOT_FOUND, ERROR_ACCESS_DENIED (Node says EPERM, not EACCES), ERROR_SHARING_VIOLATION.
    for (code, name) in [(2, "ENOENT"), (5, "EPERM"), (32, "EBUSY")] {
        assert_eq!(error_code(&std::io::Error::from_raw_os_error(code)), Some(name));
    }
    assert_eq!(error_code(&std::io::Error::other("no code")), None);
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
const NAMES: &str = include_str!("../../../../fixtures/plugins-status/uv-errno-names.json");

/// Every errno of 1..=200 that has a name, against the list libuv's `errno.h` gives; what no errno of
/// this platform reaches is exactly what the platform lacks (`ECHARSET` is no platform's errno).
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn every_errno_libuv_names_is_named() {
    use mixdog_mcp::uv_error::errno_name;
    let listed: Value = serde_json::from_str(NAMES).unwrap();
    let listed: HashSet<&str> = listed["names"].as_array().unwrap().iter().map(|name| name.as_str().unwrap()).collect();
    assert_eq!(listed.len(), 69);
    let named: HashSet<&str> = (1..=200).map(errno_name).filter(|name| *name != "UNKNOWN").collect();
    assert!(named.is_subset(&listed), "{:?}", named.difference(&listed).collect::<Vec<_>>());
    let missing: HashSet<&str> = listed.difference(&named).copied().collect();
    let lacking: &[&str] = if cfg!(target_os = "linux") { &["ECHARSET", "EFTYPE"] } else { &["ECHARSET", "ENONET", "EUNATCH", "EREMOTEIO"] };
    assert_eq!(missing, lacking.iter().copied().collect::<HashSet<_>>());
}

#[cfg(unix)]
#[test]
fn a_system_error_carries_the_name_of_its_errno() {
    assert_eq!(error_code(&std::io::Error::from_raw_os_error(libc::ENOENT)), Some("ENOENT"));
    assert_eq!(error_code(&std::io::Error::from_raw_os_error(libc::ECONNRESET)), Some("ECONNRESET"));
    assert_eq!(error_code(&std::io::Error::other("no code")), None);
}