//! Relay-owned Web Push (RFC 8030 delivery, RFC 8292 VAPID): `lib/web-push.mjs` and the logic of `lib/web-push-legs.mjs`.
//!
//! A browser subscription is bound to ONE applicationServerKey. When every desktop held its own key, a browser paired with
//! several PCs could only be subscribed for one of them. The relay therefore owns the single sender identity every PC delivers
//! through ([`vapid`]): the browser subscribes once with the relay's public key, and each paired PC holds its OWN association
//! with that subscription ([`registry`]), made by the browser with that PC's pairing credential. The relay never sees
//! notification content: the browser's p256dh/auth reach the desktop sealed to its E2EE identity, and the desktop sends the
//! ciphertext ([`send`]) to a push service the endpoint policy allows ([`endpoint`]).
//!
//! The desktop leg speaks three frames:
//!
//! * relay to desktop `{ type: 'webpush-subscriptions', subscriptions: [{ endpoint, clientId, sealed }] }`: the full set THIS PC
//!   may deliver to, sent when the leg opens and again whenever it changes ([`WebPush::subscriptions_frame`]);
//! * desktop to relay `{ type: 'webpush-send', endpoint, clientId, payload, ttl?, urgency?, topic? }` with `payload` the RFC 8291
//!   body, base64url ([`WebPush::send_from_desktop`]);
//! * relay to desktop `{ type: 'webpush-result', endpoint, clientId, ok, status?, expired?, error? }`.
//!
//! A desktop sends only through an association it holds for a client the device store still knows: an unpaired or revoked
//! client, or another PC's association, is refused. `{ type: 'webpush-ready' }` marks a PC as delivering through the relay
//! ([`WebPush::mark_ready`]).
//!
//! [`frames`] registers these frames, the capability and the revocation hooks with the desktop leg; [`http`] answers the browser's
//! `/webpush/*` routes.

pub mod endpoint;
pub mod frames;
pub mod http;
pub mod registry;
pub mod send;
pub mod vapid;

use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use mixdog_fsio::Unlaned;
use serde_json::{Map, Value, json};

use self::registry::Registry;
use self::send::{PushClient, SendRequest, Sender, web_push_body, web_push_options};
use self::vapid::VapidKeys;
use crate::js;
use crate::rate_limit::RateLimiter;

/// Sends per minute one PC may make.
pub const SEND_RATE_LIMIT: usize = 240;
pub const SEND_RATE_WINDOW_MS: i64 = 60_000;
/// Registrations and removals per minute one browser credential may make (the HTTP routes' limiter).
pub const MUTATION_LIMIT: usize = 20;
pub const MUTATION_WINDOW_MS: i64 = 60_000;

/// Write-then-rename, owner-only: the VAPID private key lives in one of these.
pub(crate) fn write_owner_only(path: &Path, text: &str) -> std::io::Result<()> {
    let directory = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let temporary = directory.join(format!(".webpush-{}-{}.tmp", std::process::id(), uuid::Uuid::new_v4()));
    let written = write_then_rename(directory, &temporary, path, text);
    // Nothing is left behind by a failed write; after a rename there is nothing to remove.
    drop(mixdog_fsio::remove_file(&Unlaned, &temporary));
    written
}

fn write_then_rename(directory: &Path, temporary: &Path, path: &Path, text: &str) -> std::io::Result<()> {
    mixdog_fsio::create_dir_all(&Unlaned, directory)?;
    let mut options = mixdog_fsio::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&Unlaned, temporary)?;
    file.write_all(text.as_bytes())?;
    drop(file);
    #[cfg(unix)]
    owner_only(temporary)?;
    mixdog_fsio::rename(&Unlaned, temporary, path)?;
    // Committed; tightening is best effort on exotic filesystems.
    #[cfg(unix)]
    drop(owner_only(path));
    Ok(())
}

#[cfg(unix)]
fn owner_only(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    mixdog_fsio::set_permissions(&Unlaned, path, std::fs::Permissions::from_mode(0o600))
}

/// The relay's Web Push: the identity, the registry, the sender and the limiters the server hands to the desktop legs and to
/// the `/webpush/*` routes. Absent (`None` from [`WebPush::open`]) when no identity could be loaded or minted: desktops then keep
/// their own direct send.
pub struct WebPush {
    public_key: String,
    registry: Mutex<Registry>,
    sender: Sender,
    limiter: Mutex<RateLimiter>,
    mutation_limiter: Mutex<RateLimiter>,
}

