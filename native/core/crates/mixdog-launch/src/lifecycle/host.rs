//! What the ledger asks of the machine it runs on: the clock, the process table, memory, the parent, timers. One trait, so a
//! test can script all of it; [`OsHost`] answers from the operating system.

use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use serde_json::Map;
use serde_json::Value;

use super::identity;

/// The facts and timers a [`super::ProcessLifecycle`] runs on.
pub trait Host: Send + Sync {
    /// `Date.now()`.
    fn now_ms(&self) -> i64;
    /// `process.hrtime.bigint()`: a monotonic count of nanoseconds.
    fn monotonic_ns(&self) -> u128;
    /// The identity of the process `pid` names (`processIdentityForPid`), `None` when the OS gives none.
    fn identity_of(&self, pid: u32) -> Option<Value>;
    /// Whether a process with this pid exists (`process.kill(pid, 0)`; only "no such process" proves it gone).
    fn process_exists(&self, pid: u32) -> bool;
    /// `process.ppid`.
    fn parent_pid(&self) -> Option<u32>;
    /// `process.cwd()`.
    fn cwd(&self) -> Option<String>;
    /// `memoryCounters()`: the counters of this process the OS reports, `{}` when it reports none.
    fn memory(&self) -> Map<String, Value>;
    /// Runs `job` once, after `delay`, on a thread that does not keep the process alive.
    fn schedule(&self, delay: Duration, job: Box<dyn FnOnce() + Send>);
}

/// The operating system.
pub struct OsHost;

fn anchor() -> Instant {
    static START: OnceLock<Instant> = OnceLock::new();
    *START.get_or_init(Instant::now)
}

/// `process.ppid`.
#[cfg(unix)]
fn parent_pid() -> Option<u32> {
    // SAFETY: getppid has no preconditions and cannot fail.
    u32::try_from(unsafe { libc::getppid() }).ok().filter(|pid| *pid > 0)
}

/// `process.ppid`: the parent a process snapshot names for this process.
#[cfg(windows)]
fn parent_pid() -> Option<u32> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::PROCESSENTRY32W;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32FirstW;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32NextW;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPPROCESS;
    let me = std::process::id();
    // SAFETY: a snapshot handle is opened, walked with an entry of the declared size, and closed before returning.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut parent = None;
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            if entry.th32ProcessID == me {
                parent = Some(entry.th32ParentProcessID);
                break;
            }
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        parent
    }
}

/// `process.memoryUsage()`'s `rss` and `heapUsed`: the working set, and the private bytes the process allocated (a native
/// process has no garbage-collected heap; this is what its allocations hold, as the core's crash record reads it).
#[cfg(windows)]
fn memory() -> Option<(u64, u64)> {
    use windows_sys::Win32::System::ProcessStatus::GetProcessMemoryInfo;
    use windows_sys::Win32::System::ProcessStatus::PROCESS_MEMORY_COUNTERS;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: a plain query of the current process into an out struct of the declared size.
    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) == 0 {
            return None;
        }
        Some((counters.WorkingSetSize as u64, counters.PagefileUsage as u64))
    }
}

/// `/proc/self/statm`: resident and data pages; where there is no procfs the counters are not known.
#[cfg(not(windows))]
fn memory() -> Option<(u64, u64)> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: Vec<u64> = statm.split_whitespace().filter_map(|number| number.parse().ok()).collect();
    // SAFETY: sysconf has no preconditions.
    let page = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap_or(4096);
    Some((pages.get(1)? * page, pages.get(5)? * page))
}

/// `new Date(ms).toISOString()` for a time within years 0000 to 9999.
pub(super) fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let of_day = ms.rem_euclid(86_400_000);
    // Days since 1970-01-01 as a civil date (the proleptic Gregorian calendar).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", of_day / 3_600_000, of_day / 60_000 % 60, of_day / 1000 % 60, of_day % 1000)
}

/// `n.toString(36)`.
pub(super) fn base36(mut n: u128) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_time_is_written_as_to_iso_string_writes_it() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        // Date.UTC(2026, 10, 14, 3, 4, 5, 678)
        assert_eq!(iso_from_ms(1_794_625_445_678), "2026-11-14T03:04:05.678Z");
        // A leap day, and the last millisecond of a year.
        assert_eq!(iso_from_ms(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_767_225_599_999), "2025-12-31T23:59:59.999Z");
    }

    #[test]
    fn a_number_is_written_in_base_36() {
        assert_eq!((base36(0), base36(35), base36(36)), ("0".to_owned(), "z".to_owned(), "10".to_owned()));
        assert_eq!(base36(1_794_625_445_678), "mwftnk8e");
    }
}

impl Host for OsHost {
    fn now_ms(&self) -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
    }

    fn monotonic_ns(&self) -> u128 {
        anchor().elapsed().as_nanos()
    }

    fn identity_of(&self, pid: u32) -> Option<Value> {
        identity::of_pid(pid)
    }

    fn process_exists(&self, pid: u32) -> bool {
        mixdog_statefile::process_exists(pid)
    }

    fn parent_pid(&self) -> Option<u32> {
        parent_pid()
    }

    fn cwd(&self) -> Option<String> {
        std::env::current_dir().ok().map(|dir| dir.to_string_lossy().into_owned())
    }

    fn memory(&self) -> Map<String, Value> {
        let mut counters = Map::new();
        if let Some((rss, heap_used)) = memory() {
            counters.insert("rss".to_owned(), rss.into());
            counters.insert("heapUsed".to_owned(), heap_used.into());
        }
        counters
    }

    fn schedule(&self, delay: Duration, job: Box<dyn FnOnce() + Send>) {
        // The thread is detached: a run that ends while it sleeps is not held up by it (Node's `timer.unref()`).
        let spawned = std::thread::Builder::new().name("process-lifecycle".to_owned()).spawn(move || {
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            job();
        });
        drop(spawned);
    }
}
