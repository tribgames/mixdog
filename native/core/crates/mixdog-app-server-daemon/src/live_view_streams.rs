//! The phones' subscriptions to a browser session's live view and their JPEG view, as Node's relay paces them
//! (`apps/desktop/src/main/remote-browser-streams.ts` at b6f10295a): a subscription per phone and session that lapses 4 s after
//! its last renewal; the largest options of a session's subscribers told to the desktop on every change (`null` when the last one
//! ends); a take-over's fit, under which a phone is shown no picture until the fitted layout's first one; and the frames, one in
//! flight per subscription until the phone acknowledges it or 1.5 s pass, the newest one always next, the session's newest frame
//! for a phone that joins, and the pictures withheld while WebRTC owns the phone's view (`set_images`).
//!
//! The options a phone sends are checked as `normalizeRemoteBrowserStreamOptions` (`shared/remote-browser.ts:60-98`) and the
//! session id as `requiredSessionId` (`desktop-state.ts:58-65`) check them, with their texts.
//!
//! Every effect on the world (a push to a phone, a request to the desktop, a dropped subscription) is queued in the state's outbox
//! by the same locked step that changed the state, and delivered once the state is released, one at a time and in the outbox's
//! order, by whichever caller finds no delivery running. Node changes the state and calls out in one synchronous step
//! (`remote-browser-streams.ts:114-128`), so no effect ever leaves after one of a later change; the outbox keeps that order across
//! threads. A delivered effect may come back into this state (a dropped subscription's WebRTC view gives the JPEG back): what it
//! queues goes out after it.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::Weak;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_rt::TaskClass;
use serde_json::Map;
use serde_json::Value;

/// A frame is sent again after this long even if its ack never arrived (`REMOTE_BROWSER_FRAME_ACK_TIMEOUT_MS`).
pub const ACK_TIMEOUT_MS: f64 = 1_500.0;
/// A subscription not renewed within this window is dropped (`SUBSCRIPTION_EXPIRY_MS`).
pub const SUBSCRIPTION_EXPIRY_MS: f64 = 4_000.0;

const MAX_STREAM_DIMENSION: f64 = 4_096.0;
const MIN_DRIVE_DIMENSION: f64 = 200.0;
const MAX_DRIVE_DIMENSION: f64 = 3_840.0;
const MIN_DRIVE_SCALE: f64 = 0.5;
const MAX_DRIVE_SCALE: f64 = 4.0;
const MAX_SESSION_ID_LENGTH: usize = 256;

/// Time and timers of the streams: the process clock in the product, a virtual one in the replays.
pub trait Clock: Send + Sync {
    fn now(&self) -> f64;
    /// Runs `run` once, `ms` from now, unless cleared first; never from inside this call.
    fn set_timer(&self, ms: f64, run: Box<dyn FnOnce() + Send>) -> u64;
    fn clear_timer(&self, handle: u64);
}

/// What the streams do to the world (Node's `BrowserRemoteStreamsDeps`).
pub trait StreamsDeps: Send + Sync {
    /// Whether the phone's connection is still open.
    fn is_live(&self, client: &str) -> bool;
    /// One frame to that phone (`browserRemoteFrame`).
    fn send(&self, client: &str, frame: Value);
    /// Start or renew (`Some`) or stop (`None`) the desktop's view of the session.
    fn request(&self, session: &str, options: Option<Value>);
    /// The phone's subscription to the session ended (stop, lapse or departure).
    fn on_drop(&self, client: &str, session: &str);
}

/// A take-over's fit in a phone's options: absent (watching, or a renewal that keeps it), `null` (released) or a viewport.
#[derive(Debug, Clone, PartialEq)]
pub enum Fit {
    Absent,
    Release,
    Viewport(Value),
}

/// A phone's checked `DesktopRemoteBrowserStreamOptions`.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamOptions {
    pub max_width: u64,
    pub max_height: u64,
    pub fit: Fit,
}

/// A number as JavaScript writes it: an integral value without a fraction.
fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        if value >= 0.0 { Value::from(value as u64) } else { Value::from(value as i64) }
    } else {
        Value::from(value)
    }
}

