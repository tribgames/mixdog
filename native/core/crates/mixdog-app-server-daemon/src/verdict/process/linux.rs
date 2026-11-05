//! Linux: `/proc/<pid>/stat` (state and start time), and LISTEN sockets matched
//! by inode between `/proc/net/tcp` and `/proc/<pid>/fd`.

#![allow(
    clippy::disallowed_methods,
    reason = "procfs reads back the synchronous process table, queried by the startup gate and the exit wait"
)]

use std::fs;
use std::io;

use super::ProcessIdentity;
use super::ProcessInfo;

fn boot_ms() -> io::Result<u64> {
    let stat = fs::read_to_string("/proc/stat")?;
    stat.lines()
        .find_map(|line| line.strip_prefix("btime "))
        .and_then(|secs| secs.trim().parse::<u64>().ok())
        .map(|secs| secs * 1000)
        .ok_or_else(|| io::Error::other("/proc/stat has no btime"))
}

fn clock_ticks() -> io::Result<u64> {
    // SAFETY: sysconf has no preconditions.
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if ticks > 0 {
        Ok(ticks as u64)
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(super) fn query(pid: u32) -> io::Result<Option<ProcessInfo>> {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    // Fields after the parenthesised command name start at field 3 (state);
    // field 22 is the start time in clock ticks since boot.
    let rest = stat
        .rfind(')')
        .map(|close| &stat[close + 1..])
        .unwrap_or_default();
    let fields: Vec<&str> = rest.split_whitespace().collect();
    if matches!(fields.first(), Some(&("Z" | "X" | "x"))) {
        return Ok(None);
    }
    let ticks = fields
        .get(19)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| io::Error::other(format!("unparseable /proc/{pid}/stat")))?;
    let start_ms = boot_ms()? + ticks * 1000 / clock_ticks()?;
    let image = fs::read_link(format!("/proc/{pid}/exe")).ok();
    let command_line = fs::read(format!("/proc/{pid}/cmdline"))
        .ok()
        .filter(|bytes| !bytes.is_empty())
        .map(|bytes| {
            bytes
                .split(|b| *b == 0)
                .filter(|arg| !arg.is_empty())
                .map(|arg| String::from_utf8_lossy(arg).into_owned())
                .collect::<Vec<_>>()
                .join(" ")
        });
    Ok(Some(ProcessInfo {
        identity: ProcessIdentity { pid, start_ms },
        image,
        command_line,
    }))
}

/// Inodes of LISTEN sockets bound to 127.0.0.1:`port`.
fn listen_inodes(port: u16) -> io::Result<Vec<u64>> {
    let table = fs::read_to_string("/proc/net/tcp")?;
    Ok(table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (addr, local_port) = fields.get(1)?.split_once(':')?;
            // The address is the raw network-order word printed as a host u32.
            let addr = u32::from_str_radix(addr, 16).ok()?.to_ne_bytes();
            let listening = fields.get(3) == Some(&"0A");
            (listening
                && addr == [127, 0, 0, 1]
                && u16::from_str_radix(local_port, 16).ok()? == port)
                .then(|| fields.get(9)?.parse().ok())
                .flatten()
        })
        .collect())
}

pub(super) fn listens(pid: u32, port: u16) -> io::Result<bool> {
    let inodes = listen_inodes(port)?;
    if inodes.is_empty() {
        return Ok(false);
    }
    let entries = match fs::read_dir(format!("/proc/{pid}/fd")) {
        Ok(entries) => entries,
        // Exited; or another user's process, which no data-dir owner of this user is.
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
            ) =>
        {
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    for entry in entries.flatten() {
        let Ok(target) = fs::read_link(entry.path()) else {
            continue;
        };
        let target = target.to_string_lossy();
        if let Some(inode) = target
            .strip_prefix("socket:[")
            .and_then(|rest| rest.strip_suffix(']'))
            && inode
                .parse::<u64>()
                .is_ok_and(|inode| inodes.contains(&inode))
        {
            return Ok(true);
        }
    }
    Ok(false)
}
