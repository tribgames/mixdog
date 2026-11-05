//! macOS: `proc_pidinfo(PROC_PIDTBSDINFO)` for state and start time, and
//! `PROC_PIDLISTFDS` + `PROC_PIDFDSOCKETINFO` for the process's LISTEN sockets.

use std::ffi::c_int;
use std::ffi::c_void;
use std::io;
use std::mem::size_of;
use std::path::PathBuf;

use super::ProcessIdentity;
use super::ProcessInfo;

const PROC_PIDFDSOCKETINFO: c_int = 3;
const SOCKINFO_TCP: i32 = 2;
const TSI_S_LISTEN: i32 = 1;
const INI_IPV4: u8 = 0x1;

// `<sys/proc_info.h>` socket structures; libc does not provide them.
#[repr(C)]
#[derive(Clone, Copy)]
struct ProcFileInfo {
    fi_openflags: u32,
    fi_status: u32,
    fi_offset: i64,
    fi_type: i32,
    fi_guardflags: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct VinfoStat {
    vst_dev: u32,
    vst_mode: u16,
    vst_nlink: u16,
    vst_ino: u64,
    vst_uid: u32,
    vst_gid: u32,
    vst_times: [i64; 8],
    vst_size: i64,
    vst_blocks: i64,
    vst_blksize: i32,
    vst_flags: u32,
    vst_gen: u32,
    vst_rdev: u32,
    vst_qspare: [i64; 2],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SockbufInfo {
    sbi_cc: u32,
    sbi_hiwat: u32,
    sbi_mbcnt: u32,
    sbi_mbmax: u32,
    sbi_lowat: u32,
    sbi_flags: i16,
    sbi_timeo: i16,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct In4In6Addr {
    i46a_pad32: [u32; 3],
    i46a_addr4: [u8; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
union InAddr46 {
    ina_46: In4In6Addr,
    ina_6: [u8; 16],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct InSockInfoV6 {
    in6_hlim: u8,
    in6_cksum: i32,
    in6_ifindex: u16,
    in6_hops: i16,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct InSockInfo {
    insi_fport: i32,
    insi_lport: i32,
    insi_gencnt: u64,
    insi_flags: u32,
    insi_flow: u32,
    insi_vflag: u8,
    insi_ip_ttl: u8,
    rfu_1: u32,
    insi_faddr: InAddr46,
    insi_laddr: InAddr46,
    insi_v4_tos: u8,
    insi_v6: InSockInfoV6,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct TcpSockInfo {
    tcpsi_ini: InSockInfo,
    tcpsi_state: i32,
    tcpsi_timer: [i32; 4],
    tcpsi_mss: i32,
    tcpsi_flags: u32,
    rfu_1: u32,
    tcpsi_tp: u64,
}

/// The largest member is `un_sockinfo` (2 × u64 + 2 × 255-byte addresses).
#[repr(C)]
#[derive(Clone, Copy)]
union SoiProto {
    pri_tcp: TcpSockInfo,
    _largest: [u64; 66],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SocketInfo {
    soi_stat: VinfoStat,
    soi_so: u64,
    soi_pcb: u64,
    soi_type: i32,
    soi_protocol: i32,
    soi_family: i32,
    soi_options: i16,
    soi_linger: i16,
    soi_state: i16,
    soi_qlen: i16,
    soi_incqlen: i16,
    soi_qlimit: i16,
    soi_timeo: i16,
    soi_error: u16,
    soi_oobmark: u32,
    soi_rcv: SockbufInfo,
    soi_snd: SockbufInfo,
    soi_kind: i32,
    rfu_1: u32,
    soi_proto: SoiProto,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SocketFdInfo {
    pfi: ProcFileInfo,
    psi: SocketInfo,
}

fn bsd_info(pid: u32) -> io::Result<Option<libc::proc_bsdinfo>> {
    // SAFETY: zeroed proc_bsdinfo is a valid out-buffer.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = size_of::<libc::proc_bsdinfo>() as c_int;
    // SAFETY: the buffer is `size` bytes.
    let ret = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&raw mut info).cast::<c_void>(),
            size,
        )
    };
    if ret == size {
        return Ok(Some(info));
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(None),
        _ => Err(error),
    }
}

fn image(pid: u32) -> Option<PathBuf> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is its length in bytes.
    let len = unsafe {
        libc::proc_pidpath(
            pid as c_int,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    };
    (len > 0).then(|| PathBuf::from(String::from_utf8_lossy(&buffer[..len as usize]).into_owned()))
}

/// `KERN_PROCARGS2`: argc, the exec path, padding NULs, then argv.
fn command_line(pid: u32) -> Option<String> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as c_int];
    let mut size: libc::size_t = 0;
    // SAFETY: size query with a null buffer.
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    let mut buffer = vec![0u8; size];
    // SAFETY: the buffer is `size` bytes.
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    buffer.truncate(size);
    let argc = i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?) as usize;
    let mut rest = &buffer[4..];
    let exec_end = rest.iter().position(|b| *b == 0)?;
    rest = &rest[exec_end..];
    let args_start = rest.iter().position(|b| *b != 0)?;
    let args: Vec<String> = rest[args_start..]
        .split(|b| *b == 0)
        .take(argc)
        .map(|arg| String::from_utf8_lossy(arg).into_owned())
        .collect();
    Some(args.join(" "))
}

pub(super) fn query(pid: u32) -> io::Result<Option<ProcessInfo>> {
    let info = match bsd_info(pid) {
        Ok(Some(info)) => info,
        Ok(None) => return Ok(None),
        // Another user's process: it exists; its details are not ours to read.
        Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
            return Ok(Some(ProcessInfo {
                identity: ProcessIdentity { pid, start_ms: 0 },
                image: None,
                command_line: None,
            }));
        }
        Err(error) => return Err(error),
    };
    if info.pbi_status == libc::SZOMB {
        return Ok(None);
    }
    let start_ms = info.pbi_start_tvsec * 1000 + info.pbi_start_tvusec / 1000;
    Ok(Some(ProcessInfo {
        identity: ProcessIdentity { pid, start_ms },
        image: image(pid),
        command_line: command_line(pid),
    }))
}

pub(super) fn listens(pid: u32, port: u16) -> io::Result<bool> {
    // SAFETY: size query with a null buffer.
    let needed = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDLISTFDS,
            0,
            std::ptr::null_mut(),
            0,
        )
    };
    if needed <= 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ESRCH | libc::EPERM) => Ok(false),
            _ => Err(error),
        };
    }
    let count = needed as usize / size_of::<libc::proc_fdinfo>() + 16;
    // SAFETY: zeroed proc_fdinfo values are valid.
    let mut fds: Vec<libc::proc_fdinfo> = vec![unsafe { std::mem::zeroed() }; count];
    // SAFETY: the buffer holds `count` entries.
    let got = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr().cast(),
            (count * size_of::<libc::proc_fdinfo>()) as c_int,
        )
    };
    if got <= 0 {
        return Ok(false);
    }
    fds.truncate(got as usize / size_of::<libc::proc_fdinfo>());
    for fd in fds
        .iter()
        .filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32)
    {
        // SAFETY: zeroed SocketFdInfo is a valid out-buffer.
        let mut info: SocketFdInfo = unsafe { std::mem::zeroed() };
        let size = size_of::<SocketFdInfo>() as c_int;
        // SAFETY: the buffer is `size` bytes.
        let ret = unsafe {
            libc::proc_pidfdinfo(
                pid as c_int,
                fd.proc_fd,
                PROC_PIDFDSOCKETINFO,
                (&raw mut info).cast(),
                size,
            )
        };
        if ret <= 0 || info.psi.soi_kind != SOCKINFO_TCP {
            continue;
        }
        // SAFETY: `soi_kind == SOCKINFO_TCP` selects the tcp member.
        let tcp = unsafe { info.psi.soi_proto.pri_tcp };
        // SAFETY: `INI_IPV4` selects the IPv4 member.
        let addr = unsafe { tcp.tcpsi_ini.insi_laddr.ina_46.i46a_addr4 };
        if tcp.tcpsi_state == TSI_S_LISTEN
            && tcp.tcpsi_ini.insi_vflag & INI_IPV4 != 0
            && u16::from_be(tcp.tcpsi_ini.insi_lport as u16) == port
            && addr == [127, 0, 0, 1]
        {
            return Ok(true);
        }
    }
    Ok(false)
}
