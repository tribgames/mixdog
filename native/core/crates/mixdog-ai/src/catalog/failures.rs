//! The latest catalog failure of each provider (`providers/catalog-failures.mjs`), kept so a view that
//! lists a provider's models can say WHY the list is empty (expired key, spent credits, timeout)
//! instead of showing a silent 0/0. Cleared by the provider's next answer and by an account change.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::PoisonError;

use mixdog_core_api::domain::provider::ProviderError;
use serde_json::Value;
use serde_json::json;

use crate::service::error_text::ErrorView;
use crate::service::error_text::safe_error_details;

/// `MESSAGE_LIMIT`.
const MESSAGE_LIMIT: usize = 300;

/// `{ message, errorKind }` of one provider's latest failure.
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    /// Plain text, never a JSON envelope: secrets removed, whitespace collapsed, cut to 300.
    pub message: String,
    /// `providerErrorKind(error)`: `{ kind, code, status, retryAfterMs, resetAt }`.
    pub error_kind: Value,
}

#[derive(Default)]
pub struct CatalogFailureStore {
    failures: Mutex<HashMap<String, Failure>>,
}

/// `safeErrorDetails(message)` with every whitespace run collapsed to one space, cut to 300 UTF-16 units.
fn failure_text(message: &str) -> String {
    let safe = safe_error_details(message);
    let mut collapsed = String::with_capacity(safe.len());
    let mut in_space = false;
    for c in safe.chars() {
        if mixdog_js::is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    mixdog_js::slice_utf16(&collapsed, MESSAGE_LIMIT)
}

impl CatalogFailureStore {
    /// `recordProviderCatalogOutcome(name, error)`.
    pub fn record(&self, name: &str, error: &ProviderError) {
        let view = ErrorView::from(error);
        let kind = view.descriptor.unwrap_or_else(crate::service::error_text::Descriptor::unknown);
        let error_kind = json!({
            "kind": kind.kind,
            "code": kind.code,
            "status": kind.status,
            "retryAfterMs": kind.retry_after_ms,
            "resetAt": kind.reset_at,
        });
        let failure = Failure { message: failure_text(&error.message), error_kind };
        self.failures.lock().unwrap_or_else(PoisonError::into_inner).insert(name.to_owned(), failure);
    }

    /// `recordProviderCatalogOutcome(name, null)`: the provider answered.
    pub fn recover(&self, name: &str) {
        self.failures.lock().unwrap_or_else(PoisonError::into_inner).remove(name);
    }

    /// `clearProviderCatalogFailures()`: an account change.
    pub fn clear(&self) {
        self.failures.lock().unwrap_or_else(PoisonError::into_inner).clear();
    }

    /// `providerCatalogFailure(name)`.
    pub fn failure(&self, name: &str) -> Option<Failure> {
        self.failures.lock().unwrap_or_else(PoisonError::into_inner).get(name).cloned()
    }
}
