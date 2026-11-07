//! Media generation lanes (`runtime/media/lanes.mjs`): each lane is one credential path we can
//! generate with. A lane is offered only when its credential exists, and an unauthenticated lane
//! fails closed: no lane falls back to another lane's credential.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::catalog::CatalogFailure;
use super::catalog::Model;
use super::catalog::catalog_diagnostic;
use super::catalog::project_media_models;

/// `MEDIA_KINDS`.
pub const MEDIA_KINDS: [&str; 2] = ["image", "video"];

/// `mediaError(message, code, status)`.
#[derive(Debug, Clone, PartialEq)]
pub struct LaneError {
    pub message: String,
    pub code: &'static str,
    pub status: u16,
}

fn media_error(message: impl Into<String>, code: &'static str, status: u16) -> LaneError {
    LaneError { message: message.into(), code, status }
}

/// A lane's catalog rows as the loader answers them (`rows.catalogWarning` rides along when the
/// last successful catalog stands in for an outage).
#[derive(Debug, Clone, Default)]
pub struct CatalogRows {
    pub rows: Vec<Value>,
    pub warning: Option<String>,
}

/// What the lanes read of the world: the credential probe and the live model catalog.
#[async_trait]
pub trait LaneSources: Send + Sync + 'static {
    /// `laneAuthenticated(lane)`: a file-level credential check, never a network call.
    async fn authenticated(&self, lane: &str) -> bool;
    /// `loadMediaModels(lane)`: single-flight per credential, so a listing that gave up waiting
    /// can be joined by the next one.
    async fn models(&self, lane: &str) -> Result<CatalogRows, CatalogFailure>;
}

struct LaneDef {
    id: &'static str,
    label: &'static str,
    auth_type: &'static str,
    auth_provider: &'static str,
    image: Option<Value>,
    video: Option<Value>,
}

fn grok_aspects() -> Value {
    json!(["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"])
}

fn grok_image() -> Value {
    json!({ "aspectRatio": grok_aspects(), "resolution": ["1k", "2k"], "maxReferences": 5 })
}

fn grok_video() -> Value {
    // 1 ref = image-to-video, 2-7 = reference-to-video.
    json!({ "aspectRatio": grok_aspects(), "resolution": ["480p", "720p", "1080p"], "durationRange": [1, 15], "maxReferences": 7 })
}

fn gemini_image_controls() -> Value {
    json!({ "aspectRatio": ["auto", "1:1", "16:9", "9:16", "4:3", "3:4"], "maxReferences": 3 })
}

fn lanes() -> Vec<LaneDef> {
    vec![
        LaneDef { id: "grok-oauth", label: "Grok Imagine", auth_type: "oauth", auth_provider: "grok-oauth", image: Some(grok_image()), video: Some(grok_video()) },
        LaneDef { id: "xai", label: "Grok Imagine", auth_type: "api-key", auth_provider: "xai", image: Some(grok_image()), video: Some(grok_video()) },
        LaneDef {
            id: "openai-oauth",
            label: "OpenAI Images",
            auth_type: "oauth",
            auth_provider: "openai-oauth",
            image: Some(json!({ "maxReferences": 5, "background": ["auto", "transparent", "opaque"] })),
            video: None,
        },
        LaneDef {
            id: "gemini",
            label: "Google Gemini",
            auth_type: "api-key",
            auth_provider: "gemini",
            image: Some(gemini_image_controls()),
            // Veo 3.1 accepts discrete clip lengths; it takes a single start frame (Omni overrides this).
            video: Some(json!({ "aspectRatio": ["16:9", "9:16"], "resolution": ["720p", "1080p"], "durations": [4, 6, 8], "maxReferences": 1 })),
        },
        // The gateway lists Nano Banana image models only: the lane never advertises a video kind.
        LaneDef { id: "antigravity-oauth", label: "Google Antigravity", auth_type: "oauth", auth_provider: "antigravity-oauth", image: Some(gemini_image_controls()), video: None },
        // Gateway lanes on the normalized Image API: every model advertises its own parameters.
        LaneDef { id: "openrouter", label: "OpenRouter", auth_type: "api-key", auth_provider: "openrouter", image: Some(json!({})), video: None },
        LaneDef { id: "nano-gpt", label: "NanoGPT", auth_type: "api-key", auth_provider: "nano-gpt", image: Some(json!({})), video: None },
    ]
}

