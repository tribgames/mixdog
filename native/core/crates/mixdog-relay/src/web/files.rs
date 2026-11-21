//! Serving files of the renderer tree: the MIME table, the cache rules, the stat-keyed weak ETag, the conditional request, the
//! streamed body (precompressed sibling, live gzip or the file as it is) and the device-scoped manifest. Every read of the disk is
//! a job of the `InteractiveIo` lane. The target of a request path is resolved by [`resolve_static_target`]; [`resolve_for_device`]
//! picks the renderer directory of a device first, through `web::releases`.

use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use mixdog_fsio::{File, ReadProof};
use mixdog_rt::{CancellationToken, InLane, InteractiveIo, LaneToken};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::hashed::is_hashed_asset;
use super::headers::{ResponseHeaders, device_cookie_headers, security_headers_for_target};
use super::negotiate::{Encoding, LiveGzip, encoding_accepted, is_compressible, select_precompressed};
pub use super::readiness::{StaticResolution, resolve_static_target};
use super::releases::{DeviceReport, RendererCatalog};
use crate::http1::{HeaderError, Request, ResponseWriter, fail_request};
use crate::js;

/// `MIME_TYPES`, by lower-case extension with its dot.
pub const MIME_TYPES: [(&str, &str); 15] = [
    (".html", "text/html; charset=utf-8"),
    (".js", "text/javascript; charset=utf-8"),
    (".mjs", "text/javascript; charset=utf-8"),
    (".css", "text/css; charset=utf-8"),
    (".json", "application/json; charset=utf-8"),
    (".webmanifest", "application/manifest+json; charset=utf-8"),
    (".map", "application/json; charset=utf-8"),
    (".svg", "image/svg+xml"),
    (".png", "image/png"),
    (".ico", "image/x-icon"),
    (".woff2", "font/woff2"),
    (".woff", "font/woff"),
    (".ttf", "font/ttf"),
    (".wasm", "application/wasm"),
    (".txt", "text/plain; charset=utf-8"),
];

const MANIFEST_TYPE: &str = "application/manifest+json; charset=utf-8";

/// What a read job takes of a file at a time.
const CHUNK_BYTES: usize = 64 * 1024;

/// The validators kept across requests (bodies are not kept).
const VALIDATOR_CACHE_ENTRIES: usize = 256;

/// The type of `target` by its extension, `application/octet-stream` for an unknown one.
pub fn mime_type(target: &Path) -> &'static str {
    let extension = target.extension().map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase())).unwrap_or_default();
    MIME_TYPES.iter().find(|(known, _)| *known == extension).map_or("application/octet-stream", |(_, mime)| mime)
}

/// Files that revalidate every time. `boot.js` carries no content hash yet is version-locked to `index.html` (it picks the
/// viewport projection and the first-paint theme): under the generic one-day rule a phone kept an old `boot.js` while the
/// document handed it a new hashed bundle, and the mismatched pair rendered the PWA shrunk to a fraction of the screen.
const NO_CACHE_SUFFIXES: [&str; 7] = ["index.html", "manifest.webmanifest", "sw.js", "sw-shell.js", "sw-media.js", "ui-language.js", "boot.js"];

/// `cacheControlForTarget`.
pub fn cache_control_for_target(target: &Path, hashed_asset: bool) -> &'static str {
    let text = target.to_string_lossy();
    if NO_CACHE_SUFFIXES.iter().any(|suffix| text.ends_with(suffix)) {
        "no-cache"
    } else if hashed_asset {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=86400"
    }
}

struct Validator {
    target: PathBuf,
    stamp: String,
    etag: String,
}

/// Release swaps and in-place edits invalidate an entry, precompressed siblings included. The oldest entry goes first.
static VALIDATORS: Mutex<Vec<Validator>> = Mutex::new(Vec::new());

/// What identifies the state of a file without reading it: device, inode, size and both times (where the platform tells
/// them) plus the encoding of the representation.
fn stamp(info: &std::fs::Metadata, encoding: &str) -> String {
    let nanos = |time: io::Result<std::time::SystemTime>| time.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}:{}:{}.{}", info.dev(), info.ino(), info.size(), info.ctime(), info.ctime_nsec())
    };
    #[cfg(not(unix))]
    let identity = format!("{}:{}", info.len(), nanos(info.created()));
    format!("{identity}:{}:{encoding}", nanos(info.modified()))
}

