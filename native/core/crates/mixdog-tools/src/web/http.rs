//! HTTP layer: manual redirects with the address policy re-applied on every
//! hop, bounded bodies, charset decoding and the per-fetch cookie jar. Every
//! function is cancel-safe by drop; the caller owns deadlines.

use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use reqwest::Response;
use reqwest::cookie::CookieStore;
use reqwest::cookie::Jar;
use reqwest::header::ACCEPT;
use reqwest::header::ACCEPT_LANGUAGE;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::COOKIE;
use reqwest::header::HeaderMap;
use reqwest::header::LOCATION;
use reqwest::header::RETRY_AFTER;
use reqwest::header::SET_COOKIE;
use reqwest::header::USER_AGENT;
use url::Url;

use super::error::FetchError;
use super::error::FetchKind;
use super::ssrf::AddressPolicy;
use super::ssrf::PolicyResolver;

pub const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const SAFE_IMAGE_MIMES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Cookies live for one logical fetch (the original URL and its redirect and
/// meta-refresh hops) and are never shared between callers.
#[derive(Clone, Default)]
pub struct Session {
    jar: Arc<Jar>,
}

pub struct Document {
    pub url: Url,
    pub content_type: String,
    pub body: String,
    pub redirects: Vec<Redirect>,
}

/// One redirect hop as Node records it: an HTTP hop has a status code, a meta refresh has none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Redirect {
    pub url: String,
    pub status: Option<u16>,
    pub location: String,
}

pub struct BrowserResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

