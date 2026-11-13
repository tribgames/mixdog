//! `grok-oauth`: the xAI Responses wire through the Grok CLI proxy
//! (`cli-chat-proxy.grok.com`), signed in with the account's OAuth tokens.
//!
//! The wire is the xAI Responses codec of the compat family (its request
//! body, stream decoding and error classification); this module owns what is
//! Grok's: the proxy endpoint, the CLI identity headers that clear the
//! proxy's version gate, and the credential.
#![allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]

pub mod auth;
pub mod listing;
mod tool_schema;
#[cfg(test)]
mod fixture_manifest;
#[cfg(test)]
mod listing_tests;
#[cfg(test)]
mod version_gate_tests;

use std::sync::Arc;

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use self::auth::GrokCredential;
use self::listing::GrokListing;
use self::listing::SeedEffortRule;
use crate::catalog::ListingLookup;
use crate::transport::http::HttpSend;
use crate::providers::connect::rewrite::HttpAdapter;
use crate::providers::connect::rewrite::RewriteCodec;
use crate::providers::connect::rewrite::Rewriter;
use crate::providers::compat::CompatConfig;
use crate::providers::compat::chat::EnvSource;
use crate::registry::keys::ProcessEnv;
use crate::providers::connect::random_uuid;
use crate::providers::compat::CompatProfile;
use crate::providers::compat::responses::CompatResponsesCodec;

pub const PROVIDER_ID: &str = "grok-oauth";
pub const PROXY_BASE_URL: &str = "https://cli-chat-proxy.grok.com/v1";
/// The origin of [`PROXY_BASE_URL`], the one the CLI warms.
const PROXY_ORIGIN: &str = "https://cli-chat-proxy.grok.com";
/// The xAI catalog: release dates and the public SKUs. The proxy serves
/// inference and its own catalog; the two are merged by the listing.
pub const INFERENCE_BASE_URL: &str = "https://api.x.ai/v1";
const CLIENT_IDENTIFIER: &str = "grok-shell";

/// The CLI identity every proxy request carries, the version gate's inputs.
pub fn identity_headers(client_version: &str) -> Vec<(String, String)> {
    vec![
        ("x-grok-client-version".to_owned(), client_version.to_owned()),
        ("x-grok-client-identifier".to_owned(), CLIENT_IDENTIFIER.to_owned()),
        ("user-agent".to_owned(), format!("xai-grok-build/{client_version}")),
    ]
}
/// The oldest CLI release the proxy accepts; a newer one is configured.
pub const CLIENT_VERSION_FLOOR: &str = "1.0.70";

/// `openai` npm package version the Node provider's client reports (`x-stainless-package-version`).
const SDK_PACKAGE_VERSION: &str = "6.49.0";
/// The Node runtime the product runs its core under (`process.version` of the desktop's Electron 43.8.4 in node mode,
/// `x-stainless-runtime-version`), as the wire recording names it in its manifest.
pub(crate) const SDK_RUNTIME_VERSION: &str = "v24.22.1";

/// The platform headers Node's OpenAI client adds to every request (`detect-platform.js`) for a Node host:
/// `process.platform`, `process.arch` and `process.version`, normalized the way the client does.
pub fn sdk_headers_for(platform: &str, arch: &str, runtime_version: &str) -> Vec<(String, String)> {
    let platform = platform.to_lowercase();
    let os = if platform.contains("ios") {
        "iOS".to_owned()
    } else {
        match platform.as_str() {
            "android" => "Android".to_owned(),
            "darwin" => "MacOS".to_owned(),
            "win32" => "Windows".to_owned(),
            "freebsd" => "FreeBSD".to_owned(),
            "openbsd" => "OpenBSD".to_owned(),
            "linux" => "Linux".to_owned(),
            "" => "Unknown".to_owned(),
            other => format!("Other:{other}"),
        }
    };
    let arch = match arch {
        "x32" => "x32".to_owned(),
        "x86_64" | "x64" => "x64".to_owned(),
        "arm" => "arm".to_owned(),
        "aarch64" | "arm64" => "arm64".to_owned(),
        "" => "unknown".to_owned(),
        other => format!("other:{other}"),
    };
    [
        ("x-stainless-retry-count", "0".to_owned()),
        ("x-stainless-lang", "js".to_owned()),
        ("x-stainless-package-version", SDK_PACKAGE_VERSION.to_owned()),
        ("x-stainless-os", os),
        ("x-stainless-arch", arch),
        ("x-stainless-runtime", "node".to_owned()),
        ("x-stainless-runtime-version", runtime_version.to_owned()),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), value))
    .collect()
}

