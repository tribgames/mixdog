//! The device store: the credentials of every desktop and every paired browser, kept in `<DATA_DIR>/devices.json` in the form Node
//! writes it.
//!
//! A mutation is applied to a copy, the copy is written by a `DurabilityIo` lane job, and only then is the same mutation applied to
//! the shared state, one mutation at a time through a single-writer queue, so a reader never sees a state that is later rolled
//! back. Readers take the committed state under a std mutex held only in synchronous sections. A mutation runs to its end in a
//! task of its own, so a caller that goes away cannot leave the disk and the shared state apart.
//!
//! Client activity (`touch_client`, version reports) is not a credential: it is applied to the shared state at once and written on
//! a 250 ms beat, so a fleet redial is not one whole-file rewrite per desktop.

mod auth;
mod devices;
mod persistence;
mod version;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken, TaskClass};
use serde_json::Value;

pub use auth::{
    ClientProfile, Credentials, DEFAULT_CLIENT_NAME, MAX_PAIRED_CLIENTS_PER_DEVICE, MIN_SECRET_LEN, PROFILE_FIELD_LIMIT, ProfileInput, client_profile,
    client_token_usable, leg_credentials_usable, read_device_credentials, registrable_device_id, sha256_hex, sha256_hex_parsed,
};
pub use devices::{BrowserClient, ClientAccess, ListedClient};
pub use version::{DeviceVersion, SEEN_REFRESH_MS, is_desktop_version, is_shell_version};

use devices::{Change, Devices};

use crate::logline;
use crate::rate_limit::now_ms;

/// The debounce of client-activity writes.
pub const SAVE_DEBOUNCE: Duration = Duration::from_millis(250);

/// `devices.json` could not be loaded: the relay refuses to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadError(pub String);

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "failed to load device store: {}", self.0)
    }
}

/// A browser credential handed out once: the token is shown to the caller and kept only as its digest.
#[derive(Debug, Clone, PartialEq)]
pub struct RegisteredClient {
    pub token: String,
    pub client: BrowserClient,
}

/// The write did not land (already logged); the mutation was not applied.
struct NotPersisted;

struct State {
    devices: Devices,
    /// Client activity applied to `devices` since start, and how much of it is on disk.
    dirty: u64,
    saved: u64,
    /// The pending debounced write, if any.
    timer: Option<tokio::task::AbortHandle>,
}

struct Inner {
    path: PathBuf,
    io: DurabilityIo,
    state: Mutex<State>,
    /// The single-writer queue: one mutation or write at a time.
    writer: tokio::sync::Mutex<()>,
}

/// The credential database.
#[derive(Clone)]
pub struct DeviceStore {
    inner: Arc<Inner>,
}

/// Runs `body` as a durability lane job.
async fn lane_job<R: Send + 'static>(io: DurabilityIo, body: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> io::Result<R> {
    let handle = io.submit(&CancellationToken::new(), body).map_err(io::Error::other)?;
    handle.await.map_err(io::Error::other)
}

fn log_failure(error: &io::Error) {
    logline::emit(&logline::device_store_persist_failed(&error.to_string()));
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Writes `rows` to disk.
    async fn write_rows(&self, rows: serde_json::Map<String, Value>) -> io::Result<()> {
        let path = self.path.clone();
        lane_job(self.io, move |lane| persistence::write(lane, &path, rows)).await?
    }

    /// Applies `apply` to a copy, writes the copy and, only once it is on disk, applies `apply` to the shared state.
    async fn commit<R: Send + 'static>(&self, apply: impl Fn(&mut Devices) -> Change<R>) -> Result<R, NotPersisted> {
        let _queue = self.writer.lock().await;
        let (mut draft, generation) = {
            let state = self.state();
            (state.devices.clone(), state.dirty)
        };
        let result = match apply(&mut draft) {
            Change::Keep(result) => return Ok(result),
            Change::Write(result) => result,
        };
        if let Err(error) = self.write_rows(draft.rows().clone()).await {
            log_failure(&error);
            return Err(NotPersisted);
        }
        let mut state = self.state();
        // Activity recorded while the write ran is not in the file: it keeps its beat.
        let _ = apply(&mut state.devices);
        state.saved = state.saved.max(generation);
        if state.saved == state.dirty
            && let Some(timer) = state.timer.take()
        {
            timer.abort();
        }
        Ok(result)
    }

    /// `save`: the shared state to disk, whatever is pending. The pending beat is cleared first.
    async fn save(&self) -> io::Result<()> {
        let _queue = self.writer.lock().await;
        let (rows, generation) = {
            let mut state = self.state();
            if let Some(timer) = state.timer.take() {
                timer.abort();
            }
            (state.devices.rows().clone(), state.dirty)
        };
        self.write_rows(rows).await?;
        let mut state = self.state();
        state.saved = state.saved.max(generation);
        Ok(())
    }

    /// `saveOrLog`: false means the write did not land.
    async fn save_or_log(&self) -> bool {
        match self.save().await {
            Ok(()) => true,
            Err(error) => {
                log_failure(&error);
                false
            }
        }
    }
}