/// `staticEtag`: `W/"<sha256 hex of the encoding name and the file's bytes>"`, so clients and service workers keep their
/// cached validators.
fn static_etag<P: ReadProof>(proof: &P, target: &Path, encoding: &str) -> io::Result<String> {
    let info = mixdog_fsio::metadata(proof, target)?;
    let stamp = stamp(&info, encoding);
    {
        let cache = VALIDATORS.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(cached) = cache.iter().find(|entry| entry.target == target && entry.stamp == stamp) {
            return Ok(cached.etag.clone());
        }
    }
    let bytes = mixdog_fsio::read(proof, target)?;
    let digest = Sha256::new().chain_update(encoding.as_bytes()).chain_update(&bytes).finalize();
    let etag = format!("W/\"{}\"", digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
    let mut cache = VALIDATORS.lock().unwrap_or_else(PoisonError::into_inner);
    cache.retain(|entry| entry.target != target);
    cache.push(Validator { target: target.to_path_buf(), stamp, etag: etag.clone() });
    while cache.len() > VALIDATOR_CACHE_ENTRIES {
        cache.remove(0);
    }
    Ok(etag)
}

/// `notModified`: `If-None-Match` of a GET or HEAD names this entity, `*` or a weak match included.
pub fn not_modified(method: &str, if_none_match: Option<&str>, etag: &str) -> bool {
    if method != "GET" && method != "HEAD" {
        return false;
    }
    let bare = |tag: &str| tag.strip_prefix("W/").unwrap_or(tag).to_owned();
    if_none_match.unwrap_or_default().split(',').any(|value| {
        let candidate = js::js_trim(value);
        candidate == "*" || bare(candidate) == bare(etag)
    })
}

/// What `sendStaticFile` reads of a request.
#[derive(Debug, Clone, Copy)]
pub struct StaticRequest<'a> {
    pub method: &'a str,
    pub accept_encoding: Option<&'a str>,
    pub if_none_match: Option<&'a str>,
}

impl<'a> StaticRequest<'a> {
    pub fn of(request: &'a Request) -> Self {
        Self { method: &request.method, accept_encoding: request.headers.get("accept-encoding"), if_none_match: request.headers.get("if-none-match") }
    }
}

/// `sendStaticFile`'s options.
#[derive(Debug, Clone, Copy, Default)]
pub struct StaticOptions {
    /// Per-device releases are on: the answer varies by `Cookie` too (hashed assets are the same in every release and do
    /// not).
    pub vary_on_cookie: bool,
}

/// What follows the head of an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StaticBody {
    /// A 304 or a HEAD.
    None,
    /// The bytes of `path`, run through live gzip when `live_gzip`.
    File { path: PathBuf, live_gzip: bool },
}

/// The head of an answer and where its body comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaticAnswer {
    pub status: u16,
    pub headers: ResponseHeaders,
    pub body: StaticBody,
}

/// How the body of a file is represented.
enum Representation {
    Precompressed { path: PathBuf, encoding: Encoding, length: u64 },
    LiveGzip,
    Identity { length: u64 },
}

struct Plan {
    headers: ResponseHeaders,
    representation: Representation,
}

/// The reads of `sendStaticFile` before the head: size, the sibling to negotiate, the validator and the security headers.
fn plan_in_lane(lane: &InLane<InteractiveIo>, target: &Path, accept_encoding: Option<&str>, options: StaticOptions) -> io::Result<Plan> {
    let content_type = mime_type(target);
    let length = mixdog_fsio::metadata(lane, target)?.len();
    let hashed_asset = is_hashed_asset(target);
    let compressible = is_compressible(content_type, length);
    let precompressed = if compressible { select_precompressed(lane, target, accept_encoding) } else { None };
    let live_gzip = precompressed.is_none() && compressible && encoding_accepted(accept_encoding, "gzip");
    let encoding_name = match (&precompressed, live_gzip) {
        (Some(sibling), _) => sibling.encoding.name(),
        (None, true) => "gzip",
        (None, false) => "identity",
    };
    let etag_source = precompressed.as_ref().map_or(target, |sibling| sibling.path.as_path());
    let etag = static_etag(lane, etag_source, encoding_name)?;
    let mut headers = security_headers_for_target(lane, target);
    headers.set("Content-Type", content_type);
    headers.set("Cache-Control", cache_control_for_target(target, hashed_asset));
    // Hashed build assets are content-addressed, identical in every release.
    headers.set("Vary", if options.vary_on_cookie && !hashed_asset { "Accept-Encoding, Cookie" } else { "Accept-Encoding" });
    headers.set("ETag", etag);
    let representation = match precompressed {
        Some(sibling) => {
            let length = mixdog_fsio::metadata(lane, &sibling.path)?.len();
            Representation::Precompressed { path: sibling.path, encoding: sibling.encoding, length }
        }
        None if live_gzip => Representation::LiveGzip,
        None => Representation::Identity { length },
    };
    Ok(Plan { headers, representation })
}

