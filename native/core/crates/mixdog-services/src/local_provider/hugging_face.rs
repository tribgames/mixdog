//! Hugging Face search and inspection. Inspection reads only public, ungated repositories with
//! an immutable revision and verified LFS size/SHA-256, and the GGUF header through growing
//! bounded Range requests (64 KiB up to 16 MiB). Nothing is registered or downloaded until the
//! user accepts the license against a pending preview.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::context::LOCAL_CONTEXT_MIN_TOKENS;
use super::gguf::{GgufError, default_gguf_memory_plan, gguf_memory_plan, parse_gguf_header};
use super::registered_models::{RegisteredModels, RegistryError, hugging_face_file_url, is_repository_id};
use crate::media::store::now_ms;

pub const ORIGIN: &str = "https://huggingface.co";
const MAX_JSON: usize = 4 * 1024 * 1024;
const PREVIEW_TTL_MS: i64 = 15 * 60_000;
const MAX_PREVIEWS: usize = 100;

#[derive(Debug, thiserror::Error)]
pub enum HfError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Failed(String),
    #[error(transparent)]
    Registry(#[from] RegistryError),
}

fn invalid<T>(m: &str) -> Result<T, HfError> {
    Err(HfError::Invalid(m.to_owned()))
}
fn failed<T>(m: impl Into<String>) -> Result<T, HfError> {
    Err(HfError::Failed(m.into()))
}

impl From<GgufError> for HfError {
    fn from(e: GgufError) -> Self {
        Self::Failed(e.to_string())
    }
}

/// The HTTP surface inspection needs, so tests need no network.
#[async_trait::async_trait]
pub trait HfHttp: Send + Sync {
    /// GET `url` without redirects, answering a body bounded by `limit`.
    async fn get_json(&self, url: &str, limit: usize) -> Result<Value, String>;
    /// GET `bytes=0-end`; `(status, content-range, scheme-is-https, body)`.
    async fn get_range(&self, url: &str, end: u64) -> Result<RangeResponse, String>;
}

pub struct RangeResponse {
    pub status: u16,
    pub content_range: String,
    pub https: bool,
    pub body: Vec<u8>,
}

pub struct ReqwestHf(reqwest::Client);

impl Default for ReqwestHf {
    fn default() -> Self {
        Self(reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(30)).build().expect("client builds"))
    }
}