impl std::error::Error for LoadError {}
/// `scheduleSave`: one pending beat at a time.
fn schedule_save(inner: &Arc<Inner>, state: &mut State) {
    if state.timer.is_some() {
        return;
    }
    let weak: Weak<Inner> = Arc::downgrade(inner);
    let task = mixdog_rt::spawn("relay-store-beat", TaskClass::Control, async move {
        mixdog_rt::time::sleep_unrefed(SAVE_DEBOUNCE).await;
        let Some(inner) = weak.upgrade() else { return };
        inner.state().timer = None;
        inner.save_or_log().await;
    });
    state.timer = Some(task.abort_handle());
}
impl DeviceStore {
    /// `new DeviceStore(dataDir)`: loads `<dataDir>/devices.json`. A missing file is an empty store; any invalid row, id or
    /// digest refuses the start.
    pub async fn open(data_dir: &Path, io: DurabilityIo) -> Result<Self, LoadError> {
        let path = data_dir.join("devices.json");
        let read_path = path.clone();
        let rows = lane_job(io, move |lane| persistence::load(lane, &read_path)).await.map_err(|error| LoadError(error.to_string()))?.map_err(LoadError)?;
        let state = State { devices: Devices::from_rows(rows), dirty: 0, saved: 0, timer: None };
        Ok(Self { inner: Arc::new(Inner { path, io, state: Mutex::new(state), writer: tokio::sync::Mutex::new(()) }) })
    }

