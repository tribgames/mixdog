//! A replay's barrier on the model's bytes (feature `replay-bytes`, development builds only; off until
//! `MIXDOG_REPLAY_BYTES=127.0.0.1:<port>` names the replay's listener). Bytes arriving on a socket are outside the core's clock
//! until the core admits them, so a replay that advances the clock after writing a scripted response first waits for this
//! announcement: after each response chunk the core has handled (its reader asked for the next chunk, or the body ended),
//! one line `bytes <total>` with the total of response bytes handled since the process began.

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
    total: u64,
}

fn announcer() -> Option<&'static Mutex<Announcer>> {
    static ANNOUNCER: OnceLock<Option<Mutex<Announcer>>> = OnceLock::new();
    ANNOUNCER
        .get_or_init(|| {
            let address = std::env::var(ENV).ok()?;
            // A core started under a replay's barrier must not run without it.
            let stream = TcpStream::connect(&address).unwrap_or_else(|error| panic!("the replay's byte barrier at {address}: {error}"));
            let _ = stream.set_nodelay(true);
            Some(Mutex::new(Announcer { stream, total: 0 }))
        })
        .as_ref()
}

/// A response body whose chunks are announced as handled when its reader asks for the next (or the body ends).
pub(crate) struct Counted {
    inner: Box<dyn BodyStream>,
    held: usize,
}

/// `body`, counted for the replay's barrier.
pub(crate) fn counted(body: Box<dyn BodyStream>) -> Box<dyn BodyStream> {
    Box::new(Counted { inner: body, held: 0 })
}

#[async_trait]
impl BodyStream for Counted {
    fn hold_connection(&mut self) {
        self.inner.hold_connection();
    }

    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        handled(std::mem::take(&mut self.held));
        let item = parked(self.inner.next()).await;
        match &item {
            Some(Ok(bytes)) => self.held = bytes.len(),
            None => handled(std::mem::take(&mut self.held)),
            Some(Err(_)) => {}
        }
        item
    }
}

// A replay's settled signal (mixdog-core-session `replay_settled.rs`) asks whether every turn is parked: waiting on the model (its
// answer's head or its body's next chunk) or on the user (an approval or a question), the waits only a replay's next input ends.
// A turn's task runs inside [`in_run`]; its waits on those inputs go through [`parked`]. Elsewhere they are plain awaits.
tokio::task_local! {
    static RUN: ();
}

static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static PARKED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static ON_CHANGE: OnceLock<fn()> = OnceLock::new();

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
    let (alive, parked) = (RUNS.load(SeqCst), PARKED.load(SeqCst));
    (alive != parked).then(|| (alive.saturating_sub(parked), alive))
}

struct Alive;

impl Drop for Alive {
    fn drop(&mut self) {
        RUNS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        changed();
    }
}

/// Runs a turn's task: alive (and busy unless parked) until it ends.
pub async fn in_run<F: std::future::Future>(run: F) -> F::Output {
    RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let _alive = Alive;
    RUN.scope((), run).await
}

/// A turn's wait on an input (the model, the user): parked from the poll that left it pending until the wake that ends it. The
/// wake unparks it where it happens (inside the actor's step that resolved an approval, or the I/O driver's read), so a turn about to
/// run again never counts as parked.
pub async fn parked<F: std::future::Future>(wait: F) -> F::Output {
    if RUN.try_with(|_| ()).is_err() {
        return wait.await;
    }
    turn_parked(wait).await
}

/// [`parked`] for a wait that belongs to a turn whatever task it runs on (a tool's approval, awaited on the tool's own task while the
/// turn's task awaits the tool).
pub async fn turn_parked<F: std::future::Future>(wait: F) -> F::Output {
    let flag = std::sync::Arc::new(Park { parked: std::sync::atomic::AtomicBool::new(false), waker: Mutex::new(None) });
    // A wait dropped while parked (its turn was stopped) is no longer counted.
    let _dropped = Unpark(flag.clone());
    let mut wait = std::pin::pin!(wait);
    std::future::poll_fn(move |cx| {
        use std::sync::atomic::Ordering::SeqCst;
        *flag.waker.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(cx.waker().clone());
        let waker = std::task::Waker::from(flag.clone());
        match wait.as_mut().poll(&mut std::task::Context::from_waker(&waker)) {
            std::task::Poll::Ready(out) => {
                flag.unpark();
                std::task::Poll::Ready(out)
            }
            std::task::Poll::Pending => {
                if !flag.parked.swap(true, SeqCst) {
                    PARKED.fetch_add(1, SeqCst);
                    changed();
                }
                std::task::Poll::Pending
            }
        }
    })
    .await
}

struct Park {
    parked: std::sync::atomic::AtomicBool,
    waker: Mutex<Option<std::task::Waker>>,
}

impl Park {
    fn unpark(&self) {
        if self.parked.swap(false, std::sync::atomic::Ordering::SeqCst) {
            PARKED.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
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

/// `bytes` more of a response were handled.
fn handled(bytes: usize) {
    if bytes == 0 {
        return;
    }
    let Some(announcer) = announcer() else { return };
    let mut announcer = announcer.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    announcer.total += bytes as u64;
    let line = format!("bytes {}\n", announcer.total);
    announcer.stream.write_all(line.as_bytes()).expect("the replay's byte barrier");
}
