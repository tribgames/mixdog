//! Listening TCP ports (SPEC §4.10). The OS has no event for its socket tables, so this module
//! reads them: `GetExtendedTcpTable` on Windows, `/proc/net/tcp*` plus `/proc/<pid>/fd` on
//! Linux, `lsof -F` on macOS. Only structured sources are read, never console tables.
//!
//! [`PortsHub`] is the one sampler: its thread exists only while at least one viewer is
//! subscribed, and it publishes differences only.

use std::collections::BTreeMap;
use std::collections::HashSet;
use std::io;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

/// The sampling cadence of the server ports panel (SPEC §4.10, H6).
pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

/// One listening socket as an OS source reports it.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ListeningSocket {
    pub port: u16,
    pub address: String,
    pub inode: Option<String>,
    pub pid: Option<u32>,
    pub process: Option<String>,
}

/// One listening port with its addresses merged.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ListeningPort {
    pub port: u16,
    pub addresses: Vec<String>,
    pub process: Option<String>,
    pub pid: Option<u32>,
}

/// Which socket table a `/proc/net/tcp*` text is.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Family {
    V4,
    V6,
}

fn hex_bytes(hex: &str) -> Option<Vec<u8>> {
    if !hex.is_ascii() || hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

fn ipv4_text(octets: [u8; 4]) -> String {
    format!("{}.{}.{}.{}", octets[0], octets[1], octets[2], octets[3])
}

/// `/proc/net/tcp` stores the address as one 32-bit word in host (little-endian) order.
fn ipv4_from_proc(hex: &str) -> Option<String> {
    let mut bytes: [u8; 4] = hex_bytes(hex)?.try_into().ok()?;
    bytes.reverse();
    Some(ipv4_text(bytes))
}

/// The text form every platform reports: groups without leading zeros and without `::`
/// compression, except the unspecified and loopback addresses, and IPv4-mapped addresses
/// reported as plain IPv4.
fn ipv6_text(groups: [u16; 8]) -> String {
    if groups[..5].iter().all(|g| *g == 0) && groups[5] == 0xffff {
        let [a, b] = groups[6].to_be_bytes();
        let [c, d] = groups[7].to_be_bytes();
        return ipv4_text([a, b, c, d]);
    }
    match groups {
        [0, 0, 0, 0, 0, 0, 0, 0] => "::".to_owned(),
        [0, 0, 0, 0, 0, 0, 0, 1] => "::1".to_owned(),
        _ => groups
            .iter()
            .map(|g| format!("{g:x}"))
            .collect::<Vec<_>>()
            .join(":"),
    }
}

/// `/proc/net/tcp6` stores four 32-bit words, each in host (little-endian) order.
fn ipv6_from_proc(hex: &str) -> Option<String> {
    let bytes = hex_bytes(hex)?;
    if bytes.len() != 16 {
        return None;
    }
    let mut octets = [0u8; 16];
    for (word, chunk) in bytes.chunks(4).enumerate() {
        for (i, byte) in chunk.iter().rev().enumerate() {
            octets[word * 4 + i] = *byte;
        }
    }
    let mut groups = [0u16; 8];
    for (i, pair) in octets.chunks(2).enumerate() {
        groups[i] = u16::from_be_bytes([pair[0], pair[1]]);
    }
    Some(ipv6_text(groups))
}

/// The LISTEN rows (state `0A`) of `/proc/net/tcp` (`V4`) or `/proc/net/tcp6` (`V6`).
pub fn parse_proc_net_tcp(text: &str, family: Family) -> Vec<ListeningSocket> {
    let mut sockets = Vec::new();
    for line in text.split('\n').skip(1) {
        let fields: Vec<&str> = mixdog_js::js_words(line).collect();
        if fields.len() < 10 || fields[3] != "0A" {
            continue;
        }
        let Some((address_hex, port_hex)) = fields[1].split_once(':') else {
            continue;
        };
        let Ok(port) = u16::from_str_radix(port_hex, 16) else {
            continue;
        };
        if port == 0 {
            continue;
        }
        let address = match family {
            Family::V4 => ipv4_from_proc(address_hex),
            Family::V6 => ipv6_from_proc(address_hex),
        };
        let Some(address) = address else { continue };
        sockets.push(ListeningSocket {
            port,
            address,
            inode: Some(fields[9].to_owned()),
            ..ListeningSocket::default()
        });
    }
    sockets
}

/// `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output.
pub fn parse_lsof_listen(text: &str) -> Vec<ListeningSocket> {
    let mut sockets = Vec::new();
    let mut pid: Option<u32> = None;
    let mut command: Option<String> = None;
    for line in text.split('\n') {
        let mut chars = line.chars();
        let Some(tag) = chars.next() else { continue };
        let value = mixdog_js::js_trim(chars.as_str());
        match tag {
            'p' => {
                pid = value.parse::<u32>().ok().filter(|p| *p != 0);
                command = None;
            }
            'c' => command = Some(value.to_owned()),
            'n' => {
                let Some((host, port)) = value.rsplit_once(':') else {
                    continue;
                };
                let Ok(port) = port.parse::<u16>() else {
                    continue;
                };
                let host = host
                    .strip_prefix('[')
                    .and_then(|h| h.strip_suffix(']'))
                    .unwrap_or(host);
                sockets.push(ListeningSocket {
                    port,
                    address: if host == "*" { "0.0.0.0" } else { host }.to_owned(),
                    inode: None,
                    pid,
                    process: command.clone().filter(|c| !c.is_empty()),
                });
            }
            _ => {}
        }
    }
    sockets
}

/// One entry per port, its addresses merged, sorted by port; the service's own sockets are left
/// out.
pub fn merge_listening_sockets(sockets: &[ListeningSocket], own_pid: u32) -> Vec<ListeningPort> {
    let mut by_port: BTreeMap<u16, ListeningPort> = BTreeMap::new();
    for socket in sockets {
        if socket.pid == Some(own_pid) {
            continue;
        }
        let entry = by_port.entry(socket.port).or_insert_with(|| ListeningPort {
            port: socket.port,
            addresses: Vec::new(),
            process: None,
            pid: None,
        });
        if !entry.addresses.contains(&socket.address) {
            entry.addresses.push(socket.address.clone());
        }
        if entry.process.is_none() {
            entry.process = socket.process.clone();
        }
        if entry.pid.is_none() {
            entry.pid = socket.pid;
        }
    }
    by_port.into_values().collect()
}

/// Reads the OS socket table once.
pub fn sample_listening_ports() -> io::Result<Vec<ListeningPort>> {
    Ok(merge_listening_sockets(
        &os::listening_sockets()?,
        std::process::id(),
    ))
}

#[cfg(target_os = "linux")]
mod os {
    use super::*;
    use std::collections::HashMap;
    use std::fs;

    /// At most this many processes are searched for socket owners.
    const MAX_PROCESSES: usize = 4_096;

    fn socket_owners(inodes: &HashSet<String>) -> HashMap<String, (u32, Option<String>)> {
        let mut owners = HashMap::new();
        if inodes.is_empty() {
            return owners;
        }
        let Ok(entries) = fs::read_dir("/proc") else {
            return owners;
        };
        let pids = entries
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
            .take(MAX_PROCESSES);
        for pid in pids {
            let Ok(fds) = fs::read_dir(format!("/proc/{pid}/fd")) else {
                continue;
            };
            let mut name: Option<Option<String>> = None;
            for fd in fds.flatten() {
                let Ok(link) = fs::read_link(fd.path()) else {
                    continue;
                };
                let Some(inode) = link
                    .to_str()
                    .and_then(|l| l.strip_prefix("socket:["))
                    .and_then(|l| l.strip_suffix(']'))
                else {
                    continue;
                };
                if !inodes.contains(inode) || owners.contains_key(inode) {
                    continue;
                }
                let name = name.get_or_insert_with(|| {
                    fs::read_to_string(format!("/proc/{pid}/comm"))
                        .ok()
                        .map(|c| mixdog_js::js_trim(&c).to_owned())
                        .filter(|c| !c.is_empty())
                });
                owners.insert(inode.to_owned(), (pid, name.clone()));
            }
            if owners.len() == inodes.len() {
                break;
            }
        }
        owners
    }

    pub(super) fn listening_sockets() -> io::Result<Vec<ListeningSocket>> {
        let mut sockets = Vec::new();
        for (file, family) in [
            ("/proc/net/tcp", Family::V4),
            ("/proc/net/tcp6", Family::V6),
        ] {
            match fs::read_to_string(file) {
                Ok(text) => sockets.extend(parse_proc_net_tcp(&text, family)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        let inodes: HashSet<String> = sockets
            .iter()
            .filter_map(|s| s.inode.clone())
            .filter(|i| i != "0")
            .collect();
        let owners = socket_owners(&inodes);
        for socket in &mut sockets {
            if let Some((pid, process)) = socket.inode.as_ref().and_then(|i| owners.get(i)) {
                socket.pid = Some(*pid);
                socket.process = process.clone();
            }
        }
        Ok(sockets)
    }
}

#[cfg(target_os = "macos")]
mod os {
    use super::*;
    use std::process::Command;

    pub(super) fn listening_sockets() -> io::Result<Vec<ListeningSocket>> {
        let output = Command::new("lsof")
            .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"])
            .output()?;
        // lsof exits 1 when nothing listens.
        if !output.status.success() && output.stdout.is_empty() {
            return match output.status.code() {
                Some(1) => Ok(Vec::new()),
                _ => Err(io::Error::other("lsof failed")),
            };
        }
        Ok(parse_lsof_listen(&String::from_utf8_lossy(&output.stdout)))
    }
}

#[cfg(windows)]
mod os {
    use super::*;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows_sys::Win32::Foundation::NO_ERROR;
    use windows_sys::Win32::NetworkManagement::IpHelper::GetExtendedTcpTable;
    use windows_sys::Win32::NetworkManagement::IpHelper::MIB_TCP6ROW_OWNER_PID;
    use windows_sys::Win32::NetworkManagement::IpHelper::MIB_TCP6TABLE_OWNER_PID;
    use windows_sys::Win32::NetworkManagement::IpHelper::MIB_TCPROW_OWNER_PID;
    use windows_sys::Win32::NetworkManagement::IpHelper::MIB_TCPTABLE_OWNER_PID;
    use windows_sys::Win32::NetworkManagement::IpHelper::TCP_TABLE_OWNER_PID_LISTENER;
    use windows_sys::Win32::Networking::WinSock::AF_INET;
    use windows_sys::Win32::Networking::WinSock::AF_INET6;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;

    /// The raw table bytes for one address family, grown until the OS accepts the size.
    fn table(family: u32) -> io::Result<Vec<u8>> {
        let mut size = 0u32;
        loop {
            let mut buffer = vec![0u8; size as usize];
            // The buffer is 8-byte aligned by the allocator for sizes the OS asks for; rows
            // are read unaligned below regardless.
            let status = unsafe {
                GetExtendedTcpTable(
                    buffer.as_mut_ptr().cast(),
                    &mut size,
                    0,
                    family,
                    TCP_TABLE_OWNER_PID_LISTENER,
                    0,
                )
            };
            match status {
                NO_ERROR => return Ok(buffer),
                ERROR_INSUFFICIENT_BUFFER => {}
                code => return Err(io::Error::from_raw_os_error(code as i32)),
            }
        }
    }

    /// The listening port is in network byte order in the low 16 bits of the DWORD.
    fn port_of(raw: u32) -> u16 {
        u16::from_be(raw as u16)
    }

    fn process_name(pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buffer = [0u16; 1024];
            let mut length = buffer.len() as u32;
            let queried = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length);
            CloseHandle(handle);
            if queried == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buffer[..length as usize]);
            let file = path.rsplit(['\\', '/']).next()?;
            let stem = file.strip_suffix(".exe").unwrap_or(file);
            (!stem.is_empty()).then(|| stem.to_owned())
        }
    }

    pub(super) fn listening_sockets() -> io::Result<Vec<ListeningSocket>> {
        let mut sockets = Vec::new();
        let v4 = table(AF_INET as u32)?;
        let count = unsafe { std::ptr::read_unaligned(v4.as_ptr().cast::<u32>()) } as usize;
        let rows_at = std::mem::offset_of!(MIB_TCPTABLE_OWNER_PID, table);
        for i in 0..count {
            let row: MIB_TCPROW_OWNER_PID = unsafe {
                std::ptr::read_unaligned(
                    v4.as_ptr()
                        .add(rows_at + i * std::mem::size_of::<MIB_TCPROW_OWNER_PID>())
                        .cast(),
                )
            };
            sockets.push(ListeningSocket {
                port: port_of(row.dwLocalPort),
                address: ipv4_text(row.dwLocalAddr.to_ne_bytes()),
                inode: None,
                pid: Some(row.dwOwningPid),
                process: None,
            });
        }
        let v6 = table(AF_INET6 as u32)?;
        let count = unsafe { std::ptr::read_unaligned(v6.as_ptr().cast::<u32>()) } as usize;
        let rows_at = std::mem::offset_of!(MIB_TCP6TABLE_OWNER_PID, table);
        for i in 0..count {
            let row: MIB_TCP6ROW_OWNER_PID = unsafe {
                std::ptr::read_unaligned(
                    v6.as_ptr()
                        .add(rows_at + i * std::mem::size_of::<MIB_TCP6ROW_OWNER_PID>())
                        .cast(),
                )
            };
            let mut groups = [0u16; 8];
            for (g, pair) in groups.iter_mut().zip(row.ucLocalAddr.chunks(2)) {
                *g = u16::from_be_bytes([pair[0], pair[1]]);
            }
            sockets.push(ListeningSocket {
                port: port_of(row.dwLocalPort),
                address: ipv6_text(groups),
                inode: None,
                pid: Some(row.dwOwningPid),
                process: None,
            });
        }
        let pids: HashSet<u32> = sockets.iter().filter_map(|s| s.pid).collect();
        let names: std::collections::HashMap<u32, Option<String>> =
            pids.into_iter().map(|p| (p, process_name(p))).collect();
        for socket in &mut sockets {
            socket.process = socket.pid.and_then(|p| names.get(&p).cloned().flatten());
        }
        Ok(sockets)
    }
}

/// Differences between two samples, keyed by port.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct PortsDiff {
    /// Ports that appeared or whose entry changed.
    pub upserted: Vec<ListeningPort>,
    /// Ports that stopped listening.
    pub removed: Vec<u16>,
}

