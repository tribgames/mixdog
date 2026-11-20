//! A replay's barrier on the model's bytes (feature `replay-bytes`, development builds only; off until
//! `MIXDOG_REPLAY_BYTES=127.0.0.1:<port>` names the replay's listener). Bytes arriving on a socket are outside the core's clock
//! until the core admits them, so a replay that advances the clock after writing a scripted response first waits for this
//! announcement: after each response chunk the core has handled (its reader asked for the next chunk, or the body ended),
//! one line `bytes <origin> <total>` with the total of response bytes handled from that origin (`host:port`) since the process
//! began. Per origin: the replay counts what its model endpoint wrote, and the core's other fetches must not satisfy it.

use async_trait::async_trait;
use bytes::Bytes;
use std::io::Write;
use std::net::TcpStream;
use std::sync::Mutex;
use std::sync::OnceLock;

use super::link::BodyStream;
use mixdog_core_api::domain::provider::TransportFault;

/// The replay's listener address.
pub const ENV: &str = "MIXDOG_REPLAY_BYTES";

struct Announcer {
    stream: TcpStream,
    totals: std::collections::HashMap<String, u64>,
}

/// A response body whose chunks are announced as handled when its reader asks for the next (or the body ends).
pub(crate) struct Counted {
    inner: Box<dyn BodyStream>,
    held: usize,
    origin: String,
}

/// `body`, the response from `url`, counted for the replay's barrier.
pub(crate) fn counted(url: &url::Url, body: Box<dyn BodyStream>) -> Box<dyn BodyStream> {
    let origin = format!("{}:{}", url.host_str().unwrap_or_default(), url.port_or_known_default().unwrap_or_default());
    Box::new(Counted { inner: body, held: 0, origin })
}

// A replay's settled signal (mixdog-core-session `replay_settled.rs`) asks whether every turn is parked: waiting on the model (its
// answer's head or its body's next chunk) or on the user (an approval or a question), the waits only a replay's next input ends.
// A turn's task runs inside [`in_run`] under its [`Run`]; a wait on such an input counts for the run it belongs to: [`parked`] for a
// wait on the run's own task, [`turn_parked`] with the run's handle for a wait on a task the run spawned (a tool's approval: the
// handle is captured where the run is spawned and passed in, since a spawned task does not inherit the run's task-local), and any wait
// on a task the run spawned for part of its own work under a [`delegate`] of the run, retired when the run stops waiting. A run is
// parked while at least one of its waits is; RUNS and PARKED_RUNS count runs, so they compare like for like. A wait outside any
// run is counted apart (OUTSIDE) and never holds "settled".
tokio::task_local! {
    static RUN: Run;
}

static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static PARKED_RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static OUTSIDE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static ON_CHANGE: OnceLock<fn()> = OnceLock::new();

/// One turn's run: the handle its waits are counted on.
#[derive(Clone, Default)]
pub struct Run(std::sync::Arc<Waits>);

enum Waits {
    /// A turn's own: how many of its waits are parked.
    Own(std::sync::atomic::AtomicUsize),
    /// The waits of a task a turn spawned for part of its own work ([`delegate`]): parked on the turn while any is, until
    /// the turn stops waiting for the task (`retired`), whatever the task does after.
    Delegated { run: Run, state: Mutex<Delegated> },
}

#[derive(Default)]
struct Delegated {
    parked: usize,
    retired: bool,
}

impl Default for Waits {
    fn default() -> Self {
        Self::Own(std::sync::atomic::AtomicUsize::new(0))
    }
}

