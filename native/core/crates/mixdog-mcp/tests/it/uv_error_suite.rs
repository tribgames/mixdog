//! The name a system error carries: libuv's translation of Windows error codes and of POSIX errnos.

use mixdog_mcp::uv_error::error_code;
use mixdog_mcp::uv_error::win32_error_name;

#[cfg(windows)]
#[test]
fn a_system_error_carries_the_name_node_gives_it() {
    // ERROR_FILE_NOT_FOUND, ERROR_ACCESS_DENIED (Node says EPERM, not EACCES), ERROR_SHARING_VIOLATION.
    for (code, name) in [(2, "ENOENT"), (5, "EPERM"), (32, "EBUSY")] {
        assert_eq!(error_code(&std::io::Error::from_raw_os_error(code)), Some(name));
    }
    assert_eq!(error_code(&std::io::Error::other("no code")), None);
}

#[cfg(unix)]
#[test]
fn a_system_error_carries_the_name_of_its_errno() {
    assert_eq!(error_code(&std::io::Error::from_raw_os_error(libc::ENOENT)), Some("ENOENT"));
    assert_eq!(error_code(&std::io::Error::from_raw_os_error(libc::ECONNRESET)), Some("ECONNRESET"));
    assert_eq!(error_code(&std::io::Error::other("no code")), None);
}

#[test]
fn common_windows_errors_translate_to_the_codes_libuv_gives_them() {
    // ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_ACCESS_DENIED (libuv: EPERM, not EACCES), ERROR_SHARING_VIOLATION,
    // ERROR_FILE_EXISTS, ERROR_ALREADY_EXISTS, ERROR_TOO_MANY_OPEN_FILES, ERROR_INVALID_PARAMETER.
    for (code, name) in [(2, "ENOENT"), (3, "ENOENT"), (5, "EPERM"), (32, "EBUSY"), (80, "EEXIST"), (183, "EEXIST"), (4, "EMFILE"), (87, "EINVAL")] {
        assert_eq!(win32_error_name(code), name, "{code}");
    }
}

#[test]
fn a_windows_error_libuv_does_not_know_is_unknown() {
    assert_eq!(win32_error_name(0xdead_beef), "UNKNOWN");
}
