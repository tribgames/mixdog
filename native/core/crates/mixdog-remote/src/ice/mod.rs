//! ICE servers for the phone ↔ PC WebRTC connection: this deployment's own STUN and TURN, reached
//! with short-lived credentials the relay issues over this PC's authenticated leg
//! (remote-ice-servers.ts). No third-party STUN is ever named here.
//!
//! `resolve` never fails and waits on nothing but the relay's answer: a credential is cached
//! until [`refresh_margin`] before it expires and an expired one is never handed out; when the
//! relay cannot issue, the list degrades to the relay's STUN URL alone, else empty; the only
//! waiting period is the one a rate-limited answer names.
//!
//! Lifetimes are counted on two clocks, a monotonic and the wall clock; the elapsed time is the
//! larger, so a change in either can only make a credential expire sooner. `invalidate` (wired to
//! OS suspend/resume) drops the cache and makes any answer still on its way worthless.

use std::future::Future;
use std::sync::Mutex;

use serde_json::Value;

pub const MAX_ICE_SERVERS: usize = 16;
pub const MAX_ICE_URLS: usize = 16;
/// coturn `max-allocate-lifetime` default: a credential handed out with less than this left could
/// not carry one allocation lifetime.
const ICE_ALLOCATION_LIFETIME_MS: u64 = 3_600_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

pub trait IceClock: Send + Sync {
    /// Cannot be set by anyone.
    fn monotonic_ms(&self) -> u64;
    /// Follows sleep, can be set.
    fn wall_ms(&self) -> u64;
}

pub struct SystemClock {
    start: std::time::Instant,
}

impl Default for SystemClock {
    fn default() -> Self {
        Self { start: std::time::Instant::now() }
    }
}

impl IceClock for SystemClock {
    fn monotonic_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    fn wall_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }
}

/// How long before expiry a credential stops being served: one coturn allocation lifetime, but
/// never more than half the credential's own life.
pub fn refresh_margin(life_ms: u64) -> u64 {
    ICE_ALLOCATION_LIFETIME_MS.min(life_ms / 2)
}

fn is_ice_url(url: &str) -> bool {
    ["stun:", "turn:", "turns:"]
        .iter()
        .any(|scheme| url.strip_prefix(scheme).is_some_and(|rest| !rest.is_empty() && !rest.chars().any(mixdog_js::is_js_space)))
}

fn read_urls(value: &Value) -> Option<Vec<String>> {
    let list = value.as_array().filter(|list| !list.is_empty() && list.len() <= MAX_ICE_URLS)?;
    list.iter().map(|url| url.as_str().filter(|u| is_ice_url(u)).map(str::to_owned)).collect()
}

fn read_server(row: &Value) -> Option<IceServer> {
    let urls = read_urls(row.get("urls")?)?;
    let (username, credential) = (row.get("username"), row.get("credential"));
    if urls.iter().all(|url| url.starts_with("stun:")) {
        return (username.is_none() && credential.is_none()).then_some(IceServer { urls, username: None, credential: None });
    }
    let name = username?.as_str().filter(|s| !s.is_empty())?;
    let secret = credential?.as_str().filter(|s| !s.is_empty())?;
    Some(IceServer { urls, username: Some(name.to_owned()), credential: Some(secret.to_owned()) })
}

/// The servers and the credential's real remaining life (`remainingMs`: the relay's own figure
/// after flooring the expiry to a whole second, never more than the nominal `ttlSeconds`).
fn read_issue(envelope: &Value) -> Option<(Vec<IceServer>, u64)> {
    if envelope.get("ok") != Some(&Value::Bool(true)) {
        return None;
    }
    let rows = envelope.get("servers")?.as_array().filter(|rows| !rows.is_empty() && rows.len() <= MAX_ICE_SERVERS)?;
    let ttl = envelope.get("ttlSeconds")?.as_f64().filter(|t| t.is_finite() && *t > 0.0)?;
    let remaining = envelope.get("remainingMs")?.as_f64().filter(|r| r.is_finite() && *r > 0.0)?;
    if remaining > ttl * 1000.0 {
        return None;
    }
    let servers: Option<Vec<_>> = rows.iter().map(read_server).collect();
    Some((servers?, remaining as u64))
}

#[derive(Clone, Copy)]
struct Mark {
    monotonic: u64,
    wall: u64,
}

struct Cached {
    servers: Vec<IceServer>,
    issued_at: Mark,
    life_ms: u64,
    refresh_after_ms: u64,
}

#[derive(Default)]
struct State {
    cache: Option<Cached>,
    /// The relay's STUN-only list: learned from any answer, kept across failures.
    stun_only: Vec<IceServer>,
    /// Set only by a rate-limited answer, from the retry-after the relay gave.
    retry: Option<(Mark, u64)>,
    /// Bumped by `invalidate`: a request started in an earlier epoch is stale.
    epoch: u64,
}

