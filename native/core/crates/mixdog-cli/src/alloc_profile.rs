//! Live heap bytes by allocation site, for a core running without a debugger (feature `alloc-profile`).
//!
//! Build: `cargo build --release -p mixdog-cli --bin mixdogd --features mixdog-cli/alloc-profile`. Check that the
//! feature took: the binary then contains the text `MIXDOG_ALLOC_PROFILE` (`findstr /m MIXDOG_ALLOC_PROFILE mixdogd.exe`);
//! a build without it uses the system heap and has none of this, so no report is ever written and `.now` is never consumed.
//! With the feature, build.rs passes `/MAP` and rust-lld writes `<target>/release/deps/mixdogd.map` beside
//! `deps/mixdogd.exe` (cargo copies only the exe up to `release/`). For a map at a chosen path, link once more with
//! `cargo rustc --release -p mixdog-cli --bin mixdogd --features mixdog-cli/alloc-profile -- -C link-arg=/MAP:<path>`.
//!
//! The feature installs [`ProfilingAllocator`] as the global allocator and counts live bytes and blocks from process start.
//! `serve` enables stack sampling and reports to `MIXDOG_ALLOC_PROFILE=<report file>`, or, when the variable is unset
//! (a core the desktop app starts), to `<USERPROFILE>/.mixdog/data/alloc-profile.txt`. A sample of allocations
//! (every allocation of 64 KiB or more, and size / 64 KiB probability for smaller ones) is recorded with the call stack
//! that made it and forgotten when it is freed. A report is appended to the file every `MIXDOG_ALLOC_PROFILE_SECS`
//! seconds (default 60) and whenever `<report file>.now` appears (the marker is deleted).
//! A report ranks sampled live stacks and puts them beside the process's private bytes, so
//! changes in Rust live data can be distinguished from changes outside it. Private minus live is NOT proof of allocator
//! retention: foreign allocations, stacks and private mappings also contribute. Sampled sizes are estimates
//! (a sample of a small block stands for 64 KiB); the live total includes profiler overhead and is read concurrently.
//! Resolve addresses outside the core using `alloc-report REPORT MAP OUTPUT.jsonl`. Symbol loading inside the measured
//! process would itself inflate private memory. No debugger, PDB, or symbol-server access is needed.
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
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicIsize;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

/// A rise of live bytes over the last report that is reported without waiting for the period.
const SPIKE_BYTES: isize = 48 * 1024 * 1024;
/// How often a second the report thread looks for such a rise.
const SPIKE_POLLS_PER_SECOND: u64 = 20;
/// One sample stands for this many bytes of the allocations smaller than it.
const SAMPLE_BYTES: usize = 64 * 1024;
/// Deep enough to pass the clone chains of nested JSON values to the code that started them: a value nested a few levels takes
/// more than 60 frames of `serde_json` and `indexmap` before its caller's (the 62-frame bound of the capture call was that of
/// Windows before Vista).
const FRAMES: usize = 192;
const SHARDS: usize = 64;
/// Slots of one shard of the sampled-block table; a shard takes no new sample once 3/4 full.
const SHARD_SLOTS: usize = 1 << 12;
/// Distinct stacks the ledger keeps; a sample of a further stack is counted under "other stacks". A slot is never reused,
/// and a core that ran 80 turns and 48 agent sessions filled 16,384 of them, after which its growth had no stack. Each
/// claimed slot commits about 1.6 KiB of `.bss`: the report says how many are claimed.
const SITES: usize = 1 << 16;
/// Slots a site lookup probes before giving up.
const SITE_PROBES: usize = 64;
/// The site of a sample whose stack found no free slot.
const OVERFLOW: u32 = u32::MAX;
/// Bits of the filter that says a block may be sampled; a freed block not in it is never looked up.
const MARK_BITS: usize = 1 << 25;

type Table<K, V> = HashMap<K, V, BuildHasherDefault<DefaultHasher>>;

static ON: AtomicBool = AtomicBool::new(false);
static LIVE_BYTES: AtomicIsize = AtomicIsize::new(0);
static LIVE_BLOCKS: AtomicIsize = AtomicIsize::new(0);
static MARKS: [AtomicU64; MARK_BITS / 64] = [const { AtomicU64::new(0) }; MARK_BITS / 64];
static LEDGER: Ledger = Ledger::new();
static STATS: Stats = Stats::new();

