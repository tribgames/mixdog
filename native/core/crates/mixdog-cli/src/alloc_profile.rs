//! Live heap bytes by allocation site, for a core running without a debugger (feature `alloc-profile`).
//!
//! Build with `--features alloc-profile`; the linker also writes `deps/mixdogd.map`.
//! The feature installs [`ProfilingAllocator`] as the global allocator and counts live bytes and blocks from process start.
//! `MIXDOG_ALLOC_PROFILE=<report file>` enables stack sampling for `serve` only. A sample of allocations
//! (every allocation of 64 KiB or more, and size / 64 KiB probability for smaller ones) is also
//! recorded with the call stack that made it and forgotten when it is freed. A report is appended to the file every
//! `MIXDOG_ALLOC_PROFILE_SECS` seconds (default 60) and whenever `<report file>.now` appears (the marker is deleted).
//! A report ranks sampled live stacks and puts them beside the process's private bytes, so
//! changes in Rust live data can be distinguished from changes outside it. Private minus live is NOT proof of allocator
//! retention: foreign allocations, stacks and private mappings also contribute. Sampled sizes are estimates
//! (a sample of a small block stands for 64 KiB); the live total includes profiler overhead and is read concurrently.
//! Resolve addresses outside the core using `alloc-report REPORT MAP OUTPUT.jsonl`. Symbol loading inside the measured
//! process would itself inflate private memory. No debugger, PDB, or symbol-server access is needed.
//!
//! The default build has none of this: without the feature the system allocator is linked directly.
#![allow(
    unsafe_code,
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "diagnostic allocator and its report writer: it wraps the system allocator and owns its thread and file"
)]

use std::alloc::GlobalAlloc;
use std::alloc::Layout;
use std::alloc::System;
use std::cell::Cell;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::BuildHasherDefault;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicIsize;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

/// One sample stands for this many bytes of the allocations smaller than it.
const SAMPLE_BYTES: usize = 64 * 1024;
/// Deep enough to pass the clone chains of nested JSON values to the code that started them (the capture call accepts at most 62 frames with the 2 skipped).
const FRAMES: usize = 60;
const SHARDS: usize = 64;
/// Bits of the filter that says a block may be sampled; a freed block not in it is never looked up.
const MARK_BITS: usize = 1 << 25;

type Table<K, V> = HashMap<K, V, BuildHasherDefault<DefaultHasher>>;

static ON: AtomicBool = AtomicBool::new(false);
static LIVE_BYTES: AtomicIsize = AtomicIsize::new(0);
static LIVE_BLOCKS: AtomicIsize = AtomicIsize::new(0);
static MARKS: [AtomicU64; MARK_BITS / 64] = [const { AtomicU64::new(0) }; MARK_BITS / 64];
static LEDGER: OnceLock<Ledger> = OnceLock::new();

thread_local! {
    /// Set while this thread runs the profiler's own code, so what that allocates is not recorded.
    static BUSY: Cell<bool> = const { Cell::new(false) };
    static RANDOM: Cell<u64> = const { Cell::new(0x6a09_e667_f3bc_c909) };
}

fn quietly<R>(f: impl FnOnce() -> R) -> Option<R> {
    if BUSY.get() {
        return None;
    }
    BUSY.set(true);
    let out = f();
    BUSY.set(false);
    Some(out)
}

/// The system allocator; stack sampling starts with [`enable_from_env`].
pub struct ProfilingAllocator;

// SAFETY: every request is forwarded to `System` with the caller's layout and its result returned unchanged; the
// counters and the ledger only observe.
unsafe impl GlobalAlloc for ProfilingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract, which `System` shares.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            note_alloc(ptr, layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: as in `alloc`; kept so zeroed blocks are still the system's, untouched until used.
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            note_alloc(ptr, layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        note_free(ptr, layout.size());
        // SAFETY: `ptr` and `layout` are the caller's, from this allocator.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note_free(ptr, layout.size());
        // SAFETY: the caller upholds `GlobalAlloc::realloc`'s contract, which `System` shares.
        let moved = unsafe { System.realloc(ptr, layout, new_size) };
        if moved.is_null() {
            // The old block is still live.
            note_alloc(ptr, layout.size());
        } else {
            note_alloc(moved, new_size);
        }
        moved
    }
}

