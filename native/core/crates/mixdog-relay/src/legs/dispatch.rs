//! Where the later areas of the relay plug into the desktop leg: the frame types the leg itself does not answer, what it
//! publishes about the relay's own services, what it sends on connect, and what must happen when a device or a browser is
//! revoked or a live leg closes.
//!
//! `DESKTOP_FRAME_HANDLERS` of `lib/relay-legs.mjs` was one table; the frames the legs code owns are answered in
//! [`super::desktop`], and every other type is registered here by the area that owns it (`claim-approve`, `claim-deny`,
//! `pair-code-request`, `pair-code-clear`, `native-push*`, `webpush-*`, `ice-servers-request`) or by prefix (`media-`).
//!
//! A handler is awaited in frame order, so two frames of one leg are answered in the order they arrived, as in Node. A handler
//! that has to wait for the network or the disk starts that work itself (`mixdog_rt::spawn`) and returns, so one slow answer
//! never holds back the frames behind it.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::Value;

use super::desktop::BUILT_IN_TYPES;
use super::hub::Hub;

/// The future a handler returns.
pub type HandlerFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// One frame of a desktop leg, handed to the handler of its type.
#[derive(Clone)]
pub struct LegCall {
    pub hub: Arc<Hub>,
    /// The device the leg authenticated as.
    pub device_id: String,
    /// The frame, as `JSON.parse` produced it.
    pub message: Value,
}

/// A frame handler. It is only called for the live leg of its device: a superseded or revoked leg is never dispatched.
pub type Handler = Arc<dyn Fn(LegCall) -> HandlerFuture + Send + Sync>;

/// What a service says about itself in the `relay-capabilities` frame (`nativePush`, `nativePushPlatforms`, `webPush`, `ice`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CapabilityOffer {
    /// APNs and FCM credentials the relay holds; empty when it holds none.
    pub native_push_platforms: Vec<String>,
    pub web_push: bool,
    pub ice: bool,
}

/// Asked every time the capabilities frame is built.
pub type CapabilityProvider = Arc<dyn Fn() -> CapabilityOffer + Send + Sync>;

/// A frame sent to a desktop leg right after its capabilities (the `webpush-subscriptions` frame): the device it connected as in,
/// the frame out, or none.
pub type ConnectFrame = Arc<dyn Fn(&str) -> Option<Value> + Send + Sync>;

/// What a revocation takes with it besides the credential.
pub trait RevokeHook: Send + Sync {
    /// The device was revoked: its native and web push bindings go.
    fn device_revoked(&self, device_id: &str);
    /// One browser of the device was revoked: its bindings go, and the services that tell the desktop about its set publish it.
    fn client_revoked(&self, device_id: &str, client_id: &str);
}

/// Called with the device id when its live leg closes (the leg's pairing code dies with it).
pub type CloseHook = Arc<dyn Fn(&str) + Send + Sync>;

/// A registration that was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejected {
    /// The legs code answers this type itself.
    BuiltIn(String),
    /// Another handler already owns this type or prefix.
    Taken(String),
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BuiltIn(kind) => write!(f, "frame type {kind} is answered by the legs themselves"),
            Self::Taken(kind) => write!(f, "frame type {kind} already has a handler"),
        }
    }
}

impl std::error::Error for Rejected {}

#[derive(Default)]
struct Registry {
    handlers: HashMap<String, Handler>,
    prefixes: Vec<(String, Handler)>,
    capabilities: Vec<CapabilityProvider>,
    connect_frames: Vec<ConnectFrame>,
    revoke_hooks: Vec<Arc<dyn RevokeHook>>,
    close_hooks: Vec<CloseHook>,
}

/// The registrations of the areas that sit behind the desktop leg. Registered once at start; read on every frame.
#[derive(Default)]
pub struct Dispatch {
    registry: Mutex<Registry>,
}

impl Dispatch {
    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Own the frames whose `type` is exactly `kind`.
    pub fn register(&self, kind: &str, handler: Handler) -> Result<(), Rejected> {
        if BUILT_IN_TYPES.contains(&kind) {
            return Err(Rejected::BuiltIn(kind.to_owned()));
        }
        let mut registry = self.lock();
        if registry.handlers.contains_key(kind) {
            return Err(Rejected::Taken(kind.to_owned()));
        }
        registry.handlers.insert(kind.to_owned(), handler);
        Ok(())
    }

    /// Own the frames whose `type` starts with `prefix` and that no exact registration owns (`media-`).
    pub fn register_prefix(&self, prefix: &str, handler: Handler) -> Result<(), Rejected> {
        let mut registry = self.lock();
        if registry.prefixes.iter().any(|(taken, _)| taken == prefix) {
            return Err(Rejected::Taken(prefix.to_owned()));
        }
        registry.prefixes.push((prefix.to_owned(), handler));
        Ok(())
    }

    /// Add a service to the capabilities frame.
    pub fn register_capability(&self, provider: CapabilityProvider) {
        self.lock().capabilities.push(provider);
    }

    /// Send a frame to every desktop leg right after its capabilities.
    pub fn register_connect_frame(&self, frame: ConnectFrame) {
        self.lock().connect_frames.push(frame);
    }

    pub fn register_revoke_hook(&self, hook: Arc<dyn RevokeHook>) {
        self.lock().revoke_hooks.push(hook);
    }

    pub fn register_close_hook(&self, hook: CloseHook) {
        self.lock().close_hooks.push(hook);
    }

    /// The handler of a frame type: an exact registration first, then the first prefix that matches.
    pub(super) fn handler_for(&self, kind: &str) -> Option<Handler> {
        let registry = self.lock();
        if let Some(handler) = registry.handlers.get(kind) {
            return Some(Arc::clone(handler));
        }
        registry.prefixes.iter().find(|(prefix, _)| kind.starts_with(prefix.as_str())).map(|(_, handler)| Arc::clone(handler))
    }

    /// What every registered service offers, merged.
    pub(super) fn capabilities(&self) -> CapabilityOffer {
        let providers: Vec<CapabilityProvider> = self.lock().capabilities.clone();
        let mut merged = CapabilityOffer::default();
        for provider in providers {
            let offer = provider();
            merged.native_push_platforms.extend(offer.native_push_platforms);
            merged.web_push |= offer.web_push;
            merged.ice |= offer.ice;
        }
        merged
    }

    pub(super) fn connect_frames(&self, device_id: &str) -> Vec<Value> {
        let frames: Vec<ConnectFrame> = self.lock().connect_frames.clone();
        frames.iter().filter_map(|frame| frame(device_id)).collect()
    }

    pub(super) fn device_revoked(&self, device_id: &str) {
        let hooks: Vec<Arc<dyn RevokeHook>> = self.lock().revoke_hooks.clone();
        for hook in hooks {
            hook.device_revoked(device_id);
        }
    }

    pub(super) fn client_revoked(&self, device_id: &str, client_id: &str) {
        let hooks: Vec<Arc<dyn RevokeHook>> = self.lock().revoke_hooks.clone();
        for hook in hooks {
            hook.client_revoked(device_id, client_id);
        }
    }

    pub(super) fn leg_closed(&self, device_id: &str) {
        let hooks: Vec<CloseHook> = self.lock().close_hooks.clone();
        for hook in hooks {
            hook(device_id);
        }
    }
}
