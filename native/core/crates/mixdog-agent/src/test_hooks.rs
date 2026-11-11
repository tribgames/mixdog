//! Test-only gates in the streamed dispatch of edits (feature `test-support`; no normal build enables it): a test parks a
//! streamed edit between the settlement that lets it go and its run, and sees where a group retry queues meanwhile.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use tokio::sync::watch;

struct Inner {
    /// The file's name, matched against the end of the lock key.
    file: String,
    ids: Vec<String>,
    parked: watch::Sender<usize>,
    released: watch::Sender<bool>,
    /// The ids of group retries that reached the file's lock while an earlier place was still held.
    retries_waiting: watch::Sender<Vec<String>>,
}

fn holds() -> &'static Mutex<Vec<Arc<Inner>>> {
    static HOLDS: OnceLock<Mutex<Vec<Arc<Inner>>>> = OnceLock::new();
    HOLDS.get_or_init(Mutex::default)
}

fn find(key: &str) -> Option<Arc<Inner>> {
    holds().lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().find(|h| key.ends_with(&h.file)).cloned()
}

/// Parks the streamed edits `ids` of `file` (a name no other test uses) once their barriers let them go, until `release`.
pub struct EditHold(Arc<Inner>);

pub fn hold_edits(file: &str, ids: &[&str]) -> EditHold {
    let inner = Arc::new(Inner {
        file: format!("/{}", file.to_lowercase()),
        ids: ids.iter().map(|id| (*id).to_owned()).collect(),
        parked: watch::Sender::new(0),
        released: watch::Sender::new(false),
        retries_waiting: watch::Sender::new(Vec::new()),
    });
    holds().lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(Arc::clone(&inner));
    EditHold(inner)
}

impl EditHold {
    /// How many of the held edits are parked.
    pub fn parked(&self) -> watch::Receiver<usize> {
        self.0.parked.subscribe()
    }

    pub fn retries_waiting(&self) -> watch::Receiver<Vec<String>> {
        self.0.retries_waiting.subscribe()
    }

    pub fn release(&self) {
        self.0.released.send_replace(true);
    }
}

impl Drop for EditHold {
    fn drop(&mut self) {
        self.release();
        holds().lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|h| !Arc::ptr_eq(h, &self.0));
    }
}

pub(crate) async fn edit_start(key: &str, id: &str) {
    let Some(hold) = find(key).filter(|h| h.ids.iter().any(|held| held == id)) else {
        return;
    };
    let mut released = hold.released.subscribe();
    hold.parked.send_modify(|n| *n += 1);
    let _ = released.wait_for(|r| *r).await;
}

pub(crate) fn retry_queued(key: &str, id: &str, waits: bool) {
    if waits && let Some(hold) = find(key) {
        hold.retries_waiting.send_modify(|ids| ids.push(id.to_owned()));
    }
}