impl PortsDiff {
    pub fn is_empty(&self) -> bool {
        self.upserted.is_empty() && self.removed.is_empty()
    }
}

pub fn diff_ports(before: &[ListeningPort], after: &[ListeningPort]) -> PortsDiff {
    let old: BTreeMap<u16, &ListeningPort> = before.iter().map(|p| (p.port, p)).collect();
    let new: BTreeMap<u16, &ListeningPort> = after.iter().map(|p| (p.port, p)).collect();
    PortsDiff {
        upserted: after
            .iter()
            .filter(|p| old.get(&p.port).is_none_or(|o| *o != *p))
            .cloned()
            .collect(),
        removed: before
            .iter()
            .filter(|p| !new.contains_key(&p.port))
            .map(|p| p.port)
            .collect(),
    }
}

type Source = dyn Fn() -> io::Result<Vec<ListeningPort>> + Send + Sync;
type Sink = dyn Fn(&PortsDiff) + Send + Sync;

struct HubState {
    viewers: HashSet<String>,
    /// Bumped at every sampler start and stop; a sampler thread of another generation exits
    /// without publishing.
    generation: u64,
    last: Vec<ListeningPort>,
}

struct HubInner {
    interval: Duration,
    source: Box<Source>,
    sink: Box<Sink>,
    state: Mutex<HubState>,
    wake: Condvar,
    sampler_threads: AtomicUsize,
}