impl WebPush {
    /// Loads or mints the identity in `data_dir` and loads the registry; `client` is the HTTP client the sender posts through.
    pub fn open(data_dir: &Path, client: Arc<dyn PushClient>) -> Option<Self> {
        let keys = VapidKeys::load_or_create(data_dir)?;
        let public_key = keys.public_key().to_owned();
        Some(Self {
            public_key,
            registry: Mutex::new(Registry::open(data_dir)),
            sender: Sender::new(Arc::new(keys), client),
            limiter: Mutex::new(RateLimiter::new(SEND_RATE_LIMIT, SEND_RATE_WINDOW_MS)),
            mutation_limiter: Mutex::new(RateLimiter::new(MUTATION_LIMIT, MUTATION_WINDOW_MS)),
        })
    }

    /// The applicationServerKey a browser subscribes with (`GET /webpush/key`).
    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    /// The registry, locked for one call: never held across an await.
    pub fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether one browser credential may register or unregister now.
    pub fn allow_mutation(&self, key: &str) -> bool {
        self.mutation_limiter.lock().unwrap_or_else(PoisonError::into_inner).allow(key)
    }

    /// `{ type: 'webpush-subscriptions', subscriptions }`: the set one PC may deliver to, minus the clients `client_known`
    /// (the device store's `hasClient`) no longer knows.
    pub fn subscriptions_frame(&self, device_id: &str, client_known: impl Fn(&str, &str) -> bool) -> Value {
        let rows: Vec<Value> = self
            .registry()
            .list_for(device_id)
            .into_iter()
            .filter(|row| client_known(device_id, &row.client_id))
            .map(|row| row.to_value())
            .collect();
        json!({ "type": "webpush-subscriptions", "subscriptions": rows })
    }

    /// `{ type: 'webpush-ready' }`: this PC delivers through the relay. Browsers register their subscription only with PCs that
    /// said so; an older PC keeps its own registration.
    pub fn mark_ready(&self, device_id: &str) {
        self.registry().mark_capable(device_id);
    }

    /// Handles a `webpush-send` of the desktop leg `device_id` and returns the `webpush-result` frame to answer it with.
    /// `client_known` is the device store's `hasClient`; `publish` tells a PC its new set (called for every PC that held a
    /// subscription the push service retired).
    pub async fn send_from_desktop(
        &self,
        device_id: &str,
        message: &Value,
        client_known: impl Fn(&str, &str) -> bool,
        publish: impl Fn(&str),
    ) -> Value {
        let text = |name: &str| message.get(name).and_then(Value::as_str).unwrap_or_default();
        let (endpoint, client_id) = (text("endpoint"), text("clientId"));
        let reply = |fields: Vec<(&str, Value)>| {
            let mut frame = Map::new();
            frame.insert("type".to_owned(), json!("webpush-result"));
            frame.insert("endpoint".to_owned(), json!(js::js_slice(endpoint, 2048)));
            frame.insert("clientId".to_owned(), json!(js::js_slice(client_id, 128)));
            for (name, value) in fields {
                frame.insert(name.to_owned(), value);
            }
            Value::Object(frame)
        };
        let refused = |error: &str| reply(vec![("ok", json!(false)), ("error", json!(error))]);
        let body = message.get("payload").and_then(web_push_body);
        let Some(body) = body.filter(|_| !endpoint.is_empty() && !client_id.is_empty()) else {
            return refused("invalid-message");
        };
        if !self.registry().has(device_id, client_id, endpoint) || !client_known(device_id, client_id) {
            return refused("unbound-subscription");
        }
        if !self.limiter.lock().unwrap_or_else(PoisonError::into_inner).allow(device_id) {
            return refused("rate-limited");
        }
        let result = self.sender.send(SendRequest { endpoint: endpoint.to_owned(), body, options: web_push_options(message) }).await;
        if result.expired {
            // The browser retired this subscription for every PC; each PC that held it gets its new set.
            let holders = self.registry().drop_endpoint(endpoint);
            for holder in holders {
                publish(&holder);
            }
        }
        let mut fields = vec![("ok", json!(result.ok))];
        if result.status != 0 {
            fields.push(("status", json!(result.status)));
        }
        if result.expired {
            fields.push(("expired", json!(true)));
        }
        if let Some(error) = result.error.filter(|error| !error.is_empty()) {
            fields.push(("error", json!(js::js_slice(&error, 80))));
        }
        reply(fields)
    }
}
