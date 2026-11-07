//! Fetching generated media (`download.mjs` `downloadPublicMedia` / `downloadGeminiMedia`, and
//! `bounded-download.mjs` `readResponseBuffer`): a result that comes back as an address is fetched
//! from the public internet, following at most five redirects, with the byte limit applied to both
//! the advertised length and the bytes actually read. The request itself goes through
//! [`PublicFetch`]: its implementation owns the SSRF guard (the address policy of the web tools,
//! checked on the parsed host and again on every address dialled) and the connection; what is
//! decided here is what Node decides around it.

use async_trait::async_trait;
use reqwest::Url;
use tokio_util::sync::CancellationToken;

use super::lanes::LaneError;
use super::upstream::{MAX_GENERATED_MEDIA_BYTES, gemini_media_download_url};

/// A failure of a media adapter: a media error (code and status), or a plain one (a refused
/// address, a network failure) whose message is all there is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterError {
    pub message: String,
    pub code: Option<String>,
    pub status: Option<u16>,
    /// What the provider reported before the request failed (withReportedUsage).
    pub usage: Option<serde_json::Value>,
    /// When a usage window reopens (rr.resetsAt, an ISO time).
    pub resets_at: Option<String>,
}

impl AdapterError {
    pub fn plain(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None, status: None, usage: None, resets_at: None }
    }

    fn invalid_url() -> Self {
        Self { message: "Invalid URL".to_owned(), code: Some("ERR_INVALID_URL".to_owned()), status: None, usage: None, resets_at: None }
    }
}

impl From<LaneError> for AdapterError {
    fn from(error: LaneError) -> Self {
        Self { message: error.message, code: Some(error.code.to_owned()), status: Some(error.status), usage: None, resets_at: None }
    }
}

/// One response of [`PublicFetch`]: its status and headers, then its body in pieces.
#[async_trait]
pub trait PublicResponse: Send {
    fn status(&self) -> u16;
    /// A header's value, whatever the case of its name.
    fn header(&self, name: &str) -> Option<String>;
    /// `response.body` is not null.
    fn has_body(&self) -> bool;
    async fn chunk(&mut self) -> Result<Option<Vec<u8>>, AdapterError>;
}

/// `pinnedFetch(url, { headers, redirect: 'manual' })`: a GET of a public address that never
/// follows a redirect. It refuses what `assertPublicUrl` refuses (Node's wording: `Invalid URL`,
/// `Blocked request to private address: <host>`, `Blocked non-HTTP protocol: <scheme>`) and what
/// resolves to a private address.
#[async_trait]
pub trait PublicFetch: Send + Sync {
    async fn get(&self, url: &str, headers: &[(String, String)], cancel: &CancellationToken) -> Result<Box<dyn PublicResponse>, AdapterError>;
}

/// What a download is allowed and called.
pub struct Limits<'a> {
    pub max_bytes: usize,
    pub label: &'a str,
}

impl Default for Limits<'_> {
    fn default() -> Self {
        Self { max_bytes: MAX_GENERATED_MEDIA_BYTES, label: "generated media" }
    }
}

fn failed(message: String, status: u16) -> AdapterError {
    LaneError { message, code: "MEDIA_UPSTREAM_FAILED", status }.into()
}

/// `redirectTarget(response, currentUrl)`.
fn redirect_target(response: &dyn PublicResponse, current: &str) -> Result<Option<String>, AdapterError> {
    let status = response.status();
    if !(300..400).contains(&status) {
        return Ok(None);
    }
    let Some(location) = response.header("location").filter(|l| !l.is_empty()) else { return Ok(None) };
    let base = Url::parse(current).map_err(|_| AdapterError::invalid_url())?;
    base.join(&location).map(|url| Some(url.to_string())).map_err(|_| AdapterError::invalid_url())
}

/// `readResponseBuffer(response, { maxBytes, label })`.
pub async fn read_response_buffer(response: &mut dyn PublicResponse, limits: &Limits<'_>, cancel: &CancellationToken) -> Result<Vec<u8>, AdapterError> {
    let label = limits.label;
    let too_big = || AdapterError::plain(format!("{label}: response exceeds the {} byte limit", limits.max_bytes));
    if !response.has_body() {
        return Err(AdapterError::plain(format!("{label}: response has no body")));
    }
    let advertised = response.header("content-length").map(|v| v.trim().to_owned()).filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()));
    if advertised.is_some_and(|v| v.parse::<f64>().is_ok_and(|n| n > limits.max_bytes as f64)) {
        return Err(too_big());
    }
    let mut out = Vec::new();
    loop {
        let next = tokio::select! {
            () = cancel.cancelled() => return Err(AdapterError::plain("This operation was aborted")),
            next = response.chunk() => next?,
        };
        let Some(chunk) = next else { return Ok(out) };
        if out.len() + chunk.len() > limits.max_bytes {
            return Err(too_big());
        }
        out.extend_from_slice(&chunk);
    }
}

/// `downloadPublicMedia(input, { signal, label, maxBytes })`.
pub async fn download_public_media(fetch: &dyn PublicFetch, input: &str, limits: &Limits<'_>, cancel: &CancellationToken) -> Result<Vec<u8>, AdapterError> {
    let mut url = input.to_owned();
    for _ in 0..=5 {
        let mut response = fetch.get(&url, &[], cancel).await?;
        if let Some(next) = redirect_target(response.as_ref(), &url)? {
            url = next;
            continue;
        }
        let status = response.status();
        if !(200..300).contains(&status) {
            return Err(failed(format!("{} download failed ({status})", limits.label), status));
        }
        return read_response_buffer(response.as_mut(), limits, cancel).await;
    }
    Err(failed(format!("{} download redirected too many times", limits.label), 502))
}

/// `downloadGeminiMedia(input, { key, signal, label, maxBytes })`: the key travels in a header and
/// a redirect is refused.
pub async fn download_gemini_media(fetch: &dyn PublicFetch, input: &str, key: &str, limits: &Limits<'_>, cancel: &CancellationToken) -> Result<Vec<u8>, AdapterError> {
    let url = gemini_media_download_url(&serde_json::Value::String(input.to_owned()))?;
    let mut response = fetch.get(&url, &[("x-goog-api-key".to_owned(), key.to_owned())], cancel).await?;
    if redirect_target(response.as_ref(), &url)?.is_some() {
        return Err(failed(format!("{} download redirect was rejected", limits.label), 502));
    }
    let status = response.status();
    if !(200..300).contains(&status) {
        return Err(failed(format!("{} download failed ({status})", limits.label), status));
    }
    read_response_buffer(response.as_mut(), limits, cancel).await
}

/// `await res.json()`: the parsed body, or the rejection Node's `JSON.parse` raises for text
/// that is not JSON, in V8's words.
pub(super) fn parse_json_body(text: &str) -> Result<serde_json::Value, AdapterError> {
    mixdog_js::json_parse(text).map_err(|_| AdapterError::plain(mixdog_js::v8_json_parse_error(text).unwrap_or_else(|| "Unexpected token".to_owned())))
}
