//! The user-curated core-memory block a new session's prompt carries
//! (`loadCoreMemoryContext` of `session-runtime/cwd-plugins/core-memory-context.mjs`): the
//! snapshot file's common entries, then the working project's, then the session's own agent's,
//! one `- ` line each, cut to a byte budget. The prompt path reads the file only: it never
//! starts or waits for Postgres, embedding or IPC.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_js::{is_js_space, js_to_lowercase, js_trim, js_words};
use mixdog_rt::DurabilityIo;

use crate::memory::core::snapshot;
use crate::memory::project::resolve_project_scope;

/// The block's budget in UTF-8 bytes (`CORE_MEMORY_MAX_BYTES`).
const MAX_BYTES: usize = 32 * 1024;
const TRUNCATED_MARK: &str = "\n- ...";

/// `formatCoreMemoryLines`: trimmed, whitespace-collapsed lines without blanks or case-insensitive
/// repeats, each as `- text`, joined by newlines; over the budget it is cut back to a word.
pub fn format_core_memory_lines(user_lines: &[String]) -> String {
    let mut seen = HashSet::new();
    let mut lines = Vec::new();
    for value in user_lines {
        let text = js_words(js_trim(value)).collect::<Vec<_>>().join(" ");
        if text.is_empty() || !seen.insert(js_to_lowercase(&text)) {
            continue;
        }
        lines.push(format!("- {text}"));
    }
    let out = lines.join("\n");
    if out.len() <= MAX_BYTES {
        return out;
    }
    // A byte cut can split a multi-byte character; the lossy decode turns it into U+FFFD, which
    // is dropped again together with any other trailing U+FFFD (`stripTrailingReplacementChars`).
    let cut = String::from_utf8_lossy(&out.as_bytes()[..MAX_BYTES - TRUNCATED_MARK.len()]).into_owned();
    let head = cut.trim_end_matches('\u{FFFD}');
    format!("{}{TRUNCATED_MARK}", without_last_word(head))
}

/// `head.replace(/\s+\S*$/, '')`: the last whitespace run and what follows it, when nothing
/// after the run is whitespace; unchanged when there is no whitespace.
fn without_last_word(head: &str) -> &str {
    let Some((last, _)) = head.char_indices().rev().find(|(_, c)| is_js_space(*c)) else {
        return head;
    };
    let start = head[..last].trim_end_matches(is_js_space).len();
    &head[..start]
}

/// Reads the block for one session. `data_dir` is the directory holding `core-memory.json`
/// (Node: `MIXDOG_DATA_DIR`, else the plugin data directory, else the standalone one).
#[derive(Clone)]
pub struct CoreMemoryContext {
    lane: DurabilityIo,
    data_dir: PathBuf,
    opted_out: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl CoreMemoryContext {
    /// `opted_out` is `featureEnvOverride('MIXDOG_BOOT_CORE_MEMORY') === false`, asked on every
    /// load: an explicit opt-out skips only this prompt block, never the recall tools.
    pub fn new(lane: DurabilityIo, data_dir: PathBuf, opted_out: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        Self { lane, data_dir, opted_out }
    }

    /// `loadCoreMemoryContext()` for the session working in `cwd` as agent `agent_id` (empty for
    /// none). Empty when opted out, when there is no usable snapshot, and on any read failure.
    pub async fn load(&self, cwd: &str, agent_id: &str) -> String {
        if (self.opted_out)() {
            boot_profile("core-memory:skipped", None);
            return String::new();
        }
        let started = std::time::Instant::now();
        let text = self.read(cwd, agent_id).await;
        // `finally { bootProfile('core-memory:done', { ms }) }` (`core-memory-context.mjs:68`).
        boot_profile("core-memory:done", Some(started.elapsed().as_secs_f64() * 1000.0));
        text
    }

    async fn read(&self, cwd: &str, agent_id: &str) -> String {
        let Some(snapshot) = snapshot::read(self.lane, &self.data_dir).await else {
            boot_profile("core-memory:file-missing", None);
            return String::new();
        };
        let Ok(project_id) = resolve_project_scope(self.lane, Some(cwd), None).await else {
            return String::new();
        };
        let payload = snapshot::session_payload(&snapshot, project_id.as_deref(), agent_id);
        format_core_memory_lines(&payload.user_lines)
    }
}

/// `bootProfile(event, detail)`: a debug trace, as the daemon's other boot-profile points (`prewarm_world.rs`).
fn boot_profile(event: &'static str, ms: Option<f64>) {
    match ms {
        Some(ms) => tracing::debug!(event, ms = format!("{ms:.1}"), "boot profile"),
        None => tracing::debug!(event, "boot profile"),
    }
    #[cfg(test)]
    BOOT_PROFILE.with(|seen| {
        if let Some(seen) = seen.borrow_mut().as_mut() {
            seen.push((event, ms));
        }
    });
}

#[cfg(test)]
thread_local! {
    /// The boot-profile calls of this thread, while a test collects them.
    pub(crate) static BOOT_PROFILE: std::cell::RefCell<Option<Vec<(&'static str, Option<f64>)>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;
