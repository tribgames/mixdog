//! `machine`: one-call machine status (`machine-tool.mjs`): CPU load (total and the top processes), memory (available and
//! total, and the top processes), free space per drive and, on request, the processes matching a name. One short sample, a hard
//! 1.8 s deadline: whatever is not ready by then is reported as unavailable instead of holding the call.

use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
#[cfg(not(windows))]
use mixdog_core_api::domain::common::AbsPath;
#[cfg(not(windows))]
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProcessHandle;

use crate::fs::common::invalid;
use crate::fs::common::text_output;
use crate::orch::util::spec_from_def;

const MACHINE_SPEC: &str = include_str!("../fs/specs/machine.json");

const MACHINE_DEADLINE: Duration = Duration::from_millis(1800);
const CPU_SAMPLE: Duration = Duration::from_millis(250);
const TOP_DEFAULT: u64 = 5;
const TOP_MAX: u64 = 20;
const MATCH_MAX: usize = 25;
const PROCESS_NAME_MAX: usize = 128;
const GB: f64 = 1024.0 * 1024.0 * 1024.0;

pub struct MachineTool {
    spec: ToolSpec,
}

impl MachineTool {
    pub fn new() -> Self {
        Self { spec: spec_from_def(MACHINE_SPEC, true, &[]) }
    }
}

impl Default for MachineTool {
    fn default() -> Self {
        Self::new()
    }
}

struct Process {
    pid: u64,
    name: String,
    cpu: f64,
    memory: f64,
}

struct Drive {
    root: String,
    free: f64,
    total: f64,
}

/// `Number.prototype.toFixed`: the nearest value, and the larger one of two equally near.
fn to_fixed(x: f64, digits: usize) -> String {
    let scaled = x * 10f64.powi(digits as i32) * 2.0;
    if scaled >= 0.0 && scaled == scaled.trunc() && (scaled as u64) % 2 == 1 {
        let up = (scaled / 2.0 + 0.5).floor() / 10f64.powi(digits as i32);
        return format!("{up:.digits$}");
    }
    format!("{x:.digits$}")
}

fn gb(bytes: f64) -> String {
    format!("{} GB", to_fixed(bytes / GB, if bytes >= 100.0 * GB { 0 } else { 1 }))
}

fn mb(bytes: f64) -> String {
    format!("{} MB", (bytes / (1024.0 * 1024.0) + 0.5).floor())
}

fn proc_line(p: &Process) -> String {
    format!("  {} (pid {})  cpu {}%  mem {}", p.name, p.pid, to_fixed(p.cpu, 1), mb(p.memory))
}

fn list(rows: &[String]) -> String {
    if rows.is_empty() { "  none".to_owned() } else { rows.join("\n") }
}

/// Spawned once per call, so two calls at once never share a name.
static SPAWNS: AtomicU64 = AtomicU64::new(0);

/// A short child's whole stdout, or `None` when it fails to start, exits non-zero or is cut by `limit`.
async fn run(ctx: &ToolContext, program: &str, args: &[&str], limit: Duration) -> Option<String> {
    let handle = ProcessHandle(format!("machine-{}-{}", ctx.call_id, SPAWNS.fetch_add(1, Ordering::Relaxed)));
    let request = SpawnRequest {
        handle,
        command: CommandSpec::Argv { program: program.to_owned(), args: args.iter().map(|a| (*a).to_owned()).collect() },
        cwd: ctx.cwd.clone(),
        env: EnvSpec { inherit: true, ..EnvSpec::default() },
        pty: None,
        stdin_piped: false,
        output: OutputMode::Separate,
        owner: ProcessOwner::Tool { thread_id: ctx.thread_id.clone(), tool_call_id: ctx.call_id.clone() },
        time_limit: Some(limit),
    };
    let (_, mut events) = ctx.processes.spawn_subscribed(request).await.ok()?;
    let mut out = Vec::new();
    while let Some(event) = events.next().await {
        match event {
            ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } => out.extend_from_slice(&bytes),
            ProcessEvent::Output { .. } => {}
            ProcessEvent::Exited { exit, .. } => {
                return (exit.killed.is_none() && exit.status == ExitStatus::Code(0)).then(|| String::from_utf8_lossy(&out).into_owned());
            }
        }
    }
    None
}

fn cores() -> f64 {
    std::thread::available_parallelism().map_or(1, usize::from) as f64
}

#[cfg(windows)]
mod host {
    use mixdog_rt::LaneToken;

    use super::*;