fn mark_slot(ptr: *mut u8) -> (usize, u64) {
    let bit = ((ptr as usize >> 4).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 20) % MARK_BITS;
    (bit / 64, 1 << (bit % 64))
}

fn note_alloc(ptr: *mut u8, size: usize) {
    LIVE_BYTES.fetch_add(size as isize, Ordering::Relaxed);
    LIVE_BLOCKS.fetch_add(1, Ordering::Relaxed);
    if !ON.load(Ordering::Relaxed) || BUSY.get() {
        return;
    }
    let sampled = RANDOM.with(|state| {
        let mut next = state.get();
        next ^= next << 13;
        next ^= next >> 7;
        next ^= next << 17;
        state.set(next);
        size >= SAMPLE_BYTES || (next as usize % SAMPLE_BYTES) < size
    });
    if !sampled {
        return;
    }
    quietly(|| {
        let mut frames = [0usize; FRAMES];
        let depth = capture(&mut frames);
        let key = frames[..depth].iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, frame| (hash ^ *frame as u64).wrapping_mul(0x100_0000_01b3));
        let (estimate_bytes, estimate_blocks) = if size >= SAMPLE_BYTES { (size, 1) } else { (SAMPLE_BYTES, SAMPLE_BYTES / size.max(1)) };
        let ledger = LEDGER.get_or_init(Ledger::new);
        ledger.track(ptr as usize, key, estimate_bytes, estimate_blocks, || Stack::Captured(frames));
        let (word, bit) = mark_slot(ptr);
        MARKS[word].fetch_or(bit, Ordering::Relaxed);
    });
}

fn note_free(ptr: *mut u8, size: usize) {
    LIVE_BYTES.fetch_sub(size as isize, Ordering::Relaxed);
    LIVE_BLOCKS.fetch_sub(1, Ordering::Relaxed);
    if !ON.load(Ordering::Relaxed) || BUSY.get() {
        return;
    }
    let (word, bit) = mark_slot(ptr);
    if MARKS[word].load(Ordering::Relaxed) & bit == 0 {
        return;
    }
    // Before the block goes back to the system: once it does, another thread may be handed the same address.
    quietly(|| {
        if let Some(ledger) = LEDGER.get() {
            ledger.untrack(ptr as usize);
        }
    });
}

#[cfg(windows)]
fn capture(frames: &mut [usize; FRAMES]) -> usize {
    use windows_sys::Win32::System::Diagnostics::Debug::RtlCaptureStackBackTrace;
    // SAFETY: `frames` holds FRAMES pointer-sized slots; no hash is asked for.
    usize::from(unsafe { RtlCaptureStackBackTrace(2, FRAMES as u32, frames.as_mut_ptr().cast(), std::ptr::null_mut()) })
}

#[cfg(not(windows))]
fn capture(_frames: &mut [usize; FRAMES]) -> usize {
    0
}

/// The process's private (committed) bytes and working set, for the report's comparison with the live total.
#[cfg(windows)]
fn process_bytes() -> Option<(usize, usize)> {
    use windows_sys::Win32::System::ProcessStatus::K32GetProcessMemoryInfo;
    use windows_sys::Win32::System::ProcessStatus::PROCESS_MEMORY_COUNTERS_EX;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: an all-zero counters struct is valid; the call fills at most `cb` bytes of it.
    let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    // SAFETY: the pseudo-handle of this process and a correctly sized counters struct.
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), (&raw mut counters).cast(), counters.cb) };
    (ok != 0).then_some((counters.PrivateUsage, counters.WorkingSetSize))
}

#[cfg(not(windows))]
fn process_bytes() -> Option<(usize, usize)> {
    None
}

/// Raw addresses are resolved by a separate process, never by the measured core.
enum Stack {
    Captured([usize; FRAMES]),
    Text(String),
}

impl Stack {
    fn frames(&mut self) -> Vec<String> {
        if let Stack::Captured(frames) = self {
            return frames.iter().take_while(|address| **address != 0).map(|address| format!("0x{address:x}")).collect();
        }
        let Stack::Text(text) = self else { unreachable!("resolved above") };
        text.lines().filter_map(frame_name).collect()
    }
}

