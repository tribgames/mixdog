//! The `/usage` panel (`app/usage-context-panels/usage-panel.mjs`): opens the provider-quota dashboard under a usage claim and
//! streams its updates until Esc or a newer `/usage` invalidates the claim.
//!
//! The dashboard streams updates for seconds, so it paints through a usage claim, which `closeUsagePanel` (Esc) and any newer
//! `/usage` invalidate. The settlements are ordered events: [`open_usage_panel`] paints the checking frame and answers the
//! request; once the run loop gets to it (the `setTimeout(0)` of the Node code) [`UsageRequest::due`] says whether the fetch
//! is still wanted; every `onUpdate` goes to [`UsageRequest::update`]; the answer goes to [`UsageRequest::settle`].

use mixdog_js::{is_js_space, js_to_lowercase};
use serde_json::{Value, json};

use super::PanelsHost;
use crate::slash::host::Tone;
use crate::slash::notices::truthy;
use crate::surface::owner::UsageClaim;

/// The store method that answers the dashboard.
pub const USAGE_DASHBOARD_METHOD: &str = "getUsageDashboard";

/// A `/usage` open in flight.
#[derive(Clone, Copy, Debug)]
pub struct UsageRequest {
    claim: UsageClaim,
    /// `{ refresh }` of the call: the argument asked for a fresh read.
    pub refresh: bool,
}

/// `/(?:^|\s)(?:refresh|--refresh|-r|true)(?:\s|$)/i` over the argument: one of the words, between whitespace or the ends.
fn asks_refresh(arg: &str) -> bool {
    arg.split(is_js_space).any(|word| {
        let word = js_to_lowercase(word);
        matches!(word.as_str(), "refresh" | "--refresh" | "-r" | "true")
    })
}

/// The frame painted while the first read runs.
fn checking_frame(refresh: bool) -> Value {
    json!({
        "title": "Provider Quotas",
        "subtitle": "Statusline-style provider quota windows.",
        "checking": true,
        "refresh": refresh,
        "rows": [],
        "total": null,
    })
}

/// `openUsagePanel(arg)`: takes the surface, closes the prompts and the context panel and paints the checking frame.
pub fn open_usage_panel<H: PanelsHost>(host: &mut H, arg: &str) -> UsageRequest {
    let refresh = asks_refresh(arg);
    let mut own = host.surface().claim();
    // The dashboard streams updates for seconds: they paint through a usage claim, which closeUsagePanel (Esc) and any
    // newer /usage invalidate.
    let dashboard_own = host.surface().claim_usage();
    host.clear_text_prompts();
    let surface = host.surface();
    own.paint(surface, None);
    own.context(surface, None);
    dashboard_own.paint(surface, Some(checking_frame(refresh)));
    UsageRequest { claim: dashboard_own, refresh }
}

impl UsageRequest {
    /// The deferred start of the read: whether the claim still holds and the store can answer the dashboard. A store without
    /// the method leaves the checking frame up, as the optional call of the Node code does.
    pub fn due<H: PanelsHost>(&self, host: &mut H) -> bool {
        self.claim.owns(host.surface()) && host.store_has(USAGE_DASHBOARD_METHOD)
    }

    /// The call to make: `getUsageDashboard({ refresh, onUpdate })`; the run loop attaches its update sink.
    pub fn args(&self) -> Value {
        json!({ "refresh": self.refresh })
    }

    /// `onUpdate(dashboard)`: a streamed dashboard is painted (a null one is skipped).
    pub fn update<H: PanelsHost>(&self, host: &mut H, dashboard: Value) {
        if truthy(&dashboard) {
            self.claim.paint(host.surface(), Some(dashboard));
        }
    }

    /// The read settled with `result`: the final dashboard is painted; none, or a failure, closes the panel and says so.
    pub fn settle<H: PanelsHost>(&self, host: &mut H, result: Result<Value, String>) {
        if !self.claim.owns(host.surface()) {
            return;
        }
        match result {
            Ok(dashboard) if truthy(&dashboard) => {
                self.claim.paint(host.surface(), Some(dashboard));
            }
            Ok(_) => {
                host.close_usage_panel();
                host.notify("usage dashboard unavailable", Tone::Warn);
            }
            Err(error) => {
                host.close_usage_panel();
                host.notify(&format!("usage failed: {error}"), Tone::Error);
            }
        }
    }
}