impl HubInner {
    fn lock(&self) -> MutexGuard<'_, HubState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The one ports sampler of a core. It samples every `interval` only while at least one viewer
/// is subscribed and hands `sink` the differences from the previous sample (the first sample of
/// a viewing period is a diff against the empty list).
#[derive(Clone)]
pub struct PortsHub {
    inner: Arc<HubInner>,
}

impl PortsHub {
    /// The production hub: the OS socket table every [`SAMPLE_INTERVAL`].
    pub fn new(sink: impl Fn(&PortsDiff) + Send + Sync + 'static) -> Self {
        Self::with_source(SAMPLE_INTERVAL, sample_listening_ports, sink)
    }

    pub fn with_source(
        interval: Duration,
        source: impl Fn() -> io::Result<Vec<ListeningPort>> + Send + Sync + 'static,
        sink: impl Fn(&PortsDiff) + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(HubInner {
                interval,
                source: Box::new(source),
                sink: Box::new(sink),
                state: Mutex::new(HubState {
                    viewers: HashSet::new(),
                    generation: 0,
                    last: Vec::new(),
                }),
                wake: Condvar::new(),
                sampler_threads: AtomicUsize::new(0),
            }),
        }
    }

    /// Adds a viewer (a connection id) and returns the last published list, which the viewer
    /// needs as its base for later diffs. The first viewer starts the sampler.
    pub fn subscribe(&self, viewer: &str) -> io::Result<Vec<ListeningPort>> {
        let mut state = self.inner.lock();
        let first = state.viewers.is_empty();
        state.viewers.insert(viewer.to_owned());
        let snapshot = state.last.clone();
        if first {
            state.generation += 1;
            let generation = state.generation;
            let inner = Arc::clone(&self.inner);
            inner.sampler_threads.fetch_add(1, Ordering::AcqRel);
            if let Err(error) = thread::Builder::new()
                .name("ports-sampler".to_owned())
                .spawn({
                    let inner = Arc::clone(&self.inner);
                    move || sampler(inner, generation)
                })
            {
                self.inner.sampler_threads.fetch_sub(1, Ordering::AcqRel);
                state.viewers.remove(viewer);
                return Err(error);
            }
        }
        Ok(snapshot)
    }

