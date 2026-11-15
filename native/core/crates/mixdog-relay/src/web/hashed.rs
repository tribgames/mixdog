//! Content-hashed build filenames (`name-<8+ chars>.ext`, `lib/hashed-asset-name.mjs`), a leaf so the staging tools and the
//! static file server share one pattern.

use std::path::{Component, Path};
use std::sync::LazyLock;

use mixdog_js::JsRegex;

static HASHED_ASSET_NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"-[A-Za-z0-9_-]{8,}\.[^.]+$", ""));

/// `HASHED_ASSET_NAME.test(target)`: a dash, eight or more name characters, a dot and an extension at the end of `target`.
pub fn is_hashed_asset_name(target: &str) -> bool {
    HASHED_ASSET_NAME.is_match(target)
}

/// What `sendStaticFile` tests: a path with an `assets` directory in it and a hashed file name. Such a file never changes
/// under its name, so it is cached for a year.
pub fn is_hashed_asset(target: &Path) -> bool {
    let under_assets = target.components().any(|part| matches!(part, Component::Normal(name) if name == "assets"));
    under_assets && is_hashed_asset_name(&target.to_string_lossy())
}
