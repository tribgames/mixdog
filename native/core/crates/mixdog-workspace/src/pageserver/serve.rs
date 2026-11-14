#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "file reads run only as lane jobs (lanes::run_fallible); the server never touches the disk on an async thread")]
//! The page server (`local-page-server.ts`): leases name pages, a loopback listener answers GET/HEAD for them, and every response is read from
//! the one handle opened first, authorized again for the lease it is served under.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::{Body, Frame};
use hyper::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE, HeaderValue, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS};
use hyper::{Method, Response, StatusCode};
use tokio::sync::{OnceCell, mpsc};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::lease::{LOCAL_PAGE_TTL, Lease, Leases, PageScope};
use super::policy::{page_asset_type, page_location};
use super::shim::with_sandbox_storage_shim;
use crate::error::{WsError, WsResult};
use crate::lanes::{self, Lanes};
use crate::openedpath::{open_page_file, opened_location};
use crate::pathguard::{comparable, resolve};

const DENIED_CODE: &str = "MIXDOG_LOCAL_ACCESS_DENIED";
const HTML_TYPE: &str = "text/html; charset=utf-8";
/// One read of a streamed file.
const CHUNK: u64 = 256 * 1024;

/// Why a lease's authority refused a response. `Denied` is definite: the lease is revoked. `Transient` is a failed lookup (a timeout, a
/// busy daemon, a path that cannot be resolved right now): this response is refused and the URL stays usable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Denied,
    Transient,
}

/// The permission a lease was granted under, asked again before every response and when a URL is made.
#[async_trait]
pub trait PageAuthority: Send + Sync {
    /// `absolute` is the file about to be served (the lease's page when a URL is made).
    async fn check(&self, scope: &PageScope, absolute: &Path) -> Result<(), Refusal>;
}

pub(super) type PageBody = BoxBody<Bytes, io::Error>;

/// The path and page a lease was made from. A lease pins the real location of `rel` under `root` (a link may be retargeted later);
/// each response resolves it again and a different answer is a definite denial.
#[derive(Clone)]
struct Pinned {
    root: PathBuf,
    rel: String,
}

struct Listening {
    origin: String,
    task: JoinHandle<()>,
}

impl Drop for Listening {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct PageServer {
    me: Weak<PageServer>,
    port_file: PathBuf,
    authority: Arc<dyn PageAuthority>,
    lanes: Lanes,
    ttl: Duration,
    leases: Leases,
    pins: Mutex<HashMap<String, Pinned>>,
    listening: OnceCell<Listening>,
}

impl PageServer {
    pub fn new(port_file: PathBuf, authority: Arc<dyn PageAuthority>, lanes: Lanes) -> Arc<Self> {
        Self::with_ttl(port_file, authority, lanes, LOCAL_PAGE_TTL)
    }

