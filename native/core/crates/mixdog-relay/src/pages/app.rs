//! `/app` and `/app/latest.json`: the target of the desktop's Phone QR. A static install page with the store or APK button for the
//! visitor's platform and a line on how to pair. It takes no parameters and grants nothing.
//!
//! The Android link is the newest release the deploy verified as published, recorded in `mobile-release.json` beside the
//! executable and read once, at startup ([`AppPages::load`]).

use std::path::Path;
use std::sync::LazyLock;

use mixdog_fsio::Unlaned;
use regex::Regex;
use serde_json::Value;

use super::{PageReply, PageRequest, STATIC_PAGE_CSP, fill, is_get_or_head};
use crate::js;
use crate::logline::{self, Line};

/// Without a deployed link the releases list still reaches every published APK.
pub const ANDROID_FALLBACK_URL: &str = "https://github.com/tribgames/mixdog/releases";

/// The file the deploy writes beside the relay.
pub const MOBILE_RELEASE_FILE: &str = "mobile-release.json";

const TEMPLATE: &str = include_str!("../../assets/pages/app.html");

/// The recorded link is the APK itself: this repository's `mobile-v*` release asset.
static ANDROID_APK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^https://github\.com/tribgames/mixdog/releases/download/mobile-v[0-9]+\.[0-9]+\.[0-9]+/[A-Za-z0-9_.-]+\.apk$")
        .unwrap_or_else(|error| unreachable!("the APK pattern is a literal: {error}"))
});

/// The first `/mobile-vN.N.N/` of a URL: the version `/app/latest.json` reports.
static VERSION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/mobile-v([0-9]+\.[0-9]+\.[0-9]+)/").unwrap_or_else(|error| unreachable!("the version pattern is a literal: {error}")));

/// `isAndroidApkUrl`.
pub fn is_android_apk_url(value: &str) -> bool {
    ANDROID_APK_RE.is_match(value)
}

/// `/Android/i` on a user agent: the case folding of a non-Unicode JavaScript pattern touches ASCII letters only.
fn is_android_agent(user_agent: Option<&str>) -> bool {
    user_agent.is_some_and(|agent| agent.to_ascii_lowercase().contains("android"))
}

/// `readAndroidUrl`: the link the file records, or the releases list. The second value is the line Node writes when the
/// file exists but cannot be read, or holds nothing usable (a missing file is silent).
pub fn read_android_url(file: &Path) -> (String, Option<Line>) {
    let fallback = ANDROID_FALLBACK_URL.to_owned();
    let bytes = match mixdog_fsio::read(&Unlaned, file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return (fallback, None),
        Err(error) => return (fallback, Some(logline::cannot_read(&logline::file_url(file), &error.to_string()))),
    };
    if let Ok(Value::Object(map)) = js::parse_bytes(&bytes)
        && let Some(Value::String(url)) = map.get("androidUrl")
        && (url == ANDROID_FALLBACK_URL || is_android_apk_url(url))
    {
        return (url.clone(), None);
    }
    (fallback, Some(logline::ignoring_malformed(&logline::file_url(file))))
}

/// The pages that depend on the Android link, built once from it.
#[derive(Debug, Clone)]
pub struct AppPages {
    android_url: String,
    page: String,
    latest: Option<String>,
}

impl AppPages {
    /// Reads `mobile-release.json` from the install directory (the directory of the running executable), writes the line
    /// of a file it could not use, and builds the pages.
    pub fn load(install_dir: &Path) -> Self {
        let (url, warning) = read_android_url(&install_dir.join(MOBILE_RELEASE_FILE));
        if let Some(line) = warning {
            logline::emit(&line);
        }
        Self::new(&url)
    }

    /// `createAppPageHandler` and `createLatestHandler` for this link.
    pub fn new(android_url: &str) -> Self {
        let latest = VERSION_RE
            .captures(android_url)
            .filter(|_| is_android_apk_url(android_url))
            .map(|caps| format!("{{\"version\":{},\"url\":{}}}", json_string(&caps[1]), json_string(android_url)));
        Self { android_url: android_url.to_owned(), page: render_app_page(android_url), latest }
    }

    /// The Android link the pages carry.
    pub fn android_url(&self) -> &str {
        &self.android_url
    }

    /// `/app`: an Android phone is sent straight to the APK when one is known; anything else gets the install page.
    pub fn app_page(&self, request: PageRequest<'_>) -> PageReply {
        if !is_get_or_head(request.method) {
            return PageReply::method_not_allowed();
        }
        if is_android_apk_url(&self.android_url) && is_android_agent(request.user_agent) {
            return PageReply::bodyless(302, vec![("Location", self.android_url.clone()), ("Cache-Control", "no-store".to_owned())]);
        }
        PageReply::html(STATIC_PAGE_CSP, &self.page, request.method == "HEAD")
    }

    /// `/app/latest.json`: the newest published version and its APK, so the Android app asks GitHub only when this is newer
    /// than itself. A 404 means "no APK known here": the client then uses its own GitHub fallback.
    pub fn latest_release(&self, request: PageRequest<'_>) -> PageReply {
        if !is_get_or_head(request.method) {
            return PageReply::method_not_allowed();
        }
        match &self.latest {
            None => PageReply::bodyless(404, vec![("Cache-Control", "no-store".to_owned()), ("X-Content-Type-Options", "nosniff".to_owned())]),
            Some(body) => PageReply::ok("application/json; charset=utf-8", None, body, request.method == "HEAD"),
        }
    }
}

/// `renderAppPage`: the install page with the Android link. The link is inserted as it is: the callers pass only the releases
/// list or a link that matches the APK pattern, so it carries nothing that needs escaping.
pub fn render_app_page(android_url: &str) -> String {
    fill(TEMPLATE, &[("ANDROID_URL", android_url)])
}

fn json_string(text: &str) -> String {
    js::wire(&Value::String(text.to_owned()))
}