async fn bounded_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!("Hugging Face request failed: HTTP {}", response.status().as_u16()));
    }
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if out.len() + chunk.len() > limit {
            return Err("Hugging Face response exceeds the inspection limit".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

#[async_trait::async_trait]
impl HfHttp for ReqwestHf {
    async fn get_json(&self, url: &str, limit: usize) -> Result<Value, String> {
        let response = self.0.get(url).send().await.map_err(|e| e.to_string())?;
        serde_json::from_slice(&bounded_body(response, limit).await?).map_err(|e| e.to_string())
    }

    async fn get_range(&self, url: &str, end: u64) -> Result<RangeResponse, String> {
        // The file URL answers a redirect to the CDN; follow it by hand, https only.
        let mut target = url.to_owned();
        for _ in 0..5 {
            let response = self.0.get(&target).header("Range", format!("bytes=0-{end}")).send().await.map_err(|e| e.to_string())?;
            if response.status().is_redirection() {
                let next = response.headers().get("location").and_then(|v| v.to_str().ok()).ok_or("redirect without location")?;
                target = response.url().join(next).map_err(|e| e.to_string())?.to_string();
                if !target.starts_with("https://") {
                    return Err("The GGUF host redirected to a non-https URL.".into());
                }
                continue;
            }
            let status = response.status().as_u16();
            let content_range = response.headers().get("content-range").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
            let https = response.url().scheme() == "https";
            let limit = end as usize + 1;
            let body = if status == 206 { bounded_body(response, limit).await? } else { Vec::new() };
            return Ok(RangeResponse { status, content_range, https, body });
        }
        Err("too many redirects".into())
    }
}

/// Parses `bytes 0-<end>/<total>`.
fn content_range(value: &str) -> Option<(u64, u64)> {
    let rest = value.strip_prefix("bytes 0-")?;
    let (end, total) = rest.split_once('/')?;
    Some((end.parse().ok()?, total.parse().ok()?))
}

async fn fetch_gguf_header(http: &dyn HfHttp, url: &str, file_size: u64) -> Result<super::gguf::GgufHeader, HfError> {
    let mut size: u64 = 64 * 1024;
    while size <= 16 * 1024 * 1024 {
        let end = file_size.min(size) - 1;
        let response = http.get_range(url, end).await.map_err(HfError::Failed)?;
        if response.status != 206 || !response.https || content_range(&response.content_range) != Some((end, file_size)) {
            return failed("The GGUF host did not honor the bounded metadata range request.");
        }
        match parse_gguf_header(&response.body) {
            Ok(header) => return Ok(header),
            Err(GgufError::NeedMore) if end + 1 != file_size => {}
            Err(e) => return Err(e.into()),
        }
        size *= 2;
    }
    failed("GGUF metadata exceeds the 16 MiB inspection limit.")
}

struct Preview {
    model: Value,
    expires_at: i64,
}

pub struct HuggingFaceCatalog {
    http: Box<dyn HfHttp>,
    registry: RegisteredModels,
    previews: Mutex<HashMap<String, Preview>>,
}

fn repository_id(value: Option<&Value>) -> Result<&str, HfError> {
    let v = value.and_then(Value::as_str).filter(|v| is_repository_id(v) && !v.split('/').any(|p| p == "." || p == ".."));
    v.ok_or_else(|| HfError::Invalid("repository must be an owner/name Hugging Face model id.".into()))
}

impl HuggingFaceCatalog {
    pub fn new(http: Box<dyn HfHttp>, registry: RegisteredModels) -> Self {
        Self { http, registry, previews: Mutex::default() }
    }

    pub fn registry(&self) -> &RegisteredModels {
        &self.registry
    }

    pub async fn search(&self, query: Option<&Value>) -> Result<Value, HfError> {
        let query = query.and_then(Value::as_str).map(mixdog_js::js_trim).filter(|q| !q.is_empty() && mixdog_js::utf16_len(q) <= 200);
        let Some(query) = query else { return invalid("query must contain 1–200 characters.") };
        let url = format!("{ORIGIN}/api/models?search={}&filter=gguf&limit=20&sort=downloads&direction=-1", encode(query));
        let rows = self.http.get_json(&url, MAX_JSON).await.map_err(HfError::Failed)?;
        let Some(rows) = rows.as_array() else { return failed("Invalid Hugging Face search response") };
        let models: Vec<Value> = rows
            .iter()
            .take(20)
            .filter(|r| is_repository_id(r.get("id").and_then(Value::as_str).unwrap_or("")))
            .map(|r| {
                let id = r["id"].as_str().expect("filtered");
                json!({"repository": id, "downloads": r.get("downloads").and_then(Value::as_f64).unwrap_or(0.0), "source": format!("{ORIGIN}/{id}")})
            })
            .collect();
        Ok(json!({"models": models}))
    }

    /// With no `filename`: the repository's GGUF files. With one: a preview of that file.
    pub async fn inspect(&self, args: &Value, max_gpu_memory: i64) -> Result<Value, HfError> {
        let repository = repository_id(args.get("repository"))?;
        let requested = match args.get("contextWindow") {
            None => None,
            Some(v) => Some(v.as_f64().filter(|c| c.fract() == 0.0).map(|c| c as i64).filter(|c| (LOCAL_CONTEXT_MIN_TOKENS..=32768).contains(c)).ok_or_else(|| HfError::Invalid(format!("contextWindow must be between {LOCAL_CONTEXT_MIN_TOKENS} and 32768.")))?),
        };
        let info = self.http.get_json(&format!("{ORIGIN}/api/models/{repository}?blobs=true"), MAX_JSON).await.map_err(HfError::Failed)?;
        let flag = |k: &str| info.get(k).map_or(false, |v| !matches!(v, Value::Null | Value::Bool(false)) && v != "");
        if flag("private") || flag("gated") || flag("disabled") {
            return failed("Only public, ungated Hugging Face models can be installed.");
        }
        let sha = info.get("sha").and_then(Value::as_str).filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        let Some(sha) = sha else { return failed("Hugging Face did not supply an immutable revision.") };
        let license = info.pointer("/cardData/license").and_then(Value::as_str).filter(|l| !mixdog_js::js_trim(l).is_empty() && mixdog_js::utf16_len(l) <= 200);
        let Some(license) = license else { return failed("Model license is missing; inspect its license before installation.") };
        let files: Vec<&Value> = info
            .get("siblings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|e| e.get("rfilename").and_then(Value::as_str).is_some_and(|n| n.to_lowercase().ends_with(".gguf")))
            .collect();
        let Some(filename) = args.get("filename").filter(|f| !f.is_null() && *f != "") else {
            return Ok(json!({
                "repository": repository, "revision": sha, "license": license, "source": format!("{ORIGIN}/{repository}"),
                "files": files.iter().take(200).map(|e| json!({"filename": e["rfilename"], "sizeBytes": e.get("size"), "sha256": e.pointer("/lfs/sha256")})).collect::<Vec<_>>(),
                "filesTruncated": files.len() > 200,
            }));
        };
        let Some(filename) = filename.as_str() else { return invalid("Select one complete GGUF file; split shards and traversal paths are unsupported.") };
        if filename.chars().any(|c| c == '\\' || (c as u32) < 0x20) || filename.split('/').any(|p| p.is_empty() || p == "." || p == "..") || is_shard(filename) {
            return invalid("Select one complete GGUF file; split shards and traversal paths are unsupported.");
        }
        let file = files.iter().find(|e| e["rfilename"] == filename);
        let size = file.and_then(|f| f.get("size")).and_then(Value::as_i64).filter(|s| *s > 0);
        let sha256 = file.and_then(|f| f.pointer("/lfs/sha256")).and_then(Value::as_str).filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        let (Some(file), Some(size), Some(sha256)) = (file, size, sha256) else { return failed("Selected GGUF is missing verified LFS size/SHA-256 metadata.") };
        if file.pointer("/lfs/size").and_then(Value::as_i64) != Some(size) {
            return failed("Selected GGUF is missing verified LFS size/SHA-256 metadata.");
        }
        let url = hugging_face_file_url(repository, sha, filename);
        let header = fetch_gguf_header(self.http.as_ref(), &url, size as u64).await?;
        let plan = match requested {
            None => default_gguf_memory_plan(&header, size, max_gpu_memory)?,
            Some(c) => gguf_memory_plan(&header, size, c)?,
        };
        let digest: String = Sha256::digest(format!("{repository}|{sha}|{filename}").as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        let id = format!("hf-{}", &digest[..24]);
        let mut model = Map::from_iter([
            ("id".to_owned(), json!(id)),
            ("name".into(), json!(format!("{repository} · {filename}"))),
            ("filename".into(), json!(format!("{id}.gguf"))),
            ("remoteFilename".into(), json!(filename)),
            ("repository".into(), json!(repository)),
            ("revision".into(), json!(sha)),
            ("source".into(), json!(format!("{ORIGIN}/{repository}/tree/{sha}"))),
            ("url".into(), json!(url)),
            ("size".into(), json!(size)),
            ("sha256".into(), json!(sha256)),
            ("license".into(), json!(license)),
        ]);
        model.extend(plan.as_object().expect("plan is an object").clone());
        model.extend(Map::from_iter([
            ("supportsFunctionCalling".to_owned(), Value::Null),
            ("supportsReasoning".into(), Value::Null),
            ("supportsImages".into(), json!(false)),
            ("recommended".into(), json!(false)),
            ("compatibility".into(), json!("GGUF metadata checked; runtime loading and tool support not yet verified")),
        ]));
        let model = Value::Object(model);
        let now = now_ms();
        let preview_id = uuid::Uuid::new_v4().to_string();
        {
            let mut previews = self.previews.lock().unwrap();
            previews.retain(|_, p| p.expires_at >= now);
            if previews.len() >= MAX_PREVIEWS {
                return failed("Too many pending model inspections; wait for them to expire.");
            }
            previews.insert(preview_id.clone(), Preview { model: model.clone(), expires_at: now + PREVIEW_TTL_MS });
        }
        Ok(json!({
            "previewId": preview_id, "expiresAt": now + PREVIEW_TTL_MS, "model": model, "downloadBytes": size,
            "licenseUrl": format!("{ORIGIN}/{repository}/tree/{sha}"),
            "note": "No model was registered or installed. Review license and resource requirements before approval.",
        }))
    }

    pub fn register(&self, preview_id: &str, license_accepted: bool) -> Result<Value, HfError> {
        let model = {
            let previews = self.previews.lock().unwrap();
            previews.get(preview_id).filter(|p| p.expires_at >= now_ms()).map(|p| p.model.clone())
        };
        let Some(model) = model else { return failed("Model inspection expired; inspect again before registering.") };
        if !license_accepted {
            return invalid("Explicit license acceptance is required.");
        }
        let registered = self.registry.register(&model)?;
        self.previews.lock().unwrap().remove(preview_id);
        Ok(json!({"model": registered, "registered": true, "downloadStarted": false}))
    }
}

/// A split shard: `-00001-of-00003.gguf`.
fn is_shard(name: &str) -> bool {
    let lower = name.to_lowercase();
    let Some(stem) = lower.strip_suffix(".gguf") else { return false };
    let b = stem.as_bytes();
    b.len() >= 15 && {
        let t = &b[b.len() - 15..];
        t[0] == b'-' && t[1..6].iter().all(u8::is_ascii_digit) && &t[6..10] == b"-of-" && t[10..].iter().all(u8::is_ascii_digit)
    }
}

/// `URLSearchParams` value encoding (space becomes `+`).
fn encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        match b {
            b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            b' ' => out.push('+'),
            b if b.is_ascii_alphanumeric() => out.push(b as char),
            b => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::gguf::tests::sample;
    use super::*;

    struct Fake {
        info: Value,
        gguf: Vec<u8>,
    }

    #[async_trait::async_trait]
    impl HfHttp for Fake {
        async fn get_json(&self, url: &str, _: usize) -> Result<Value, String> {
            if url.contains("/api/models?") {
                Ok(json!([{"id": "o/n", "downloads": 5}, {"id": "bad id", "downloads": 1}]))
            } else {
                Ok(self.info.clone())
            }
        }
        async fn get_range(&self, _: &str, end: u64) -> Result<RangeResponse, String> {
            let total = self.gguf.len() as u64;
            let end = end.min(total - 1);
            Ok(RangeResponse { status: 206, content_range: format!("bytes 0-{end}/{total}"), https: true, body: self.gguf[..=end as usize].to_vec() })
        }
    }

    fn catalog(dir: &std::path::Path, gated: bool) -> HuggingFaceCatalog {
        let gguf = sample(131_072);
        let size = gguf.len();
        let info = json!({
            "sha": "c".repeat(40), "gated": gated, "cardData": {"license": "apache-2.0"},
            "siblings": [{"rfilename": "m.gguf", "size": size, "lfs": {"sha256": "d".repeat(64), "size": size}}, {"rfilename": "readme.md"}],
        });
        HuggingFaceCatalog::new(Box::new(Fake { info, gguf }), RegisteredModels::new(dir))
    }

    #[tokio::test]
    async fn search_filters_unusable_rows_and_validates_the_query() {
        let dir = tempfile::tempdir().unwrap();
        let c = catalog(dir.path(), false);
        let found = c.search(Some(&json!("llama 3"))).await.unwrap();
        assert_eq!(found["models"], json!([{"repository": "o/n", "downloads": 5.0, "source": "https://huggingface.co/o/n"}]));
        assert!(c.search(Some(&json!("  "))).await.is_err());
        assert!(c.search(None).await.is_err());
    }

    #[tokio::test]
    async fn inspect_lists_files_then_previews_one_and_register_needs_the_license() {
        let dir = tempfile::tempdir().unwrap();
        let c = catalog(dir.path(), false);
        let listing = c.inspect(&json!({"repository": "o/n"}), 0).await.unwrap();
        assert_eq!(listing["files"].as_array().unwrap().len(), 1);
        assert_eq!(listing["license"], "apache-2.0");
        let preview = c.inspect(&json!({"repository": "o/n", "filename": "m.gguf"}), 0).await.unwrap();
        let model = &preview["model"];
        assert!(model["id"].as_str().unwrap().starts_with("hf-"));
        assert_eq!(model["contextWindow"], 16_384, "no GPU holds the default window");
        assert_eq!(model["supportsImages"], false);
        let id = preview["previewId"].as_str().unwrap();
        assert!(matches!(c.register(id, false), Err(HfError::Invalid(_))));
        let done = c.register(id, true).unwrap();
        assert_eq!(done["registered"], true);
        assert_eq!(c.registry().list().len(), 1);
        assert!(c.register(id, true).is_err(), "a used preview is consumed");
    }

    #[tokio::test]
    async fn gated_models_shards_traversal_and_bad_contexts_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        assert!(catalog(dir.path(), true).inspect(&json!({"repository": "o/n"}), 0).await.is_err());
        let c = catalog(dir.path(), false);
        for name in ["m-00001-of-00002.gguf", "../m.gguf", "a\\b.gguf"] {
            assert!(matches!(c.inspect(&json!({"repository": "o/n", "filename": name}), 0).await, Err(HfError::Invalid(_))), "{name}");
        }
        assert!(c.inspect(&json!({"repository": "o/n", "filename": "other.gguf"}), 0).await.is_err());
        assert!(c.inspect(&json!({"repository": "../x"}), 0).await.is_err());
        assert!(c.inspect(&json!({"repository": "o/n", "filename": "m.gguf", "contextWindow": 1000}), 0).await.is_err());
    }

    #[test]
    fn shards_and_ranges_are_recognised() {
        assert!(is_shard("x-00001-of-00004.GGUF") && !is_shard("x-1-of-4.gguf"));
        assert_eq!(content_range("bytes 0-9/100"), Some((9, 100)));
        assert_eq!(content_range("bytes 5-9/100"), None);
    }
}
