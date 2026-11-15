//! The desktop-leg side of native push (`native-push-legs.mjs`). A token is a delivery destination, not something one
//! desktop owns: one phone paired with several PCs hands the same installation token to each of them. Every desktop
//! therefore holds its OWN association (token -> device, client, platform), made over its authenticated leg for one of ITS
//! OWN paired clients and checked against the device store on every send. A desktop sends only through an association it
//! holds, and unbind and revoke only ever remove that desktop's associations.
//!
//! The table is `Map<token, Map<'deviceId\nclientId', association>>`. A single-association entry (`Map<token,
//! association>`) is still read: it is upgraded in place the first time its token is touched.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Map, Value};

use super::{Platform, PushMessage, PushSender};
use crate::js;
use crate::rate_limit::RateLimiter;

pub const NATIVE_PUSH_REASONS: [&str; 3] = ["turn-finished", "approval-pending", "input-needed"];
/// `mx` is limited in UTF-16 code units, as `String.length` counts them.
pub const MAX_MX_CHARS: usize = 3500;
pub const MAX_NATIVE_BINDINGS_PER_DEVICE: usize = 64;
/// Sends one desktop may make in a minute.
pub const NATIVE_SENDS_PER_MINUTE: usize = 120;

/// The device store as the push code sees it: which clients a desktop has paired.
pub trait PairedClients: Sync {
    fn has_client(&self, device_id: &str, client_id: &str) -> bool;
}

/// `^[0-9a-fA-F]{32,400}$` for APNs, `^[A-Za-z0-9_:.-]{32,4096}$` for FCM.
pub fn valid_native_token(platform: &str, token: &str) -> bool {
    let (lengths, allowed): (std::ops::RangeInclusive<usize>, fn(u8) -> bool) = match platform {
        "apns" => (32..=400, |byte: u8| byte.is_ascii_hexdigit()),
        "fcm" => (32..=4096, |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':' | b'.' | b'-')),
        _ => return false,
    };
    lengths.contains(&token.len()) && token.bytes().all(allowed)
}

/// `^[A-Za-z0-9_-]{1,64}$`.
pub fn valid_collapse_key(key: &str) -> bool {
    (1..=64).contains(&key.len()) && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

struct Association {
    device_id: String,
    client_id: String,
    platform: String,
}

enum Entry {
    /// The single-association shape.
    Single(Association),
    Many(HashMap<String, Association>),
}

type Table = HashMap<String, Entry>;

fn association_key(device_id: &str, client_id: &str) -> String {
    format!("{device_id}\n{client_id}")
}

/// The associations held for one token, upgrading a single-association entry.
fn associations_of(entry: &mut Entry) -> &mut HashMap<String, Association> {
    if let Entry::Single(single) = entry {
        let single = Association {
            device_id: std::mem::take(&mut single.device_id),
            client_id: std::mem::take(&mut single.client_id),
            platform: std::mem::take(&mut single.platform),
        };
        *entry = Entry::Many(HashMap::from([(association_key(&single.device_id, &single.client_id), single)]));
    }
    match entry {
        Entry::Many(map) => map,
        Entry::Single(_) => unreachable!("a single association was upgraded above"),
    }
}

/// Removes the associations of `device_id` (optionally one client, optionally one token) and forgets tokens nobody is
/// associated with any more.
fn drop_associations(table: &mut Table, device_id: &str, client_id: Option<&str>, token: Option<&str>) {
    let tokens: Vec<String> = match token {
        None => table.keys().cloned().collect(),
        Some(token) => vec![token.to_owned()],
    };
    for token in tokens {
        let Some(entry) = table.get_mut(&token) else { continue };
        let associations = associations_of(entry);
        associations.retain(|_, held| !(held.device_id == device_id && client_id.is_none_or(|client| held.client_id == client)));
        if associations.is_empty() {
            table.remove(&token);
        }
    }
}

fn owns(paired: &dyn PairedClients, device_id: &str, client_id: Option<&str>) -> bool {
    client_id.is_some_and(|client| paired.has_client(device_id, client))
}

fn text<'a>(message: &'a Value, name: &str) -> Option<&'a str> {
    message.get(name).and_then(Value::as_str)
}

