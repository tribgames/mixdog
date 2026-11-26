//! The code graph engine as a service a graph worker process hosts. It alone owns the [`GraphCache`] (the held graphs,
//! the ledger and its epoch, the per-root refresh turns, leases, lookups, staged writes and heap admission) and answers a
//! query with what the `code_graph` tool answers: the rendered text, the roots it depends on, whether it is whole, and
//! where its time went. Nothing it holds leaves it; its memory goes with the process.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Instant;

use mixdog_graph_host::wire;
use mixdog_graph_host::worker::{EXIT_FAILED, Handler, Rejection, serve_stdio};
use mixdog_protocol::JsonValue;

pub use super::cache::{DiskCatalog, Timings, change_identities};
use super::cache::{self, GraphCache};
use super::{args, dispatch, federation, output, roots};

/// The tool's answer, with its warnings, pagination and output budget applied.
#[derive(Debug)]
pub struct Rendered {
    pub text: String,
    /// The paths the answer depends on (the tool's `dependencyRoots`). `None`: the call recorded none (a missing-file answer)
    /// and is never cached, which no list, however short, means.
    pub dependency_roots: Option<Vec<PathBuf>>,
    /// False when the answer is known partial (a federated section failed, a file could not be indexed, the output budget
    /// cut it).
    pub complete: bool,
    pub timings: QueryTimings,
}

/// Where a query's time went inside the engine.
#[derive(Clone, Copy, Debug)]
pub struct QueryTimings {
    /// The dispatch, its graph work included.
    pub run_ms: u64,
    /// Pruning the resident graphs after the call.
    pub prune_ms: u64,
    /// Applying the warnings and the output budget.
    pub wrap_ms: u64,
    /// The graph work inside `run_ms`.
    pub graph: Timings,
}

pub struct GraphEngine {
    cache: Arc<GraphCache>,
    flush: Arc<Debounce>,
    flusher: Option<std::thread::JoinHandle<()>>,
    #[cfg(test)]
    pub(super) output_budget: Option<usize>,
}

impl GraphEngine {
    /// The engine over the cache under `cache_dir`, with the thread that writes what it stages.
    pub fn new(cache_dir: PathBuf) -> io::Result<Self> {
        let cache = Arc::new(GraphCache::new(cache_dir));
        let flush = Arc::new(Debounce::default());
        let flusher = std::thread::Builder::new().name("code-graph-flush".to_owned()).spawn({
            let (cache, flush) = (cache.clone(), flush.clone());
            move || flush.serve(&cache)
        })?;
        Ok(Self {
            cache,
            flush,
            flusher: Some(flusher),
            #[cfg(test)]
            output_budget: None,
        })
    }

    #[cfg(test)]
    pub(super) fn cache(&self) -> &GraphCache {
        &self.cache
    }

    /// Answers one `code_graph` call as the tool does (`executeCodeGraphTool`), on the calling thread: `args` as the argument
    /// guard passed them, `session_cwd` where the call resolves from, and the registered projects and selected directories a
    /// federated call may fan out over. `Err` is the dispatcher's refusal message.
    pub fn query(&self, session_cwd: &Path, args: &JsonValue, registered: Vec<PathBuf>, selected: Vec<PathBuf>) -> Result<Rendered, String> {
        let parsed = args::Args::parse(args);
        let snapshot = federation::TrustSnapshot::new(registered, selected).with_cached(self.cache.roots());
        let env = dispatch::Env { trust: &snapshot, cache: &self.cache, session_cwd };
        // This thread's timings are this call's: none are left from another call that ran on it.
        let _ = cache::take_timings();
        let running = Instant::now();
        let answer = dispatch::run(&parsed, session_cwd, &env);
        let run_ms = cache::elapsed_ms(running);
        let graph = cache::take_timings();
        let pruning = Instant::now();
        self.cache.prune_after_call();
        let prune_ms = cache::elapsed_ms(pruning);
        self.schedule_flush();
        let answer = answer?;
        let wrapping = Instant::now();
        let (text, uncapped) = output::wrap_with_status(answer.text, &answer.warnings, &parsed, self.output_budget());
        let timings = QueryTimings { run_ms, prune_ms, wrap_ms: cache::elapsed_ms(wrapping), graph };
        Ok(Rendered { text, dependency_roots: answer.dependency_roots, complete: answer.complete && uncapped, timings })
    }

    fn output_budget(&self) -> usize {
        #[cfg(test)]
        if let Some(budget) = self.output_budget {
            return budget;
        }
        output::max_bytes()
    }

    /// Warms the graph of the project `cwd` belongs to (`prewarmCodeGraphIfProject`; the implicit walk, so a home or temp
    /// folder is never adopted): `true` when a project was found and its warm ran.
    pub fn prewarm(&self, cwd: &Path) -> bool {
        let Some(root) = roots::find_dir_project_root(cwd, true) else { return false };
        self.cache.prewarm(&root);
        self.schedule_flush();
        true
    }

