//! The pairing-gated static shell (`lib/relay-static-gate.mjs`, `serveStatic`): device routes, the public installability
//! assets, the share-target fallback and the health probe. The branding files of [`PUBLIC_APP_ASSETS`] are served without the
//! pairing gate because browsers fetch them without credentials; a 401 would silently downgrade "install app" to an icon-less
//! shortcut. They carry no user data.
//!
//! Gate: an approved browser presents its per-browser token (`?token=`, else the cookie for plain asset requests). A
//! container with no credential yet may still reach the shell through its device route (or the device cookie it was given
//! there): that shell can only show the install guide and ask the desktop for approval, and the bundle behind it holds no
//! user data. A caller with none of these sees 401, throttled to 429 by the unauthorized limiter.

use std::io;
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_rt::{CancellationToken, InLane, InteractiveIo, LaneToken};
use url::Url;

use super::device_route::{DeviceRoute, bare, parse_device_route, serve_device_route};
use super::files::{StaticOptions, StaticResolution, resolve_static_target, send_static_file};
use super::headers::{
    ResponseHeaders, device_cookie_headers, merge_cookie_headers, pairing_cookie_headers, parse_cookie_device, request_cookie_token,
};
use super::preview::{PREVIEW_FRAME_PATH, send_preview_frame};
use super::releases::{DeviceReport, RendererCatalog};
use crate::http1::util::{decoded_request_path, end_text, reject_unauthorized_text};
use crate::http1::{HeaderError, Request, ResponseWriter, fail_request};
use crate::pages::PageReply;
use crate::pages::update_pc::{is_native_app_request, renderer_unavailable_page, update_pc_page};
use crate::rate_limit::RateLimiter;
use crate::store::DeviceStore;

/// `PUBLIC_APP_ASSETS`: the installability metadata and its icons.
pub const PUBLIC_APP_ASSETS: [&str; 5] =
    ["/manifest.webmanifest", "/mixdog.svg", "/mixdog-logo-titanium.svg", "/mixdog-192.png", "/mixdog-512.png"];

// The installed worker must be able to replace itself even without a matching renderer.
const WORKER_SCRIPTS: [&str; 4] = ["/sw.js", "/sw-shell.js", "/sw-media.js", "/ui-language.js"];

/// What the gate asks of the device store (`store.deviceIdForClientToken`, `store.isKnown`, `store.deviceVersion`).
pub trait GateStore: Send + Sync + 'static {
    /// The device a per-browser token belongs to.
    fn device_id_for_client_token(&self, token: &str) -> Option<String>;
    fn is_known(&self, device_id: &str) -> bool;
    /// What the device last reported, empty strings when unknown.
    fn device_version(&self, device_id: &str) -> DeviceReport;
}

impl GateStore for DeviceStore {
    fn device_id_for_client_token(&self, token: &str) -> Option<String> {
        DeviceStore::device_id_for_client_token(self, token)
    }

    fn is_known(&self, device_id: &str) -> bool {
        DeviceStore::is_known(self, device_id)
    }

    fn device_version(&self, device_id: &str) -> DeviceReport {
        let version = DeviceStore::device_version(self, device_id);
        DeviceReport { app_version: version.app_version, renderer_release: version.renderer_release }
    }
}

/// `shareTargetShell`: the installed app's share sheet posts to its service worker, which answers on the device. A share that
/// still reaches the relay means no worker was active yet: reopening the app beats failing the share outright, even though
/// the payload itself is lost with the request this relay never stores. The shell to reopen (`/` or `/d/<id>/`), empty when
/// the request line is not a share-target path.
pub fn share_target_shell(request_target: &str) -> String {
    let Some((_, pathname)) = decoded_request_path(request_target) else { return String::new() };
    if pathname == "/share-target" {
        return "/".to_owned();
    }
    // `^/(?:d/[^/]+/)?share-target$`
    let Some(device) = pathname.strip_prefix("/d/").and_then(|rest| rest.strip_suffix("/share-target")) else { return String::new() };
    if device.is_empty() || device.contains('/') { String::new() } else { format!("/d/{device}/") }
}

/// The result of `resolveStaticAccess`.
struct Access {
    route: Option<DeviceRoute>,
    /// Which desktop's renderer release answers this request: the route names it, else the paired token does, else the device
    /// cookie of the container. Empty when none does.
    release_device: String,
    query_token: String,
    /// Only a credential this relay actually knows is persisted as the pairing cookie. A public asset carrying
    /// `?token=<attacker value>` would otherwise plant an HttpOnly cookie the visitor cannot see or clear, and every later
    /// request would ride the attacker's session.
    persist_query_token: bool,
    route_device: String,
    route_allowed: bool,
    allowed: bool,
}

/// What one lane job learns of the renderer tree of a request.
struct Lookup {
    resolution: StaticResolution,
    unavailable: bool,
    document: bool,
    /// The minimum supported version when this native app navigation needs the update-PC page.
    update_min_version: Option<String>,
}