/// `   12: name` of a rendered backtrace; the `at file:line` rows have no number and are dropped.
fn frame_name(line: &str) -> Option<String> {
    let (number, name) = line.trim_start().split_once(": ")?;
    number.bytes().all(|b| b.is_ascii_digit()).then(|| name.trim().to_owned())
}

struct Tracked {
    stack: u64,
    bytes: usize,
    blocks: usize,
}

struct Site {
    stack: Stack,
    bytes: i64,
    blocks: i64,
}

/// The sampled live blocks and the stacks that made them.
struct Ledger {
    blocks: [Mutex<Table<usize, Tracked>>; SHARDS],
    sites: Mutex<Table<u64, Site>>,
}

impl Ledger {
    fn new() -> Self {
        Self { blocks: std::array::from_fn(|_| Mutex::new(Table::default())), sites: Mutex::new(Table::default()) }
    }

    fn shard(&self, address: usize) -> &Mutex<Table<usize, Tracked>> {
        &self.blocks[(address >> 4) % SHARDS]
    }

    fn track(&self, address: usize, stack: u64, bytes: usize, blocks: usize, describe: impl FnOnce() -> Stack) {
        self.shard(address).lock().unwrap_or_else(PoisonError::into_inner).insert(address, Tracked { stack, bytes, blocks });
        let mut sites = self.sites.lock().unwrap_or_else(PoisonError::into_inner);
        let site = sites.entry(stack).or_insert_with(|| Site { stack: describe(), bytes: 0, blocks: 0 });
        site.bytes += bytes as i64;
        site.blocks += blocks as i64;
    }

    fn untrack(&self, address: usize) {
        let Some(tracked) = self.shard(address).lock().unwrap_or_else(PoisonError::into_inner).remove(&address) else { return };
        let mut sites = self.sites.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(site) = sites.get_mut(&tracked.stack) {
            site.bytes -= tracked.bytes as i64;
            site.blocks -= tracked.blocks as i64;
            if site.bytes == 0 {
                sites.remove(&tracked.stack);
            }
        }
    }

    /// Every stack with live sampled bytes, as its frames from the allocating call outward.
    fn live(&self) -> Vec<(Vec<String>, i64, i64)> {
        let mut sites = self.sites.lock().unwrap_or_else(PoisonError::into_inner);
        sites.values_mut().filter(|site| site.bytes > 0).map(|site| (site.stack.frames(), site.bytes, site.blocks)).collect()
    }
}

fn mib(bytes: i64) -> String {
    format!("{:.1}", bytes as f64 / 1_048_576.0)
}

/// One report: the unsampled totals, then estimated bytes by full stack.
fn render(elapsed_secs: u64, live: &[(Vec<String>, i64, i64)], previous: &mut Table<String, i64>) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let exact = LIVE_BYTES.load(Ordering::Relaxed).max(0);
    let blocks = LIVE_BLOCKS.load(Ordering::Relaxed).max(0);
    let sampled: i64 = live.iter().map(|row| row.1).sum();
    let _ = write!(out, "== t+{elapsed_secs}s live {} MiB in {blocks} blocks (unsampled counters, including profiler; concurrent snapshot); sampled estimate {} MiB", mib(exact as i64), mib(sampled));
    if let Some((private, working)) = process_bytes() {
        let _ = write!(out, "; private {} MiB, working set {} MiB, private minus live {} MiB (allocator-held or foreign)", mib(private as i64), mib(working as i64), mib(private as i64 - exact as i64));
    }
    out.push('\n');
    let mut stacks: Vec<_> = live.iter().collect();
    stacks.sort_by_key(|row| std::cmp::Reverse(row.1));
    out.push_str("-- live stacks (estimated bytes, change, estimated blocks)\n");
    for (frames, bytes, count) in stacks {
        let key = frames.join(";");
        let change = bytes - previous.get(&key).copied().unwrap_or(0);
        let _ = writeln!(out, "stack bytes={bytes} delta={change:+} blocks={count}");
        for name in frames {
            let _ = writeln!(out, "            {name}");
        }
    }
    *previous = live.iter().map(|(frames, bytes, _)| (frames.join(";"), *bytes)).collect();
    out
}