    // Two Get-Process reads 250 ms apart inside ONE PowerShell, so the per-process CPU is a rate, not a lifetime average.
    // Rows: pid, name, cpu s before, cpu s after, working set bytes; the last row is the elapsed ms.
    const PROCESS_SCRIPT: &str = "$sw=[Diagnostics.Stopwatch]::StartNew();$a=@{};Get-Process|%{$a[$_.Id]=[double]$_.CPU};Start-Sleep -Milliseconds 250;Get-Process|%{\"$($_.Id)`t$($_.ProcessName)`t$($a[$_.Id])`t$([double]$_.CPU)`t$($_.WorkingSet64)\"};$sw.ElapsedMilliseconds";

    fn filetime(t: &windows_sys::Win32::Foundation::FILETIME) -> u64 {
        (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)
    }

    /// (idle, total) of the system's CPU time so far.
    fn cpu_times() -> (u64, u64) {
        use windows_sys::Win32::Foundation::FILETIME;
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut idle, mut kernel, mut user) = (zero, zero, zero);
        // SAFETY: three valid out-pointers to FILETIMEs.
        let ok = unsafe { windows_sys::Win32::System::Threading::GetSystemTimes(&mut idle, &mut kernel, &mut user) };
        if ok == 0 {
            return (0, 0);
        }
        // The kernel time includes the idle time.
        (filetime(&idle), filetime(&kernel) + filetime(&user))
    }

    pub async fn cpu_busy(ctx: &ToolContext) -> u64 {
        let sample = |ctx: &ToolContext| {
            let job = ctx.io.maintenance.submit(&ctx.cancel, |_| cpu_times());
            async move { job.ok()?.await.ok() }
        };
        let Some(a) = sample(ctx).await else { return 0 };
        mixdog_rt::time::sleep(CPU_SAMPLE).await;
        let Some(b) = sample(ctx).await else { return 0 };
        let total = b.1.saturating_sub(a.1);
        if total == 0 {
            return 0;
        }
        let busy = total.saturating_sub(b.0.saturating_sub(a.0));
        ((100.0_f64 * busy as f64) / total as f64 + 0.5).floor() as u64
    }

    /// (available, total) physical memory.
    pub async fn memory(ctx: &ToolContext) -> (f64, f64) {
        let job = ctx.io.maintenance.submit(&ctx.cancel, |_| {
            use windows_sys::Win32::System::SystemInformation::GlobalMemoryStatusEx;
            use windows_sys::Win32::System::SystemInformation::MEMORYSTATUSEX;
            // SAFETY: a zeroed struct with its length set, as the call requires.
            let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
            status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            // SAFETY: a valid out-pointer.
            let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
            (ok != 0).then_some((status.ullAvailPhys as f64, status.ullTotalPhys as f64))
        });
        match job {
            Ok(job) => job.await.ok().flatten().unwrap_or((0.0, 1.0)),
            Err(_) => (0.0, 1.0),
        }
    }

    pub async fn processes(ctx: &ToolContext) -> Option<Vec<Process>> {
        let out = run(ctx, "powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", PROCESS_SCRIPT], MACHINE_DEADLINE - Duration::from_millis(200)).await?;
        let mut rows: Vec<&str> = out.trim().lines().collect();
        let elapsed = rows.pop().and_then(|r| r.trim().parse::<f64>().ok()).filter(|e| *e != 0.0).unwrap_or(250.0) / 1000.0;
        let cores = cores();
        Some(
            rows.into_iter()
                .map(|row| {
                    let mut cols = row.split('\t');
                    let pid = cols.next().and_then(|c| c.trim().parse().ok()).unwrap_or(0);
                    let name = cols.next().unwrap_or("").to_owned();
                    let before: f64 = cols.next().and_then(|c| c.trim().parse().ok()).unwrap_or(-1.0);
                    let after: f64 = cols.next().and_then(|c| c.trim().parse().ok()).unwrap_or(-1.0);
                    let memory: f64 = cols.next().and_then(|c| c.trim().parse().ok()).unwrap_or(0.0);
                    let used = if before >= 0.0 && after >= 0.0 { after - before } else { 0.0 };
                    Process { pid, name, cpu: (100.0 * used) / elapsed / cores, memory }
                })
                .collect(),
        )
    }

    pub async fn drives(ctx: &ToolContext) -> Option<Vec<Drive>> {
        let job = ctx.io.maintenance.submit(&ctx.cancel, |_| {
            use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
            let mut rows = Vec::new();
            for letter in b'A'..=b'Z' {
                let root = format!("{}:\\", letter as char);
                let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
                let (mut free, mut total, mut total_free) = (0_u64, 0_u64, 0_u64);
                // SAFETY: a NUL-terminated wide path and three valid out-pointers.
                let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, &mut total_free) };
                if ok != 0 && total > 0 {
                    rows.push(Drive { root, free: free as f64, total: total as f64 });
                }
            }
            rows
        });
        job.ok()?.await.ok()
    }
}