async fn job<R: Send + 'static>(io: &InteractiveIo, body: impl FnOnce(&InLane<InteractiveIo>) -> io::Result<R> + Send + 'static) -> io::Result<R> {
    let handle = io.submit(&CancellationToken::new(), body).map_err(|_| io::Error::other("lane"))?;
    handle.await.map_err(|_| io::Error::other("lane"))?
}

/// The head `sendStaticFile` writes for `target` and where its body comes from. A precompressed sibling has a known length,
/// so the browser gets a real progress figure; live gzip has none, its byte count is settled only when the stream ends.
/// `extra` is merged over the standard headers, as the caller's own (`Set-Cookie`) win.
pub async fn answer_static_file(
    io: &InteractiveIo,
    request: &StaticRequest<'_>,
    target: &Path,
    extra: &ResponseHeaders,
    options: StaticOptions,
) -> io::Result<StaticAnswer> {
    let path = target.to_path_buf();
    let accept_encoding = request.accept_encoding.map(str::to_owned);
    let Plan { mut headers, representation } = job(io, move |lane| plan_in_lane(lane, &path, accept_encoding.as_deref(), options)).await?;
    headers.extend(extra);
    if not_modified(request.method, request.if_none_match, headers.get("ETag").unwrap_or_default()) {
        return Ok(StaticAnswer { status: 304, headers, body: StaticBody::None });
    }
    let (path, live_gzip) = match representation {
        Representation::Precompressed { path, encoding, length } => {
            headers.set("Content-Encoding", encoding.name());
            headers.set("Content-Length", length.to_string());
            (path, false)
        }
        Representation::LiveGzip => {
            headers.set("Content-Encoding", "gzip");
            (target.to_path_buf(), true)
        }
        Representation::Identity { length } => {
            headers.set("Content-Length", length.to_string());
            (target.to_path_buf(), false)
        }
    };
    let body = if request.method == "HEAD" { StaticBody::None } else { StaticBody::File { path, live_gzip } };
    Ok(StaticAnswer { status: 200, headers, body })
}

/// `response.writeHead(status, headers)` with header values that may be several lines.
fn write_head(response: &mut ResponseWriter, status: u16, headers: &ResponseHeaders) -> Result<(), HeaderError> {
    for (name, values) in headers.iter() {
        let values: Vec<&str> = values.iter().map(String::as_str).collect();
        response.set_header_values(name, &values)?;
    }
    response.write_head(status, &[])
}

/// Reads `path` a chunk at a time, one lane job each, into `response`; live gzip compresses as it goes. Ends the response,
/// or destroys it when the file cannot be read.
async fn stream_body(io: &InteractiveIo, response: &mut ResponseWriter, path: PathBuf, live_gzip: bool) {
    match stream_chunks(io, response, path, live_gzip).await {
        Ok(()) => response.end(None),
        Err(_) => response.destroy(),
    }
}

async fn stream_chunks(io: &InteractiveIo, response: &mut ResponseWriter, path: PathBuf, live_gzip: bool) -> io::Result<()> {
    let mut file = job(io, move |lane| File::open(lane, &path)).await?;
    let mut gzip = live_gzip.then(LiveGzip::default);
    let conn = response.conn();
    loop {
        let (next_file, next_gzip, out, eof) = job(io, move |_| {
            let mut buffer = vec![0u8; CHUNK_BYTES];
            let read = file.read(&mut buffer)?;
            buffer.truncate(read);
            let eof = read == 0;
            let out = if eof {
                gzip.take().map_or_else(|| Ok(buffer), LiveGzip::finish)?
            } else if let Some(compressor) = gzip.as_mut() {
                compressor.push(&buffer)?
            } else {
                buffer
            };
            Ok((file, gzip, out, eof))
        })
        .await?;
        (file, gzip) = (next_file, next_gzip);
        if conn.is_destroyed() {
            return Ok(());
        }
        if !out.is_empty() && !response.write(&out) {
            response.drain().await;
        }
        if eof {
            return Ok(());
        }
    }
}

