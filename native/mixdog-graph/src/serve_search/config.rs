// Server tunables: compile-time defaults and the environment overrides
// that bound queue sizes, cache budgets, reader chunking and the AIMD
// scheduler window.
use super::*;

pub(super) const CANCELLED: &str = "cancelled";
pub(super) const SOFT_TIMEOUT: &str = "soft timeout";

/// The request's soft deadline has passed. Every stage asks this between
/// bounded batches — walk, scan, mtime and fuzzy — so the comparison lives
/// here instead of being respelled at each check point.
pub(super) fn deadline_expired(deadline_at: Option<Instant>) -> bool {
    deadline_at.is_some_and(|deadline| Instant::now() >= deadline)
}
pub(super) const FILE_LIST_CACHE_MAX: usize = 8;
pub(super) const WATCH_ROOT_MAX: usize = 16;
pub(super) const DEFAULT_SEARCH_QUEUE_CAPACITY: usize = 2_048;
pub(super) const DEFAULT_RESPONSE_QUEUE_CAPACITY: usize = 512;
pub(super) const MAX_SEARCH_THREADS: usize = 16;
pub(super) const MAX_SEARCH_QUEUE_CAPACITY: usize = 8_192;
pub(super) const MAX_RESPONSE_QUEUE_CAPACITY: usize = 2_048;
pub(super) const DEFAULT_SEARCH_READER_CHUNK_BYTES: usize = 64 * 1_024;
pub(super) const DEFAULT_SEARCH_HEAP_BYTES: usize = 32 * 1_024 * 1_024;
pub(super) const DEFAULT_FILE_LIST_CACHE_BYTES: usize = 64 * 1_024 * 1_024;
pub(super) const DEFAULT_FUZZY_CACHE_BYTES: usize = 64 * 1_024 * 1_024;
pub(super) const DEFAULT_AIMD_TARGET_MS: usize = 250;
pub(super) const DEFAULT_AIMD_INCREASE_EVERY: usize = 8;
pub(super) const WALK_ERROR_DETAIL_MAX: usize = 8;
pub(super) const WALK_ERROR_DETAIL_CHARS: usize = 300;
pub(super) const CONTENT_SIGNATURE_BITS: usize = 16_384;
pub(super) const CONTENT_SIGNATURE_WORDS: usize = CONTENT_SIGNATURE_BITS / 64;
pub(super) const CONTENT_SIGNATURE_CACHE_MAX: usize = 16_384;
pub(super) const CONTENT_SIGNATURE_CACHE_SHARDS: usize = 64;
pub(super) const CONTENT_SIGNATURE_SNAPSHOT_MAGIC: &[u8; 8] = b"MDCSIG02";
pub(super) const CONTENT_SIGNATURE_SNAPSHOT_VERSION: u32 = 2;
pub(super) const CONTENT_SIGNATURE_SNAPSHOT_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub(super) const CONTENT_SIGNATURE_SNAPSHOT_MAX_PATH_BYTES: usize = 1024 * 1024;

pub(super) fn bounded_env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

/// Request id whose handler must panic, for the isolation probe.
///
/// `contain_search_panic` promises that one panicking request comes back as
/// that request's error while the resident server keeps serving. Whether the
/// promise HOLDS depends on the panic strategy the binary was built with, so
/// it can only be proven from outside the process, against a real build. This
/// knob is how the integration suite injects the panic instead of waiting for
/// a genuine bug to appear in a handler.
pub(super) fn panic_probe_id() -> Option<u64> {
    static PROBE: OnceLock<Option<u64>> = OnceLock::new();
    *PROBE.get_or_init(|| {
        std::env::var("MIXDOG_SEARCH_PANIC_PROBE_ID")
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
    })
}

pub(super) fn search_reader_chunk_bytes() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_READER_CHUNK_BYTES",
        DEFAULT_SEARCH_READER_CHUNK_BYTES,
        4 * 1_024,
        1_024 * 1_024,
    )
}

pub(super) fn search_heap_bytes() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_HEAP_BYTES",
        DEFAULT_SEARCH_HEAP_BYTES,
        1_024 * 1_024,
        128 * 1_024 * 1_024,
    )
}

pub(super) fn file_list_cache_bytes() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_FILELIST_CACHE_BYTES",
        DEFAULT_FILE_LIST_CACHE_BYTES,
        1_024 * 1_024,
        512 * 1_024 * 1_024,
    )
}

pub(super) fn fuzzy_cache_bytes() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_FUZZY_CACHE_BYTES",
        DEFAULT_FUZZY_CACHE_BYTES,
        1_024 * 1_024,
        512 * 1_024 * 1_024,
    )
}

pub(super) fn aimd_target() -> Duration {
    Duration::from_millis(bounded_env_usize(
        "MIXDOG_SEARCH_AIMD_TARGET_MS",
        DEFAULT_AIMD_TARGET_MS,
        10,
        10_000,
    ) as u64)
}

pub(super) fn aimd_increase_every() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_AIMD_INCREASE_EVERY",
        DEFAULT_AIMD_INCREASE_EVERY,
        1,
        1_024,
    )
}

pub(super) fn file_list_ttl() -> Option<Duration> {
    match std::env::var("MIXDOG_SEARCH_FILELIST_TTL_MS") {
        Ok(raw) if raw.trim() == "0" => None,
        Ok(raw) => raw
            .parse::<u64>()
            .ok()
            .filter(|ms| *ms > 0)
            .map(Duration::from_millis),
        Err(_) => Some(Duration::from_millis(30_000)),
    }
}

pub(super) fn server_parallelism() -> usize {
    let available = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    std::env::var("MIXDOG_SEARCH_SERVER_MAX_INFLIGHT")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| available.clamp(2, 8))
        .clamp(1, MAX_SEARCH_THREADS)
}

pub(super) fn bulk_parallelism() -> usize {
    std::env::var("MIXDOG_SEARCH_SERVER_MAX_BULK_INFLIGHT")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(2)
        .min(server_parallelism())
}

pub(super) fn interactive_reserve(total_limit: usize) -> usize {
    std::env::var("MIXDOG_SEARCH_INTERACTIVE_RESERVE")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(1)
        .min(total_limit)
}

pub(super) fn queue_capacity() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_SERVER_QUEUE_CAPACITY",
        DEFAULT_SEARCH_QUEUE_CAPACITY,
        1,
        MAX_SEARCH_QUEUE_CAPACITY,
    )
}

pub(super) fn priority_queue_reserve(capacity: usize) -> usize {
    if capacity <= 1 {
        return 0;
    }
    bounded_env_usize(
        "MIXDOG_SEARCH_PRIORITY_QUEUE_RESERVE",
        capacity.div_ceil(8).clamp(1, 64),
        1,
        capacity - 1,
    )
}

pub(super) fn queue_admission_capacity(
    class: SearchClass,
    capacity: usize,
    priority_reserve: usize,
) -> usize {
    if class == SearchClass::Bulk {
        capacity.saturating_sub(priority_reserve).max(1)
    } else {
        capacity
    }
}

pub(super) fn response_queue_capacity() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_RESPONSE_QUEUE_CAPACITY",
        DEFAULT_RESPONSE_QUEUE_CAPACITY,
        1,
        MAX_RESPONSE_QUEUE_CAPACITY,
    )
}
