//! Virtual pages (`local-page-server.ts` `localVirtualPageUrl`): a page held in memory (`index.html` plus any sibling files), served like a
//! single-file grant (its own lease, scripts allowed in an opaque origin, only the named files) and read from nothing on disk.

use std::collections::BTreeMap;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hyper::header::HeaderValue;

use crate::error::{WsError, WsResult};

/// The page every virtual lease is opened on.
pub const INDEX: &str = "index.html";

/// One in-memory file of a virtual page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VirtualFile {
    pub bytes: Arc<[u8]>,
    pub content_type: String,
}

impl VirtualFile {
    /// An HTML document gets the storage shim, as the page of any sandboxed lease does.
    pub(super) fn is_html(&self) -> bool {
        self.content_type.trim_start().to_ascii_lowercase().starts_with("text/html")
    }
}

/// One entry of the `projectFs/localPage/virtual` request: `path`, its content as `data_base64` or as `text` (UTF-8), and its `type`.
#[derive(Clone, Debug)]
pub struct VirtualFileInput {
    pub path: String,
    pub data_base64: Option<String>,
    pub text: Option<String>,
    pub content_type: String,
}

/// A path a request can name: `/`-separated plain segments, none empty, `.` or `..`.
fn valid_path(path: &str) -> bool {
    !path.is_empty() && !path.contains('\\') && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

/// The file map of a virtual lease. `index.html` is required; a path twice, content given twice or not at all, or a content type that
/// cannot be a header value is an error.
pub fn build_files(entries: impl IntoIterator<Item = VirtualFileInput>) -> WsResult<Arc<BTreeMap<String, VirtualFile>>> {
    let mut files = BTreeMap::new();
    for entry in entries {
        if !valid_path(&entry.path) {
            return Err(WsError::invalid(format!("'{}' is not a path inside a virtual page.", entry.path)));
        }
        let bytes = match (entry.data_base64, entry.text) {
            (Some(data), None) => STANDARD.decode(data.trim()).map_err(|_| WsError::invalid(format!("'{}' has invalid base64 content.", entry.path)))?,
            (None, Some(text)) => text.into_bytes(),
            _ => return Err(WsError::invalid(format!("'{}' needs exactly one of dataBase64 and text.", entry.path))),
        };
        if HeaderValue::from_str(&entry.content_type).is_err() {
            return Err(WsError::invalid(format!("'{}' has an invalid content type.", entry.path)));
        }
        let file = VirtualFile { bytes: bytes.into(), content_type: entry.content_type };
        if files.insert(entry.path.clone(), file).is_some() {
            return Err(WsError::invalid(format!("'{}' is listed twice.", entry.path)));
        }
    }
    if !files.contains_key(INDEX) {
        return Err(WsError::invalid("A virtual page needs an index.html."));
    }
    Ok(Arc::new(files))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use async_trait::async_trait;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    use super::*;
    use crate::lanes::Lanes;
    use crate::pageserver::lease::{MAX_LOCAL_PAGE_LEASES, PageScope};
    use crate::pageserver::serve::{PageAuthority, PageServer, Refusal};
    use crate::pageserver::shim::SHIM_SOURCE;

    #[derive(Default)]
    struct Mock {
        refusal: Mutex<Option<Refusal>>,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl PageAuthority for Mock {
        async fn check(&self, scope: &PageScope, _absolute: &Path) -> Result<(), Refusal> {
            assert!(matches!(scope, PageScope::Virtual { .. }));
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.refusal.lock().unwrap().map_or(Ok(()), Err)
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

    async fn request(port: u16, method: &str, path: &str) -> Reply {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let split = raw.windows(4).position(|window| window == b"\r\n\r\n").expect("a response head");
        let head = String::from_utf8_lossy(&raw[..split]).into_owned();
        let mut lines = head.lines();
        let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
        let headers = lines.filter_map(|line| line.split_once(':')).map(|(name, value)| (name.trim().to_lowercase(), value.trim().to_string())).collect();
        Reply { status, headers, body: raw[split + 4..].to_vec() }
    }

    fn input(path: &str, content_type: &str, text: &str) -> VirtualFileInput {
        VirtualFileInput { path: path.into(), data_base64: None, text: Some(text.into()), content_type: content_type.into() }
    }

    fn page_files() -> Arc<BTreeMap<String, VirtualFile>> {
        build_files([
            input("index.html", "text/html; charset=utf-8", "<body><script>x()</script></body>"),
            input("app.js", "text/javascript; charset=utf-8", "window.a=1"),
        ])
        .unwrap()
    }

    struct Fx {
        _dir: tempfile::TempDir,
        server: Arc<PageServer>,
        mock: Arc<Mock>,
        port: u16,
    }

    impl Fx {
        async fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let mock = Arc::new(Mock::default());
            let server = PageServer::new(dir.path().join("state").join("page.port"), mock.clone(), lanes());
            let port = server.origin().await.unwrap().rsplit(':').next().unwrap().parse().unwrap();
            Self { _dir: dir, server, mock, port }
        }

        async fn url(&self, owner: Option<&str>) -> String {
            self.server.lease_virtual(page_files(), owner.map(str::to_string)).await.unwrap()
        }

        fn path_of(&self, url: &str) -> String {
            url.strip_prefix(&format!("http://127.0.0.1:{}", self.port)).unwrap().to_string()
        }

        async fn get(&self, url: &str) -> Reply {
            request(self.port, "GET", &self.path_of(url)).await
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_html_document_gets_the_shim_and_other_files_do_not() {
        let fx = Fx::new().await;
        let url = fx.url(None).await;
        assert!(url.ends_with("/index.html"));
        let page = fx.get(&url).await;
        assert_eq!(page.status, 200);
        assert_eq!(page.headers["content-security-policy"], "sandbox allow-scripts");
        assert_eq!(page.headers["content-type"], "text/html; charset=utf-8");
        assert_eq!(page.headers["cache-control"], "no-store");
        assert_eq!(page.headers["x-content-type-options"], "nosniff");
        assert_eq!(page.headers["referrer-policy"], "no-referrer");
        let body = String::from_utf8(page.body).unwrap();
        assert!(body.contains(SHIM_SOURCE));
        assert_eq!(page.headers["content-length"].parse::<usize>().unwrap(), body.len());
        let script = fx.get(&format!("{}app.js", &url[..url.len() - "index.html".len()])).await;
        assert_eq!(script.status, 200);
        assert_eq!(script.headers["content-security-policy"], "sandbox allow-scripts");
        assert_eq!(script.body, b"window.a=1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn only_the_named_files_are_served_and_head_has_no_body() {
        let fx = Fx::new().await;
        let url = fx.url(None).await;
        let base = &url[..url.len() - "index.html".len()];
        assert_eq!(fx.get(&format!("{base}missing.js")).await.status, 404);
        assert_eq!(fx.get(&format!("{base}..%2Findex.html")).await.status, 404);
        assert_eq!(fx.get(&format!("{base}%zz")).await.status, 400);
        assert_eq!(request(fx.port, "POST", &fx.path_of(&url)).await.status, 405);
        let head = request(fx.port, "HEAD", &fx.path_of(&url)).await;
        assert_eq!(head.status, 200);
        assert!(head.body.is_empty());
        let page = fx.get(&url).await;
        assert_eq!(head.headers["content-length"], page.headers["content-length"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_authority_is_asked_again_for_every_response_and_a_denial_revokes() {
        let fx = Fx::new().await;
        let url = fx.url(None).await;
        let made = fx.mock.calls.load(Ordering::SeqCst);
        assert!(made >= 1);
        fx.get(&url).await;
        assert_eq!(fx.mock.calls.load(Ordering::SeqCst), made + 1);
        *fx.mock.refusal.lock().unwrap() = Some(Refusal::Transient);
        assert_eq!(fx.get(&url).await.status, 503);
        *fx.mock.refusal.lock().unwrap() = None;
        assert_eq!(fx.get(&url).await.status, 200);
        *fx.mock.refusal.lock().unwrap() = Some(Refusal::Denied);
        assert_eq!(fx.get(&url).await.status, 404);
        *fx.mock.refusal.lock().unwrap() = None;
        assert_eq!(fx.get(&url).await.status, 404);
        assert!(fx.server.lease_virtual(page_files(), None).await.is_ok());
        *fx.mock.refusal.lock().unwrap() = Some(Refusal::Denied);
        assert!(fx.server.lease_virtual(page_files(), None).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closing_the_owner_revokes_and_capacity_drops_the_least_recently_used() {
        let fx = Fx::new().await;
        let owned = fx.url(Some("w1")).await;
        let other = fx.url(Some("w2")).await;
        fx.server.revoke_owner("w1");
        assert_eq!(fx.get(&owned).await.status, 404);
        assert_eq!(fx.get(&other).await.status, 200);
        // `other` was used before every lease made from here on, so it is the one dropped when the table is full.
        let next = fx.url(None).await;
        for _ in 0..MAX_LOCAL_PAGE_LEASES - 2 {
            fx.url(None).await;
        }
        assert_eq!(fx.get(&next).await.status, 200);
        fx.url(None).await;
        assert_eq!(fx.get(&other).await.status, 404);
        assert_eq!(fx.get(&next).await.status, 200);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_lease_expires_after_its_ttl() {
        let dir = tempfile::tempdir().unwrap();
        let server = PageServer::with_ttl(dir.path().join("page.port"), Arc::new(Mock::default()), lanes(), Duration::from_millis(400));
        let port: u16 = server.origin().await.unwrap().rsplit(':').next().unwrap().parse().unwrap();
        let url = server.lease_virtual(page_files(), None).await.unwrap();
        let path = url.strip_prefix(&format!("http://127.0.0.1:{port}")).unwrap().to_string();
        assert_eq!(request(port, "GET", &path).await.status, 200);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(request(port, "GET", &path).await.status, 404);
    }

    #[test]
    fn files_are_checked_when_the_page_is_made() {
        let ok = || input("index.html", "text/html", "x");
        assert!(build_files([input("a.js", "text/javascript", "x")]).is_err());
        for path in ["", "/index.html", "a//b", "../x", "a/./b", "a\\b"] {
            assert!(build_files([ok(), input(path, "text/plain", "x")]).is_err(), "{path}");
        }
        assert!(build_files([ok(), ok()]).is_err());
        assert!(build_files([ok(), input("a.txt", "bad\nvalue", "x")]).is_err());
        let both = VirtualFileInput { data_base64: Some("eA==".into()), ..ok() };
        assert!(build_files([both]).is_err());
        let neither = VirtualFileInput { text: None, ..ok() };
        assert!(build_files([neither]).is_err());
        let binary = VirtualFileInput { path: "d.bin".into(), data_base64: Some("AAEC/w==".into()), text: None, content_type: "application/wasm".into() };
        let files = build_files([ok(), binary, input("sub/x.css", "text/css", "p{}")]).unwrap();
        assert_eq!(&*files["d.bin"].bytes, &[0, 1, 2, 255]);
        assert!(files["index.html"].is_html());
        assert!(!files["sub/x.css"].is_html());
        assert!(build_files([VirtualFileInput { data_base64: Some("!!".into()), text: None, ..ok() }]).is_err());
    }
}