#[cfg(not(windows))]
mod host {
    use super::*;

    async fn read_text(ctx: &ToolContext, path: &str) -> Option<String> {
        let abs = AbsPath::new(path)?;
        let bytes = ctx.files.read(ctx.io.interactive, abs, ReadRange::default()).await.ok()?.bytes;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// (idle, total) of the first `/proc/stat` line: user, nice, sys, idle and irq, as `os.cpus()` sums them.
    async fn cpu_times(ctx: &ToolContext) -> Option<(u64, u64)> {
        let stat = read_text(ctx, "/proc/stat").await?;
        let fields: Vec<u64> = stat.lines().next()?.split_whitespace().skip(1).filter_map(|f| f.parse().ok()).collect();
        let [user, nice, sys, idle, _iowait, irq, ..] = fields[..] else { return None };
        Some((idle, user + nice + sys + idle + irq))
    }

    pub async fn cpu_busy(ctx: &ToolContext) -> u64 {
        let Some(a) = cpu_times(ctx).await else {
            // Where the kernel keeps no such file, the processes' own average stands in.
            let rows = run(ctx, "ps", &["-A", "-o", "pcpu="], MACHINE_DEADLINE - Duration::from_millis(200)).await.unwrap_or_default();
            let sum: f64 = rows.lines().filter_map(|l| l.trim().parse::<f64>().ok()).sum();
            return (sum / cores()).clamp(0.0, 100.0).round() as u64;
        };
        mixdog_rt::time::sleep(CPU_SAMPLE).await;
        let Some(b) = cpu_times(ctx).await else { return 0 };
        let total = b.1.saturating_sub(a.1);
        if total == 0 {
            return 0;
        }
        let busy = total.saturating_sub(b.0.saturating_sub(a.0));
        ((100.0_f64 * busy as f64) / total as f64 + 0.5).floor() as u64
    }

    /// (available, total) memory: `/proc/meminfo`, else the macOS counters.
    pub async fn memory(ctx: &ToolContext) -> (f64, f64) {
        if let Some(info) = read_text(ctx, "/proc/meminfo").await {
            let kb = |key: &str| info.lines().find_map(|l| l.strip_prefix(key)?.trim().strip_suffix("kB")?.trim().parse::<f64>().ok());
            if let (Some(total), Some(free)) = (kb("MemTotal:"), kb("MemAvailable:").or_else(|| kb("MemFree:"))) {
                return (free * 1024.0, total * 1024.0);
            }
        }
        let limit = MACHINE_DEADLINE - Duration::from_millis(200);
        let total = run(ctx, "sysctl", &["-n", "hw.memsize"], limit).await.and_then(|t| t.trim().parse::<f64>().ok()).unwrap_or(1.0);
        let vm = run(ctx, "vm_stat", &[], limit).await.unwrap_or_default();
        let page = vm.lines().next().and_then(|l| l.split("page size of ").nth(1)).and_then(|l| l.split_whitespace().next()).and_then(|n| n.parse::<f64>().ok()).unwrap_or(4096.0);
        let free = vm.lines().find_map(|l| l.strip_prefix("Pages free:")?.trim().trim_end_matches('.').parse::<f64>().ok()).unwrap_or(0.0);
        (free * page, total)
    }

    /// One `ps` read; `%cpu` there is the kernel's own average, not a sample.
    pub async fn processes(ctx: &ToolContext) -> Option<Vec<Process>> {
        let out = run(ctx, "ps", &["-A", "-o", "pid=,pcpu=,rss=,comm="], MACHINE_DEADLINE - Duration::from_millis(200)).await?;
        let cores = cores();
        Some(
            out.lines()
                .filter_map(|line| {
                    let mut parts = line.split_whitespace();
                    let pid = parts.next()?.parse().ok()?;
                    let cpu: f64 = parts.next()?.parse().ok()?;
                    let rss: f64 = parts.next()?.parse().ok()?;
                    let command: Vec<&str> = parts.collect();
                    let name = command.join(" ").rsplit('/').next()?.to_owned();
                    (!name.is_empty()).then_some(Process { pid, name, cpu: cpu / cores, memory: rss * 1024.0 })
                })
                .collect(),
        )
    }

    pub async fn drives(ctx: &ToolContext) -> Option<Vec<Drive>> {
        let out = run(ctx, "df", &["-Pk"], MACHINE_DEADLINE - Duration::from_millis(200)).await?;
        Some(
            out.lines()
                .skip(1)
                .filter_map(|line| {
                    let cols: Vec<&str> = line.split_whitespace().collect();
                    let total: f64 = cols.get(1)?.parse().ok()?;
                    let free: f64 = cols.get(3)?.parse().ok()?;
                    (cols.len() >= 6 && cols[0].starts_with('/') && total > 0.0).then(|| Drive { root: cols[5..].join(" "), free: free * 1024.0, total: total * 1024.0 })
                })
                .collect(),
        )
    }
}

#[async_trait]
impl Tool for MachineTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let top = {
            let n = mixdog_js::to_number_of(args.get("top")).trunc();
            if n.is_finite() && n != 0.0 { (n.clamp(1.0, TOP_MAX as f64)) as u64 } else { TOP_DEFAULT }
        }
        .clamp(1, TOP_MAX) as usize;
        let name = args.get("process").and_then(JsonValue::as_str);
        if let Some(name) = name {
            let length = name.encode_utf16().count();
            if length > PROCESS_NAME_MAX {
                return Err(invalid("process", "length", format!("Error: machine process must be at most {PROCESS_NAME_MAX} characters (got {length})")));
            }
        }
        // Control characters would break the one-line echo below.
        let shown = name
            .map(|name| {
                let mut out = String::new();
                let mut in_run = false;
                for c in name.chars() {
                    if matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}') {
                        if !in_run {
                            out.push(' ');
                        }
                        in_run = true;
                    } else {
                        out.push(c);
                        in_run = false;
                    }
                }
                mixdog_js::js_trim(&out).to_owned()
            })
            .unwrap_or_default();
        let filter = mixdog_js::js_to_lowercase(&shown);
        let (cpu, processes, drives) = futures::join!(
            host::cpu_busy(ctx),
            async { mixdog_rt::time::timeout(MACHINE_DEADLINE, host::processes(ctx)).await.ok().flatten() },
            async { mixdog_rt::time::timeout(MACHINE_DEADLINE, host::drives(ctx)).await.ok().flatten() },
        );
        let (free_mem, total_mem) = host::memory(ctx).await;
        let mut lines = vec![
            format!("cpu: {cpu}% busy of {} cores ({} ms sample)", cores() as u64, CPU_SAMPLE.as_millis()),
            format!("memory: {} available of {} ({}% used)", gb(free_mem), gb(total_mem), ((100.0 * (total_mem - free_mem)) / total_mem + 0.5).floor()),
        ];
        match &processes {
            Some(processes) => {
                let mut by_cpu: Vec<&Process> = processes.iter().collect();
                by_cpu.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
                let mut by_memory: Vec<&Process> = processes.iter().collect();
                by_memory.sort_by(|a, b| b.memory.total_cmp(&a.memory));
                let rows = |sorted: &[&Process]| list(&sorted.iter().take(top).map(|p| proc_line(p)).collect::<Vec<_>>());
                lines.push(format!("top by cpu:\n{}", rows(&by_cpu)));
                lines.push(format!("top by memory:\n{}", rows(&by_memory)));
            }
            None => lines.push("processes: unavailable (no answer within the deadline)".to_owned()),
        }
        lines.push(match &drives {
            Some(drives) => format!(
                "drives (free of total):\n{}",
                list(&drives.iter().map(|d| format!("  {}  {} of {}", d.root, gb(d.free), gb(d.total))).collect::<Vec<_>>())
            ),
            None => "drives: unavailable (no answer within the deadline)".to_owned(),
        });
        if let (false, Some(processes)) = (filter.is_empty(), &processes) {
            let mut matches: Vec<&Process> = processes.iter().filter(|p| mixdog_js::js_to_lowercase(&p.name).contains(&filter)).collect();
            matches.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
            let more = if matches.len() > MATCH_MAX { format!("\n  … {} more", matches.len() - MATCH_MAX) } else { String::new() };
            let rows: Vec<String> = matches.iter().take(MATCH_MAX).map(|p| proc_line(p)).collect();
            lines.push(format!("processes matching \"{shown}\" ({}):\n{}{more}", matches.len(), list(&rows)));
        }
        Ok(text_output(lines.join("\n")))
    }
}