/// Starts sampling and the report thread when the process was started with `MIXDOG_ALLOC_PROFILE`.
pub fn enable_from_env() {
    let Some(path) = std::env::var_os("MIXDOG_ALLOC_PROFILE").map(std::path::PathBuf::from) else { return };
    let every = std::env::var("MIXDOG_ALLOC_PROFILE_SECS").ok().and_then(|secs| secs.parse().ok()).unwrap_or(60u64);
    LEDGER.get_or_init(Ledger::new);
    ON.store(true, Ordering::Relaxed);
    let started = std::time::Instant::now();
    let spawned = std::thread::Builder::new().name("alloc-profile".to_owned()).spawn(move || {
        BUSY.set(true);
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetModuleHandleW(name: *const u16) -> *mut std::ffi::c_void;
        }
        // SAFETY: null asks for this process's executable; no pointer is dereferenced.
        let image_base = unsafe { GetModuleHandleW(std::ptr::null()) } as usize;
        let request = {
            let mut name = path.clone().into_os_string();
            name.push(".now");
            std::path::PathBuf::from(name)
        };
        let mut previous = Table::default();
        let mut waited = 0u64;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            waited += 1;
            let asked = std::fs::remove_file(&request).is_ok();
            if asked || waited >= every {
                waited = 0;
                let live = LEDGER.get().map(Ledger::live).unwrap_or_default();
                let text = format!("image_base=0x{image_base:x}\n{}", render(started.elapsed().as_secs(), &live, &mut previous));
                use std::io::Write as _;
                if let Err(error) = std::fs::OpenOptions::new().create(true).append(true).open(&path)
                    .and_then(|mut file| file.write_all(text.as_bytes()))
                {
                    eprintln!("mixdogd: allocation profile report: {error}");
                    break;
                }
            }
        }
    });
    if let Err(error) = spawned {
        eprintln!("mixdogd: allocation profile report thread: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(frames: &[&str]) -> Stack {
        Stack::Text(frames.iter().enumerate().map(|(i, name)| format!("{i:>4}: {name}\n             at src/x.rs:1\n")).collect())
    }

    #[test]
    fn a_freed_block_leaves_the_live_ranking_and_a_kept_one_stays() {
        let ledger = Ledger::new();
        ledger.track(0x1000, 1, 100_000, 1, || text(&["alloc::vec::grow", "mixdog_services::memory::open", "main"]));
        ledger.track(0x2000, 1, 100_000, 1, || unreachable!("the stack is already known"));
        ledger.track(0x3000, 2, 70_000, 3, || text(&["mixdog_ai::catalog::load"]));
        ledger.untrack(0x1000);
        ledger.untrack(0x9999);
        let mut live = ledger.live();
        live.sort_by_key(|row| std::cmp::Reverse(row.1));
        assert_eq!((live[0].1, live[0].2, live.len()), (100_000, 1, 2));
        assert_eq!(live[0].0[1], "mixdog_services::memory::open");
        ledger.untrack(0x2000);
        assert_eq!(ledger.live().len(), 1);
    }

    #[test]
    fn the_report_ranks_by_size_and_shows_growth_since_the_last_one() {
        let rows = vec![
            (vec!["mixdog_ai::catalog::load".to_owned()], 3_145_728, 3),
            (vec!["mixdog_store::log::append".to_owned()], 1_048_576, 9),
        ];
        let mut previous = Table::default();
        let first = render(60, &rows, &mut previous);
        let load = first.lines().position(|line| line.ends_with("mixdog_ai::catalog::load")).unwrap();
        let append = first.lines().position(|line| line.ends_with("mixdog_store::log::append")).unwrap();
        assert!(load < append);
        let grown = vec![(vec!["mixdog_ai::catalog::load".to_owned()], 4_194_304, 4)];
        let second = render(120, &grown, &mut previous);
        assert!(second.contains("stack bytes=4194304 delta=+1048576 blocks=4"), "{second}");
    }

    #[test]
    fn rendered_backtrace_rows_give_frame_names_only() {
        assert_eq!(frame_name("   3: mixdog_ai::load"), Some("mixdog_ai::load".to_owned()));
        assert_eq!(frame_name("             at src/x.rs:1"), None);
    }
}
