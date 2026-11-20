//! A GET of one public address that never follows a redirect: Node's
//! `pinnedFetch(url, { headers, redirect: 'manual' })` behind `assertPublicUrl(url)`, as the media
//! downloads make it. The address rules are the web tools' own (`ssrf::AddressPolicy::PublicOnly`)
//! and the connection is made through the daemon's single [`RoutedClients`]: the client is its
//! direct client of the `public-get` flavour, whose name resolver validates every address it
//! returns, so the address dialled is one the policy allowed and no second lookup can change it.
//!
//! Like Node's pinned agent it never uses a proxy, and a 3xx answer is returned as it is: its
//! `Location` is the caller's to check (the next hop goes through [`PublicGet::get`] again).

use std::sync::Arc;

use mixdog_ai::netproxy::RoutedClients;
use reqwest::header::ACCEPT;
use reqwest::header::ACCEPT_LANGUAGE;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderValue;
use reqwest::header::USER_AGENT;
use url::Url;

use super::error::FetchError;
use super::error::LookupFailure;
use super::lanes::WebLanes;
use super::ssrf::AddressPolicy;
use super::ssrf::PolicyResolver;

/// The name of this client among the daemon's direct clients.
const FLAVOUR: &str = "public-get";

/// Why a request was not made or did not complete. Each variant is a kind of failure, not text:
/// the caller words it (the media fetch as Node's media path does, a web tool as its own).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublicError {
    /// The address does not parse (`new URL` throws `Invalid URL`, code `ERR_INVALID_URL`).
    InvalidUrl,
    /// The guard's own words: a refused protocol, credentials or address, an empty lookup.
    Refused(String),
    /// A name lookup failed for a reason other than "no addresses".
    Lookup { code: String, host: String },
    /// Any other failure of the connection or the request.
    FetchFailed,
    /// The body was cut short.
    Terminated,
    /// The client could not be built; nothing was sent.
    Client(String),
}

impl PublicError {
    /// The `code` of Node's error: only an unparsable address has one.
    pub fn code(&self) -> Option<&'static str> {
        matches!(self, Self::InvalidUrl).then_some("ERR_INVALID_URL")
    }
}

impl From<FetchError> for PublicError {
    fn from(error: FetchError) -> Self {
        match error.lookup {
            Some(LookupFailure { code, host }) => Self::Lookup { code, host },
            None => Self::Refused(error.message),
        }
    }
}

/// `assertPublicUrl(url)`: the address must parse, be http(s), carry no credentials and not be a
/// private or local one (a name is checked again, address by address, where it is resolved).
fn guard_url(policy: AddressPolicy, text: &str) -> Result<Url, PublicError> {
    let url = Url::parse(text).map_err(|_| PublicError::InvalidUrl)?;
    policy.check_url(&url)?;
    Ok(url)
}

/// The text of a header value as the fetch API shows it: each byte one character.
fn latin1(value: &HeaderValue) -> String {
    value.as_bytes().iter().map(|&byte| char::from(byte)).collect()
}

pub struct PublicGet {
    clients: Arc<RoutedClients>,
    lanes: WebLanes,
    policy: AddressPolicy,
}

impl PublicGet {
    /// `lanes.dns` runs the name lookups of the guard.
    pub fn new(clients: Arc<RoutedClients>, lanes: WebLanes) -> Self {
        Self::with_policy(clients, lanes, AddressPolicy::PublicOnly)
    }

    fn with_policy(clients: Arc<RoutedClients>, lanes: WebLanes, policy: AddressPolicy) -> Self {
        Self { clients, lanes, policy }
    }