/// `LANE_BY_ID.get(String(laneId || '').trim())?.auth.provider`.
pub fn lane_auth_provider(lane_id: &str) -> Option<&'static str> {
    let id = js_trim(lane_id);
    lanes().into_iter().find(|lane| lane.id == id).map(|lane| lane.auth_provider)
}

/// `LANE_BY_ID.get(id)?.auth`: `(type, provider)`.
pub fn lane_auth(lane_id: &str) -> Option<(&'static str, &'static str)> {
    let id = js_trim(lane_id);
    lanes().into_iter().find(|lane| lane.id == id).map(|lane| (lane.auth_type, lane.auth_provider))
}

impl LaneDef {
    fn spec(&self, kind: &str) -> Option<&Value> {
        if kind == "video" { self.video.as_ref() } else { self.image.as_ref() }
    }
}

/// `laneKindView(lane, kind, models)`: each model publishes its effective controls (the lane's
/// plus its own), so the UI never offers a knob the model rejects.
fn lane_kind_view(lane: &LaneDef, kind: &str, models: &[Model]) -> Value {
    let Some(lane_controls) = lane.spec(kind) else { return Value::Null };
    if models.is_empty() {
        return Value::Null;
    }
    let rows: Vec<Value> = models
        .iter()
        .map(|model| {
            let mut controls: Map<String, Value> = lane_controls.as_object().cloned().unwrap_or_default();
            if let Some(own) = model.controls.as_object() {
                controls.extend(own.clone());
            }
            let mut row = Map::new();
            row.insert("id".into(), json!(model.id));
            row.insert("label".into(), json!(model.label));
            if let Some(description) = model.description.as_deref().filter(|d| !d.is_empty()) {
                row.insert("description".into(), json!(description));
            }
            if let Some(request) = model.request_model.as_deref().filter(|r| !r.is_empty()) {
                row.insert("requestModel".into(), json!(request));
            }
            row.insert("controls".into(), Value::Object(controls));
            Value::Object(row)
        })
        .collect();
    json!({ "models": rows, "defaultModel": models[0].id, "controls": lane_controls })
}

/// A resolved request: the lane's view, the kind, the model that will really be used, and the
/// kind's view of the lane.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedRequest {
    pub lane: Value,
    pub kind: String,
    pub model: String,
    pub spec: Value,
}

/// `createMediaLaneCatalog({ loadModels, authenticated })`.
pub struct MediaLanes {
    sources: Arc<dyn LaneSources>,
}

impl MediaLanes {
    pub fn new(sources: Arc<dyn LaneSources>) -> Self {
        Self { sources }
    }

    /// `laneView(lane, budgetMs)`; `None` for a lane whose billing is blocked (unusable
    /// connections are absent from public catalogs).
    async fn lane_view(&self, lane: &LaneDef, budget: Option<Duration>) -> Option<Value> {
        let signed_in = self.sources.authenticated(lane.id).await;
        let mut view = json!({
            "id": lane.id,
            "label": lane.label,
            "authType": lane.auth_type,
            "authProvider": lane.auth_provider,
            "authenticated": signed_in,
            "supportedKinds": MEDIA_KINDS.iter().filter(|kind| lane.spec(kind).is_some()).collect::<Vec<_>>(),
            "kinds": [],
            "image": Value::Null,
            "video": Value::Null,
        });
        if !signed_in {
            return Some(view);
        }
        let sources = self.sources.clone();
        let id = lane.id;
        let loading = tokio::spawn(async move { sources.models(id).await });
        let loaded = match budget {
            // The request keeps running: the loader's single flight lets the next listing join it.
            Some(budget) => {
                let mut loading = loading;
                match tokio::time::timeout(budget, &mut loading).await {
                    Ok(joined) => Some(joined),
                    Err(_) => None,
                }
            }
            None => Some(loading.await),
        };
        let Some(loaded) = loaded else {
            // Still loading, not empty: the caller shows that and asks again.
            view["catalogPending"] = json!(true);
            return Some(view);
        };
        let result = loaded.unwrap_or_else(|_| Err(CatalogFailure::default()));
        match result {
            Ok(CatalogRows { rows, warning }) => {
                let models = project_media_models(lane.id, &rows);
                if let Some(warning) = warning {
                    view["catalogWarning"] = json!(warning);
                }
                let mut kinds = Vec::new();
                for kind in MEDIA_KINDS {
                    let kind_view = lane_kind_view(lane, kind, models.of(kind));
                    if !kind_view.is_null() {
                        kinds.push(kind);
                    }
                    view[kind] = kind_view;
                }
                view["kinds"] = json!(kinds);
            }
            Err(failure) => {
                let (code, message) = catalog_diagnostic(&failure);
                if code == "MEDIA_BILLING_BLOCKED" {
                    return None;
                }
                view["catalogErrorCode"] = json!(code);
                view["catalogError"] = json!(format!("{} ({}): {}", lane.label, if lane.auth_type == "oauth" { "Account" } else { "API key" }, message));
            }
        }
        Some(view)
    }