pub struct Fetcher {
    client: Client,
    policy: AddressPolicy,
    user_agent: String,
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn header_text(headers: &HeaderMap, name: reqwest::header::HeaderName) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

pub fn parse_retry_after(value: &str) -> Duration {
    let value = mixdog_js::js_trim(value);
    if value.is_empty() {
        return Duration::ZERO;
    }
    if let Ok(seconds) = value.parse::<f64>() {
        return Duration::from_secs_f64(seconds.max(0.0));
    }
    let at = mixdog_js::time::date_parse(value);
    if !at.is_finite() {
        return Duration::ZERO;
    }
    let wait_ms = at - chrono::Utc::now().timestamp_millis() as f64;
    Duration::from_secs_f64(wait_ms.max(0.0) / 1000.0)
}

pub fn assert_document_response(status: u16, headers: &HeaderMap) -> Result<(), FetchError> {
    let challenged = headers
        .get("cf-mitigated")
        .and_then(|value| value.to_str().ok())
        == Some("challenge");
    if !challenged && (200..300).contains(&status) {
        return Ok(());
    }
    let mut error = if challenged {
        FetchError::new(FetchKind::Challenge, "Challenge response (cf-mitigated: challenge)")
    } else {
        FetchError::new(FetchKind::Http, format!("HTTP {status}"))
    };
    error.status = Some(status);
    error.retry_after = parse_retry_after(&header_text(headers, RETRY_AFTER));
    Err(error)
}

fn is_text_content_type(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || content_type.contains("/html")
        || content_type.contains("/xml")
        || content_type.contains("/json")
        || content_type.contains("+json")
        || content_type.contains("+xml")
        || content_type.contains("javascript")
        || content_type.contains("application/x-www-form-urlencoded")
}

fn charset_of(content_type: &str) -> Option<&str> {
    let at = content_type.find("charset=")? + "charset=".len();
    let rest = content_type[at..].trim_start_matches(['"', '\'']);
    let end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .unwrap_or(rest.len());
    (end > 0).then(|| &rest[..end])
}

fn too_large(detail: String) -> FetchError {
    FetchError::policy(format!("response body too large: {detail}"))
}

async fn read_capped(mut response: Response) -> Result<Vec<u8>, FetchError> {
    if let Some(length) = response.content_length()
        && length > MAX_BODY_BYTES as u64
    {
        return Err(too_large(format!(
            "Content-Length={length} > cap={MAX_BODY_BYTES}"
        )));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| FetchError::network(&error))?
    {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(too_large(format!(
                "received {}+ bytes > cap={MAX_BODY_BYTES}",
                body.len() + chunk.len()
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn read_text(response: Response) -> Result<String, FetchError> {
    let content_type = header_text(response.headers(), CONTENT_TYPE).to_lowercase();
    if !content_type.is_empty() && !is_text_content_type(&content_type) {
        let mime = mixdog_js::js_trim(content_type.split(';').next().unwrap_or_default());
        return Err(FetchError::policy(format!(
            "Blocked non-text content-type: {mime}"
        )));
    }
    let encoding = charset_of(&content_type)
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let bytes = read_capped(response).await?;
    Ok(encoding.decode_with_bom_removal(&bytes).0.into_owned())
}

impl Fetcher {
    pub fn new(policy: AddressPolicy, version: &str) -> Result<Self, FetchError> {
        let client = Client::builder()
            .dns_resolver(Arc::new(PolicyResolver(policy)))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|error| FetchError::network(&error))?;
        Ok(Self {
            client,
            policy,
            user_agent: format!("mixdog-web-search/{version}"),
        })
    }

    pub fn parse_url(&self, text: &str) -> Result<Url, FetchError> {
        let url = Url::parse(text).map_err(|error| FetchError::policy(format!("Invalid URL: {error}")))?;
        self.policy.check_url(&url)?;
        Ok(url)
    }

    async fn send(&self, url: &Url, cookie: Option<reqwest::header::HeaderValue>) -> Result<Response, FetchError> {
        let mut request = self
            .client
            .get(url.clone())
            .header(USER_AGENT, &self.user_agent)
            .header(
                ACCEPT,
                "text/html, application/xhtml+xml, text/markdown, text/plain, application/json;q=0.9, */*;q=0.5",
            )
            .header(ACCEPT_LANGUAGE, "en, ko;q=0.9");
        if let Some(cookie) = cookie {
            request = request.header(COOKIE, cookie);
        }
        request.send().await.map_err(|error| FetchError::network(&error))
    }

    /// The next hop of a redirect response, validated against the policy.
    fn next_hop(&self, current: &Url, response: &Response, hops: usize) -> Result<Url, FetchError> {
        if hops >= MAX_REDIRECTS {
            return Err(FetchError::policy(format!(
                "Too many redirects (max {MAX_REDIRECTS})"
            )));
        }
        let status = response.status().as_u16();
        let location = header_text(response.headers(), LOCATION);
        if location.is_empty() {
            return Err(FetchError::policy(format!(
                "Redirect {status} without Location header"
            )));
        }
        let next = current
            .join(&location)
            .map_err(|error| FetchError::policy(format!("Invalid redirect Location: {error}")))?;
        self.policy.check_url(&next)?;
        Ok(next)
    }

    pub async fn fetch_document(&self, url: &Url, session: &Session) -> Result<Document, FetchError> {
        let mut current = url.clone();
        let mut redirects = Vec::new();
        for hops in 0.. {
            self.policy.check_url(&current)?;
            let response = self.send(&current, session.jar.cookies(&current)).await?;
            let set_cookies = response.headers().get_all(SET_COOKIE);
            session.jar.set_cookies(&mut set_cookies.iter(), &current);
            let status = response.status().as_u16();
            if is_redirect(status) {
                let next = self.next_hop(&current, &response, hops)?;
                redirects.push(Redirect {
                    url: current.to_string(),
                    status: Some(status),
                    location: next.to_string(),
                });
                current = next;
                continue;
            }
            assert_document_response(status, response.headers())?;
            let content_type = header_text(response.headers(), CONTENT_TYPE);
            let body = read_text(response).await?;
            return Ok(Document {
                url: current,
                content_type,
                body,
                redirects,
            });
        }
        unreachable!("the redirect loop returns or errors")
    }

    /// One request on behalf of the browser (address policy applied): the
    /// response goes back to Chromium as it is, which owns redirects, cookie
    /// scoping and method rewriting; each next hop is intercepted again. The
    /// browser's headers override the defaults.
    pub async fn fetch_for_browser(
        &self,
        url: &Url,
        method: &str,
        headers: &[(String, String)],
        body: Option<String>,
    ) -> Result<BrowserResponse, FetchError> {
        self.policy.check_url(url)?;
        let invalid = |what: &str| FetchError::new(FetchKind::Network, format!("invalid browser request {what}"));
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| invalid("method"))?;
        let mut merged = HeaderMap::new();
        merged.insert(USER_AGENT, self.user_agent.parse().map_err(|_| invalid("user agent"))?);
        merged.insert(
            ACCEPT,
            "text/html, application/xhtml+xml, text/markdown, text/plain, application/json;q=0.9, */*;q=0.5"
                .parse()
                .map_err(|_| invalid("accept"))?,
        );
        merged.insert(ACCEPT_LANGUAGE, "en, ko;q=0.9".parse().map_err(|_| invalid("accept-language"))?);
        for (name, value) in headers {
            let name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid("header name"))?;
            merged.insert(name, value.parse().map_err(|_| invalid("header value"))?);
        }
        let mut request = self.client.request(method, url.clone()).headers(merged);
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = request.send().await.map_err(|error| FetchError::network(&error))?;
        let status = response.status().as_u16();
        if is_redirect(status)
            && let Some(location) = response.headers().get(LOCATION).and_then(|value| value.to_str().ok())
        {
            let next = url
                .join(location)
                .map_err(|error| FetchError::policy(format!("Invalid redirect Location: {error}")))?;
            self.policy.check_url(&next)?;
        }
        let headers = response.headers().clone();
        let body = read_capped(response).await?;
        Ok(BrowserResponse { status, headers, body })
    }

    /// Follow redirects (optionally within one host) to the final 2xx response.
    async fn follow(&self, url: &Url, same_host: bool) -> Result<Response, FetchError> {
        let mut current = url.clone();
        for hops in 0.. {
            self.policy.check_url(&current)?;
            if same_host && current.host_str() != url.host_str() {
                return Err(FetchError::policy(format!(
                    "cross-host redirect blocked (redirected_to: {current})"
                )));
            }
            let response = self.send(&current, None).await?;
            if !is_redirect(response.status().as_u16()) {
                if !response.status().is_success() {
                    return Err(FetchError::new(
                        FetchKind::Http,
                        format!("HTTP {}", response.status().as_u16()),
                    ));
                }
                return Ok(response);
            }
            current = self.next_hop(&current, &response, hops)?;
        }
        unreachable!("the redirect loop returns or errors")
    }

    pub async fn fetch_text(&self, url: &Url) -> Result<String, FetchError> {
        read_text(self.follow(url, false).await?).await
    }

    /// Returns `(mime, bytes)` of a png/jpeg/gif/webp image on the same host.
    pub async fn fetch_image(&self, url: &Url) -> Result<(String, Vec<u8>), FetchError> {
        let response = self.follow(url, true).await?;
        let content_type = header_text(response.headers(), CONTENT_TYPE);
        let mime = mixdog_js::js_trim(content_type.split(';').next().unwrap_or_default()).to_lowercase();
        if !SAFE_IMAGE_MIMES.contains(&mime.as_str()) {
            let shown = if mime.is_empty() { "(missing)" } else { mime.as_str() };
            return Err(FetchError::policy(format!(
                "Blocked unsupported image content-type: {shown}"
            )));
        }
        Ok((mime, read_capped(response).await?))
    }
}

/// A short `<meta http-equiv="refresh" content="N; url=...">` in the head is a
/// redirect for a browser; a delay over 5 s is an auto-reload and is not
/// followed.
pub fn meta_refresh_target(html: &str, base: &Url) -> Option<Url> {
    use mixdog_js::JsRegex;
    use std::sync::LazyLock;
    static TAG: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<meta\b[^>]*>", "i"));
    static EQUIV: LazyLock<JsRegex> =
        LazyLock::new(|| JsRegex::new_static(r#"http-equiv\s*=\s*["']?refresh\b"#, "i"));
    static CONTENT: LazyLock<[JsRegex; 3]> = LazyLock::new(|| {
        [
            JsRegex::new_static(r#"content\s*=\s*"([^"]*)""#, "i"),
            JsRegex::new_static(r"content\s*=\s*'([^']*)'", "i"),
            JsRegex::new_static(r"content\s*=\s*([^\s>]+)", "i"),
        ]
    });
    static DIRECTIVE: LazyLock<JsRegex> = LazyLock::new(|| {
        JsRegex::new_static(r#"^\s*(\d+(?:\.\d+)?)\s*[;,]\s*url\s*=\s*['"]?([^'"]+?)['"]?\s*$"#, "i")
    });
    let mut end = html.len().min(8192);
    while !html.is_char_boundary(end) {
        end -= 1;
    }
    let head = &html[..end];
    for tag in TAG.find_iter(head) {
        let tag = &head[tag];
        if !EQUIV.is_match(tag) {
            continue;
        }
        let Some(content) = CONTENT.iter().find_map(|re| re.captures(tag)) else {
            continue;
        };
        let Some(directive) = DIRECTIVE.captures(content.get(1).unwrap_or_default()) else {
            continue;
        };
        let delay: f64 = directive.get(1).unwrap_or_default().parse().unwrap_or(f64::INFINITY);
        if delay > 5.0 {
            continue;
        }
        let Ok(resolved) = base.join(mixdog_js::js_trim(directive.get(2).unwrap_or_default())) else {
            continue;
        };
        if !matches!(resolved.scheme(), "http" | "https") || resolved.as_str() == base.as_str() {
            continue;
        }
        return Some(resolved);
    }
    None
}
