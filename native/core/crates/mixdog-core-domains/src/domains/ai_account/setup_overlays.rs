//! What is overlaid on a cached provider setup on every read (`session-runtime/provider-auth/setup.mjs`
//! `withLiveKeychain` / `withCatalogErrors`): the keyring alert reflects the live state (the keyring
//! can lock or unlock while a cached setup is served), and a provider whose model list failed says why
//! on its row so a view never shows its empty list as if nothing were wrong.
//!
//! The failures themselves are [`CatalogFailures`], the store `recordProviderCatalogOutcome` fills
//! (message cut to 300, whitespace collapsed, the error's kind).

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::provider_setup::keychain_issue_of;
use super::setup_cache::{KeychainLive, SetupOverlays};

/// `{ message, errorKind }` of a provider's latest catalog failure (`providerCatalogFailure`).
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogFailure {
    pub message: String,
    /// `providerErrorKind(error)`: `{ kind, code, status, retryAfterMs, resetAt }`.
    pub error_kind: Option<Value>,
}

/// `providerCatalogFailure(id)`.
pub trait CatalogFailures: Send + Sync {
    fn failure(&self, id: &str) -> Option<CatalogFailure>;
}

/// `withCatalogErrors(setup)`: each row of `api`, `oauth` and `local` whose provider has a failure
/// gets `catalogError: { message, errorKind }` (appended; an existing one keeps its place). Anything
/// that is not an object is returned as it came.
pub fn with_catalog_errors(setup: Value, failures: &dyn CatalogFailures) -> Value {
    let Value::Object(mut out) = setup else { return setup };
    for group in ["api", "oauth", "local"] {
        let Some(Value::Array(rows)) = out.get(group) else { continue };
        let rows: Vec<Value> = rows
            .iter()
            .map(|row| {
                let found = row.get("id").and_then(Value::as_str).and_then(|id| failures.failure(id)).filter(|f| !f.message.is_empty());
                match (row, found) {
                    (Value::Object(map), Some(failure)) => {
                        let mut map = map.clone();
                        let mut error = Map::new();
                        error.insert("message".into(), json!(failure.message));
                        if let Some(kind) = failure.error_kind {
                            error.insert("errorKind".into(), kind);
                        }
                        map.insert("catalogError".into(), Value::Object(error));
                        Value::Object(map)
                    }
                    _ => row.clone(),
                }
            })
            .collect();
        out.insert(group.into(), Value::Array(rows));
    }
    Value::Object(out)
}

/// `withLiveKeychain(setup)`: the setup without its stale `keychain`, plus the live alert if any
/// (last, after the other keys).
pub fn with_live_keychain(setup: Value, issue: Option<Value>) -> Value {
    let Value::Object(mut out) = setup else { return setup };
    out.shift_remove("keychain");
    if let Some(issue) = issue {
        out.insert("keychain".into(), issue);
    }
    Value::Object(out)
}

/// The production [`SetupOverlays`].
pub struct LiveOverlays {
    pub failures: Arc<dyn CatalogFailures>,
    pub keychain: Arc<dyn KeychainLive>,
}

impl SetupOverlays for LiveOverlays {
    fn with_live_keychain(&self, setup: Value) -> Value {
        with_live_keychain(setup, keychain_issue_of(self.keychain.status()))
    }

    fn with_catalog_errors(&self, setup: Value) -> Value {
        with_catalog_errors(setup, self.failures.as_ref())
    }
}

/// The catalog's own failure store is the production source (`recordProviderCatalogOutcome` fills it
/// from every refresh).
impl CatalogFailures for mixdog_ai::catalog::CatalogFailureStore {
    fn failure(&self, id: &str) -> Option<CatalogFailure> {
        mixdog_ai::catalog::CatalogFailureStore::failure(self, id).map(|f| CatalogFailure { message: f.message, error_kind: Some(f.error_kind) })
    }
}