/// The headers for this host, spelled with the names Node's `process` has for it.
pub(crate) fn sdk_headers() -> Vec<(String, String)> {
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86" => "ia32",
        other => other,
    };
    sdk_headers_for(platform, arch, SDK_RUNTIME_VERSION)
}
/// `randomUUID()` of `proxyHeaders`: minted once per send (its `SendIdentity`), every attempt carries it.
fn request_id() -> String {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(drawn) = NUMBERED_REQUEST_IDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_mut() {
        *drawn += 1;
        return format!("00000000-0000-4000-8000-{drawn:012}");
    }
    random_uuid()
}

#[cfg(any(test, feature = "test-support"))]
static NUMBERED_REQUEST_IDS: std::sync::Mutex<Option<u64>> = std::sync::Mutex::new(None);

/// From now on the Grok request ids of this process are a sequence starting over at its 1st id
/// (`00000000-0000-4000-8000-000000000001`, ...), as the Node wire recorder's `crypto.randomUUID` is for each scenario.
/// Compiled for tests and the `test-support` feature only.
#[cfg(any(test, feature = "test-support"))]
pub fn number_request_ids_from_one() {
    *NUMBERED_REQUEST_IDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(0);
}

/// A new process's Grok state: random request ids again, and no token endpoint discovered (`_discoveryCache`).
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn reset_process_state() {
    *NUMBERED_REQUEST_IDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    auth::reset_discovered();
}

/// Points the xAI request at the proxy and adds the CLI identity headers.
pub struct GrokRewriter {
    pub client_version: crate::client_versions::Live,
    /// The signed-in user's id once a turn loaded it (`x-grok-user-id`).
    pub user_id: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// The platform headers of the Node client this host stands in for (sdk_headers).
    pub sdk_headers: Vec<(String, String)>,
    /// Which models take a reasoning effort when no roster row says (_grokModelSupportsEffort).
    pub effort_rule: Arc<dyn self::listing::XaiEffortRule>,
}

impl Rewriter for GrokRewriter {
    fn rewrite(&self, mut wire: WireRequest, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let opts = &request.options;
        // The order Node's OpenAI client writes (`openai/client.js` `buildHeaders`): its `accept: application/json` (even
        // for a streamed request), its platform headers, the auth header (`GrokCredential::place`), the provider's own
        // headers, then the body's `content-type`.
        let body_headers: Vec<(String, String)> = wire.headers.iter().filter(|(name, _)| name.eq_ignore_ascii_case("content-type")).cloned().collect();
        wire.headers.retain(|(name, _)| !name.eq_ignore_ascii_case("accept") && !name.eq_ignore_ascii_case("content-type"));
        wire.headers.push(("accept".to_owned(), "application/json".to_owned()));
        wire.headers.extend(self.sdk_headers.iter().cloned());
        wire.headers.extend(identity_headers(&self.client_version.get()));
        let mut add = |name: &str, value: String| wire.headers.push((name.to_owned(), value));
        // The session id is Mixdog's own; no Grok conversation id is made up.
        if let Some(session) = opts.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            add("x-grok-session-id", session.to_owned());
        }
        add("x-grok-req-id", opts.send_identity.get_or_mint(request_id));
        if !request.model.is_empty() {
            add("x-grok-model-override", request.model.clone());
        }
        // Only a loop turn names its iteration (from 1, `round.nextIteration`); a send outside the loop (a hosted
        // search) passes none and Node sends no turn index (grok-oauth-tokens.mjs:61-69).
        if opts.iteration > 0 {
            add("x-grok-turn-idx", opts.iteration.to_string());
        }
        if let Some(user) = (self.user_id)() {
            add("x-grok-user-id", user);
        }
        wire.headers.extend(body_headers);
        if let Ok(mut body) = serde_json::from_slice::<serde_json::Value>(&wire.body) {
            // `send` flattens the tools on each send (`normalizeGrokToolSchemas`); a TypeError it throws fails the send.
            let tool_schema::Flattened { mut changed, marker } = tool_schema::flatten_tools(&mut body).map_err(|tool_schema::TypeError(message)| {
                let mut error = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Unknown, mixdog_core_api::domain::provider::DeliveryState::NotSent);
                error.message = message;
                error
            })?;
            // `send`: a model that takes no effort is sent none, whatever the session pinned (the service 400s on one).
            if !listing::id_takes_effort(&*self.effort_rule, &request.model, false) {
                changed |= body.as_object_mut().and_then(|map| map.shift_remove("reasoning")).is_some();
            }
            if changed {
                wire.body = tool_schema::js_json(&body, &marker);
            }
        }
        Ok(wire)
    }
}