thread_local! {
    /// Set while this thread runs the profiler's own code, so what that allocates is not recorded.
    static BUSY: Cell<bool> = const { Cell::new(false) };
    static RANDOM: Cell<u64> = const { Cell::new(0x6a09_e667_f3bc_c909) };
}

/// What sampling recorded and what it had to leave out, for the report's header.
struct Stats {
    samples: AtomicU64,
    sites: AtomicU64,
    dropped_busy: AtomicU64,
    dropped_full: AtomicU64,
    skipped_loader: AtomicU64,
    overflow_bytes: AtomicI64,
    overflow_blocks: AtomicI64,
}

impl Stats {
    const fn new() -> Self {
        Self {
            samples: AtomicU64::new(0),
            sites: AtomicU64::new(0),
            dropped_busy: AtomicU64::new(0),
            dropped_full: AtomicU64::new(0),
            skipped_loader: AtomicU64::new(0),
            overflow_bytes: AtomicI64::new(0),
            overflow_blocks: AtomicI64::new(0),
        }
    }
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

fn mark_slot(address: usize) -> (usize, u64) {
    let bit = ((address >> 4).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 20) % MARK_BITS;
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
        if loader_lock_held() {
            STATS.skipped_loader.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let mut frames = [0usize; FRAMES];
        let depth = capture(&mut frames);
        let (estimate_bytes, estimate_blocks) = if size >= SAMPLE_BYTES { (size, 1) } else { (SAMPLE_BYTES, SAMPLE_BYTES / size.max(1)) };
        if LEDGER.track(ptr as usize, &frames[..depth], estimate_bytes, estimate_blocks) {
            let (word, bit) = mark_slot(ptr as usize);
            MARKS[word].fetch_or(bit, Ordering::Relaxed);
        }
    });
}