impl Run {
    /// One more of the run's waits is parked.
    fn park(&self) {
        match &*self.0 {
            Waits::Own(parked) => {
                if parked.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    PARKED_RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
            Waits::Delegated { run, state } => {
                let mut state = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if !state.retired {
                    state.parked += 1;
                    if state.parked == 1 {
                        run.park();
                    }
                }
            }
        }
    }

    /// One of the run's parked waits ended.
    fn unpark(&self) {
        match &*self.0 {
            Waits::Own(parked) => {
                if parked.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                    PARKED_RUNS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
            Waits::Delegated { run, state } => {
                let mut state = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if !state.retired {
                    state.parked -= 1;
                    if state.parked == 0 {
                        run.unpark();
                    }
                }
            }
        }
    }
}

/// Held by a turn's task while it waits for the task it delegated part of its work to ([`delegate`]); dropped, the
/// delegate's parked waits stop counting for the turn at once, before the turn itself can end.
pub(crate) struct Delegate(Option<Run>);

impl Drop for Delegate {
    fn drop(&mut self) {
        let Some(Run(waits)) = &self.0 else { return };
        let Waits::Delegated { run, state } = &**waits else { return };
        let mut state = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !state.retired {
            state.retired = true;
            if std::mem::take(&mut state.parked) > 0 {
                run.unpark();
            }
        }
    }
}

/// `work`, which the task that calls this spawns as part of its own turn: its waits park that turn as the turn's own task's
/// would, and add no run of their own, while the caller holds the [`Delegate`].
pub(crate) fn delegate<F: std::future::Future>(work: F) -> (impl std::future::Future<Output = F::Output>, Delegate) {
    let delegated = RUN.try_with(Run::clone).ok().map(|run| Run(std::sync::Arc::new(Waits::Delegated { run, state: Mutex::new(Delegated::default()) })));
    (mixdog_rt::within_local(&RUN, delegated.clone(), work), Delegate(delegated))
}

/// `hook` is called whenever a turn may have become parked (it began a wait on an input, or ended).
pub fn on_change(hook: fn()) {
    let _ = ON_CHANGE.set(hook);
}

fn changed() {
    if let Some(hook) = ON_CHANGE.get() {
        hook();
    }
}

/// `Some((running, alive))` while a turn alive is not parked on an input.
pub fn unparked() -> Option<(usize, usize)> {
    use std::sync::atomic::Ordering::SeqCst;
    let (alive, parked) = (RUNS.load(SeqCst), PARKED_RUNS.load(SeqCst));
    let running = alive.saturating_sub(parked);
    (running > 0).then_some((running, alive))
}

/// The waits on an input parked outside any run (not part of "settled").
pub fn parked_outside() -> usize {
    OUTSIDE.load(std::sync::atomic::Ordering::SeqCst)
}

struct Alive;

impl Drop for Alive {
    fn drop(&mut self) {
        RUNS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        changed();
    }
}

/// Runs a turn's task under a run of its own: alive (and busy unless parked) until it ends.
pub async fn in_run<F: std::future::Future>(run: F) -> F::Output {
    in_run_as(Run::default(), run).await
}

/// [`in_run`] under `handle`, which the run's spawned tasks were given for their waits ([`turn_parked`]).
pub async fn in_run_as<F: std::future::Future>(handle: Run, run: F) -> F::Output {
    RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let _alive = Alive;
    RUN.scope(handle, run).await
}

/// A wait on an input (the model, the user) on the current task: counted for the task's run, or apart outside any run.
pub async fn parked<F: std::future::Future>(wait: F) -> F::Output {
    let run = RUN.try_with(Run::clone).ok();
    turn_parked(run.as_ref(), wait).await
}

/// A wait on an input that belongs to `run` whatever task it runs on (a tool's approval, awaited on the tool's own task while the
/// run's task awaits the tool); `None`: a wait outside any run. Parked from the poll that left it pending until the wake that ends
/// it; the wake unparks it where it happens (inside the actor's step that resolved an approval, or the I/O driver's read), so a run
/// about to go on never counts as parked.
pub async fn turn_parked<F: std::future::Future>(run: Option<&Run>, wait: F) -> F::Output {
    let flag = std::sync::Arc::new(Park { run: run.cloned(), parked: Mutex::new(false), waker: Mutex::new(None) });
    // A wait dropped while parked (its turn was stopped) is no longer counted.
    let _dropped = Unpark(flag.clone());
    let mut wait = std::pin::pin!(wait);
    std::future::poll_fn(move |cx| {
        *flag.waker.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(cx.waker().clone());
        let waker = std::task::Waker::from(flag.clone());
        match wait.as_mut().poll(&mut std::task::Context::from_waker(&waker)) {
            std::task::Poll::Ready(out) => {
                flag.unpark();
                std::task::Poll::Ready(out)
            }
            std::task::Poll::Pending => {
                if flag.park() {
                    changed();
                }
                std::task::Poll::Pending
            }
        }
    })
    .await
}

struct Park {
    run: Option<Run>,
    /// Whether the wait is counted as parked. The count moves under this lock: a wake on another thread that meets the park
    /// ends the wait after it is counted, never before.
    parked: Mutex<bool>,
    waker: Mutex<Option<std::task::Waker>>,
}

impl Park {
    /// Counts the wait as parked; whether it was not already.
    fn park(&self) -> bool {
        let mut parked = self.parked.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if std::mem::replace(&mut *parked, true) {
            return false;
        }
        match &self.run {
            Some(run) => run.park(),
            None => _ = OUTSIDE.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
        }
        true
    }

    fn unpark(&self) {
        let mut parked = self.parked.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if std::mem::take(&mut *parked) {
            match &self.run {
                Some(run) => run.unpark(),
                None => _ = OUTSIDE.fetch_sub(1, std::sync::atomic::Ordering::SeqCst),
            }
        }
    }
}

struct Unpark(std::sync::Arc<Park>);

impl Drop for Unpark {
    fn drop(&mut self) {
        self.0.unpark();
    }
}

impl std::task::Wake for Park {
    fn wake(self: std::sync::Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &std::sync::Arc<Self>) {
        self.unpark();
        if let Some(waker) = self.waker.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref() {
            waker.wake_by_ref();
        }
    }
}

#[cfg(test)]
mod settled_tests {
    use super::*;
    use tokio::sync::oneshot;

    async fn let_tasks_run() {
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
    }

    /// One test: the counters are the process's.
    #[tokio::test]
    async fn a_tool_tasks_approval_wait_parks_its_run_and_a_computing_run_or_an_outside_wait_does_not_settle() {
        // A run still computing (awaiting something no replay input ends) is not settled; a wait outside any run does not count.
        let (go, gate) = oneshot::channel::<()>();
        let computing = tokio::spawn(in_run(async move { gate.await.ok() }));
        let (_never, outside_wait) = oneshot::channel::<()>();
        let outside = tokio::spawn(turn_parked(None, outside_wait));
        let_tasks_run().await;
        assert_eq!(parked_outside(), 1);
        assert_eq!(unparked(), Some((1, 1)), "the computing run holds settled");
        go.send(()).expect("the computing run");
        computing.await.expect("the computing run");
        assert_eq!(unparked(), None, "no run alive, the outside wait does not hold settled");

        // A run whose task awaits a tool, the tool's task awaiting the user's decision on the run's handle: settled.
        let run = Run::default();
        let (decide, decision) = oneshot::channel::<()>();
        let tool_run = run.clone();
        let tool = tokio::spawn(async move { turn_parked(Some(&tool_run), decision).await.ok() });
        let turn = tokio::spawn(in_run_as(run, async move { tool.await.ok().flatten() }));
        let_tasks_run().await;
        assert_eq!(unparked(), None, "the run is parked on its tool's approval");
        decide.send(()).expect("the decision");
        assert_eq!(turn.await.expect("the turn"), Some(()));
        assert_eq!(unparked(), None);

        // A run that hands part of its work to a task of its own: that task's wait parks the run, its wake ends the park, and
        // once the run stops waiting for the task the task's waits no longer count for it.
        let (answer, answered) = oneshot::channel::<()>();
        let (_never, unanswered) = oneshot::channel::<()>();
        let (stop, stopped) = oneshot::channel::<()>();
        let (go_on, going_on) = oneshot::channel::<()>();
        let turn = tokio::spawn(in_run(async move {
            let (work, delegate) = delegate(async move {
                parked(answered).await.ok();
                parked(unanswered).await.ok();
            });
            let child = tokio::spawn(work);
            stopped.await.ok();
            drop(delegate);
            going_on.await.ok();
            child.abort();
        }));
        let_tasks_run().await;
        assert_eq!(unparked(), None, "the run is parked on its delegate's wait");
        answer.send(()).expect("the delegate's first wait");
        assert_eq!(unparked(), Some((1, 1)), "the wake ends the park where it happens");
        let_tasks_run().await;
        assert_eq!(unparked(), None, "the delegate waits again");
        stop.send(()).expect("the run");
        let_tasks_run().await;
        assert_eq!(unparked(), Some((1, 1)), "a retired delegate's wait does not park the run");
        go_on.send(()).expect("the run");
        turn.await.expect("the turn");
        assert_eq!(unparked(), None);
        outside.abort();
    }
}

fn announcer() -> Option<&'static Mutex<Announcer>> {
    static ANNOUNCER: OnceLock<Option<Mutex<Announcer>>> = OnceLock::new();
    ANNOUNCER
        .get_or_init(|| {
            let address = std::env::var(ENV).ok()?;
            // A core started under a replay's barrier must not run without it.
            let stream = TcpStream::connect(&address).unwrap_or_else(|error| panic!("the replay's byte barrier at {address}: {error}"));
            let _ = stream.set_nodelay(true);
            Some(Mutex::new(Announcer { stream, totals: std::collections::HashMap::new() }))
        })
        .as_ref()
}
#[async_trait]
impl BodyStream for Counted {
    fn hold_connection(&mut self) {
        self.inner.hold_connection();
    }

    fn connection(&self) -> Option<mixdog_core_api::domain::provider::ConnectionInfo> {
        self.inner.connection()
    }

    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        handled(&self.origin, std::mem::take(&mut self.held));
        let item = parked(self.inner.next()).await;
        match &item {
            Some(Ok(bytes)) => self.held = bytes.len(),
            None => handled(&self.origin, std::mem::take(&mut self.held)),
            Some(Err(_)) => {}
        }
        item
    }
}
/// `bytes` more of a response from `origin` were handled.
fn handled(origin: &str, bytes: usize) {
    if bytes == 0 {
        return;
    }
    let Some(announcer) = announcer() else { return };
    let mut announcer = announcer.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let total = announcer.totals.entry(origin.to_owned()).or_default();
    *total += bytes as u64;
    let line = format!("bytes {origin} {total}\n");
    announcer.stream.write_all(line.as_bytes()).expect("the replay's byte barrier");
}