/// The static surface of the relay: everything `routeRequest` does not claim goes here.
pub struct StaticGate {
    io: InteractiveIo,
    catalog: Arc<RendererCatalog>,
    store: Arc<dyn GateStore>,
    unauthorized: Arc<Mutex<RateLimiter>>,
}

impl StaticGate {
    /// `catalog` picks the release matching the desktop version the device last reported; `unauthorized` is the limiter the
    /// other unauthenticated routes charge too.
    pub fn new(io: InteractiveIo, catalog: Arc<RendererCatalog>, store: Arc<dyn GateStore>, unauthorized: Arc<Mutex<RateLimiter>>) -> Self {
        Self { io, catalog, store, unauthorized }
    }

    /// `serveStatic`. A failure to write an answer is logged and answered 500, as the guarded handler does a throw.
    pub async fn serve(&self, request: &Request, response: &mut ResponseWriter) {
        if let Err(message) = self.answer(request, response).await {
            fail_request("request", &message, response);
        }
    }

    async fn answer(&self, request: &Request, response: &mut ResponseWriter) -> Result<(), String> {
        if request.method != "GET" && request.method != "HEAD" {
            return answer_non_read_method(request, response).map_err(|error| error.to_string());
        }
        let Some((url, pathname)) = decoded_request_path(&request.url) else {
            return bare(response, 400).map_err(|error| error.to_string());
        };
        if pathname == "/healthz" {
            response.write_head(200, &[("Content-Type", "application/json")]).map_err(|error| error.to_string())?;
            response.end(Some(b"{\"status\":\"ok\"}"));
            return Ok(());
        }
        if pathname == PREVIEW_FRAME_PATH {
            return send_preview_frame(&request.method, response).map_err(|error| error.to_string());
        }
        let access = self.access(request, &url, &pathname);
        if !access.allowed {
            let mut limiter = self.unauthorized.lock().unwrap_or_else(PoisonError::into_inner);
            return reject_unauthorized_text(&mut limiter, request.remote_address.as_deref(), response).map_err(|error| error.to_string());
        }
        let report = if access.release_device.is_empty() { DeviceReport::default() } else { self.store.device_version(&access.release_device) };
        let rest = access.route.as_ref().map_or_else(|| pathname.clone(), |route| route.rest.clone());
        let update_page = wants_update_page(request, access.route.as_ref());
        let allow_default_asset = PUBLIC_APP_ASSETS.contains(&pathname.as_str()) || WORKER_SCRIPTS.contains(&pathname.as_str());
        let lookup = self.lookup(report.clone(), rest, update_page, allow_default_asset).await.map_err(|error| error.to_string())?;
        let Some(Lookup { resolution, unavailable, document, update_min_version }) = lookup else {
            let text = "Mixdog relay: no RENDERER_DIR configured; this relay only forwards WebSocket traffic.";
            return end_text(response, 404, text, &[]).map_err(|error| error.to_string());
        };
        if let Some(min) = update_min_version {
            return write_page_reply(response, &update_pc_page(&request.method, &report.app_version, &min)).map_err(|error| error.to_string());
        }
        if unavailable && document && !access.route.as_ref().is_some_and(|route| route.redirect) {
            return write_page_reply(response, &renderer_unavailable_page(&request.method)).map_err(|error| error.to_string());
        }
        if unavailable && !allow_default_asset && matches!(&resolution, StaticResolution::Missing)
            && !access.route.as_ref().is_some_and(|route| route.redirect)
        {
            response.write_head(404, &[("Cache-Control", "no-store")]).map_err(|error| error.to_string())?;
            response.end(None);
            return Ok(());
        }
        match &access.route {
            Some(route) => serve_device_route(&self.io, route, resolution, request, response).await.map_err(|error| error.to_string()),
            None => self.serve_resolved_asset(&access, resolution, request, response).await.map_err(|error| error.to_string()),
        }
    }

    /// `resolveStaticAccess`.
    fn access(&self, request: &Request, url: &Url, pathname: &str) -> Access {
        let route = parse_device_route(pathname);
        let query_token = url.query_pairs().find(|(name, _)| name == "token").map(|(_, value)| value.into_owned()).unwrap_or_default();
        let token = if query_token.is_empty() { request_cookie_token(&request.headers) } else { query_token.clone() };
        let token_device = if token.is_empty() { None } else { self.store.device_id_for_client_token(&token) };
        let cookie_device = parse_cookie_device(request.headers.get("cookie"));
        let route_device = route.as_ref().map_or_else(|| cookie_device.clone(), |route| route.device_id.clone());
        let route_allowed = !route_device.is_empty() && self.store.is_known(&route_device);
        let release_device = [route.as_ref().map(|route| route.device_id.clone()), token_device.clone(), Some(cookie_device)]
            .into_iter()
            .flatten()
            .find(|id| !id.is_empty())
            .unwrap_or_default();
        Access {
            persist_query_token: !query_token.is_empty() && token_device.is_some(),
            allowed: PUBLIC_APP_ASSETS.contains(&pathname) || route_allowed || token_device.is_some(),
            route,
            release_device,
            query_token,
            route_device,
            route_allowed,
        }
    }

