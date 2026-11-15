//! "Update your PC" (`lib/update-pc-page.mjs`): answered instead of the renderer to the Mixdog phone app (user agent
//! `MixdogApp/`), whose PC reported a version older than the renderers the relay holds. Static and self-contained like
//! `/connect` and `/app`; it grants nothing.

use super::{PageReply, STATIC_PAGE_CSP, fill};

/// Keep in sync with `NATIVE_APP_USER_AGENT_TOKEN` (`apps/desktop/src/shared/native-app.ts`).
const NATIVE_APP_USER_AGENT_TOKEN: &str = "MixdogApp/";

const TEMPLATE: &str = include_str!("../../assets/pages/update-pc.html");

/// `isNativeAppRequest`: the phone app, by its user agent. Browsers and home-screen web apps never are.
pub fn is_native_app_request(user_agent: Option<&str>) -> bool {
    user_agent.is_some_and(|agent| agent.contains(NATIVE_APP_USER_AGENT_TOKEN))
}

/// `escapeHtml`: `& < > " '` as decimal character references.
fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '&' | '<' | '>' | '"' | '\'') {
            out.push_str(&format!("&#{};", u32::from(ch)));
        } else {
            out.push(ch);
        }
    }
    out
}

/// `renderUpdatePcPage`. `current` is the PC's reported app version ("" = never reported), `min` the oldest version the
/// relay still has a renderer for.
pub fn render_update_pc_page(current: &str, min: &str) -> String {
    let (current, min) = (escape_html(current), escape_html(min));
    fill(TEMPLATE, &[("CURRENT", current.as_str()), ("MIN", min.as_str())])
}

/// `sendUpdatePcPage`: always a 200 (the caller decided the visitor needs it); the method is only told apart for HEAD.
pub fn update_pc_page(method: &str, current: &str, min: &str) -> PageReply {
    PageReply::html(STATIC_PAGE_CSP, &render_update_pc_page(current, min), method == "HEAD")
}