/// `requiredSessionId` (`desktop-state.ts:58-65`): trimmed, 1-256 characters of `[A-Za-z0-9_-]`.
pub fn required_session_id(value: &str) -> Result<String, String> {
    let id = value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if id.is_empty() || id.chars().count() > MAX_SESSION_ID_LENGTH || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("session id is invalid.".to_owned());
    }
    Ok(id.to_owned())
}

/// `normalizeDriveViewport` (`shared/remote-browser.ts:55-70`).
fn drive_viewport(input: &Value) -> Result<Value, String> {
    let dimension = |name: &str| {
        input.get(name).and_then(Value::as_f64).filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 && (MIN_DRIVE_DIMENSION..=MAX_DRIVE_DIMENSION).contains(n))
    };
    let (Some(width), Some(height)) = (dimension("width"), dimension("height")) else {
        return Err("remote browser viewport size is invalid.".to_owned());
    };
    let Some(scale) = input.get("deviceScaleFactor").and_then(Value::as_f64).filter(|s| (MIN_DRIVE_SCALE..=MAX_DRIVE_SCALE).contains(s)) else {
        return Err("remote browser viewport scale is invalid.".to_owned());
    };
    let mut viewport = Map::new();
    viewport.insert("width".to_owned(), js_number(width));
    viewport.insert("height".to_owned(), js_number(height));
    viewport.insert("deviceScaleFactor".to_owned(), js_number(scale));
    Ok(Value::Object(viewport))
}

/// `normalizeRemoteBrowserStreamOptions` (`shared/remote-browser.ts:73-98`).
pub fn normalize_stream_options(value: Option<&Value>) -> Result<StreamOptions, String> {
    let empty = Value::Object(Map::new());
    let input = match value {
        Some(object @ (Value::Object(_) | Value::Array(_))) => object,
        _ => &empty,
    };
    let dimension = |name: &str| {
        input
            .get(name)
            .and_then(Value::as_f64)
            .filter(|n| (64.0..=MAX_STREAM_DIMENSION).contains(n))
            // `Math.round`.
            .map(|n| (n + 0.5).floor() as u64)
            .ok_or_else(|| format!("remote browser stream {name} is invalid."))
    };
    let max_width = dimension("maxWidth")?;
    let max_height = dimension("maxHeight")?;
    let fit = match input.get("fit") {
        None => Fit::Absent,
        Some(Value::Null) => Fit::Release,
        Some(fit @ (Value::Object(_) | Value::Array(_))) => Fit::Viewport(drive_viewport(fit)?),
        Some(_) => return Err("remote browser stream fit is invalid.".to_owned()),
    };
    Ok(StreamOptions { max_width, max_height, fit })
}

/// JavaScript truthiness of a frame field.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn without(frame: &Value, keys: &[&str]) -> Map<String, Value> {
    let mut out = frame.as_object().cloned().unwrap_or_default();
    for key in keys {
        out.shift_remove(*key);
    }
    out
}

/// A frame's facts with no picture described (`withoutPicture`).
fn without_picture(frame: &Value) -> Value {
    let mut facts = without(frame, &["image", "fitSettled"]);
    for key in ["width", "height", "viewportWidth", "viewportHeight"] {
        facts.insert(key.to_owned(), Value::from(0));
    }
    Value::Object(facts)
}

/// A metadata-only frame carrying an earlier frame's image: settled only if both are (`withImageOf`).
fn with_image_of(frame: &Value, source: &Value) -> Value {
    let mut merged = without(frame, &["fitSettled"]);
    merged.insert("image".to_owned(), source.get("image").cloned().unwrap_or(Value::Null));
    if truthy(frame.get("fitSettled")) && truthy(source.get("fitSettled")) {
        merged.insert("fitSettled".to_owned(), Value::Bool(true));
    }
    Value::Object(merged)
}

/// The frame a slot takes when `frame` arrives while it holds `waiting`.
fn superseding(frame: &Value, waiting: Option<&Value>) -> Value {
    match waiting {
        Some(waiting) if !truthy(frame.get("image")) && truthy(waiting.get("image")) => with_image_of(frame, waiting),
        _ => frame.clone(),
    }
}