    /// `<dataDir>/devices.json`.
    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    /// Runs `apply` through the writer queue in a task of its own; a refused write is `None`.
    async fn mutate<R: Send + 'static>(&self, apply: impl Fn(&mut Devices) -> Change<R> + Send + 'static) -> Option<R> {
        let inner = self.inner.clone();
        let task = mixdog_rt::spawn("relay-store-commit", TaskClass::Control, async move { inner.commit(apply).await.ok() });
        match task.await {
            Ok(result) => result,
            Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            Err(_) => None,
        }
    }

    /// `isKnown`.
    pub fn is_known(&self, device_id: &str) -> bool {
        self.inner.state().devices.is_known(device_id)
    }

    /// `authenticate`: a known device on its secret; a new, registrable id is bound to the first secret that arrives and
    /// persisted before this returns true (a write that fails leaves nothing behind). The caller applies the per-IP limiter
    /// to new ids. `secret` is the decoded Basic secret.
    pub async fn authenticate(&self, device_id: &str, secret: &str) -> bool {
        {
            let state = self.inner.state();
            if state.devices.is_known(device_id) {
                return state.devices.secret_matches(device_id, secret);
            }
        }
        if !registrable_device_id(device_id) {
            return false;
        }
        let (device_id, secret) = (device_id.to_owned(), secret.to_owned());
        let hash = sha256_hex(&secret);
        // A caller that raced this one registered the id first: its secret decides.
        self.mutate(move |devices| {
            if devices.is_known(&device_id) {
                return Change::Keep(devices.secret_matches(&device_id, &secret));
            }
            devices.register_device(&device_id, &hash)
        })
        .await
        .unwrap_or(false)
    }

    /// `setClientToken`: the pairing token the desktop announces, as `JSON.parse` produced it. An unchanged token writes
    /// nothing; a changed one is persisted before it is honoured.
    pub async fn set_client_token(&self, device_id: &str, token: &str) -> bool {
        let (device_id, hash) = (device_id.to_owned(), sha256_hex_parsed(token));
        self.mutate(move |devices| devices.set_client_token(&device_id, &hash)).await.unwrap_or(false)
    }

    /// `revoke`: the device and every browser of it are gone once this returns true; false when it is unknown or the write
    /// failed (then nothing changed).
    pub async fn revoke(&self, device_id: &str) -> bool {
        let device_id = device_id.to_owned();
        self.mutate(move |devices| devices.revoke_device(&device_id)).await.unwrap_or(false)
    }

    /// `clientAccessForToken`: whose a pairing token or a browser token is; none for an empty or unknown one.
    pub fn client_access_for_token(&self, token: &str) -> Option<ClientAccess> {
        if token.is_empty() {
            return None;
        }
        self.inner.state().devices.access_for_hash(&sha256_hex(token))
    }

    /// `deviceIdForClientToken`.
    pub fn device_id_for_client_token(&self, token: &str) -> Option<String> {
        self.client_access_for_token(token).map(|access| access.device_id)
    }

    /// `registerClient`: a credential for a browser of a known device, under a routing id; at most 256 per device. The token
    /// of 32 random bytes in hex is returned once and persisted before it is handed out; a previous token of the same id stops
    /// working. None when the device or the id is not acceptable, the device is full, or the write failed.
    pub async fn register_client(&self, device_id: &str, client_id: &str, profile: &ProfileInput) -> Option<RegisteredClient> {
        let token = auth::hex(&rand::random::<[u8; 32]>());
        let (device_id, client_id, profile) = (device_id.to_owned(), client_id.to_owned(), profile.clone());
        let (hash, now) = (sha256_hex(&token), now_ms());
        let client = self.mutate(move |devices| devices.register_client(&device_id, &client_id, &profile, &hash, now)).await??;
        Some(RegisteredClient { token, client })
    }

    /// The stamp of the credential a browser id holds now (None when it holds none), for [`Self::register_client_expecting`].
    pub fn client_credential_stamp(&self, device_id: &str, client_id: &str) -> Option<String> {
        self.inner.state().devices.client_token_hash(device_id, client_id)
    }

    /// `registerClient` for a claim's approval: it writes only if the id still holds the credential the claim saw (`expected`
    /// is its stamp, or None for an id that held none), so a claim cannot overwrite a credential another claim has issued since.
    /// None, and nothing written, otherwise.
    pub async fn register_client_expecting(
        &self,
        device_id: &str,
        client_id: &str,
        profile: &ProfileInput,
        expected: Option<&str>,
    ) -> Option<RegisteredClient> {
        let token = auth::hex(&rand::random::<[u8; 32]>());
        let (device_id, client_id, profile, expected) = (device_id.to_owned(), client_id.to_owned(), profile.clone(), expected.map(str::to_owned));
        let (hash, now) = (sha256_hex(&token), now_ms());
        let client = self
            .mutate(move |devices| {
                if devices.client_token_hash(&device_id, &client_id) != expected {
                    return Change::Keep(None);
                }
                devices.register_client(&device_id, &client_id, &profile, &hash, now)
            })
            .await??;
        Some(RegisteredClient { token, client })
    }

    /// `touchClient`: the browser was seen now; a profile field that is set replaces the stored one. Persisted on the debounced beat.
    pub fn touch_client(&self, device_id: &str, client_id: &str, profile: &ProfileInput) -> bool {
        let mut state = self.inner.state();
        if !state.devices.touch_client(device_id, client_id, profile, now_ms()) {
            return false;
        }
        state.dirty += 1;
        schedule_save(&self.inner, &mut state);
        true
    }

    /// `hasClient`.
    pub fn has_client(&self, device_id: &str, client_id: &str) -> bool {
        self.inner.state().devices.has_client(device_id, client_id)
    }

    /// `listClients`: the paired browsers of a device, most recently seen first; `online` names the ones with a live leg.
    pub fn list_clients(&self, device_id: &str, online: &dyn Fn(&str) -> bool) -> Vec<ListedClient> {
        self.inner.state().devices.list_clients(device_id, online)
    }

    /// `revokeClient`: false when the browser is unknown or the write failed (then it stays paired).
    pub async fn revoke_client(&self, device_id: &str, client_id: &str) -> bool {
        let (device_id, client_id) = (device_id.to_owned(), client_id.to_owned());
        self.mutate(move |devices| devices.revoke_client(&device_id, &client_id)).await.unwrap_or(false)
    }

    /// `recordDesktopVersion`: what a desktop reported on its leg (the `desktop-version` frame, as `JSON.parse` produced it).
    /// False when the report has no usable app version. An unchanged report is rewritten only when older than an hour.
    pub fn record_desktop_version(&self, device_id: &str, report: &Value) -> bool {
        self.record_desktop_version_at(device_id, report, now_ms())
    }

    /// [`Self::record_desktop_version`] at a given time.
    pub fn record_desktop_version_at(&self, device_id: &str, report: &Value, now: i64) -> bool {
        let report = version::report_version(report);
        let mut state = self.inner.state();
        match state.devices.record_version(device_id, &report, now) {
            None => false,
            Some(false) => true,
            Some(true) => {
                state.dirty += 1;
                schedule_save(&self.inner, &mut state);
                true
            }
        }
    }

    /// `deviceVersion`: what the device last reported, empty strings when unknown.
    pub fn device_version(&self, device_id: &str) -> DeviceVersion {
        self.inner.state().devices.version(device_id)
    }

    /// `save`: writes the whole database now and clears the pending beat; the error is the failed write.
    pub async fn save(&self) -> io::Result<()> {
        let inner = self.inner.clone();
        match mixdog_rt::spawn("relay-store-save", TaskClass::Control, async move { inner.save().await }).await {
            Ok(result) => result,
            Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            Err(error) => Err(io::Error::other(error)),
        }
    }

    /// `saveOrLog`: [`Self::save`], logging `[relay] failed to persist device store: <message>` instead of returning it.
    pub async fn save_or_log(&self) -> bool {
        let inner = self.inner.clone();
        match mixdog_rt::spawn("relay-store-save", TaskClass::Control, async move { inner.save_or_log().await }).await {
            Ok(result) => result,
            Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            Err(_) => false,
        }
    }

    /// Whether a debounced write is pending.
    pub fn save_pending(&self) -> bool {
        self.inner.state().timer.is_some()
    }
}
