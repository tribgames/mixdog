//! Name lookup that keeps the `getaddrinfo` result code. `std` and `tokio::net::lookup_host`
//! turn a Unix failure into text, which cannot be classified, so this calls the resolver
//! directly: `libc` on Unix, `GetAddrInfoW` on Windows, one entry point for both.

use std::net::IpAddr;

/// What libuv names the failure, which is what Node's retry and policy decisions key on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LookupKind {
    /// `EAI_NONAME` (libuv `ENOTFOUND`).
    NotFound,
    /// `EAI_NODATA` (libuv `ENODATA`).
    NoData,
    /// `EAI_AGAIN`.
    TryAgain,
    Other,
}

#[derive(Clone, Copy, Debug)]
pub struct LookupError {
    pub kind: LookupKind,
    pub code: i32,
}

#[cfg(unix)]
pub fn classify(code: i32) -> LookupKind {
    if code == libc::EAI_AGAIN {
        return LookupKind::TryAgain;
    }
    if code == libc::EAI_NONAME {
        return LookupKind::NotFound;
    }
    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    if code == libc::EAI_NODATA {
        return LookupKind::NoData;
    }
    LookupKind::Other
}

#[cfg(windows)]
pub fn classify(code: i32) -> LookupKind {
    use windows_sys::Win32::Networking::WinSock as ws;
    match code {
        c if c == ws::WSATRY_AGAIN => LookupKind::TryAgain,
        c if c == ws::WSAHOST_NOT_FOUND => LookupKind::NotFound,
        c if c == ws::WSANO_DATA => LookupKind::NoData,
        _ => LookupKind::Other,
    }
}

/// Blocking; run it on a blocking thread.
#[cfg(unix)]
pub fn lookup(host: &str) -> Result<Vec<IpAddr>, LookupError> {
    use std::ffi::CString;
    use std::net::Ipv4Addr;
    use std::net::Ipv6Addr;

    let name = CString::new(host).map_err(|_| LookupError { kind: LookupKind::Other, code: 0 })?;
    // SAFETY: `hints` is zeroed plain data; `found` is only read after `getaddrinfo` succeeds and
    // is released with `freeaddrinfo`; each `ai_addr` matches its `ai_family`.
    unsafe {
        let mut hints: libc::addrinfo = std::mem::zeroed();
        hints.ai_family = libc::AF_UNSPEC;
        hints.ai_socktype = libc::SOCK_STREAM;
        let mut found: *mut libc::addrinfo = std::ptr::null_mut();
        let code = libc::getaddrinfo(name.as_ptr(), std::ptr::null(), &hints, &mut found);
        if code != 0 {
            return Err(LookupError { kind: classify(code), code });
        }
        let mut addrs = Vec::new();
        let mut node = found;
        while !node.is_null() {
            let info = &*node;
            if info.ai_family == libc::AF_INET {
                let sin = &*(info.ai_addr as *const libc::sockaddr_in);
                addrs.push(IpAddr::V4(Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr))));
            } else if info.ai_family == libc::AF_INET6 {
                let sin6 = &*(info.ai_addr as *const libc::sockaddr_in6);
                addrs.push(IpAddr::V6(Ipv6Addr::from(sin6.sin6_addr.s6_addr)));
            }
            node = info.ai_next;
        }
        libc::freeaddrinfo(found);
        Ok(addrs)
    }
}

/// Blocking; run it on a blocking thread.
#[cfg(windows)]
pub fn lookup(host: &str) -> Result<Vec<IpAddr>, LookupError> {
    use std::net::Ipv4Addr;
    use std::net::Ipv6Addr;
    use std::sync::Once;

    use windows_sys::Win32::Networking::WinSock as ws;

    static STARTUP: Once = Once::new();
    STARTUP.call_once(|| {
        // SAFETY: `WSADATA` is plain data the call fills in; the startup is idempotent.
        unsafe {
            let mut data: ws::WSADATA = std::mem::zeroed();
            ws::WSAStartup(0x0202, &mut data);
        }
    });
    let wide: Vec<u16> = host.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is NUL-terminated; `found` is read only after success and released with
    // `FreeAddrInfoW`; each `ai_addr` matches its `ai_family`.
    unsafe {
        let mut hints: ws::ADDRINFOW = std::mem::zeroed();
        hints.ai_family = i32::from(ws::AF_UNSPEC);
        hints.ai_socktype = ws::SOCK_STREAM;
        let mut found: *mut ws::ADDRINFOW = std::ptr::null_mut();
        let code = ws::GetAddrInfoW(wide.as_ptr(), std::ptr::null(), &hints, &mut found);
        if code != 0 {
            return Err(LookupError { kind: classify(code), code });
        }
        let mut addrs = Vec::new();
        let mut node = found;
        while !node.is_null() {
            let info = &*node;
            if info.ai_family == i32::from(ws::AF_INET) {
                let sin = &*(info.ai_addr as *const ws::SOCKADDR_IN);
                addrs.push(IpAddr::V4(Ipv4Addr::from(u32::from_be(sin.sin_addr.S_un.S_addr))));
            } else if info.ai_family == i32::from(ws::AF_INET6) {
                let sin6 = &*(info.ai_addr as *const ws::SOCKADDR_IN6);
                addrs.push(IpAddr::V6(Ipv6Addr::from(sin6.sin6_addr.u.Byte)));
            }
            node = info.ai_next;
        }
        ws::FreeAddrInfoW(found);
        Ok(addrs)
    }
}