/// The `native-push-result` frame: `{ type, platform, token, collapseKey, ...fields }`, the echoed fields only when the
/// message had them (`JSON.stringify` leaves out what is `undefined`).
fn result_frame(message: &Value, fields: Vec<(&str, Value)>) -> Value {
    let mut frame = Map::new();
    frame.insert("type".to_owned(), Value::from("native-push-result"));
    for name in ["platform", "token", "collapseKey"] {
        if let Some(value) = message.get(name) {
            frame.insert(name.to_owned(), value.clone());
        }
    }
    for (name, value) in fields {
        frame.insert(name.to_owned(), value);
    }
    Value::Object(frame)
}

fn refusal(message: &Value, error: &str) -> Value {
    result_frame(message, vec![("ok", Value::Bool(false)), ("error", Value::from(error))])
}

/// Native push as the relay serves it: the sender (absent on a relay without credentials), the per-desktop associations and
/// the per-desktop send limit. Every desktop leg of the relay shares one.
pub struct NativePushService {
    push: Option<Arc<dyn PushSender>>,
    table: Mutex<Table>,
    limiter: Mutex<RateLimiter>,
}

impl NativePushService {
    /// 120 sends a minute per desktop.
    pub fn new(push: Option<Arc<dyn PushSender>>) -> Self {
        Self::with_limiter(push, RateLimiter::new(NATIVE_SENDS_PER_MINUTE, 60_000))
    }

    pub fn with_limiter(push: Option<Arc<dyn PushSender>>, limiter: RateLimiter) -> Self {
        Self { push, table: Mutex::new(HashMap::new()), limiter: Mutex::new(limiter) }
    }