/// The xAI Responses codec aimed at the Grok CLI proxy.
pub fn codec(client_version: &str) -> Arc<dyn WireCodec> {
    codec_with(client_version, false)
}

/// [`codec`], with the server-hosted tool search the provider's config opted into (`xaiServerToolSearch`).
pub fn codec_with(client_version: &str, server_tool_search: bool) -> Arc<dyn WireCodec> {
    let profile = CompatProfile::xai();
    let config = CompatConfig {
        server_tool_search,
        base_url: Some(PROXY_BASE_URL.to_owned()),
        client_version: client_version.to_owned(),
        environment: Some(EnvSource(Arc::new(ProcessEnv))),
        ..CompatConfig::for_profile(&profile)
    };
    Arc::new(CompatResponsesCodec::new(profile, config, TransportKind::Http1))
}

/// The Grok adapter around the xAI Responses codec.
pub fn adapter(
    http: Arc<dyn HttpSend>,
    credential: Arc<GrokCredential>,
    client_version: Option<crate::client_versions::Live>,
    retry_policy: RetryPolicy,
    lookup: ListingLookup,
    versions: Option<Arc<crate::client_versions::ClientVersions>>,
    server_tool_search: bool,
) -> HttpAdapter {
    let client_version = client_version.unwrap_or_else(|| CLIENT_VERSION_FLOOR.into());
    let rewriter = GrokRewriter {
        client_version: client_version.clone(),
        user_id: {
            let credential = credential.clone();
            Arc::new(move || credential.user_id())
        },
        sdk_headers: sdk_headers(),
        effort_rule: Arc::new(SeedEffortRule),
    };
    let codec: Arc<dyn WireCodec> = Arc::new(RewriteCodec::new(codec_with(&client_version.get(), server_tool_search), rewriter));
    let listing = GrokListing::new(
        http.clone(),
        credential.clone(),
        codec.clone(),
        client_version,
        Arc::new(SeedEffortRule),
        lookup,
    );
    // Grok runs the xAI Responses send, whose ladder writes `[xai:responses]` (openai-compat-xai-send.mjs:154).
    let line = mixdog_core_api::domain::provider::RetryLine {
        tag: "[xai:responses]".into(),
        delay: true,
        style: mixdog_core_api::domain::provider::RetryLineStyle::Attempt,
    };
    let adapter =
        HttpAdapter::new(ProviderId::from(PROVIDER_ID), codec, http, credential, retry_policy).with_listing(Arc::new(listing)).with_retry_line(line);
    match versions {
        Some(versions) => adapter.with_resend(version_gate(versions)),
        None => adapter,
    }
}

/// `send`'s version gate (`grok-oauth.mjs:451-465`): a 426 whose body states a minimum above the version in use teaches
/// it, and the same request goes out once more at once at that version.
fn version_gate(versions: Arc<crate::client_versions::ClientVersions>) -> crate::providers::connect::rewrite::Resend {
    Arc::new(move |error| error.status == Some(426) && versions.learn_grok_required(&error.message))
}