    fn with_ttl(port_file: PathBuf, authority: Arc<dyn PageAuthority>, lanes: Lanes, ttl: Duration) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            port_file,
            authority,
            lanes,
            ttl,
            leases: Leases::new(),
            pins: Mutex::new(HashMap::new()),
            listening: OnceCell::new(),
        })
    }

    /// `http://127.0.0.1:<port>`: the app frames visualize pages from this origin only, so its CSP names it exactly. Starts the listener.
    pub async fn origin(&self) -> WsResult<String> {
        let listening = self
            .listening
            .get_or_try_init(|| async {
                let port_file = self.port_file.clone();
                let (listener, port) = lanes::run_fallible(self.lanes.interactive, &CancellationToken::new(), move || super::http::bind(&port_file)).await?;
                let task = super::http::spawn_accept_loop(listener, self.me.clone(), port)?;
                Ok::<_, WsError>(Listening { origin: format!("http://127.0.0.1:{port}"), task })
            })
            .await?;
        Ok(listening.origin.clone())
    }

    /// A URL for the page `rel` under `root`, served under `scope`. The caller chooses the scope from verified authority, not from
    /// renderer input; a single-file lease never inherits a project's wider reach for the same root.
    pub async fn lease_url(&self, root: &Path, rel: &str, scope: PageScope, owner_id: Option<String>) -> WsResult<String> {
        let (location_root, page) = {
            let (root, rel) = (root.to_path_buf(), rel.to_string());
            lanes::run_fallible(self.lanes.interactive, &CancellationToken::new(), move || page_location(&root, &rel)).await?
        };
        let origin = self.origin().await?;
        self.authority.check(&scope, &page).await.map_err(|refusal| match refusal {
            Refusal::Denied => WsError::coded(DENIED_CODE, "The page is not available."),
            Refusal::Transient => WsError::plain("The page permission could not be checked."),
        })?;
        let path: Vec<String> = page.components().skip(location_root.components().count()).map(|part| percent_encode(&part.as_os_str().to_string_lossy())).collect();
        let token = self.leases.insert(Lease { root: location_root, page, scope, owner_id, expires_at: Instant::now() + self.ttl });
        let mut pins = self.pins();
        let now = Instant::now();
        pins.retain(|token, _| self.leases.active(token, now).is_some());
        pins.insert(token.clone(), Pinned { root: root.to_path_buf(), rel: rel.to_string() });
        Ok(format!("{origin}/{token}/{}", path.join("/")))
    }

    /// A closed window leaves no usable preview URL behind.
    pub fn revoke_owner(&self, owner_id: &str) {
        self.leases.revoke_owner(owner_id);
    }

    fn pins(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pinned>> {
        self.pins.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn revoke(&self, token: &str) {
        self.leases.revoke(token);
        self.pins().remove(token);
    }

    fn is_active(&self, token: &str) -> bool {
        self.leases.active(token, Instant::now()).is_some()
    }

    /// The answer to one request.
    pub(super) async fn respond(&self, method: &Method, host: Option<&HeaderValue>, path: &str, port: u16) -> Response<PageBody> {
        match self.serve(method, host, path, port).await {
            Ok(response) => response,
            Err(status) => refuse(status),
        }
    }

    async fn serve(&self, method: &Method, host: Option<&HeaderValue>, path: &str, port: u16) -> Result<Response<PageBody>, StatusCode> {
        let head = *method == Method::HEAD;
        if !head && *method != Method::GET {
            return Err(StatusCode::METHOD_NOT_ALLOWED);
        }
        // Only this loopback origin: a rebound DNS name never reaches the files.
        if host.map(HeaderValue::as_bytes) != Some(format!("127.0.0.1:{port}").as_bytes()) {
            return Err(StatusCode::FORBIDDEN);
        }
        let mut parts = path.split('/').skip(1);
        let token = parts.next().unwrap_or_default();
        let lease = self.leases.active(token, Instant::now()).ok_or(StatusCode::NOT_FOUND)?;
        let segments = parts.map(percent_decode).collect::<Option<Vec<String>>>().ok_or(StatusCode::BAD_REQUEST)?;
        let mut target = lease.root.clone();
        target.extend(&segments);
        let target = resolve(&target);
        let is_file_scope = matches!(lease.scope, PageScope::File { .. });
        if page_asset_type(&lease.root, &target, None).is_none() || (is_file_scope && comparable(&target) != comparable(&lease.page)) {
            return Err(StatusCode::NOT_FOUND);
        }
        let (file, location, size) = {
            let root = lease.root.clone();
            lanes::run_fallible(self.lanes.interactive, &CancellationToken::new(), move || {
                let opened = open_page_file(&target, &root)?;
                // A platform that cannot name an open file's location has only the path the open was made on.
                let location = opened_location(&opened.file).unwrap_or_else(|_| opened.path.clone());
                let size = opened.file.metadata()?.len();
                Ok((opened.file, location, size))
            })
            .await
            .map_err(|_| StatusCode::NOT_FOUND)?
        };
        // A link must obey the same boundary, hidden-path and file-type rules as the requested path.
        let mime = page_asset_type(&lease.root, &location, None).ok_or(StatusCode::NOT_FOUND)?;
        if is_file_scope && comparable(&location) != comparable(&lease.page) {
            return Err(StatusCode::NOT_FOUND);
        }
        self.authorize(token, &lease, &location).await?;
        // Successful GET/HEAD makes this lease most recently used. A bad path or a failed authorization never reaches this line.
        self.leases.touch(token);
        // Only a sandboxed lease's page document is rewritten; assets stream.
        let page = if is_file_scope && mime == HTML_TYPE {
            let file = file.try_clone().map_err(|_| StatusCode::NOT_FOUND)?;
            let bytes = lanes::run_fallible(self.lanes.interactive, &CancellationToken::new(), move || {
                let mut bytes = Vec::new();
                (&file).read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .await
            .map_err(|_| StatusCode::NOT_FOUND)?;
            // Expiry or owner closure during the read must not still return the page.
            if !self.is_active(token) {
                return Err(StatusCode::NOT_FOUND);
            }
            Some(Bytes::from(with_sandbox_storage_shim(&bytes)))
        } else {
            None
        };
        let length = page.as_ref().map_or(size, |page| page.len() as u64);
        let body: PageBody = match page {
            _ if head => Empty::new().map_err(|never| match never {}).boxed(),
            Some(page) => Full::new(page).map_err(|never| match never {}).boxed(),
            None => ChunkBody::stream(self.lanes, file, length),
        };
        let mut response = Response::new(body);
        let headers = response.headers_mut();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(mime));
        headers.insert(CONTENT_LENGTH, HeaderValue::from(length));
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
        if is_file_scope {
            // Selected HTML keeps its scripts, without the project pages' origin, storage or window authority on this server.
            headers.insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox allow-scripts"));
        }
        Ok(response)
    }

    /// The lease's authority and its pinned page, then the lease itself: expiry, eviction or owner closure while those awaited win over a
    /// late success, and a definite denial revokes.
    async fn authorize(&self, token: &str, lease: &Lease, file: &Path) -> Result<(), StatusCode> {
        let verdict = match self.authority.check(&lease.scope, file).await {
            Ok(()) => self.recheck_pin(token, lease).await,
            Err(refusal) => Err(refusal),
        };
        match verdict {
            Ok(()) => {}
            Err(Refusal::Denied) => {
                self.revoke(token);
                return Err(StatusCode::NOT_FOUND);
            }
            // A timeout or failed lookup denies this response, not future attempts; expiry still wins over it.
            Err(Refusal::Transient) => return Err(if self.is_active(token) { StatusCode::SERVICE_UNAVAILABLE } else { StatusCode::NOT_FOUND }),
        }
        if self.is_active(token) { Ok(()) } else { Err(StatusCode::NOT_FOUND) }
    }

    /// The page the lease was made for must still be the real file at its path: a retargeted folder link or page alias is a denial, a
    /// path that cannot be resolved just now is not.
    async fn recheck_pin(&self, token: &str, lease: &Lease) -> Result<(), Refusal> {
        let Some(pin) = self.pins().get(token).cloned() else { return Ok(()) };
        let current = lanes::run_fallible(self.lanes.interactive, &CancellationToken::new(), move || page_location(&pin.root, &pin.rel)).await;
        match current {
            Ok((root, page)) if root == lease.root && page == lease.page => Ok(()),
            Ok(_) => Err(Refusal::Denied),
            Err(error) if error.reason.code() == DENIED_CODE => Err(Refusal::Denied),
            Err(_) => Err(Refusal::Transient),
        }
    }
}

pub(super) fn refuse(status: StatusCode) -> Response<PageBody> {
    let mut response = Response::new(Full::new(Bytes::from(status.as_u16().to_string())).map_err(|never| match never {}).boxed());
    *response.status_mut() = status;
    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// A body fed by a task reading the open file on a lane, one chunk at a time. Dropping the body (the client left) ends the task, which
/// drops the file.
struct ChunkBody {
    chunks: mpsc::Receiver<io::Result<Bytes>>,
}

impl ChunkBody {
    fn stream(lanes: Lanes, file: File, length: u64) -> PageBody {
        let (send, chunks) = mpsc::channel(2);
        tokio::spawn(pump(lanes, Arc::new(file), length, send));
        ChunkBody { chunks }.boxed()
    }
}

impl Body for ChunkBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        self.get_mut().chunks.poll_recv(cx).map(|chunk| chunk.map(|chunk| chunk.map(Frame::data)))
    }
}

/// Sends the first `length` bytes of `file` as chunks. A file that ends early fails the body, so the client sees a truncated response, not
/// a short one passed off as whole.
async fn pump(lanes: Lanes, file: Arc<File>, length: u64, send: mpsc::Sender<io::Result<Bytes>>) {
    let cancel = CancellationToken::new();
    let mut remaining = length;
    while remaining > 0 {
        let (file, want) = (file.clone(), remaining.min(CHUNK) as usize);
        let read = lanes::run(lanes.interactive, &cancel, move || {
            let mut buffer = vec![0u8; want];
            let read = (&*file).read(&mut buffer)?;
            buffer.truncate(read);
            Ok::<_, io::Error>(Bytes::from(buffer))
        })
        .await;
        let chunk = match read {
            Ok(Ok(chunk)) if chunk.is_empty() => Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
            Ok(result) => result,
            Err(error) => Err(io::Error::other(error.message)),
        };
        let failed = chunk.is_err();
        remaining = remaining.saturating_sub(chunk.as_ref().map_or(0, |chunk| chunk.len() as u64));
        if send.send(chunk).await.is_err() || failed {
            return;
        }
    }
}

/// `decodeURIComponent`: `%XX` escapes that form UTF-8; anything else is an error.
fn percent_decode(part: &str) -> Option<String> {
    let bytes = part.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = bytes.get(at + 1..at + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `encodeURIComponent`: everything but letters, digits and `- _ . ! ~ * ' ( )` is escaped, as UTF-8.
fn percent_encode(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    for byte in part.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::sync::Notify;

    use super::*;
    use crate::pageserver::lease::MAX_LOCAL_PAGE_LEASES;
    use crate::pageserver::shim::SHIM_SOURCE;

    struct Gate {
        entered: Notify,
        release: Notify,
        outcome: Mutex<Option<Refusal>>,
    }

    /// The authority a test drives: a standing refusal, a hook that runs inside the check, a gate that holds one check until released.
    #[derive(Default)]
    struct Mock {
        refusal: Mutex<Option<Refusal>>,
        gate: Mutex<Option<Arc<Gate>>>,
        hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl PageAuthority for Mock {
        async fn check(&self, _scope: &PageScope, _absolute: &Path) -> Result<(), Refusal> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let hook = self.hook.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
            let gate = self.gate.lock().unwrap().take();
            if let Some(gate) = gate {
                gate.entered.notify_one();
                gate.release.notified().await;
                let outcome = *gate.outcome.lock().unwrap();
                return outcome.map_or(Ok(()), Err);
            }
            let refusal = *self.refusal.lock().unwrap();
            refusal.map_or(Ok(()), Err)
        }
    }

    impl Mock {
        fn refuse_with(&self, refusal: Option<Refusal>) {
            *self.refusal.lock().unwrap() = refusal;
        }
        fn gate(&self) -> Arc<Gate> {
            let gate = Arc::new(Gate { entered: Notify::new(), release: Notify::new(), outcome: Mutex::new(None) });
            *self.gate.lock().unwrap() = Some(gate.clone());
            gate
        }
    }

    fn lanes() -> Lanes {
        let tokens = mixdog_rt::testing::tokens();
        Lanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io, cpu_bulk: tokens.cpu_bulk }
    }

    struct Reply {
        status: u16,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    impl Reply {
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.body).into_owned()
        }
        fn header(&self, name: &str) -> Option<&str> {
            self.headers.get(name).map(String::as_str)
        }
    }

    /// One request over a plain socket, so a malformed path or a foreign Host reaches the server as written.
    async fn request(port: u16, method: &str, path: &str, host: Option<&str>) -> Reply {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let host = host.map(|host| format!("Host: {host}\r\n")).unwrap_or_default();
        stream.write_all(format!("{method} {path} HTTP/1.1\r\n{host}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let split = raw.windows(4).position(|window| window == b"\r\n\r\n").expect("a response head");
        let head = String::from_utf8_lossy(&raw[..split]).into_owned();
        let mut lines = head.lines();
        let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
        let headers = lines.filter_map(|line| line.split_once(':')).map(|(name, value)| (name.trim().to_lowercase(), value.trim().to_string())).collect();
        Reply { status, headers, body: raw[split + 4..].to_vec() }
    }

    struct Fx {
        _dir: tempfile::TempDir,
        root: PathBuf,
        server: Arc<PageServer>,
        mock: Arc<Mock>,
        port: u16,
    }

    impl Fx {
        async fn new() -> Self {
            Self::with_ttl(LOCAL_PAGE_TTL).await
        }

        async fn with_ttl(ttl: Duration) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = crate::pathguard::canonical(dir.path()).unwrap().join("site");
            std::fs::create_dir_all(root.join("assets")).unwrap();
            std::fs::create_dir_all(root.join(".git")).unwrap();
            for (name, body) in [
                ("page.html", "<p>한글 페이지</p>"),
                ("other.htm", "<p>another</p>"),
                ("assets/style.css", "p{color:red}"),
                (".env", "SECRET=1"),
                (".git/config.json", "{}"),
                ("app.ts", "export {}"),
                ("private.csv", "private,data"),
                (".hidden.html", "hidden"),
            ] {
                std::fs::write(root.join(name), body).unwrap();
            }
            let mock = Arc::new(Mock::default());
            let server = PageServer::with_ttl(dir.path().join("state").join("page.port"), mock.clone(), lanes(), ttl);
            let port = server.origin().await.unwrap().rsplit(':').next().unwrap().parse().unwrap();
            Self { _dir: dir, root, server, mock, port }
        }

        async fn url(&self, rel: &str, scope: PageScope) -> String {
            self.server.lease_url(&self.root, rel, scope, None).await.unwrap()
        }

        async fn project(&self) -> String {
            self.url("page.html", PageScope::Project).await
        }

        async fn file(&self) -> String {
            self.url("page.html", file_scope()).await
        }

        fn host(&self) -> String {
            format!("127.0.0.1:{}", self.port)
        }

        /// The path part of one of this server's URLs.
        fn path_of(&self, url: &str) -> String {
            url.strip_prefix(&format!("http://127.0.0.1:{}", self.port)).unwrap().to_string()
        }

        /// A GET of `path` (default: the URL's own path).
        async fn get(&self, url: &str, path: Option<&str>) -> Reply {
            self.send("GET", url, path, Some(&self.host())).await
        }

        async fn send(&self, method: &str, url: &str, path: Option<&str>, host: Option<&str>) -> Reply {
            request(self.port, method, &path.map_or_else(|| self.path_of(url), str::to_string), host).await
        }
    }

    /// The path of `url` with its last segment replaced by `rel`.
    fn sibling(url: &str, rel: &str) -> String {
        let path = &url[url.find("//").unwrap() + 2..];
        let path = &path[path.find('/').unwrap()..];
        format!("{}/{rel}", &path[..path.rfind('/').unwrap()])
    }

    fn link_dir(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
                || std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().map(|o| o.status.success()).unwrap_or(false)
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    fn unlink_dir(link: &Path) {
        #[cfg(windows)]
        std::fs::remove_dir(link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(link).unwrap();
    }

    fn file_scope() -> PageScope {
        PageScope::File { grant_token: Some("granted".into()) }
    }

    #[test]
    fn percent_codecs_follow_the_uri_component_functions() {
        assert_eq!(percent_decode("a%20b%ED%95%9C"), Some("a b한".into()));
        assert_eq!(percent_decode("..%2fx"), Some("../x".into()));
        for bad in ["%zz", "%", "%2", "%+1", "%C3", "%ED%A0%80"] {
            assert_eq!(percent_decode(bad), None, "{bad}");
        }
        assert_eq!(percent_encode("my page(1)!~*'.-_한.html"), "my%20page(1)!~*'.-_%ED%95%9C.html");
        assert_eq!(percent_encode("a/b?c#d%"), "a%2Fb%3Fc%23d%25");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_page_and_its_relative_assets_are_served_from_an_unguessable_loopback_prefix() {
        let fx = Fx::new().await;
        let url = fx.project().await;
        let rest = url.strip_prefix(&format!("http://127.0.0.1:{}/", fx.port)).unwrap();
        let (token, tail) = rest.split_once('/').unwrap();
        assert_eq!(token.len(), 32);
        assert_eq!(tail, "page.html");
        let page = fx.get(&url, None).await;
        assert_eq!(page.status, 200);
        assert_eq!(page.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(page.text(), "<p>한글 페이지</p>");
        assert_eq!(page.header("content-length"), Some(page.body.len().to_string().as_str()));
        assert_eq!(page.header("cache-control"), Some("no-store"));
        assert_eq!(page.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(page.header("referrer-policy"), Some("no-referrer"));
        assert_eq!(page.header("content-security-policy"), None);
        assert_eq!(fx.get(&url, Some(&sibling(&url, "assets/style.css"))).await.status, 200);
        // A fresh invocation gets independent authority, even for the same page.
        let another = fx.url("assets/../page.html", PageScope::Project).await;
        assert_ne!(another, url);
        assert!(another.ends_with("/page.html"));
        assert_eq!(fx.get(&another, None).await.text(), page.text());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn newly_supported_web_asset_types_carry_their_content_type() {
        let fx = Fx::new().await;
        for (name, body) in [("app.webmanifest", "{}"), ("notes.md", "# hi"), ("model.glb", "glb"), ("model.bin", "buffers")] {
            std::fs::write(fx.root.join(name), body).unwrap();
        }
        let url = fx.project().await;
        for (name, mime) in [
            ("app.webmanifest", "application/manifest+json; charset=utf-8"),
            ("notes.md", "text/markdown; charset=utf-8"),
            ("model.glb", "model/gltf-binary"),
            ("model.bin", "application/octet-stream"),
        ] {
            assert_eq!(fx.get(&url, Some(&sibling(&url, name))).await.header("content-type"), Some(mime), "{name}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn nothing_hidden_outside_or_not_web_is_served_and_a_foreign_host_is_refused() {
        let fx = Fx::new().await;
        let url = fx.project().await;
        for rel in [".env", ".git/config.json", "app.ts", "..%2f..%2fpage.html", "missing.html", "%2fetc%2fpasswd", ".hidden.html"] {
            assert_eq!(fx.get(&url, Some(&sibling(&url, rel))).await.status, 404, "{rel}");
        }
        assert_eq!(fx.get(&url, Some("/wrong-token/page.html")).await.status, 404);
        assert_eq!(fx.get(&url, Some("/")).await.status, 404);
        assert_eq!(fx.get(&url, None).await.status, 200);
        // A DNS-rebound name pointing at loopback never reaches the files.
        for host in [Some("evil.example"), Some("127.0.0.1"), Some("localhost:1")] {
            assert_eq!(fx.send("GET", &url, None, host).await.status, 403, "{host:?}");
        }
        // No Host header at all (hyper may refuse such a request before it gets here): the server's own answer is a refusal too.
        assert_eq!(fx.server.respond(&Method::GET, None, &fx.path_of(&url), fx.port).await.status(), StatusCode::FORBIDDEN);
        let error = fx.server.lease_url(&fx.root.join("assets"), "../page.html", PageScope::Project, None).await.unwrap_err();
        assert!(error.message.contains("inside its folder"), "{}", error.message);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn directory_links_cannot_expose_hidden_or_outside_files_but_public_assets_load() {
        let fx = Fx::new().await;
        let outside = fx._dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("page.html"), "OUTSIDE").unwrap();
        let links = [("hidden-link", fx.root.join(".git")), ("outside-link", outside), ("assets-link", fx.root.join("assets"))];
        for (name, target) in &links {
            if !link_dir(&fx.root.join(name), target) {
                return;
            }
        }
        let url = fx.project().await;
        assert_eq!(fx.get(&url, Some(&sibling(&url, "hidden-link/config.json"))).await.status, 404);
        assert_eq!(fx.get(&url, Some(&sibling(&url, "outside-link/page.html"))).await.status, 404);
        let asset = fx.get(&url, Some(&sibling(&url, "assets-link/style.css"))).await;
        assert_eq!(asset.status, 200);
        assert_eq!(asset.header("content-type"), Some("text/css; charset=utf-8"));
        assert_eq!(asset.text(), "p{color:red}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_selected_page_serves_only_that_page_never_its_neighbours() {
        let fx = Fx::new().await;
        std::fs::write(fx.root.join("data.json"), "{\"a\":1}").unwrap();
        let url = fx.file().await;
        assert_eq!(fx.get(&url, None).await.status, 200);
        for rel in ["data.json", "assets/style.css", "other.htm", "../shared/style.css", "..%2fprivate.csv", "assets%2fstyle.css", "%2ehidden.html"] {
            assert_eq!(fx.get(&url, Some(&sibling(&url, rel))).await.status, 404, "{rel}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_sandboxed_page_carries_the_storage_shim_first_with_a_matching_length() {
        let fx = Fx::new().await;
        std::fs::write(fx.root.join("tabs.html"), "<!doctype html><html><head><title>탭</title></head><body><script>run()</script></body></html>").unwrap();
        let url = fx.url("tabs.html", file_scope()).await;
        let page = fx.get(&url, None).await;
        assert_eq!(page.status, 200);
        assert_eq!(page.header("content-security-policy"), Some("sandbox allow-scripts"));
        let text = page.text();
        assert!(text.find(SHIM_SOURCE).unwrap() < text.find("run()").unwrap());
        assert!(text.contains("<title>탭</title>"));
        assert_eq!(page.header("content-length").unwrap().parse::<usize>().unwrap(), page.body.len());
        let head = fx.send("HEAD", &url, None, Some(&fx.host())).await;
        assert_eq!(head.header("content-length").unwrap().parse::<usize>().unwrap(), page.body.len());
        assert!(head.body.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_folder_swapped_for_a_link_while_authorizing_cannot_serve_an_outside_file() {
        let fx = Fx::new().await;
        let outside = fx._dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.css"), "OUTSIDE").unwrap();
        std::fs::create_dir_all(fx.root.join("docs")).unwrap();
        std::fs::write(fx.root.join("docs/secret.css"), "INSIDE").unwrap();
        let url = fx.project().await;
        let docs = fx.root.join("docs");
        *fx.mock.hook.lock().unwrap() = Some(Box::new(move || {
            // Windows refuses to rename a folder holding an open file, which also stops the swap; elsewhere the swap happens.
            // Either way the file served is the one already open.
            if std::fs::rename(&docs, docs.with_file_name("docs-moved")).is_ok() {
                link_dir(&docs, &outside);
            }
        }));
        let asset = fx.get(&url, Some(&sibling(&url, "docs/secret.css"))).await;
        assert_eq!(asset.status, 200);
        assert_eq!(asset.text(), "INSIDE");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_sandboxed_page_is_rewritten_from_the_file_it_opened_not_from_what_later_sits_at_its_path() {
        let fx = Fx::new().await;
        let url = fx.file().await;
        let root = fx.root.clone();
        *fx.mock.hook.lock().unwrap() = Some(Box::new(move || {
            if std::fs::rename(root.join("page.html"), root.join("page-moved.html")).is_ok() {
                std::fs::write(root.join("page.html"), "<p>REPLACED</p>").unwrap();
            }
        }));
        let page = fx.get(&url, None).await;
        assert_eq!(page.status, 200);
        assert!(page.text().contains("한글 페이지"));
        assert!(!page.text().contains("REPLACED"));
        assert_eq!(page.header("content-length").unwrap().parse::<usize>().unwrap(), page.body.len());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_large_file_streams_whole_and_a_vanished_client_releases_the_handle() {
        let fx = Fx::new().await;
        let big = vec![b'a'; 3 * CHUNK as usize + 5];
        std::fs::write(fx.root.join("big.css"), &big).unwrap();
        let url = fx.project().await;
        let reply = fx.get(&url, Some(&sibling(&url, "big.css"))).await;
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, big);
        // The task that feeds a body ends, and drops the file, when the body is dropped.
        let file = Arc::new(File::open(fx.root.join("big.css")).unwrap());
        let (send, receive) = mpsc::channel(2);
        let task = tokio::spawn(pump(lanes(), file.clone(), big.len() as u64, send));
        drop(receive);
        task.await.unwrap();
        assert_eq!(Arc::strong_count(&file), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_file_that_shrank_fails_its_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("short.css");
        std::fs::write(&path, "abc").unwrap();
        let (send, mut receive) = mpsc::channel(4);
        tokio::spawn(pump(lanes(), Arc::new(File::open(&path).unwrap()), 10, send));
        assert_eq!(receive.recv().await.unwrap().unwrap(), Bytes::from("abc"));
        assert_eq!(receive.recv().await.unwrap().unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        assert!(receive.recv().await.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn lease_expiry_is_absolute_rather_than_extended_by_traffic() {
        let fx = Fx::with_ttl(Duration::from_millis(900)).await;
        let url = fx.project().await;
        assert_eq!(fx.get(&url, None).await.status, 200);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(fx.get(&url, None).await.status, 200);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(fx.get(&url, None).await.status, 404);
        let fresh = fx.project().await;
        assert_eq!(fx.get(&fresh, None).await.status, 200);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_bounded_table_refreshes_on_an_authorized_get_or_head_not_on_issuance_order() {
        for method in ["GET", "HEAD"] {
            let fx = Fx::new().await;
            let mut urls = Vec::new();
            for _ in 0..MAX_LOCAL_PAGE_LEASES {
                urls.push(fx.file().await);
            }
            assert_eq!(fx.send(method, &urls[0], None, Some(&fx.host())).await.status, 200);
            let newest = fx.file().await;
            assert_eq!(fx.get(&urls[0], None).await.status, 200, "a recently used old URL survives ({method})");
            assert_eq!(fx.get(&urls[1], None).await.status, 404, "the least recently used URL is evicted ({method})");
            assert_eq!(fx.get(&newest, None).await.status, 200);
            assert_eq!(fx.get(&newest, Some(&sibling(&newest, "private.csv"))).await.status, 404);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn denied_paths_and_transient_authorization_errors_cannot_refresh_lru() {
        let fx = Fx::new().await;
        let oldest = fx.file().await;
        for _ in 1..MAX_LOCAL_PAGE_LEASES {
            fx.file().await;
        }
        assert_eq!(fx.get(&oldest, Some(&sibling(&oldest, "private.csv"))).await.status, 404);
        assert_eq!(fx.get(&oldest, Some(&sibling(&oldest, "%zz"))).await.status, 400);
        assert_eq!(fx.send("POST", &oldest, None, Some(&fx.host())).await.status, 405);
        assert_eq!(fx.send("GET", &oldest, None, Some("evil.example")).await.status, 403);
        fx.mock.refuse_with(Some(Refusal::Transient));
        assert_eq!(fx.get(&oldest, None).await.status, 503);
        fx.mock.refuse_with(None);
        fx.file().await;
        assert_eq!(fx.get(&oldest, None).await.status, 404);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn authorization_after_expiry_owner_closure_or_eviction_cannot_revive_the_lease() {
        for cause in ["expiry", "owner closure", "capacity eviction"] {
            for fails in [false, true] {
                let fx = Fx::with_ttl(Duration::from_millis(1500)).await;
                let url = fx.server.lease_url(&fx.root, "page.html", file_scope(), Some("w1".into())).await.unwrap();
                let gate = fx.mock.gate();
                *gate.outcome.lock().unwrap() = fails.then_some(Refusal::Transient);
                let (port, path, host) = (fx.port, fx.path_of(&url), fx.host());
                let pending = tokio::spawn(async move { request(port, "GET", &path, Some(&host)).await });
                gate.entered.notified().await;
                match cause {
                    "expiry" => tokio::time::sleep(Duration::from_millis(1700)).await,
                    "owner closure" => fx.server.revoke_owner("w1"),
                    _ => {
                        for _ in 0..MAX_LOCAL_PAGE_LEASES {
                            fx.server.lease_url(&fx.root, "page.html", file_scope(), None).await.unwrap();
                        }
                    }
                }
                gate.release.notify_one();
                assert_eq!(pending.await.unwrap().status, 404, "{cause} {fails}");
                assert_eq!(fx.get(&url, None).await.status, 404, "{cause} {fails}");
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_parallel_definite_denial_wins_over_an_older_successful_authorization() {
        let fx = Fx::new().await;
        let url = fx.file().await;
        let gate = fx.mock.gate();
        let (port, path, host) = (fx.port, fx.path_of(&url), fx.host());
        let pending = tokio::spawn(async move { request(port, "GET", &path, Some(&host)).await });
        gate.entered.notified().await;
        fx.mock.refuse_with(Some(Refusal::Denied));
        assert_eq!(fx.get(&url, None).await.status, 404);
        gate.release.notify_one();
        assert_eq!(pending.await.unwrap().status, 404);
        fx.mock.refuse_with(None);
        assert_eq!(fx.get(&url, None).await.status, 404);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn head_malformed_encoding_and_methods_keep_the_same_boundary() {
        let fx = Fx::new().await;
        let url = fx.file().await;
        let head = fx.send("HEAD", &url, None, Some(&fx.host())).await;
        assert_eq!(head.status, 200);
        assert!(head.body.is_empty());
        assert!(head.header("content-length").unwrap().parse::<usize>().unwrap() > 0);
        assert_eq!(fx.send("HEAD", &url, Some(&sibling(&url, "private.csv")), Some(&fx.host())).await.status, 404);
        assert_eq!(fx.get(&url, Some(&sibling(&url, "%zz"))).await.status, 400);
        for method in ["POST", "PUT", "DELETE", "OPTIONS"] {
            assert_eq!(fx.send(method, &url, None, Some(&fx.host())).await.status, 405, "{method}");
        }
        assert_eq!(fx.get(&url, Some(&format!("{}?a=1#b", fx.path_of(&url)))).await.status, 200);
        assert_eq!(fx.get(&url, Some(&sibling(&url, "other.htm"))).await.status, 404);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_lookup_is_503_and_keeps_the_url_a_denial_does_not() {
        let fx = Fx::new().await;
        let url = fx.file().await;
        fx.mock.refuse_with(Some(Refusal::Transient));
        let busy = fx.get(&url, None).await;
        assert_eq!(busy.status, 503);
        assert_eq!(busy.text(), "503");
        assert_eq!(busy.header("cache-control"), Some("no-store"));
        assert_eq!(busy.header("content-type"), Some("text/plain; charset=utf-8"));
        fx.mock.refuse_with(None);
        assert_eq!(fx.get(&url, None).await.status, 200, "recovery must not need a new URL");
        fx.mock.refuse_with(Some(Refusal::Denied));
        assert_eq!(fx.get(&url, None).await.status, 404);
        fx.mock.refuse_with(None);
        assert_eq!(fx.get(&url, None).await.status, 404, "a definite denial stays revoked after recovery");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_retargeted_alias_invalidates_the_pinned_url_and_a_transient_failure_keeps_it() {
        let fx = Fx::new().await;
        let other = fx._dir.path().join("other-site");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("page.html"), "<p>other</p>").unwrap();
        let alias = fx._dir.path().join("alias");
        if !link_dir(&alias, &other) {
            return;
        }
        let url = fx.server.lease_url(&alias, "page.html", file_scope(), None).await.unwrap();
        assert_eq!(fx.get(&url, None).await.status, 200);
        unlink_dir(&alias);
        assert_eq!(fx.get(&url, None).await.status, 503, "the canonical file exists but cannot be resolved through its alias");
        assert!(link_dir(&alias, &other));
        assert_eq!(fx.get(&url, None).await.status, 200);
        unlink_dir(&alias);
        assert!(link_dir(&alias, &fx.root));
        assert_eq!(fx.get(&url, None).await.status, 404);
        unlink_dir(&alias);
        assert!(link_dir(&alias, &other));
        assert_eq!(fx.get(&url, None).await.status, 404, "restoring a denied alias must not revive its old URL");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_page_replaced_in_place_stays_served() {
        let fx = Fx::new().await;
        let url = fx.file().await;
        std::fs::write(fx.root.join("replacement.tmp"), "<p>updated</p>").unwrap();
        std::fs::rename(fx.root.join("replacement.tmp"), fx.root.join("page.html")).unwrap();
        assert!(fx.get(&url, None).await.text().contains("<p>updated</p>"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn only_visible_html_inside_the_folder_gets_a_lease_and_the_authority_decides_the_rest() {
        let fx = Fx::new().await;
        for rel in [".hidden.html", "private.csv", "assets/style.css", "../site/../x.html"] {
            let error = fx.server.lease_url(&fx.root, rel, PageScope::Project, None).await.unwrap_err();
            assert!(error.message.contains("visible HTML"), "{rel}: {}", error.message);
        }
        std::fs::create_dir_all(fx.root.join(".private")).unwrap();
        std::fs::write(fx.root.join(".private/page.html"), "secret").unwrap();
        if link_dir(&fx.root.join("alias"), &fx.root.join(".private")) {
            let error = fx.server.lease_url(&fx.root, "alias/page.html", PageScope::Project, None).await.unwrap_err();
            assert!(error.message.contains("visible HTML"));
        }
        let calls = fx.mock.calls.load(Ordering::SeqCst);
        fx.mock.refuse_with(Some(Refusal::Denied));
        let error = fx.server.lease_url(&fx.root, "page.html", PageScope::Project, None).await.unwrap_err();
        assert_eq!(error.reason.code(), DENIED_CODE);
        fx.mock.refuse_with(Some(Refusal::Transient));
        assert!(fx.server.lease_url(&fx.root, "page.html", PageScope::Project, None).await.is_err());
        assert_eq!(fx.mock.calls.load(Ordering::SeqCst), calls + 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closing_a_window_revokes_only_its_urls() {
        let fx = Fx::new().await;
        let first = fx.server.lease_url(&fx.root, "page.html", file_scope(), Some("w1".into())).await.unwrap();
        let second = fx.server.lease_url(&fx.root, "page.html", file_scope(), Some("w2".into())).await.unwrap();
        let third = fx.server.lease_url(&fx.root, "page.html", file_scope(), Some("w1".into())).await.unwrap();
        fx.server.revoke_owner("w1");
        assert_eq!(fx.get(&first, None).await.status, 404);
        assert_eq!(fx.get(&third, None).await.status, 404);
        assert_eq!(fx.get(&second, None).await.status, 200);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_url_encodes_each_segment_and_the_port_is_remembered() {
        let fx = Fx::new().await;
        std::fs::create_dir_all(fx.root.join("my dir")).unwrap();
        std::fs::write(fx.root.join("my dir/한 page#1.html"), "<p>x</p>").unwrap();
        let url = fx.url("my dir\\한 page#1.html", PageScope::Project).await;
        assert!(url.ends_with("/my%20dir/%ED%95%9C%20page%231.html"), "{url}");
        assert_eq!(fx.get(&url, None).await.status, 200);
        let port_file = fx._dir.path().join("state").join("page.port");
        assert_eq!(crate::pageserver::ports::read_port_file(&port_file), Some(fx.port));
        assert_eq!(fx.server.origin().await.unwrap(), format!("http://127.0.0.1:{}", fx.port));
    }
}