    fn table(&self) -> MutexGuard<'_, Table> {
        self.table.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `nativePush?.platforms ?? []`: what `relay-capabilities` advertises.
    pub fn platforms(&self) -> Vec<&'static str> {
        self.push.as_ref().map_or_else(Vec::new, |push| push.platforms())
    }

    /// Drops the pooled connections of the sender.
    pub fn close(&self) {
        if let Some(push) = &self.push {
            push.close();
        }
    }

    /// `native-push-bind`: associates a token with one of this desktop's own paired clients.
    pub fn bind(&self, device_id: &str, paired: &dyn PairedClients, message: &Value) {
        let (Some(platform), Some(token)) = (text(message, "platform"), text(message, "token")) else { return };
        if !self.platforms().contains(&platform) || !valid_native_token(platform, token) {
            return;
        }
        let client_id = text(message, "clientId");
        if !owns(paired, device_id, client_id) {
            return;
        }
        let client_id = client_id.unwrap_or_default();
        let key = association_key(device_id, client_id);
        let mut table = self.table();
        let held = table.get_mut(token).is_some_and(|entry| associations_of(entry).contains_key(&key));
        if !held {
            let mine: usize = table
                .values_mut()
                .map(|entry| associations_of(entry).values().filter(|association| association.device_id == device_id).count())
                .sum();
            if mine >= MAX_NATIVE_BINDINGS_PER_DEVICE {
                return;
            }
        }
        let association = Association { device_id: device_id.to_owned(), client_id: client_id.to_owned(), platform: platform.to_owned() };
        match table.get_mut(token) {
            Some(entry) => {
                associations_of(entry).insert(key, association);
            }
            None => {
                table.insert(token.to_owned(), Entry::Many(HashMap::from([(key, association)])));
            }
        }
    }

    /// `native-push-unbind`. Without a `clientId` (older desktops) every association THIS desktop holds for the token
    /// goes; another desktop's never does.
    pub fn unbind(&self, device_id: &str, message: &Value) {
        let Some(token) = text(message, "token") else { return };
        drop_associations(&mut self.table(), device_id, text(message, "clientId"), Some(token));
    }

    /// Forgets every association a revoked client (or desktop) could still send to.
    pub fn drop_bindings(&self, device_id: &str, client_id: Option<&str>) {
        drop_associations(&mut self.table(), device_id, client_id, None);
    }

    /// `native-push`: validates, checks the association and the limit, sends, and returns the `native-push-result` frame for
    /// the leg to write. `None` on a relay that cannot deliver to any platform, which ignores the frame (the legs got no
    /// `nativePush` when its `platforms` was empty).
    pub async fn send(&self, device_id: &str, paired: &dyn PairedClients, message: &Value) -> Option<Value> {
        let push = self.push.as_ref().filter(|push| !push.platforms().is_empty())?;
        let Some(request) = self.validated(message) else { return Some(refusal(message, "invalid-message")) };
        let bound = self.table().get_mut(&request.token).is_some_and(|entry| {
            associations_of(entry).values().any(|association| {
                association.device_id == device_id
                    && association.platform == request.platform.as_str()
                    && owns(paired, device_id, Some(&association.client_id))
            })
        });
        if !bound {
            return Some(refusal(message, "unbound-token"));
        }
        if !self.limiter.lock().unwrap_or_else(PoisonError::into_inner).allow(device_id) {
            return Some(refusal(message, "rate-limited"));
        }
        let result = push.send(&request).await;
        // Only the sender's associations go: every other desktop learns the token is dead from its own send and cleans up
        // its own store.
        if result.invalid {
            drop_associations(&mut self.table(), device_id, None, Some(&request.token));
        }
        let mut fields = vec![("ok", Value::Bool(result.ok))];
        if result.status != 0 {
            fields.push(("status", Value::from(result.status)));
        }
        if result.invalid {
            fields.push(("invalid", Value::Bool(true)));
        }
        if let Some(error) = result.error.filter(|error| !error.is_empty()) {
            fields.push(("error", Value::from(js::js_slice(&error, 80))));
        }
        Some(result_frame(message, fields))
    }

    /// The message when it is one this relay can deliver: a platform it serves, a well-formed token, an `mx` of 1 to 3500
    /// code units, a known reason and a collapse key.
    fn validated(&self, message: &Value) -> Option<PushMessage> {
        let platform = text(message, "platform").filter(|platform| self.platforms().contains(platform)).and_then(Platform::parse)?;
        let token = text(message, "token").filter(|token| valid_native_token(platform.as_str(), token))?;
        let mx = text(message, "mx").filter(|mx| (1..=MAX_MX_CHARS).contains(&js::js_len(mx)))?;
        let reason = text(message, "reason").filter(|reason| NATIVE_PUSH_REASONS.contains(reason))?;
        let collapse_key = text(message, "collapseKey").filter(|key| valid_collapse_key(key))?;
        Some(PushMessage {
            platform,
            token: token.to_owned(),
            mx: mx.to_owned(),
            reason: reason.to_owned(),
            collapse_key: collapse_key.to_owned(),
            sandbox: message.get("sandbox").and_then(Value::as_bool),
        })
    }

    /// Holds a single-association entry, the shape an older relay kept: the way a test seeds the upgrade-on-use path.
    #[cfg(any(test, feature = "test-support"))]
    pub fn hold_single_association(&self, token: &str, device_id: &str, client_id: &str, platform: &str) {
        let association = Association { device_id: device_id.to_owned(), client_id: client_id.to_owned(), platform: platform.to_owned() };
        self.table().insert(token.to_owned(), Entry::Single(association));
    }

    /// How many desktops hold an association for the token (upgrading a single-association entry).
    #[cfg(any(test, feature = "test-support"))]
    pub fn association_count(&self, token: &str) -> Option<usize> {
        self.table().get_mut(token).map(|entry| associations_of(entry).len())
    }
}
