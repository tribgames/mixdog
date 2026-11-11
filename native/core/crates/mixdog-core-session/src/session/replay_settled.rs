//! A replay's settled signal (feature `replay-settled`, development builds only; inert until `MIXDOG_REPLAY_SETTLED=127.0.0.1:<port>`
//! names the replay's listener). The replay sends `settle <n>` after each of its inputs; the core answers `settled <n>` once every
//! conversation has nothing in flight: no session actor is inside a step or has a message waiting on its control, inbox or producer
//! lanes, none has a record its store has not acknowledged (the Postgres / SQLite writes included) or a job not yet reported, and
//! every turn is parked on an input only the replay gives (the model's answer, the user's decision: mixdog-ai `replay_bytes`).
//! Bytes the replay wrote that the core has not read yet are outside this; the byte barrier covers them.

use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::Weak;

use tokio::sync::mpsc;

/// The replay's listener address.
pub const ENV: &str = "MIXDOG_REPLAY_SETTLED";

/// One session actor's part of the signal.
pub(crate) struct Lane {
    thread: String,
    /// Why the actor is not settled: inside a step, or what its last step left in flight. `None`: settled.
    busy: Mutex<Option<&'static str>>,
    /// Messages sent to the actor and not yet taken.
    queued: Box<dyn Fn() -> bool + Send + Sync>,
}

impl Lane {
    /// Registers an actor's lanes (weakly: the signal keeps no channel open).
    pub(crate) fn register<C: Send + 'static, I: Send + 'static, P: Send + 'static>(
        thread: &str,
        ctl: &mpsc::Sender<C>,
        inbox: &mpsc::Sender<I>,
        prod: &mpsc::Sender<P>,
    ) -> Option<Arc<Lane>> {
        let control = control()?;
        let (ctl, inbox, prod) = (ctl.downgrade(), inbox.downgrade(), prod.downgrade());
        let lane = Arc::new(Lane {
            thread: thread.to_owned(),
            busy: Mutex::new(Some("starting")),
            queued: Box::new(move || waiting(&ctl) || waiting(&inbox) || waiting(&prod)),
        });
        control.lanes.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(Arc::downgrade(&lane));
        Some(lane)
    }

    /// A step began.
    pub(crate) fn stepping(&self) {
        *self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some("inside a step");
    }

    /// A step ended; `left` names what it left in flight (`None`: nothing).
    pub(crate) fn stepped(&self, left: Option<&'static str>) {
        *self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = left;
        evaluate();
    }

    fn unsettled(&self) -> Option<String> {
        if let Some(why) = *self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner) {
            return Some(format!("thread {}: {why}", self.thread));
        }
        (self.queued)().then(|| format!("thread {}: a message not yet taken", self.thread))
    }
}

fn waiting<T>(sender: &mpsc::WeakSender<T>) -> bool {
    sender.upgrade().is_some_and(|sender| sender.capacity() < sender.max_capacity())
}

struct Control {
    lanes: Mutex<Vec<Weak<Lane>>>,
    /// The replay's `settle <n>` not yet answered, the stream to answer on, and the last `waiting` reason sent for it.
    pending: Mutex<(Option<u64>, TcpStream, Option<String>)>,
}

fn control() -> Option<&'static Control> {
    static CONTROL: OnceLock<Option<Control>> = OnceLock::new();
    CONTROL.get_or_init(connect).as_ref()
}

/// Connects to the replay when [`ENV`] names one (a core started under a replay's signal must not run without it).
fn connect() -> Option<Control> {
    let address = std::env::var(ENV).ok()?;
    let stream = TcpStream::connect(&address).unwrap_or_else(|error| panic!("the replay's settled signal at {address}: {error}"));
    let _ = stream.set_nodelay(true);
    let reader = BufReader::new(stream.try_clone().expect("the replay's settled signal"));
    std::thread::Builder::new()
        .name("mixdog-replay-settled".to_owned())
        .spawn(move || {
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let n = match line.split_whitespace().collect::<Vec<_>>().as_slice() {
                    ["settle", n] => n.parse::<u64>().expect("settle <n>"),
                    other => panic!("the replay's settled signal sent {other:?}"),
                };
                let control = control().expect("the replay's settled signal");
                {
                    let mut pending = control.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    pending.0 = Some(n);
                    pending.2 = None;
                }
                evaluate();
            }
        })
        .expect("the replay's settled signal thread");
    mixdog_ai::transport::replay_bytes::on_change(evaluate);
    Some(Control { lanes: Mutex::new(Vec::new()), pending: Mutex::new((None, stream, None)) })
}

/// Starts the signal at the session service's start, so the replay's first `settle` has an answer before any conversation exists.
pub(crate) fn start() {
    let _ = control();
}

/// Answers the replay's pending `settle` if nothing is in flight now; otherwise tells the replay what it still waits on (once per
/// reason), which the replay names when its deadline passes.
fn evaluate() {
    let Some(control) = control() else { return };
    let mut pending = control.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(n) = pending.0 else { return };
    let unsettled = {
        let mut lanes = control.lanes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        lanes.retain(|lane| lane.strong_count() > 0);
        lanes.iter().filter_map(Weak::upgrade).find_map(|lane| lane.unsettled())
    }
    .or_else(|| mixdog_ai::transport::replay_bytes::unparked().map(|(running, of)| format!("{running} of {of} turns running, not parked on an input")));
    match unsettled {
        None => {
            pending.0 = None;
            writeln!(pending.1, "settled {n}").expect("the replay's settled signal");
        }
        Some(why) if pending.2.as_deref() != Some(why.as_str()) => {
            writeln!(pending.1, "waiting {why}").expect("the replay's settled signal");
            pending.2 = Some(why);
        }
        Some(_) => {}
    }
}