    /// Write notices, in the order they were made: each file's identity as [`change_identities`] resolved it when the write
    /// was noticed, `None` for one at an unknown location. Applied at once, beside a build in progress: every refresh that
    /// starts after this sees them.
    pub fn changed<'a>(&self, identities: impl IntoIterator<Item = Option<&'a str>>) {
        self.cache.note_identities(identities);
    }

    /// Forgets a removed worktree's root: its graphs, staged write, manifest row, payload and heap note, after a refresh or a
    /// write of it in progress. What was removed, and the files that matched but could not be deleted.
    pub fn forget_root(&self, root: &Path) -> (Vec<String>, Vec<PathBuf>) {
        self.cache.forget(root)
    }

    /// Writes everything staged, a write already under way included; a failed write is the error.
    pub fn drain(&self) -> io::Result<()> {
        self.cache.flush()
    }

    fn schedule_flush(&self) {
        if self.cache.has_pending() {
            self.flush.schedule();
        }
    }
}

impl Drop for GraphEngine {
    fn drop(&mut self) {
        self.flush.close();
        if let Some(flusher) = self.flusher.take() {
            let _ = flusher.join();
        }
    }
}

/// The graph worker process (`graph-worker`): serves the engine over the cache under `cache_dir` on the standard pipes until
/// the core drains it or closes its input. The process's exit code.
pub fn serve_worker(cache_dir: PathBuf) -> i32 {
    match GraphEngine::new(cache_dir) {
        Ok(engine) => serve_stdio(Worker(engine)),
        Err(_) => EXIT_FAILED,
    }
}

/// The engine as the worker's serve loop calls it.
pub(super) struct Worker(pub(super) GraphEngine);

impl Handler for Worker {
    fn query(&self, query: wire::Query) -> Result<wire::Answer, Rejection> {
        let wire::Query { session_cwd, args, registered, selected } = query;
        let rendered = self.0.query(&session_cwd, &args, registered, selected).map_err(|message| Rejection::Refused(wire::Refusal { message }))?;
        let (spent, graph) = (rendered.timings, rendered.timings.graph);
        let timings = wire::Timings {
            // The serve loop's own.
            queue_ms: 0,
            run_ms: spent.run_ms,
            prune_ms: spent.prune_ms,
            wrap_ms: spent.wrap_ms,
            root_wait_ms: graph.root_wait_ms,
            inventory_ms: graph.inventory_ms,
            verify_ms: graph.verify_ms,
            resolver_check_ms: graph.resolver_check_ms,
            cache_load_ms: graph.cache_load_ms,
            parse_ms: graph.parse_ms,
            link_ms: graph.link_ms,
            assemble_ms: graph.assemble_ms,
            admission_ms: graph.admission_ms,
            files_reused: graph.reused as u64,
            files_parsed: graph.parsed as u64,
            files_omitted: graph.omitted as u64,
            files_verified: graph.verified as u64,
            retained: graph.retained,
            generation: graph.generation,
        };
        Ok(wire::Answer { text: rendered.text, dependency_roots: rendered.dependency_roots, complete: rendered.complete, timings })
    }

    fn prewarm(&self, prewarm: wire::Prewarm) -> Result<wire::Warmed, wire::WorkerFailure> {
        Ok(wire::Warmed { built: self.0.prewarm(&prewarm.cwd) })
    }

    fn changed(&self, changed: wire::Changed) {
        self.0.changed(changed.files.iter().map(|file| match file {
            wire::FileIdentity::Known { identity } => Some(identity.as_str()),
            wire::FileIdentity::Unknown => None,
        }));
    }

    fn forget_root(&self, forget: wire::ForgetRoot) -> Result<wire::Forgot, wire::WorkerFailure> {
        let (removed, kept) = self.0.forget_root(&forget.root);
        Ok(wire::Forgot { removed, kept })
    }

    fn drain(&self) -> Result<(), wire::WorkerFailure> {
        self.0.drain().map_err(|error| wire::WorkerFailure { kind: wire::FailureKind::Io, message: error.to_string() })
    }
}

/// The write debounce: a flush [`cache::FLUSH_DELAY`] after the first write staged since the last one, of whatever has
/// been staged by then. A failed write leaves its roots staged: the next flush, the drain's included, writes them again.
#[derive(Default)]
struct Debounce {
    due: Mutex<Due>,
    wake: Condvar,
}

#[derive(Default)]
struct Due {
    at: Option<Instant>,
    closed: bool,
}

impl Debounce {
    fn schedule(&self) {
        let mut due = self.due.lock().unwrap_or_else(PoisonError::into_inner);
        if due.at.is_none() {
            due.at = Some(Instant::now() + cache::FLUSH_DELAY);
            self.wake.notify_one();
        }
    }

    fn close(&self) {
        self.due.lock().unwrap_or_else(PoisonError::into_inner).closed = true;
        self.wake.notify_one();
    }

    fn serve(&self, cache: &GraphCache) {
        let mut due = self.due.lock().unwrap_or_else(PoisonError::into_inner);
        while !due.closed {
            match due.at {
                None => due = self.wake.wait(due).unwrap_or_else(PoisonError::into_inner),
                Some(at) if Instant::now() < at => {
                    due = self.wake.wait_timeout(due, at.saturating_duration_since(Instant::now())).unwrap_or_else(PoisonError::into_inner).0;
                }
                Some(_) => {
                    due.at = None;
                    drop(due);
                    let _ = cache.flush();
                    due = self.due.lock().unwrap_or_else(PoisonError::into_inner);
                }
            }
        }
    }
}