    /// The headers a Node fetch sends unasked (undici's), then the redirect rule and the guarded
    /// resolver of this client.
    fn client(&self) -> Result<reqwest::Client, PublicError> {
        let (policy, lanes) = (self.policy, self.lanes);
        self.clients
            .direct_flavour(FLAVOUR, move || {
                let mut defaults = HeaderMap::new();
                defaults.insert(USER_AGENT, HeaderValue::from_static("undici"));
                defaults.insert(ACCEPT, HeaderValue::from_static("*/*"));
                defaults.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("*"));
                defaults.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
                reqwest::Client::builder()
                    .default_headers(defaults)
                    .dns_resolver(Arc::new(PolicyResolver(policy, lanes)))
                    .redirect(reqwest::redirect::Policy::none())
                    .no_proxy()
                    .build()
            })
            .map_err(|error| PublicError::Client(error.to_string()))
    }

    /// Sends the GET and returns the answer once its head has arrived. Dropping the future
    /// abandons the request.
    pub async fn get(&self, url: &str, headers: &[(String, String)]) -> Result<PublicReply, PublicError> {
        let url = guard_url(self.policy, url)?;
        let mut request = self.client()?.get(url);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|error| send_failure(&error))?;
        Ok(PublicReply { response })
    }
}

/// A refusal or lookup failure made while connecting (the resolver's) keeps its kind; any other
/// failure is the fetch API's `fetch failed`.
fn send_failure(error: &reqwest::Error) -> PublicError {
    let mut cause = std::error::Error::source(error);
    while let Some(inner) = cause {
        if let Some(typed) = inner.downcast_ref::<FetchError>() {
            return PublicError::from(typed.clone());
        }
        cause = inner.source();
    }
    PublicError::FetchFailed
}

/// One answer: its status and headers, then its body in pieces.
pub struct PublicReply {
    response: reqwest::Response,
}

impl PublicReply {
    pub fn status(&self) -> u16 {
        self.response.status().as_u16()
    }

    /// `response.headers.get(name)`: several values are joined by `, `.
    pub fn header(&self, name: &str) -> Option<String> {
        let values: Vec<String> = self.response.headers().get_all(name).iter().map(latin1).collect();
        (!values.is_empty()).then(|| values.join(", "))
    }

    /// `response.body` is not null: a body-less status has none.
    pub fn has_body(&self) -> bool {
        !matches!(self.status(), 101 | 204 | 205 | 304)
    }