pub struct RemoteIceServers<C: IceClock = SystemClock> {
    clock: C,
    state: Mutex<State>,
    /// One request at a time: a caller that waits finds the cache the first one filled.
    refreshing: tokio::sync::Semaphore,
}

impl RemoteIceServers<SystemClock> {
    pub fn new() -> Self {
        Self::with_clock(SystemClock::default())
    }
}

impl Default for RemoteIceServers<SystemClock> {
    fn default() -> Self {
        Self::new()
    }
}

impl<C: IceClock> RemoteIceServers<C> {
    pub fn with_clock(clock: C) -> Self {
        Self { clock, state: Mutex::new(State::default()), refreshing: tokio::sync::Semaphore::new(1) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn mark(&self) -> Mark {
        Mark { monotonic: self.clock.monotonic_ms(), wall: self.clock.wall_ms() }
    }

    fn elapsed_since(&self, mark: Mark) -> u64 {
        self.clock
            .monotonic_ms()
            .saturating_sub(mark.monotonic)
            .max(self.clock.wall_ms().saturating_sub(mark.wall))
    }

    fn degraded(&self, state: &State) -> Vec<IceServer> {
        match &state.cache {
            Some(cached) if self.elapsed_since(cached.issued_at) < cached.life_ms => cached.servers.clone(),
            _ => state.stun_only.clone(),
        }
    }

    fn fresh(&self, state: &State) -> Option<Vec<IceServer>> {
        let cached = state.cache.as_ref()?;
        (self.elapsed_since(cached.issued_at) < cached.refresh_after_ms).then(|| cached.servers.clone())
    }

    fn waiting(&self, state: &State) -> bool {
        state.retry.is_some_and(|(from, after)| self.elapsed_since(from) < after)
    }

    /// Fresh-enough ICE servers; empty when nothing is available. `request` asks the relay for
    /// its `ice-servers` envelope (None when the relay offers no issuance, Err when it cannot be
    /// asked).
    pub async fn resolve<F, E>(&self, request: impl FnOnce() -> F) -> Vec<IceServer>
    where
        F: Future<Output = Result<Option<Value>, E>>,
    {
        {
            let state = self.state();
            if let Some(servers) = self.fresh(&state) {
                return servers;
            }
            if self.waiting(&state) {
                return self.degraded(&state);
            }
        }
        let _turn = self.refreshing.acquire().await;
        let (requested_at, started_in) = {
            let state = self.state();
            // The caller ahead of this one may have filled the cache.
            if let Some(servers) = self.fresh(&state) {
                return servers;
            }
            if self.waiting(&state) {
                return self.degraded(&state);
            }
            // Counted from when the request left: the answer's travel time only makes the local
            // expiry earlier than the real one.
            (self.mark(), state.epoch)
        };
        let answer = request().await;
        let mut state = self.state();
        // The machine slept or woke while this was pending: what it brings was issued before a gap
        // whose length nothing here can vouch for.
        if state.epoch != started_in {
            return self.degraded(&state);
        }
        let Ok(Some(envelope)) = answer else { return self.degraded(&state) };
        if let Some((servers, life_ms)) = read_issue(&envelope) {
            let refresh_after_ms = life_ms - refresh_margin(life_ms);
            if let Some(stun) = servers.iter().find(|s| s.urls.iter().all(|u| u.starts_with("stun:"))) {
                state.stun_only = vec![IceServer { urls: stun.urls.clone(), username: None, credential: None }];
            }
            let issued = Cached { servers: servers.clone(), issued_at: requested_at, life_ms, refresh_after_ms };
            // A request can sit longer than its life: hand out only what is still servable now.
            if self.elapsed_since(issued.issued_at) >= issued.refresh_after_ms {
                return self.degraded(&state);
            }
            state.cache = Some(issued);
            state.retry = None;
            return servers;
        }
        if let Some(urls) = envelope.get("stun").and_then(read_urls).filter(|u| u.iter().all(|x| x.starts_with("stun:"))) {
            state.stun_only = vec![IceServer { urls, username: None, credential: None }];
        }
        if envelope.get("error").and_then(Value::as_str) == Some("rate-limited")
            && let Some(wait) = envelope.get("retryAfterMs").and_then(Value::as_f64).filter(|w| w.is_finite() && *w > 0.0)
        {
            state.retry = Some((self.mark(), wait as u64));
        }
        self.degraded(&state)
    }

    /// The machine slept or woke: no age counted before this point can be trusted.
    pub fn invalidate(&self) {
        let mut state = self.state();
        state.epoch += 1;
        state.cache = None;
        state.retry = None;
    }
}