    /// Removes a viewer (an unsubscribe or a closed connection). The last one stops the sampler.
    pub fn unsubscribe(&self, viewer: &str) {
        let mut state = self.inner.lock();
        if state.viewers.remove(viewer) && state.viewers.is_empty() {
            state.generation += 1;
            state.last.clear();
            self.inner.wake.notify_all();
        }
    }

    pub fn viewers(&self) -> usize {
        self.inner.lock().viewers.len()
    }

    /// Sampler threads still alive (zero once the last viewer left and the thread returned).
    pub fn sampler_threads(&self) -> usize {
        self.inner.sampler_threads.load(Ordering::Acquire)
    }
}

fn sampler(inner: Arc<HubInner>, generation: u64) {
    let mut published: Vec<ListeningPort> = Vec::new();
    loop {
        // A failed read keeps the previous list: nothing is published for it.
        if let Ok(sample) = (inner.source)() {
            let mut state = inner.lock();
            if state.generation != generation {
                break;
            }
            let diff = diff_ports(&published, &sample);
            if !diff.is_empty() {
                state.last = sample.clone();
                published = sample;
                // The sink runs under the hub lock so viewers join with a list that matches
                // the diffs that follow it; sinks only enqueue.
                (inner.sink)(&diff);
            }
        }
        let state = inner.lock();
        let (state, _) = inner
            .wake
            .wait_timeout_while(state, inner.interval, |s| s.generation == generation)
            .unwrap_or_else(|e| e.into_inner());
        if state.generation != generation {
            break;
        }
    }
    inner.sampler_threads.fetch_sub(1, Ordering::AcqRel);
}