    /// The next piece of the body; `None` at its end. A body cut short is the fetch API's
    /// `terminated`.
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, PublicError> {
        match self.response.chunk().await {
            Ok(piece) => Ok(piece.map(|bytes| bytes.to_vec())),
            Err(_) => Err(PublicError::Terminated),
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_ai::netproxy::NetworkProxy;
    use mixdog_ai::netproxy::ProcessEnv;
    use mixdog_ai::netproxy::SystemProxy;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;
    use wiremock::matchers::any;
    use wiremock::matchers::path;

    use super::super::gai::LookupError;
    use super::super::gai::LookupKind;
    use super::super::ssrf::lookup_failure;
    use super::*;

    fn lanes() -> WebLanes {
        let tokens = mixdog_rt::testing::tokens();
        WebLanes { extract: tokens.cpu_interactive, dns: tokens.interactive_io }
    }

    fn clients() -> Arc<RoutedClients> {
        let policy = NetworkProxy::new(Arc::new(ProcessEnv), SystemProxy::default());
        Arc::new(RoutedClients::new(policy, |_| reqwest::Client::builder().build()))
    }

    /// Loopback allowed: the fake servers of these tests are on it.
    fn open() -> PublicGet {
        PublicGet::with_policy(clients(), lanes(), AddressPolicy::AnyForTest)
    }

    fn public() -> PublicGet {
        PublicGet::new(clients(), lanes())
    }

    /// The words the media path gives each kind of failure.
    fn said(error: &PublicError) -> String {
        match error {
            PublicError::InvalidUrl => "Invalid URL".to_owned(),
            PublicError::Refused(words) | PublicError::Client(words) => words.clone(),
            PublicError::Lookup { code, host } => format!("getaddrinfo {code} {host}"),
            PublicError::FetchFailed => "fetch failed".to_owned(),
            PublicError::Terminated => "terminated".to_owned(),
        }
    }

    async fn drain(reply: &mut PublicReply) -> Result<Vec<u8>, PublicError> {
        let mut body = Vec::new();
        while let Some(piece) = reply.chunk().await? {
            body.extend_from_slice(&piece);
        }
        Ok(body)
    }

    #[tokio::test]
    async fn a_refused_address_is_never_connected_to() {
        let server = MockServer::start().await;
        Mock::given(any()).respond_with(ResponseTemplate::new(200)).mount(&server).await;
        let port = server.address().port();
        let guard = public();
        let literal = guard.get(&format!("http://127.0.0.1:{port}/"), &[]).await.err().unwrap();
        assert_eq!(said(&literal), "Blocked request to private address: 127.0.0.1");
        let invalid = guard.get("not a url", &[]).await.err().unwrap();
        assert_eq!((invalid.clone(), said(&invalid).as_str(), invalid.code()), (PublicError::InvalidUrl, "Invalid URL", Some("ERR_INVALID_URL")));
        // A name the URL rules pass is refused where it is resolved, before any connection: the
        // client itself (the URL check skipped) validates the address it is about to dial.
        let sent = guard.client().unwrap().get(format!("http://localhost:{port}/")).send().await.unwrap_err();
        let named = send_failure(&sent);
        assert!(said(&named).starts_with("Blocked request to private address: "), "{named:?}");
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[test]
    fn an_address_that_is_not_public_is_refused_in_every_spelling_of_it() {
        let blocked = |url: &str, shown: &str| {
            let got = guard_url(AddressPolicy::PublicOnly, url).expect_err(url);
            assert_eq!((said(&got).as_str(), got.code()), (format!("Blocked request to private address: {shown}").as_str(), None), "{url}");
        };
        for (url, shown) in [
            ("http://localhost/", "localhost"),
            ("http://LOCALHOST:8080/x", "localhost"),
            ("https://localhost:3000", "localhost"),
            ("http://127.0.0.1/", "127.0.0.1"),
            ("http://127.255.255.254/", "127.255.255.254"),
            ("http://10.0.0.1/", "10.0.0.1"),
            ("http://0.0.0.0/", "0.0.0.0"),
            ("http://172.16.0.1/", "172.16.0.1"),
            ("http://172.31.255.255/", "172.31.255.255"),
            ("http://192.168.0.1/", "192.168.0.1"),
            ("http://169.254.169.254/latest/meta-data/", "169.254.169.254"),
            ("http://100.64.0.1/", "100.64.0.1"),
            ("http://100.127.255.255/", "100.127.255.255"),
            ("http://198.18.0.1/", "198.18.0.1"),
            ("http://192.0.2.1/", "192.0.2.1"),
            ("http://198.51.100.1/", "198.51.100.1"),
            ("http://203.0.113.1/", "203.0.113.1"),
            ("http://224.0.0.1/", "224.0.0.1"),
            ("http://240.0.0.1/", "240.0.0.1"),
            ("http://255.255.255.255/", "255.255.255.255"),
            // The same loopback and private addresses spelled as one number, in hex, in octal or short.
            ("http://2130706433/", "127.0.0.1"),
            ("http://0x7f.0.0.1/", "127.0.0.1"),
            ("http://0x7f000001/", "127.0.0.1"),
            ("http://127.1/", "127.0.0.1"),
            ("http://017700000001/", "127.0.0.1"),
            ("http://0177.0.0.1/", "127.0.0.1"),
            ("http://3232235521/", "192.168.0.1"),
            ("http://[::1]/", "[::1]"),
            ("http://[::]/", "[::]"),
            ("http://[0:0:0:0:0:0:0:1]/", "[::1]"),
            ("http://[fe80::1]/", "[fe80::1]"),
            ("http://[febf::1]/", "[febf::1]"),
            ("http://[fec0::1]/", "[fec0::1]"),
        ] {
            blocked(url, shown);
        }
    }

    #[test]
    fn a_public_address_or_name_is_allowed_including_the_neighbours_of_every_blocked_range() {
        for url in [
            "https://example.com/a.png",
            "http://example.com:8080/x?y=1#z",
            "https://EXAMPLE.com/",
            "http://8.8.8.8/",
            "https://1.1.1.1/dns-query",
            "http://[2606:4700:4700::1111]/",
            "http://[2001:4860:4860::8888]:443/",
            "http://foo.localhost/",
            "http://notlocalhost/",
            "http://172.15.255.255/",
            "http://172.32.0.1/",
            "http://192.167.0.1/",
            "http://169.253.0.1/",
            "http://100.63.255.255/",
            "http://100.128.0.1/",
            "http://198.17.255.255/",
            "http://198.20.0.1/",
            "http://203.0.114.1/",
            "http://223.255.255.255/",
            "http://134744072/",
            "http://[fe7f::1]/",
            "http://[fb00::1]/",
            "http://[2606:4700::1111]/",
            "http://[::ffff:8.8.8.8]/",
        ] {
            let got = guard_url(AddressPolicy::PublicOnly, url);
            assert!(got.is_ok(), "{url}: {got:?}");
        }
    }

    #[test]
    fn a_url_that_is_not_http_or_carries_credentials_is_refused_before_any_address_is_considered() {
        for (url, scheme) in [
            ("ftp://example.com/file", "ftp:"),
            ("file:///etc/passwd", "file:"),
            ("data:text/plain,hello", "data:"),
            ("javascript:alert(1)", "javascript:"),
            ("ws://example.com/", "ws:"),
        ] {
            let got = guard_url(AddressPolicy::PublicOnly, url).expect_err(url);
            assert_eq!(said(&got), format!("Blocked non-HTTP protocol: {scheme}"), "{url}");
        }
        for (url, host) in [
            ("http://user:pass@example.com/", "example.com"),
            ("https://user@example.com/", "example.com"),
            ("http://:pw@example.com/", "example.com"),
            ("http://user@localhost/", "localhost"),
        ] {
            let got = guard_url(AddressPolicy::PublicOnly, url).expect_err(url);
            assert_eq!(said(&got), format!("Blocked URL with userinfo credentials: {host}"), "{url}");
        }
    }

    #[test]
    fn a_name_that_resolves_to_any_non_public_address_is_refused_whole() {
        let ips = |list: &[&str]| list.iter().map(|a| a.parse::<std::net::IpAddr>().unwrap()).collect::<Vec<_>>();
        for list in [&["8.8.8.8"][..], &["8.8.8.8", "1.1.1.1"], &["2606:4700::1111"], &["8.8.8.8", "2606:4700::1111"]] {
            assert_eq!(AddressPolicy::PublicOnly.validate_resolved("media.example.com", &ips(list)).unwrap().len(), list.len());
        }
        for (list, shown) in [
            (&["8.8.8.8", "10.0.0.5"][..], "10.0.0.5"),
            (&["10.0.0.5", "8.8.8.8"], "10.0.0.5"),
            (&["127.0.0.1"], "127.0.0.1"),
            (&["169.254.169.254"], "169.254.169.254"),
            (&["100.64.0.1"], "100.64.0.1"),
            (&["0.0.0.0"], "0.0.0.0"),
            (&["8.8.8.8", "::1"], "::1"),
        ] {
            let error = AddressPolicy::PublicOnly.validate_resolved("rebind.example.com", &ips(list)).unwrap_err();
            assert_eq!(error.message, format!("Blocked request to private address: {shown}"), "{list:?}");
        }
    }

    #[test]
    fn a_failed_name_lookup_reads_as_a_resolver_failure() {
        for (kind, code) in [(LookupKind::NotFound, "ENOTFOUND"), (LookupKind::NoData, "ENODATA")] {
            let got = lookup_failure("unreachable.example.com", LookupError { kind, code: 0 });
            assert_eq!(got.message, "DNS returned no addresses for unreachable.example.com", "{code}");
            assert_eq!(said(&PublicError::from(got)), "DNS returned no addresses for unreachable.example.com");
        }
        // A temporary failure keeps its kind: the web tools word it `fetch failed: getaddrinfo <code> <host>`, the guarded GET
        // keeps the code and the host.
        let got = lookup_failure("unreachable.example.com", LookupError { kind: LookupKind::TryAgain, code: 0 });
        assert_eq!(got.message, "fetch failed: getaddrinfo EAI_AGAIN unreachable.example.com");
        let kept = PublicError::from(got);
        assert_eq!(kept, PublicError::Lookup { code: "EAI_AGAIN".to_owned(), host: "unreachable.example.com".to_owned() });
        assert_eq!(said(&kept), "getaddrinfo EAI_AGAIN unreachable.example.com");
    }

    #[tokio::test]
    async fn a_redirect_is_returned_and_never_followed() {
        let server = MockServer::start().await;
        Mock::given(path("/start")).respond_with(ResponseTemplate::new(302).insert_header("location", "/next").set_body_string("moved")).mount(&server).await;
        Mock::given(path("/next")).respond_with(ResponseTemplate::new(200)).expect(0).mount(&server).await;
        let mut reply = open().get(&format!("{}/start", server.uri()), &[]).await.unwrap();
        assert_eq!(reply.status(), 302);
        assert_eq!(reply.header("location").as_deref(), Some("/next"));
        assert!(reply.has_body());
        assert_eq!(String::from_utf8(drain(&mut reply).await.unwrap()).unwrap(), "moved");
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_request_carries_the_headers_of_a_browser_style_fetch_and_the_callers_own() {
        let server = MockServer::start().await;
        Mock::given(any()).respond_with(ResponseTemplate::new(200)).mount(&server).await;
        let asked = [("x-goog-api-key".to_owned(), "k".to_owned())];
        open().get(&format!("{}/media", server.uri()), &asked).await.unwrap();
        let seen = server.received_requests().await.unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method.as_str(), "GET");
        for (name, want) in [("user-agent", "undici"), ("accept", "*/*"), ("accept-language", "*"), ("sec-fetch-mode", "cors"), ("x-goog-api-key", "k")] {
            assert_eq!(seen[0].headers.get(name).map(|v| v.to_str().unwrap()), Some(want), "{name}");
        }
    }

    #[tokio::test]
    async fn a_body_less_status_has_no_body() {
        let server = MockServer::start().await;
        for (status, has_body) in [(200, true), (204, false), (205, false), (304, false), (302, true)] {
            server.reset().await;
            Mock::given(any()).respond_with(ResponseTemplate::new(status)).mount(&server).await;
            let reply = open().get(&server.uri(), &[]).await.unwrap();
            assert_eq!((reply.status(), reply.has_body()), (status, has_body), "{status}");
        }
    }

    #[tokio::test]
    async fn a_body_cut_short_is_terminated_and_a_refused_connection_is_fetch_failed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 2048];
            let _ = socket.read(&mut buffer).await;
            socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc").await.unwrap();
            socket.shutdown().await.unwrap();
        });
        let mut reply = open().get(&format!("http://127.0.0.1:{port}/"), &[]).await.unwrap();
        let cut = drain(&mut reply).await.unwrap_err();
        served.await.unwrap();
        assert_eq!(said(&cut), "terminated");
        // The listener is gone: the port refuses.
        let refused = open().get(&format!("http://127.0.0.1:{port}/"), &[]).await.err().unwrap();
        assert_eq!(said(&refused), "fetch failed");
    }
}