    /// The release directory of the device `report` names, the target of `pathname` in it and, when `update_page` is asked
    /// for, whether that target is the document an older PC must show the update page for. `None`: no renderer
    /// directory is configured. Reads of the disk, so one lane job.
    async fn lookup(&self, report: DeviceReport, pathname: String, update_page: bool, allow_default_asset: bool) -> io::Result<Option<Lookup>> {
        let catalog = self.catalog.clone();
        let job = move |lane: &InLane<InteractiveIo>| {
            let selected = catalog.dir_for(&report);
            let dir = selected.as_deref().unwrap_or_else(|| catalog.renderer_dir());
            if selected.is_some() && dir.as_os_str().is_empty() {
                return Ok(None);
            }
            let resolution = if dir.as_os_str().is_empty() { StaticResolution::Missing } else { resolve_static_target(dir, &pathname) };
            let document = matches!(pathname.as_str(), "/" | "/index.html")
                || matches!(&resolution, StaticResolution::Found(target)
                    if mixdog_fsio::canonicalize(lane, dir.join("index.html")).is_ok_and(|index| index == *target));
            let update_min_version = if update_page && document { catalog.legacy_for(&report).map(|legacy| legacy.min_version) } else { None };
            let unavailable = selected.is_none();
            let resolution = if unavailable && !allow_default_asset && !matches!(&resolution, StaticResolution::Forbidden) {
                StaticResolution::Missing
            } else {
                resolution
            };
            Ok(Some(Lookup { resolution, unavailable, document, update_min_version }))
        };
        let handle = self.io.submit(&CancellationToken::new(), job).map_err(|_| io::Error::other("lane"))?;
        handle.await.map_err(|_| io::Error::other("lane"))?
    }

    /// `serveResolvedAsset`: a root URL is shared by every device, so the same URL can carry different bytes: shared caches
    /// key on the cookie too.
    async fn serve_resolved_asset(
        &self,
        access: &Access,
        resolution: StaticResolution,
        request: &Request,
        response: &mut ResponseWriter,
    ) -> Result<(), HeaderError> {
        let target = match resolution {
            StaticResolution::Forbidden => return bare(response, 403),
            StaticResolution::Missing => return end_text(response, 404, "Not found.", &[]),
            StaticResolution::Found(target) => target,
        };
        let persisted =
            if access.persist_query_token { pairing_cookie_headers(&access.query_token, request.encrypted) } else { ResponseHeaders::new() };
        // A root asset request proves the container still belongs to this route; refreshing the cookie keeps a long-lived
        // install from aging out of it.
        let refreshed =
            if access.route_allowed { device_cookie_headers(&access.route_device, request.encrypted) } else { ResponseHeaders::new() };
        let cookies = merge_cookie_headers(&[&persisted, &refreshed]);
        send_static_file(&self.io, request, response, &target, &cookies, StaticOptions { vary_on_cookie: true }).await;
        Ok(())
    }
}

/// Only a top-level native navigation can show the update-PC page. Fetch Metadata, when sent, must distinguish that
/// navigation from a `fetch()`, iframe or worker request. A WebView navigation may omit the header altogether.
fn wants_update_page(request: &Request, route: Option<&DeviceRoute>) -> bool {
    route.is_some_and(|route| !route.redirect)
        && is_native_app_request(request.headers.get("user-agent"))
        && request.headers.get("sec-fetch-dest").is_none_or(|dest| dest == "document")
}

/// `answerNonReadMethod`: a share-target POST is redirected into the shell; every other non-read method is refused.
fn answer_non_read_method(request: &Request, response: &mut ResponseWriter) -> Result<(), HeaderError> {
    let shell = if request.method == "POST" { share_target_shell(&request.url) } else { String::new() };
    if shell.is_empty() {
        return bare(response, 405);
    }
    response.write_head(303, &[("Location", shell.as_str())])?;
    response.end(None);
    Ok(())
}

/// Writes a page of `crate::pages`: the status, the headers in the order given, then the body when there is one (none is
/// `end()` without data: HEAD, 302, 404 and 405).
pub fn write_page_reply(response: &mut ResponseWriter, reply: &PageReply) -> Result<(), HeaderError> {
    let headers: Vec<(&str, &str)> = reply.headers.iter().map(|(name, value)| (*name, value.as_str())).collect();
    response.write_head(reply.status, &headers)?;
    response.end(reply.body.as_deref());
    Ok(())
}