struct Subscription {
    max_width: u64,
    max_height: u64,
    /// The lapse timer: its own token (checked when it fires) and the clock's handle.
    expiry: (u64, u64),
    /// The newest frame not yet sent.
    slot: Option<Value>,
    /// The `seq` of the frame in flight (`Some(Null)` for a frame without one, which no ack matches).
    inflight: Option<Value>,
    sent_at: f64,
    retry: Option<(u64, u64)>,
    /// False while WebRTC owns this phone's view: frames carry facts only.
    images: bool,
    awaiting_fit: bool,
    fit_asked: bool,
    takeover: Option<Value>,
}

/// Ordered like JavaScript `Map`s: insertion order, a removal keeps the others' order.
#[derive(Default)]
struct State {
    sessions: Vec<(String, Vec<(String, Subscription)>)>,
    /// The latest frame per session, so a phone joining a static page gets one.
    latest: HashMap<String, Value>,
    tokens: u64,
    /// The effects of the state's changes, in the order they were made, not yet delivered.
    outbox: VecDeque<Effect>,
    /// A caller is delivering the outbox: others leave their effects to it.
    delivering: bool,
}

impl State {
    fn subscriptions(&mut self, session: &str) -> Option<&mut Vec<(String, Subscription)>> {
        self.sessions.iter_mut().find(|(held, _)| held == session).map(|(_, subscriptions)| subscriptions)
    }

    fn subscription(&mut self, session: &str, client: &str) -> Option<&mut Subscription> {
        self.subscriptions(session)?.iter_mut().find(|(held, _)| held == client).map(|(_, subscription)| subscription)
    }
}

enum Effect {
    Send(String, Value),
    Request(String, Option<Value>),
    Dropped(String, String),
}

