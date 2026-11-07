//! The `code` Node puts on a failed system call, which comes from libuv: on Windows the Win32 error is
//! translated to a libuv errno by `uv_translate_sys_error` (`src/win/error.c`, libuv 1.51.0, the libuv of the Node the
//! goldens were recorded on) and named by `uv_err_name`; elsewhere the errno names itself. An error
//! libuv has no entry for is `UNKNOWN` (`UV_UNKNOWN`, Node's `uvUnmappedError`).

/// `uv_err_name(uv_translate_sys_error(code))` for a Win32 or Winsock error.
pub fn win32_error_name(code: u32) -> &'static str {
    match code {
        10013 => "EACCES", // WSAEACCES
        740 => "EACCES", // ERROR_ELEVATION_REQUIRED
        1920 => "EACCES", // ERROR_CANT_ACCESS_FILE
        1227 => "EADDRINUSE", // ERROR_ADDRESS_ALREADY_ASSOCIATED
        10048 => "EADDRINUSE", // WSAEADDRINUSE
        10049 => "EADDRNOTAVAIL", // WSAEADDRNOTAVAIL
        10047 => "EAFNOSUPPORT", // WSAEAFNOSUPPORT
        10035 => "EAGAIN", // WSAEWOULDBLOCK
        232 => "EAGAIN", // ERROR_NO_DATA
        10037 => "EALREADY", // WSAEALREADY
        1004 => "EBADF", // ERROR_INVALID_FLAGS
        6 => "EBADF", // ERROR_INVALID_HANDLE
        33 => "EBUSY", // ERROR_LOCK_VIOLATION
        231 => "EBUSY", // ERROR_PIPE_BUSY
        32 => "EBUSY", // ERROR_SHARING_VIOLATION
        995 => "ECANCELED", // ERROR_OPERATION_ABORTED
        10004 => "ECANCELED", // WSAEINTR
        1113 => "ECHARSET", // ERROR_NO_UNICODE_TRANSLATION
        1236 => "ECONNABORTED", // ERROR_CONNECTION_ABORTED
        10053 => "ECONNABORTED", // WSAECONNABORTED
        1225 => "ECONNREFUSED", // ERROR_CONNECTION_REFUSED
        10061 => "ECONNREFUSED", // WSAECONNREFUSED
        64 => "ECONNRESET", // ERROR_NETNAME_DELETED
        10054 => "ECONNRESET", // WSAECONNRESET
        183 => "EEXIST", // ERROR_ALREADY_EXISTS
        80 => "EEXIST", // ERROR_FILE_EXISTS
        998 => "EFAULT", // ERROR_NOACCESS
        10014 => "EFAULT", // WSAEFAULT
        1232 => "EHOSTUNREACH", // ERROR_HOST_UNREACHABLE
        10065 => "EHOSTUNREACH", // WSAEHOSTUNREACH
        122 => "EINVAL", // ERROR_INSUFFICIENT_BUFFER
        13 => "EINVAL", // ERROR_INVALID_DATA
        87 => "EINVAL", // ERROR_INVALID_PARAMETER
        1464 => "EINVAL", // ERROR_SYMLINK_NOT_SUPPORTED
        10022 => "EINVAL", // WSAEINVAL
        10046 => "EINVAL", // WSAEPFNOSUPPORT
        1102 => "EIO", // ERROR_BEGINNING_OF_MEDIA
        1111 => "EIO", // ERROR_BUS_RESET
        23 => "EIO", // ERROR_CRC
        1166 => "EIO", // ERROR_DEVICE_DOOR_OPEN
        1165 => "EIO", // ERROR_DEVICE_REQUIRES_CLEANING
        1393 => "EIO", // ERROR_DISK_CORRUPT
        1129 => "EIO", // ERROR_EOM_OVERFLOW
        1101 => "EIO", // ERROR_FILEMARK_DETECTED
        31 => "EIO", // ERROR_GEN_FAILURE
        1106 => "EIO", // ERROR_INVALID_BLOCK_LENGTH
        1117 => "EIO", // ERROR_IO_DEVICE
        1104 => "EIO", // ERROR_NO_DATA_DETECTED
        205 => "EIO", // ERROR_NO_SIGNAL_SENT
        110 => "EIO", // ERROR_OPEN_FAILED
        1103 => "EIO", // ERROR_SETMARK_DETECTED
        156 => "EIO", // ERROR_SIGNAL_REFUSED
        10056 => "EISCONN", // WSAEISCONN
        1921 => "ELOOP", // ERROR_CANT_RESOLVE_FILENAME
        4 => "EMFILE", // ERROR_TOO_MANY_OPEN_FILES
        10024 => "EMFILE", // WSAEMFILE
        10040 => "EMSGSIZE", // WSAEMSGSIZE
        111 => "ENAMETOOLONG", // ERROR_BUFFER_OVERFLOW
        206 => "ENAMETOOLONG", // ERROR_FILENAME_EXCED_RANGE
        1231 => "ENETUNREACH", // ERROR_NETWORK_UNREACHABLE
        10051 => "ENETUNREACH", // WSAENETUNREACH
        10055 => "ENOBUFS", // WSAENOBUFS
        161 => "ENOENT", // ERROR_BAD_PATHNAME
        267 => "ENOENT", // ERROR_DIRECTORY
        203 => "ENOENT", // ERROR_ENVVAR_NOT_FOUND
        2 => "ENOENT", // ERROR_FILE_NOT_FOUND
        123 => "ENOENT", // ERROR_INVALID_NAME
        15 => "ENOENT", // ERROR_INVALID_DRIVE
        4392 => "ENOENT", // ERROR_INVALID_REPARSE_DATA
        126 => "ENOENT", // ERROR_MOD_NOT_FOUND
        3 => "ENOENT", // ERROR_PATH_NOT_FOUND
        11001 => "ENOENT", // WSAHOST_NOT_FOUND
        11004 => "ENOENT", // WSANO_DATA
        8 => "ENOMEM", // ERROR_NOT_ENOUGH_MEMORY
        14 => "ENOMEM", // ERROR_OUTOFMEMORY
        82 => "ENOSPC", // ERROR_CANNOT_MAKE
        112 => "ENOSPC", // ERROR_DISK_FULL
        277 => "ENOSPC", // ERROR_EA_TABLE_FULL
        1100 => "ENOSPC", // ERROR_END_OF_MEDIA
        39 => "ENOSPC", // ERROR_HANDLE_DISK_FULL
        2250 => "ENOTCONN", // ERROR_NOT_CONNECTED
        10057 => "ENOTCONN", // WSAENOTCONN
        145 => "ENOTEMPTY", // ERROR_DIR_NOT_EMPTY
        10038 => "ENOTSOCK", // WSAENOTSOCK
        50 => "ENOTSUP", // ERROR_NOT_SUPPORTED
        109 => "EOF", // ERROR_BROKEN_PIPE
        5 => "EPERM", // ERROR_ACCESS_DENIED
        1314 => "EPERM", // ERROR_PRIVILEGE_NOT_HELD
        230 => "EPIPE", // ERROR_BAD_PIPE
        233 => "EPIPE", // ERROR_PIPE_NOT_CONNECTED
        10058 => "EPIPE", // WSAESHUTDOWN
        10043 => "EPROTONOSUPPORT", // WSAEPROTONOSUPPORT
        19 => "EROFS", // ERROR_WRITE_PROTECT
        121 => "ETIMEDOUT", // ERROR_SEM_TIMEOUT
        10060 => "ETIMEDOUT", // WSAETIMEDOUT
        17 => "EXDEV", // ERROR_NOT_SAME_DEVICE
        1 => "EISDIR", // ERROR_INVALID_FUNCTION
        208 => "E2BIG", // ERROR_META_EXPANSION_TOO_LONG
        10044 => "ESOCKTNOSUPPORT", // WSAESOCKTNOSUPPORT
        193 => "EFTYPE", // ERROR_BAD_EXE_FORMAT
        _ => "UNKNOWN",
    }
}