fn note_free(ptr: *mut u8, size: usize) {
    LIVE_BYTES.fetch_sub(size as isize, Ordering::Relaxed);
    LIVE_BLOCKS.fetch_sub(1, Ordering::Relaxed);
    if !ON.load(Ordering::Relaxed) || BUSY.get() {
        return;
    }
    let (word, bit) = mark_slot(ptr as usize);
    if MARKS[word].load(Ordering::Relaxed) & bit == 0 {
        return;
    }
    // Before the block goes back to the system: once it does, another thread may be handed the same address.
    quietly(|| LEDGER.untrack(ptr as usize));
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

/// Whether this thread owns the process's loader lock (`PEB.LoaderLock`, an `RTL_CRITICAL_SECTION` whose
/// `OwningThread` is the owner's thread id). A thread exits, loads a DLL, or runs TLS destructors under it, and the
/// stack walk's function-table lookups take locks the loader also takes, so no stack is captured there.
#[cfg(all(windows, target_arch = "x86_64"))]
fn loader_lock_held() -> bool {
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    let peb: *const u8;
    // SAFETY: on x64 Windows `gs:[0x60]` is this thread's TEB.ProcessEnvironmentBlock; reading it has no effect.
    unsafe { std::arch::asm!("mov {}, gs:[0x60]", out(reg) peb, options(nostack, readonly, preserves_flags)) };
    // SAFETY: the x64 PEB keeps its `LoaderLock` pointer at 0x110 and the critical section keeps `OwningThread` at
    // 0x10; both live as long as the process. A racy read can only equal this thread's id when this thread wrote it.
    let owner = unsafe {
        let lock = std::ptr::read_volatile(peb.add(0x110).cast::<*const u8>());
        if lock.is_null() {
            return false;
        }
        std::ptr::read_volatile(lock.add(0x10).cast::<usize>())
    };
    // SAFETY: no arguments; reads this thread's id.
    owner == unsafe { GetCurrentThreadId() } as usize
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
fn loader_lock_held() -> bool {
    false
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

fn mix(value: u64) -> u64 {
    (value ^ (value >> 31)).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (value >> 17)
}

/// One stack: claimed by writing its nonzero key, published once its frames are written.
struct Site {
    key: AtomicU64,
    /// 1 once the frames are written. A u64, not a bool: no padding byte keeps the static out of .bss.
    ready: AtomicU64,
    depth: AtomicUsize,
    frames: [AtomicUsize; FRAMES],
    bytes: AtomicI64,
    blocks: AtomicI64,
    /// Estimated bytes this stack ever allocated, freed or not: what it churns through the heap.
    made: AtomicI64,
}

impl Site {
    const fn new() -> Self {
        Self {
            key: AtomicU64::new(0),
            ready: AtomicU64::new(0),
            depth: AtomicUsize::new(0),
            frames: [const { AtomicUsize::new(0) }; FRAMES],
            bytes: AtomicI64::new(0),
            blocks: AtomicI64::new(0),
            made: AtomicI64::new(0),
        }
    }
}

/// One sampled live block; `address` 0 is an empty slot. Read and written only under the shard's lock.
struct Entry {
    address: AtomicUsize,
    bytes: AtomicUsize,
    site: AtomicU32,
    /// At most SAMPLE_BYTES (a sample of 1-byte blocks).
    blocks: AtomicU32,
}

impl Entry {
    const fn new() -> Self {
        Self { address: AtomicUsize::new(0), bytes: AtomicUsize::new(0), site: AtomicU32::new(0), blocks: AtomicU32::new(0) }
    }
}

/// A linear-probing table of sampled blocks behind a spin lock whose holder never allocates, calls the system or waits.
struct Shard {
    lock: AtomicUsize,
    len: AtomicUsize,
    slots: [Entry; SHARD_SLOTS],
}

impl Shard {
    const fn new() -> Self {
        Self { lock: AtomicUsize::new(0), len: AtomicUsize::new(0), slots: [const { Entry::new() }; SHARD_SLOTS] }
    }

    fn try_lock(&self) -> bool {
        self.lock.compare_exchange(0, 1, Ordering::Acquire, Ordering::Relaxed).is_ok()
    }

    /// Waits for the lock; bounded, as its holder only does a few loads and stores.
    fn lock(&self) {
        let mut spins = 0u32;
        while !self.try_lock() {
            spins += 1;
            if spins < 64 {
                std::hint::spin_loop();
            } else {
                // A preempted holder needs the CPU; SwitchToThread neither allocates nor takes a lock.
                std::thread::yield_now();
            }
        }
    }

    fn unlock(&self) {
        self.lock.store(0, Ordering::Release);
    }

    fn home(address: usize) -> usize {
        (mix(address as u64) >> 6) as usize & (SHARD_SLOTS - 1)
    }

    /// Records `address` (replacing a stale record of it); the replaced record is returned. Lock held.
    fn insert(&self, address: usize, site: u32, bytes: usize, blocks: usize) -> Option<Option<(u32, usize, usize)>> {
        let mut index = Self::home(address);
        loop {
            let slot = &self.slots[index];
            let held = slot.address.load(Ordering::Relaxed);
            if held == 0 || held == address {
                let replaced = (held == address)
                    .then(|| (slot.site.load(Ordering::Relaxed), slot.bytes.load(Ordering::Relaxed), slot.blocks.load(Ordering::Relaxed) as usize));
                if held == 0 {
                    if self.len.load(Ordering::Relaxed) >= SHARD_SLOTS / 4 * 3 {
                        return None;
                    }
                    self.len.fetch_add(1, Ordering::Relaxed);
                }
                slot.address.store(address, Ordering::Relaxed);
                slot.site.store(site, Ordering::Relaxed);
                slot.bytes.store(bytes, Ordering::Relaxed);
                slot.blocks.store(blocks as u32, Ordering::Relaxed);
                return Some(replaced);
            }
            index = (index + 1) & (SHARD_SLOTS - 1);
        }
    }

    /// Forgets `address`, closing the gap by backward shifting so no probe chain breaks. Lock held.
    fn remove(&self, address: usize) -> Option<(u32, usize, usize)> {
        let mut index = Self::home(address);
        loop {
            let held = self.slots[index].address.load(Ordering::Relaxed);
            if held == 0 {
                return None;
            }
            if held == address {
                break;
            }
            index = (index + 1) & (SHARD_SLOTS - 1);
        }
        let slot = &self.slots[index];
        let removed = (slot.site.load(Ordering::Relaxed), slot.bytes.load(Ordering::Relaxed), slot.blocks.load(Ordering::Relaxed) as usize);
        let mut hole = index;
        let mut next = index;
        loop {
            next = (next + 1) & (SHARD_SLOTS - 1);
            let moving = &self.slots[next];
            let held = moving.address.load(Ordering::Relaxed);
            if held == 0 {
                break;
            }
            let home = Self::home(held);
            if next.wrapping_sub(home) & (SHARD_SLOTS - 1) >= next.wrapping_sub(hole) & (SHARD_SLOTS - 1) {
                let target = &self.slots[hole];
                target.address.store(held, Ordering::Relaxed);
                target.site.store(moving.site.load(Ordering::Relaxed), Ordering::Relaxed);
                target.bytes.store(moving.bytes.load(Ordering::Relaxed), Ordering::Relaxed);
                target.blocks.store(moving.blocks.load(Ordering::Relaxed), Ordering::Relaxed);
                hole = next;
            }
        }
        self.slots[hole].address.store(0, Ordering::Relaxed);
        self.len.fetch_sub(1, Ordering::Relaxed);
        Some(removed)
    }
}

/// The sampled live blocks and the stacks that made them, preallocated (zeroed `.bss`, committed as touched).
struct Ledger {
    shards: [Shard; SHARDS],
    sites: [Site; SITES],
}

impl Ledger {
    const fn new() -> Self {
        Self { shards: [const { Shard::new() }; SHARDS], sites: [const { Site::new() }; SITES] }
    }

    fn shard(&self, address: usize) -> &Shard {
        &self.shards[mix(address as u64) as usize % SHARDS]
    }

    /// The slot of the stack `frames`, claimed and published on first sight; [`OVERFLOW`] when none is free nearby.
    fn site(&self, frames: &[usize]) -> u32 {
        let key = frames.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, frame| (hash ^ *frame as u64).wrapping_mul(0x100_0000_01b3)).max(1);
        let start = mix(key) as usize;
        for probe in 0..SITE_PROBES {
            let index = (start + probe) & (SITES - 1);
            let site = &self.sites[index];
            let held = site.key.load(Ordering::Acquire);
            if held == key {
                return index as u32;
            }
            if held == 0 {
                match site.key.compare_exchange(0, key, Ordering::AcqRel, Ordering::Acquire) {
                    Ok(_) => {
                        for (slot, frame) in site.frames.iter().zip(frames) {
                            slot.store(*frame, Ordering::Relaxed);
                        }
                        site.depth.store(frames.len(), Ordering::Relaxed);
                        site.ready.store(1, Ordering::Release);
                        STATS.sites.fetch_add(1, Ordering::Relaxed);
                        return index as u32;
                    }
                    Err(winner) if winner == key => return index as u32,
                    Err(_) => {}
                }
            }
        }
        OVERFLOW
    }

    fn count(&self, site: u32, bytes: i64, blocks: i64) {
        if site == OVERFLOW {
            STATS.overflow_bytes.fetch_add(bytes, Ordering::Relaxed);
            STATS.overflow_blocks.fetch_add(blocks, Ordering::Relaxed);
        } else {
            let site = &self.sites[site as usize];
            site.bytes.fetch_add(bytes, Ordering::Relaxed);
            site.blocks.fetch_add(blocks, Ordering::Relaxed);
        }
    }

    /// Records a sample; false when it was dropped because its shard was busy or full (the allocation path never waits).
    fn track(&self, address: usize, frames: &[usize], bytes: usize, blocks: usize) -> bool {
        let site = self.site(frames);
        let shard = self.shard(address);
        if !shard.try_lock() {
            STATS.dropped_busy.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let inserted = shard.insert(address, site, bytes, blocks);
        shard.unlock();
        let Some(replaced) = inserted else {
            STATS.dropped_full.fetch_add(1, Ordering::Relaxed);
            return false;
        };
        STATS.samples.fetch_add(1, Ordering::Relaxed);
        if let Some((old_site, old_bytes, old_blocks)) = replaced {
            self.count(old_site, -(old_bytes as i64), -(old_blocks as i64));
        }
        self.count(site, bytes as i64, blocks as i64);
        if site != OVERFLOW {
            self.sites[site as usize].made.fetch_add(bytes as i64, Ordering::Relaxed);
        }
        true
    }

    /// Every published stack with the estimated bytes it ever allocated (the block count is not kept: 0).
    fn made(&self) -> Vec<(Vec<usize>, i64, i64)> {
        self.sites
            .iter()
            .filter(|site| site.ready.load(Ordering::Acquire) == 1)
            .map(|site| {
                let depth = site.depth.load(Ordering::Relaxed).min(FRAMES);
                (site.frames[..depth].iter().map(|frame| frame.load(Ordering::Relaxed)).collect(), site.made.load(Ordering::Relaxed), 0)
            })
            .collect()
    }

    fn untrack(&self, address: usize) {
        let shard = self.shard(address);
        shard.lock();
        let removed = shard.remove(address);
        shard.unlock();
        if let Some((site, bytes, blocks)) = removed {
            self.count(site, -(bytes as i64), -(blocks as i64));
        }
    }

    /// Every published stack with live sampled bytes, as its raw frames from the allocating call outward. Lock-free:
    /// sampling and freeing go on while it reads, so the totals are a concurrent snapshot.
    fn live(&self) -> Vec<(Vec<usize>, i64, i64)> {
        let mut rows: Vec<(Vec<usize>, i64, i64)> = self
            .sites
            .iter()
            .filter(|site| site.ready.load(Ordering::Acquire) == 1)
            .filter_map(|site| {
                let bytes = site.bytes.load(Ordering::Relaxed);
                (bytes > 0).then(|| {
                    let depth = site.depth.load(Ordering::Relaxed).min(FRAMES);
                    (site.frames[..depth].iter().map(|frame| frame.load(Ordering::Relaxed)).collect(), bytes, site.blocks.load(Ordering::Relaxed))
                })
            })
            .collect();
        let overflow = STATS.overflow_bytes.load(Ordering::Relaxed);
        if overflow > 0 {
            rows.push((Vec::new(), overflow, STATS.overflow_blocks.load(Ordering::Relaxed)));
        }
        rows
    }
}

fn mib(bytes: i64) -> String {
    format!("{:.1}", bytes as f64 / 1_048_576.0)
}

/// Report rows of raw frames as text, outside any lock; the stack with no frames is the overflow of the site table.
fn frame_names(live: Vec<(Vec<usize>, i64, i64)>) -> Vec<(Vec<String>, i64, i64)> {
    live.into_iter()
        .map(|(frames, bytes, blocks)| {
            let names = if frames.is_empty() {
                vec!["(other stacks: the site table is full)".to_owned()]
            } else {
                frames.iter().map(|address| format!("0x{address:x}")).collect()
            };
            (names, bytes, blocks)
        })
        .collect()
}

/// One report: the unsampled totals, then estimated bytes by full stack.
fn render(elapsed_secs: u64, live: &[(Vec<String>, i64, i64)], previous: &mut Table<String, i64>) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let exact = LIVE_BYTES.load(Ordering::Relaxed).max(0);
    let blocks = LIVE_BLOCKS.load(Ordering::Relaxed).max(0);
    let sampled: i64 = live.iter().map(|row| row.1).sum();
    let _ = write!(
        out,
        "== t+{elapsed_secs}s live {} MiB in {blocks} blocks (unsampled counters, including profiler; concurrent snapshot); sampled estimate {} MiB",
        mib(exact as i64),
        mib(sampled)
    );
    if let Some((private, working)) = process_bytes() {
        let _ = write!(
            out,
            "; private {} MiB, working set {} MiB, private minus live {} MiB (allocator-held or foreign)",
            mib(private as i64),
            mib(working as i64),
            mib(private as i64 - exact as i64)
        );
    }
    out.push('\n');
    let _ = writeln!(
        out,
        "-- samples {} kept, {} of {SITES} stack slots claimed, {} dropped on a busy shard, {} dropped on a full shard, {} skipped under the loader lock",
        STATS.samples.load(Ordering::Relaxed),
        STATS.sites.load(Ordering::Relaxed),
        STATS.dropped_busy.load(Ordering::Relaxed),
        STATS.dropped_full.load(Ordering::Relaxed),
        STATS.skipped_loader.load(Ordering::Relaxed),
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A ledger of its own on the heap: the shared one is a static, and one this size would not fit a test's stack.
    fn ledger() -> Box<Ledger> {
        // SAFETY: every field of a ledger is an atomic integer or bool, for which all-zero bytes are the initial state.
        unsafe { Box::<Ledger>::new_zeroed().assume_init() }
    }

    fn names(ledger: &Ledger) -> Vec<(Vec<String>, i64, i64)> {
        let mut live = frame_names(ledger.live());
        live.sort_by_key(|row| std::cmp::Reverse(row.1));
        live
    }

    #[test]
    fn a_freed_block_leaves_the_live_ranking_and_a_kept_one_stays() {
        let ledger = ledger();
        assert!(ledger.track(0x1000, &[0x10, 0x20, 0x30], 100_000, 1));
        assert!(ledger.track(0x2000, &[0x10, 0x20, 0x30], 100_000, 1));
        assert!(ledger.track(0x3000, &[0x40], 70_000, 3));
        ledger.untrack(0x1000);
        ledger.untrack(0x9999);
        let live = names(&ledger);
        assert_eq!((live[0].1, live[0].2, live.len()), (100_000, 1, 2));
        assert_eq!(live[0].0, ["0x10", "0x20", "0x30"]);
        ledger.untrack(0x2000);
        assert_eq!(names(&ledger).len(), 1);
    }

    #[test]
    fn removal_keeps_every_other_block_findable() {
        let shard = Shard::new();
        // Addresses that share a home slot form one probe chain; removing from its middle must not cut it.
        let home = Shard::home(0x10);
        let chain: Vec<usize> = (1..200_000usize).map(|n| n * 16).filter(|address| Shard::home(*address) == home).take(6).collect();
        for (n, address) in chain.iter().enumerate() {
            assert_eq!(shard.insert(*address, n as u32, 1, 1), Some(None));
        }
        assert_eq!(shard.remove(chain[2]), Some((2, 1, 1)));
        for (n, address) in chain.iter().enumerate().filter(|(n, _)| *n != 2) {
            assert_eq!(shard.remove(*address), Some((n as u32, 1, 1)), "block {n}");
        }
        assert_eq!(shard.len.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_full_shard_drops_the_sample_instead_of_waiting() {
        let shard = Shard::new();
        let mut kept = 0;
        let mut address = 16;
        while shard.insert(address, 0, 1, 1).is_some() {
            kept += 1;
            address += 16;
        }
        assert_eq!(kept, SHARD_SLOTS / 4 * 3);
        assert_eq!(shard.insert(16, 1, 2, 2), Some(Some((0, 1, 1))), "a known block is still replaced");
    }

    #[test]
    fn a_busy_shard_drops_the_sample() {
        let ledger = ledger();
        let shard = ledger.shard(0x5000);
        assert!(shard.try_lock());
        assert!(!ledger.track(0x5000, &[0x1], 65_536, 1));
        shard.unlock();
        assert!(ledger.track(0x5000, &[0x1], 65_536, 1));
    }

    #[test]
    fn the_same_stack_is_one_site_and_concurrent_samples_all_count() {
        let ledger: &'static Ledger = Box::leak(ledger());
        let threads: Vec<_> = (0..8usize)
            .map(|thread| {
                std::thread::spawn(move || {
                    for n in 0..2_000usize {
                        let address = (thread << 32) | (n << 4) | 0x10;
                        while !ledger.track(address, &[0xa, 0xb], 10, 1) {}
                        if n % 2 == 0 {
                            ledger.untrack(address);
                        }
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let live = names(ledger);
        assert_eq!(live.len(), 1);
        assert_eq!((live[0].1, live[0].2), (8 * 1_000 * 10, 8 * 1_000));
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn a_thread_holding_the_loader_lock_is_seen_to() {
        #[link(name = "ntdll", kind = "raw-dylib")]
        unsafe extern "system" {
            fn LdrLockLoaderLock(flags: u32, disposition: *mut u32, cookie: *mut usize) -> i32;
            fn LdrUnlockLoaderLock(flags: u32, cookie: usize) -> i32;
        }
        assert!(!loader_lock_held());
        let (mut disposition, mut cookie) = (0u32, 0usize);
        // SAFETY: takes and releases the loader lock on this thread; nothing between them loads a module.
        assert_eq!(unsafe { LdrLockLoaderLock(0, &raw mut disposition, &raw mut cookie) }, 0);
        let held = loader_lock_held();
        // SAFETY: the cookie the lock call returned.
        assert_eq!(unsafe { LdrUnlockLoaderLock(0, cookie) }, 0);
        assert!(held);
        assert!(!loader_lock_held());
    }

    #[test]
    fn the_report_ranks_by_size_and_shows_growth_since_the_last_one() {
        let rows = vec![(vec!["mixdog_ai::catalog::load".to_owned()], 3_145_728, 3), (vec!["mixdog_store::log::append".to_owned()], 1_048_576, 9)];
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
    fn the_report_goes_where_the_variable_says_else_under_the_profile_folder() {
        let named = report_path(Some("D:/x/report.txt".into()), Some("C:/Users/a".into()));
        assert_eq!(named, Some(std::path::PathBuf::from("D:/x/report.txt")));
        let home = report_path(None, Some("C:/Users/a".into()));
        assert_eq!(home, Some(std::path::PathBuf::from("C:/Users/a").join(".mixdog").join("data").join("alloc-profile.txt")));
        assert_eq!(report_path(None, None), None);
    }

    #[test]
    fn the_marker_and_the_made_report_sit_beside_the_report_file() {
        let report = std::path::Path::new("D:/x/report.txt");
        assert_eq!(sibling(report, ".now"), std::path::PathBuf::from("D:/x/report.txt.now"));
        assert_eq!(sibling(report, ".made"), std::path::PathBuf::from("D:/x/report.txt.made"));
    }

    #[test]
    fn reports_are_appended_to_both_files_and_a_missing_folder_is_an_error() {
        let dir = std::env::temp_dir().join(format!("alloc-profile-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (live, made) = (dir.join("r.txt"), dir.join("r.txt.made"));
        append_reports(&live, "a\n", &made, "b\n").unwrap();
        append_reports(&live, "c\n", &made, "d\n").unwrap();
        assert_eq!(std::fs::read_to_string(&live).unwrap(), "a\nc\n");
        assert_eq!(std::fs::read_to_string(&made).unwrap(), "b\nd\n");
        assert!(append_reports(&dir.join("absent").join("r.txt"), "x", &made, "y").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// `MIXDOG_ALLOC_PROFILE` when set; otherwise a core the desktop app starts (which inherits no such variable) reports to
/// `<USERPROFILE>/.mixdog/data/alloc-profile.txt`.
fn report_path(configured: Option<std::ffi::OsString>, home: Option<std::ffi::OsString>) -> Option<std::path::PathBuf> {
    configured.map(std::path::PathBuf::from).or_else(|| home.map(|home| std::path::PathBuf::from(home).join(".mixdog").join("data").join("alloc-profile.txt")))
}

/// `<report file><suffix>`: `.now` is the marker that asks for a report, `.made` carries the same rows for the bytes each stack
/// ever allocated.
fn sibling(report: &std::path::Path, suffix: &str) -> std::path::PathBuf {
    let mut name = report.to_path_buf().into_os_string();
    name.push(suffix);
    std::path::PathBuf::from(name)
}

fn append_reports(live_path: &std::path::Path, live: &str, made_path: &std::path::Path, made: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    let append = |path: &std::path::Path, text: &str| std::fs::OpenOptions::new().create(true).append(true).open(path)?.write_all(text.as_bytes());
    append(live_path, live).and_then(|()| append(made_path, made))
}

/// Asks every heap of the process to give back the memory it holds free (the `.trim` marker), and says what private bytes
/// did: whether private bytes above the live total are the allocator's own, and whether asking returns them.
#[cfg(windows)]
fn trim_heaps(elapsed_secs: u64) -> String {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetProcessHeaps(count: u32, heaps: *mut *mut c_void) -> u32;
        fn HeapCompact(heap: *mut c_void, flags: u32) -> usize;
        fn HeapSetInformation(heap: *mut c_void, class: u32, information: *const c_void, length: usize) -> i32;
    }
    let private = || process_bytes().map_or(0, |(private, _)| private as i64);
    let before = private();
    let mut heaps = [std::ptr::null_mut::<c_void>(); 64];
    // SAFETY: the array holds 64 handles and the call writes at most that many.
    let count = (unsafe { GetProcessHeaps(64, heaps.as_mut_ptr()) } as usize).min(64);
    for heap in &heaps[..count] {
        // SAFETY: a handle the process just listed; compaction changes no block's address or content.
        unsafe { HeapCompact(*heap, 0) };
    }
    let compacted = private();
    // HEAP_OPTIMIZE_RESOURCES_INFORMATION { Version: 1, Flags: 0 } under HeapOptimizeResources (3), for every heap.
    let information = [1u32, 0u32];
    // SAFETY: a null heap names all heaps of the process; the structure is the 8 bytes the class takes.
    let optimized = unsafe { HeapSetInformation(std::ptr::null_mut(), 3, information.as_ptr().cast(), 8) };
    let after = private();
    format!(
        "== t+{elapsed_secs}s trim of {count} heaps: live {} MiB; private {} MiB before, {} MiB after HeapCompact, {} MiB after HeapOptimizeResources (accepted: {})\n",
        mib(LIVE_BYTES.load(Ordering::Relaxed).max(0) as i64),
        mib(before),
        mib(compacted),
        mib(after),
        optimized != 0,
    )
}

/// Starts sampling and the report thread (`serve` only).
pub fn enable_from_env() {
    let Some(path) = report_path(std::env::var_os("MIXDOG_ALLOC_PROFILE"), std::env::var_os("USERPROFILE")) else {
        return;
    };
    let every = std::env::var("MIXDOG_ALLOC_PROFILE_SECS").ok().and_then(|secs| secs.parse().ok()).unwrap_or(60u64).max(1);
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
        let request = sibling(&path, ".now");
        let made_path = sibling(&path, ".made");
        let mut previous_made = Table::default();
        let mut previous = Table::default();
        let mut waited = 0u64;
        let mut failing = false;
        // Live bytes at the last report: a rise of `SPIKE_BYTES` over it is reported at once, so a tree that is built and
        // freed between two periodic reports is still seen with its stacks.
        let mut reported = LIVE_BYTES.load(Ordering::Relaxed);
        let mut ticks = 0u64;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1000 / SPIKE_POLLS_PER_SECOND));
            ticks += 1;
            let live_now = LIVE_BYTES.load(Ordering::Relaxed);
            let spike = live_now > reported.saturating_add(SPIKE_BYTES);
            let second = ticks % SPIKE_POLLS_PER_SECOND == 0;
            if second {
                waited += 1;
            }
            if second && std::fs::remove_file(sibling(&path, ".trim")).is_ok() {
                let line = trim_heaps(started.elapsed().as_secs());
                let _ = append_reports(&path, &line, &made_path, "");
            }
            let asked = second && std::fs::remove_file(&request).is_ok();
            if asked || waited >= every || spike {
                waited = 0;
                reported = live_now;
                let live = frame_names(LEDGER.live());
                let text = format!("image_base=0x{image_base:x}\n{}", render(started.elapsed().as_secs(), &live, &mut previous));
                let made = frame_names(LEDGER.made());
                let made_text = format!("image_base=0x{image_base:x}\n{}", render(started.elapsed().as_secs(), &made, &mut previous_made));
                match append_reports(&path, &text, &made_path, &made_text) {
                    Err(error) if !failing => {
                        failing = true;
                        eprintln!("mixdogd: allocation profile report {}: {error}", path.display());
                    }
                    Err(_) => {}
                    Ok(()) => failing = false,
                }
            }
        }
    });
    if let Err(error) = spawned {
        eprintln!("mixdogd: allocation profile report thread: {error}");
    }
}