    /// `listMediaLanes({ budgetMs })`: the live catalog shared by Studio and the model-facing
    /// media tool. `budget` bounds the wait per lane.
    pub async fn list(&self, budget: Option<Duration>) -> Vec<Value> {
        let defs = lanes();
        futures::future::join_all(defs.iter().map(|lane| self.lane_view(lane, budget))).await.into_iter().flatten().collect()
    }

    /// `resolveMediaRequest({ lane, kind, model })`.
    pub async fn resolve(&self, lane: &str, kind: &str, model: &str) -> Result<ResolvedRequest, LaneError> {
        let kind_name = js_trim(kind);
        if !MEDIA_KINDS.contains(&kind_name) {
            return Err(media_error(format!("unsupported media kind \"{kind_name}\""), "MEDIA_KIND_UNSUPPORTED", 400));
        }
        let lane_id = js_trim(lane);
        let defs = lanes();
        let Some(definition) = defs.iter().find(|d| d.id == lane_id) else {
            return Err(media_error(format!("unknown media lane \"{lane}\""), "MEDIA_LANE_UNKNOWN", 400));
        };
        if definition.spec(kind_name).is_none() {
            return Err(media_error(format!("{} does not support {kind_name}", definition.id), "MEDIA_KIND_UNSUPPORTED", 400));
        }
        let Some(view) = self.lane_view(definition, None).await else {
            return Err(media_error("The selected media model is not available.", "MEDIA_MODEL_UNSUPPORTED", 400));
        };
        if view["authenticated"] != json!(true) {
            return Err(media_error(
                format!("{} is not authenticated — sign in from Settings → Providers first", definition.label),
                "MEDIA_LANE_UNAUTHENTICATED",
                400,
            ));
        }
        if let Some(error) = view.get("catalogError").and_then(Value::as_str) {
            let code = match view.get("catalogErrorCode").and_then(Value::as_str) {
                Some(code) => static_code(code),
                None => "MEDIA_CATALOG_UNAVAILABLE",
            };
            return Err(media_error(error, code, 503));
        }
        let spec = view[kind_name].clone();
        let requested = if js_trim(model).is_empty() { spec["defaultModel"].as_str().unwrap_or_default().to_owned() } else { js_trim(model).to_owned() };
        let offered = spec["models"].as_array().is_some_and(|models| models.iter().any(|entry| entry["id"].as_str() == Some(requested.as_str())));
        if !offered {
            return Err(media_error(format!("model \"{requested}\" is not available on {}/{kind_name}", definition.id), "MEDIA_MODEL_UNSUPPORTED", 400));
        }
        Ok(ResolvedRequest { lane: view, kind: kind_name.to_owned(), model: requested, spec })
    }
}

fn js_trim(text: &str) -> &str {
    mixdog_js::js_trim(text)
}

/// The catalog diagnostics' codes are the six `catalog_diagnostic` can answer.
fn static_code(code: &str) -> &'static str {
    ["MEDIA_BILLING_BLOCKED", "MEDIA_AUTH_REJECTED", "MEDIA_ACCESS_DENIED", "MEDIA_RATE_LIMITED", "MEDIA_CATALOG_TIMEOUT", "MEDIA_CATALOG_UNAVAILABLE"]
        .into_iter()
        .find(|known| *known == code)
        .unwrap_or("MEDIA_CATALOG_UNAVAILABLE")
}