/// The name libuv gives a POSIX errno: the C name of the constant, for every errno `include/uv/errno.h` of libuv 1.51.0 names.
/// `ECHARSET` is the one name of that list no Unix defines (libuv gives it a number of its own); `ENONET`, `EUNATCH` and
/// `EREMOTEIO` exist on Linux only, `EFTYPE` on the BSDs and macOS only, and `ENODATA` is left to the platforms whose
/// `<errno.h>` defines it (libuv gives FreeBSD a number that no errno has). An errno libuv has no name for is `UNKNOWN`.
#[cfg(unix)]
pub fn errno_name(code: i32) -> &'static str {
    match code {
        libc::E2BIG => "E2BIG",
        libc::EACCES => "EACCES",
        libc::EADDRINUSE => "EADDRINUSE",
        libc::EADDRNOTAVAIL => "EADDRNOTAVAIL",
        libc::EAFNOSUPPORT => "EAFNOSUPPORT",
        libc::EAGAIN => "EAGAIN",
        libc::EALREADY => "EALREADY",
        libc::EBADF => "EBADF",
        libc::EBUSY => "EBUSY",
        libc::ECANCELED => "ECANCELED",
        libc::ECONNABORTED => "ECONNABORTED",
        libc::ECONNREFUSED => "ECONNREFUSED",
        libc::ECONNRESET => "ECONNRESET",
        libc::EDESTADDRREQ => "EDESTADDRREQ",
        libc::EEXIST => "EEXIST",
        libc::EFAULT => "EFAULT",
        libc::EHOSTUNREACH => "EHOSTUNREACH",
        libc::EINTR => "EINTR",
        libc::EINVAL => "EINVAL",
        libc::EIO => "EIO",
        libc::EISCONN => "EISCONN",
        libc::EISDIR => "EISDIR",
        libc::ELOOP => "ELOOP",
        libc::EMFILE => "EMFILE",
        libc::EMSGSIZE => "EMSGSIZE",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENETDOWN => "ENETDOWN",
        libc::ENETUNREACH => "ENETUNREACH",
        libc::ENFILE => "ENFILE",
        libc::ENOBUFS => "ENOBUFS",
        libc::ENODEV => "ENODEV",
        libc::ENOENT => "ENOENT",
        libc::ENOMEM => "ENOMEM",
        #[cfg(any(target_os = "linux", target_os = "android"))]
        libc::ENONET => "ENONET",
        libc::ENOSPC => "ENOSPC",
        libc::ENOSYS => "ENOSYS",
        libc::ENOTCONN => "ENOTCONN",
        libc::ENOTDIR => "ENOTDIR",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::ENOTSOCK => "ENOTSOCK",
        libc::ENOTSUP => "ENOTSUP",
        libc::EPERM => "EPERM",
        libc::EPIPE => "EPIPE",
        libc::EPROTO => "EPROTO",
        libc::EPROTONOSUPPORT => "EPROTONOSUPPORT",
        libc::EPROTOTYPE => "EPROTOTYPE",
        libc::EROFS => "EROFS",
        libc::ESHUTDOWN => "ESHUTDOWN",
        libc::ESPIPE => "ESPIPE",
        libc::ESRCH => "ESRCH",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::ETXTBSY => "ETXTBSY",
        libc::EXDEV => "EXDEV",
        libc::EFBIG => "EFBIG",
        libc::ENOPROTOOPT => "ENOPROTOOPT",
        libc::ERANGE => "ERANGE",
        libc::ENXIO => "ENXIO",
        libc::EMLINK => "EMLINK",
        libc::EHOSTDOWN => "EHOSTDOWN",
        #[cfg(any(target_os = "linux", target_os = "android"))]
        libc::EREMOTEIO => "EREMOTEIO",
        libc::ENOTTY => "ENOTTY",
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly"))]
        libc::EFTYPE => "EFTYPE",
        libc::EILSEQ => "EILSEQ",
        libc::EOVERFLOW => "EOVERFLOW",
        libc::ESOCKTNOSUPPORT => "ESOCKTNOSUPPORT",
        #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios"))]
        libc::ENODATA => "ENODATA",
        #[cfg(any(target_os = "linux", target_os = "android"))]
        libc::EUNATCH => "EUNATCH",
        libc::ENOEXEC => "ENOEXEC",
        _ => "UNKNOWN",
    }
}

#[cfg(windows)]
fn os_name(raw: i32) -> &'static str {
    win32_error_name(raw as u32)
}

#[cfg(unix)]
fn os_name(raw: i32) -> &'static str {
    errno_name(raw)
}

/// `error.code` of the failure Node raises for the same system error; `None` for an error that carries no OS code
/// (Node then leaves the code out of the message).
pub fn error_code(error: &std::io::Error) -> Option<&'static str> {
    error.raw_os_error().map(os_name)
}