/// `sendStaticFile`: a resolved file with cache, compression and HEAD handling, the body streamed. A file that cannot be
/// read before the head goes is answered 500 (`[relay] static failed:` on stderr), after it the connection is closed.
pub async fn send_static_file(
    io: &InteractiveIo,
    request: &Request,
    response: &mut ResponseWriter,
    target: &Path,
    extra: &ResponseHeaders,
    options: StaticOptions,
) {
    let answer = match answer_static_file(io, &StaticRequest::of(request), target, extra, options).await {
        Ok(answer) => answer,
        Err(error) => return fail_request("static", &error.to_string(), response),
    };
    if let Err(error) = write_head(response, answer.status, &answer.headers) {
        return fail_request("static", &error.to_string(), response);
    }
    match answer.body {
        StaticBody::None => response.end(None),
        StaticBody::File { path, live_gzip } => stream_body(io, response, path, live_gzip).await,
    }
}

/// The manifest for `/d/<deviceId>/`. `start_url` is what an install captures, so pointing it at the device route lets the
/// installed web app say which desktop it wants. The route names a desktop and carries no secret; the approval on that desktop
/// grants access. Returns `false` when the manifest cannot be read, leaving the answer to the caller.
pub async fn send_device_manifest(io: &InteractiveIo, request: &Request, response: &mut ResponseWriter, target: &Path, device_id: &str) -> bool {
    let path = target.to_path_buf();
    let base = format!("/d/{device_id}/");
    let Ok(Some(body)) = job(io, move |lane| Ok(device_manifest_body(lane, &path, &base))).await else { return false };
    let etag = format!("W/\"{}\"", Sha256::digest(body.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect::<String>());
    let unchanged = not_modified(&request.method, request.headers.get("if-none-match"), &etag);
    let mut headers = super::headers::browser_security_headers();
    headers.set("Content-Type", MANIFEST_TYPE);
    headers.set("Cache-Control", "no-cache");
    headers.set("ETag", etag);
    if !unchanged {
        headers.set("Content-Length", body.len().to_string());
    }
    headers.extend(&device_cookie_headers(device_id, request.encrypted));
    if let Err(error) = write_head(response, if unchanged { 304 } else { 200 }, &headers) {
        fail_request("static", &error.to_string(), response);
        return true;
    }
    if unchanged || request.method == "HEAD" {
        response.end(None);
    } else {
        response.end(Some(body.as_bytes()));
    }
    true
}

/// The manifest with its identity moved onto the device route, or `None` when it cannot be read or is not an object or an
/// array (`JSON.parse` failing, or the assignments of a primitive throwing).
fn device_manifest_body<P: ReadProof>(proof: &P, target: &Path, base: &str) -> Option<String> {
    let text = mixdog_fsio::read(proof, target).ok()?;
    let mut manifest = js::parse(&js::decode_utf8(&text)).ok()?;
    match &mut manifest {
        Value::Object(fields) => {
            for key in ["id", "start_url", "scope"] {
                fields.insert(key.to_owned(), Value::String(base.to_owned()));
            }
            // An installer ignores a share_target whose action falls outside the manifest scope, so the share sheet entry
            // follows the device route exactly like start_url does.
            if let Some(Value::Object(share)) = fields.get_mut("share_target")
                && let Some(Value::String(action)) = share.get("action")
            {
                let routed = format!("{base}{}", action.trim_start_matches('/'));
                share.insert("action".to_owned(), Value::String(routed));
            }
        }
        Value::Array(_) => {}
        _ => return None,
    }
    Some(js::wire(&manifest))
}

/// The renderer directory of the device `report` names, then the target of `pathname` inside it: the one choice per request
/// that decides which release answers. Both are reads of the disk and run as one lane job.
pub async fn resolve_for_device(
    io: &InteractiveIo,
    catalog: Arc<RendererCatalog>,
    report: DeviceReport,
    pathname: String,
) -> io::Result<(PathBuf, StaticResolution)> {
    job(io, move |_| {
        Ok(match catalog.dir_for(&report) {
            Some(dir) => {
                let resolution = resolve_static_target(&dir, &pathname);
                (dir, resolution)
            }
            None => (PathBuf::new(), StaticResolution::Missing),
        })
    })
    .await
}