pub struct BrowserStreams {
    me: Weak<BrowserStreams>,
    deps: Arc<dyn StreamsDeps>,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
    /// Test-only: runs where a step has released the state with its effects queued, before it delivers them, so a test can hold
    /// one step there while another runs.
    #[cfg(test)]
    pub(crate) released: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

fn largest(subscriptions: &[(String, Subscription)]) -> Value {
    let mut max_width = 0;
    let mut max_height = 0;
    let mut fit = None;
    for (_, subscription) in subscriptions {
        max_width = max_width.max(subscription.max_width);
        max_height = max_height.max(subscription.max_height);
        // A take-over's fit: the earliest subscriber holding one.
        if fit.is_none() {
            fit = subscription.takeover.clone();
        }
    }
    let mut options = Map::new();
    options.insert("maxWidth".to_owned(), Value::from(max_width));
    options.insert("maxHeight".to_owned(), Value::from(max_height));
    if let Some(fit) = fit {
        options.insert("fit".to_owned(), fit);
    }
    Value::Object(options)
}

impl BrowserStreams {
    pub fn new(deps: Arc<dyn StreamsDeps>, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            deps,
            clock,
            state: Mutex::default(),
            #[cfg(test)]
            released: Mutex::default(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Ends a step: its effects join the outbox under the lock that made its change, then the outbox is delivered.
    fn commit(&self, mut state: MutexGuard<'_, State>, effects: Vec<Effect>) {
        state.outbox.extend(effects);
        drop(state);
        #[cfg(test)]
        {
            let hook = self.released.lock().unwrap_or_else(PoisonError::into_inner).clone();
            if let Some(hook) = hook {
                hook();
            }
        }
        self.deliver();
    }

    /// Delivers the outbox in order unless a delivery is already running, which then delivers what was queued here.
    fn deliver(&self) {
        {
            let mut state = self.lock();
            if state.delivering {
                return;
            }
            state.delivering = true;
        }
        loop {
            let effect = {
                let mut state = self.lock();
                match state.outbox.pop_front() {
                    Some(effect) => effect,
                    None => {
                        state.delivering = false;
                        return;
                    }
                }
            };
            match effect {
                Effect::Send(client, frame) => self.deps.send(&client, frame),
                Effect::Request(session, options) => self.deps.request(&session, options),
                Effect::Dropped(client, session) => self.deps.on_drop(&client, &session),
            }
        }
    }

    /// A timer of this state; `fire` runs with the state when it goes off and its token is still the current one.
    fn arm(&self, state: &mut State, ms: f64, fire: impl FnOnce(&BrowserStreams, u64) + Send + 'static) -> (u64, u64) {
        state.tokens += 1;
        let token = state.tokens;
        let me = self.me.clone();
        let handle = self.clock.set_timer(
            ms,
            Box::new(move || {
                if let Some(streams) = me.upgrade() {
                    fire(&streams, token);
                }
            }),
        );
        (token, handle)
    }

    /// What one phone is sent of a frame: no picture while it awaits its fitted one, no image while WebRTC owns its view.
    fn shaped(subscription: &mut Subscription, frame: &Value) -> Value {
        if subscription.awaiting_fit {
            if truthy(frame.get("fitFailed")) {
                // A fit that failed ends the wait: the take-over falls back to watching.
                subscription.awaiting_fit = false;
            } else if !truthy(frame.get("image")) || !truthy(frame.get("fitSettled")) {
                return without_picture(frame);
            } else {
                subscription.awaiting_fit = false;
            }
        }
        if subscription.images || !truthy(frame.get("image")) {
            return frame.clone();
        }
        Value::Object(without(frame, &["image"]))
    }

    /// Sends the slot's frame unless one is in flight and its ack window is open; then a retry fires when the window closes.
    fn flush(&self, state: &mut State, session: &str, client: &str, effects: &mut Vec<Effect>) {
        let (waiting, retrying) = {
            let Some(subscription) = state.subscription(session, client) else { return };
            if subscription.slot.is_none() {
                return;
            }
            let waiting = if subscription.inflight.is_some() { subscription.sent_at + ACK_TIMEOUT_MS - self.clock.now() } else { 0.0 };
            (waiting, subscription.retry.is_some())
        };
        if waiting > 0.0 {
            if !retrying {
                let (owner, viewer) = (session.to_owned(), client.to_owned());
                let retry = self.arm(state, waiting, move |streams, token| streams.retried(&owner, &viewer, token));
                if let Some(subscription) = state.subscription(session, client) {
                    subscription.retry = Some(retry);
                }
            }
            return;
        }
        let now = self.clock.now();
        let Some(subscription) = state.subscription(session, client) else { return };
        let Some(frame) = subscription.slot.take() else { return };
        // `inflightSeq = frame.seq`: a `null` seq is nothing in flight, a missing one is in flight and matches no ack.
        subscription.inflight = match frame.get("seq") {
            Some(Value::Null) => None,
            Some(seq) => Some(seq.clone()),
            None => Some(Value::Null),
        };
        subscription.sent_at = now;
        let shaped = Self::shaped(subscription, &frame);
        effects.push(Effect::Send(client.to_owned(), shaped));
    }

    fn retried(&self, session: &str, client: &str, token: u64) {
        let mut effects = Vec::new();
        let mut state = self.lock();
        let Some(subscription) = state.subscription(session, client) else { return };
        if subscription.retry.map(|(held, _)| held) != Some(token) {
            return;
        }
        subscription.retry = None;
        self.flush(&mut state, session, client, &mut effects);
        self.commit(state, effects);
    }

    fn lapsed(&self, session: &str, client: &str, token: u64) {
        let mut effects = Vec::new();
        let mut state = self.lock();
        if state.subscription(session, client).map(|subscription| subscription.expiry.0) != Some(token) {
            return;
        }
        self.drop_subscription(&mut state, session, client, &mut effects);
        self.commit(state, effects);
    }

    fn arm_expiry(&self, state: &mut State, session: &str, client: &str) {
        if let Some(subscription) = state.subscription(session, client) {
            self.clock.clear_timer(subscription.expiry.1);
        }
        let (owner, viewer) = (session.to_owned(), client.to_owned());
        let expiry = self.arm(state, SUBSCRIPTION_EXPIRY_MS, move |streams, token| streams.lapsed(&owner, &viewer, token));
        if let Some(subscription) = state.subscription(session, client) {
            subscription.expiry = expiry;
        }
    }

    /// `drop`: the subscription ends; the desktop is told the remaining subscribers' largest options, or to stop.
    fn drop_subscription(&self, state: &mut State, session: &str, client: &str, effects: &mut Vec<Effect>) {
        let Some(position) = state.sessions.iter().position(|(held, _)| held == session) else { return };
        let subscriptions = &mut state.sessions[position].1;
        let Some(index) = subscriptions.iter().position(|(held, _)| held == client) else { return };
        let (_, subscription) = subscriptions.remove(index);
        self.clock.clear_timer(subscription.expiry.1);
        if let Some((_, handle)) = subscription.retry {
            self.clock.clear_timer(handle);
        }
        if subscriptions.is_empty() {
            state.sessions.remove(position);
            state.latest.remove(session);
            effects.push(Effect::Request(session.to_owned(), None));
        } else {
            effects.push(Effect::Request(session.to_owned(), Some(largest(subscriptions))));
        }
        effects.push(Effect::Dropped(client.to_owned(), session.to_owned()));
    }

    /// Start or renew a phone's subscription.
    pub fn subscribe(&self, client: &str, session: &str, options: StreamOptions) {
        let mut effects = Vec::new();
        let mut state = self.lock();
        {
            if state.subscriptions(session).is_none() {
                state.sessions.push((session.to_owned(), Vec::new()));
            }
            let is_new = state.subscription(session, client).is_none();
            if is_new {
                let subscription = Subscription {
                    max_width: options.max_width,
                    max_height: options.max_height,
                    expiry: (0, 0),
                    slot: None,
                    inflight: None,
                    sent_at: 0.0,
                    retry: None,
                    images: true,
                    awaiting_fit: false,
                    fit_asked: false,
                    takeover: None,
                };
                if let Some(subscriptions) = state.subscriptions(session) {
                    subscriptions.push((client.to_owned(), subscription));
                }
            }
            if let Some(subscription) = state.subscription(session, client) {
                // Take-over intent lasts as long as the subscription: a renewal that omits `fit` keeps it.
                match options.fit {
                    Fit::Release => {
                        subscription.takeover = None;
                        subscription.fit_asked = false;
                        subscription.awaiting_fit = false;
                    }
                    Fit::Viewport(fit) => {
                        if subscription.takeover.is_none() {
                            subscription.takeover = Some(fit);
                        }
                    }
                    Fit::Absent => {}
                }
                if subscription.takeover.is_some() && !subscription.fit_asked {
                    subscription.fit_asked = true;
                    subscription.awaiting_fit = true;
                }
                subscription.max_width = options.max_width;
                subscription.max_height = options.max_height;
            }
            self.arm_expiry(&mut state, session, client);
            let told = state.subscriptions(session).map(|subscriptions| largest(subscriptions));
            effects.push(Effect::Request(session.to_owned(), told));
            let cached = state.latest.get(session).cloned();
            if is_new && let Some(cached) = cached {
                if let Some(subscription) = state.subscription(session, client) {
                    subscription.slot = Some(cached);
                }
                self.flush(&mut state, session, client, &mut effects);
            }
        }
        self.commit(state, effects);
    }

    /// Stop a phone's subscription.
    pub fn unsubscribe(&self, client: &str, session: &str) {
        let mut effects = Vec::new();
        let mut state = self.lock();
        self.drop_subscription(&mut state, session, client, &mut effects);
        self.commit(state, effects);
    }

    /// The phone lost its right to the view (its device was unpaired): every subscription it holds ends now, its frame in flight and
    /// its resend with it (Node's `dropClient`, `remote-browser-streams.ts:258-260`).
    pub fn drop_client(&self, client: &str) {
        let mut effects = Vec::new();
        let mut state = self.lock();
        let sessions: Vec<String> = state.sessions.iter().map(|(session, _)| session.clone()).collect();
        for session in sessions {
            self.drop_subscription(&mut state, &session, client, &mut effects);
        }
        self.commit(state, effects);
    }

    /// The relay closed: every subscription ends (Node's `dispose`, `remote-browser-streams.ts:261-265`).
    pub fn dispose(&self) {
        let mut effects = Vec::new();
        let mut state = self.lock();
        let held: Vec<(String, Vec<String>)> =
            state.sessions.iter().map(|(session, subscriptions)| (session.clone(), subscriptions.iter().map(|(client, _)| client.clone()).collect())).collect();
        for (session, clients) in held {
            for client in clients {
                self.drop_subscription(&mut state, &session, &client, &mut effects);
            }
        }
        self.commit(state, effects);
    }

    /// Whether the phone holds a live subscription to the session.
    pub fn subscribed(&self, client: &str, session: &str) -> bool {
        self.lock().subscription(session, client).is_some()
    }

    /// Whether the phone holds a subscription to any session.
    pub fn subscribes_any(&self, client: &str) -> bool {
        self.lock().sessions.iter().any(|(_, subscriptions)| subscriptions.iter().any(|(held, _)| held == client))
    }

    /// A take-over subscriber not yet sent a picture of the settled (fitted) layout: its WebRTC view must not be promoted yet either.
    pub fn awaiting_fit(&self, client: &str, session: &str) -> bool {
        self.lock().subscription(session, client).is_some_and(|subscription| subscription.awaiting_fit)
    }

    /// Withhold (false) or resume (true) a phone's images; resuming sends the newest picture at once.
    pub fn set_images(&self, client: &str, session: &str, enabled: bool) {
        let mut effects = Vec::new();
        let mut state = self.lock();
        let cached = state.latest.get(session).cloned();
        let Some(subscription) = state.subscription(session, client) else { return };
        if subscription.images == enabled {
            return;
        }
        subscription.images = enabled;
        if enabled && let Some(cached) = cached.filter(|cached| truthy(cached.get("image"))) {
            subscription.slot = Some(cached);
            self.flush(&mut state, session, client, &mut effects);
        }
        self.commit(state, effects);
    }

    /// The phone painted `seq`: its next (newest) frame may go out.
    pub fn acknowledge(&self, client: &str, session: &str, seq: f64) {
        let mut effects = Vec::new();
        let mut state = self.lock();
        let Some(subscription) = state.subscription(session, client) else { return };
        if subscription.inflight.as_ref().and_then(Value::as_f64) != Some(seq) {
            return;
        }
        subscription.inflight = None;
        if let Some((_, handle)) = subscription.retry.take() {
            self.clock.clear_timer(handle);
        }
        self.flush(&mut state, session, client, &mut effects);
        self.commit(state, effects);
    }

    /// A new frame from the desktop: every live subscriber's slot takes it.
    pub fn publish(&self, frame: Value) {
        let Some(session) = frame.get("sessionId").and_then(Value::as_str).map(str::to_owned) else { return };
        let mut effects = Vec::new();
        let mut state = self.lock();
        let Some(clients) = state.subscriptions(&session).map(|subscriptions| subscriptions.iter().map(|(client, _)| client.clone()).collect::<Vec<_>>()) else {
            return;
        };
        // A metadata-only frame inherits the newest image for anyone who has not received it yet.
        let latest = superseding(&frame, state.latest.get(&session));
        state.latest.insert(session.clone(), latest);
        for client in clients {
            if !self.deps.is_live(&client) {
                self.drop_subscription(&mut state, &session, &client, &mut effects);
                continue;
            }
            let Some(subscription) = state.subscription(&session, &client) else { continue };
            subscription.slot = Some(superseding(&frame, subscription.slot.as_ref()));
            self.flush(&mut state, &session, &client, &mut effects);
        }
        self.commit(state, effects);
    }
}

/// The product's clock: wall time and tokio timers.
pub struct SystemClock {
    me: Weak<SystemClock>,
    tasks: Mutex<(u64, HashMap<u64, tokio::task::JoinHandle<()>>)>,
}

impl SystemClock {
    pub fn new() -> Arc<Self> {
        Arc::new_cyclic(|me| Self { me: me.clone(), tasks: Mutex::default() })
    }
}

impl Clock for SystemClock {
    fn now(&self) -> f64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_millis() as f64)
    }

    fn set_timer(&self, ms: f64, run: Box<dyn FnOnce() + Send>) -> u64 {
        // Held while the task is spawned and registered, so a timer that fires at once finds its own entry to remove.
        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        tasks.0 += 1;
        let handle = tasks.0;
        let me = self.me.clone();
        let task = mixdog_rt::spawn("live-view-streams-timer", TaskClass::Work, async move {
            tokio::time::sleep(Duration::from_millis(ms.max(0.0).ceil() as u64)).await;
            if let Some(clock) = me.upgrade() {
                clock.tasks.lock().unwrap_or_else(PoisonError::into_inner).1.remove(&handle);
            }
            run();
        });
        tasks.1.insert(handle, task);
        handle
    }

    fn clear_timer(&self, handle: u64) {
        if let Some(task) = self.tasks.lock().unwrap_or_else(PoisonError::into_inner).1.remove(&handle) {
            task.abort();
        }
    }
}
