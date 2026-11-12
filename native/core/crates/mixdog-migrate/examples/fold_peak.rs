//! `fold_peak <file.log.jsonl>`: folds a 1.4.5 session log as the import does and prints the time and the peak heap.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "measurement binary")]

use std::alloc::GlobalAlloc;
use std::alloc::Layout;
use std::alloc::System;
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_migrate::durable;
use mixdog_migrate::session::source::fold_log;

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let now = LIVE.fetch_add(l.size(), Ordering::Relaxed) + l.size();
        PEAK.fetch_max(now, Ordering::Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        if new > l.size() {
            let now = LIVE.fetch_add(new - l.size(), Ordering::Relaxed) + new - l.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        } else {
            LIVE.fetch_sub(l.size() - new, Ordering::Relaxed);
        }
        unsafe { System.realloc(p, l, new) }
    }
}

#[global_allocator]
static A: Counting = Counting;

fn main() {
    let path = std::env::args().nth(1).expect("log path");
    let name = Path::new(&path).file_name().unwrap().to_string_lossy().into_owned();
    let id = name.strip_suffix(".log.jsonl").expect("a session log");
    let mut file = durable::open_buffered(Path::new(&path)).expect("open");
    let t = std::time::Instant::now();
    let mut replaced = 0;
    let fold = fold_log(id, &mut file, &mut replaced).unwrap_or_else(|_| panic!("fold"));
    println!(
        "folded {} messages, {} header keys in {:?}; peak heap {} MiB; held at the end {} MiB",
        fold.messages.len(),
        fold.header.len(),
        t.elapsed(),
        PEAK.load(Ordering::Relaxed) >> 20,
        LIVE.load(Ordering::Relaxed) >> 20
    );
}
