//! The Codex identity block of the `openai-oauth` WebSocket
//! (`openai-codex-metadata.mjs`): the installation/session/thread/turn/window
//! values that ride every `response.create` frame as `client_metadata` and,
//! in their prewarm form, the handshake headers. Pure: the clock and the
//! installation id are inputs.

use mixdog_core_api::domain::provider::ModelRequest;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

const MESSAGE: &str = "mixdog-session";

fn clean(value: Option<&str>) -> &str {
    value.map_or("", str::trim)
}

fn is_v7(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 36
        && [8, 13, 18, 23].iter().all(|&i| b[i] == b'-')
        && b[14] == b'7'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
        && b.iter().enumerate().all(|(i, c)| [8, 13, 18, 23].contains(&i) || c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// `_codexUuidV7`: a v7 id passes unchanged; anything else maps to the v7-shaped
/// id of its SHA-256.
pub fn codex_uuid_v7(value: &str) -> String {
    let clean = value.trim().to_lowercase();
    if is_v7(&clean) {
        return clean;
    }
    let digest = Sha256::digest(clean.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

/// `_sessionStartedAtUnixMs`: the stamp a v7 session id or a `_<digits>_` part
/// carries, else `now_ms`.
fn session_started_at(session: &str, now_ms: u64) -> u64 {
    let compact: String = session.trim().chars().filter(|c| *c != '-').collect();
    let cb = compact.as_bytes();
    if cb.len() == 32 && cb[12] == b'7' && cb.iter().all(u8::is_ascii_hexdigit)
        && let Ok(stamp) = u64::from_str_radix(&compact[..12], 16)
        && stamp > 0
    {
        return stamp;
    }
    for part in session.split('_') {
        if part.len() >= 12
            && part.bytes().all(|b| b.is_ascii_digit())
            && let Ok(stamp) = part.parse::<f64>()
            && stamp.is_finite()
            && stamp > 0.0
        {
            return stamp.floor() as u64;
        }
    }
    now_ms
}

pub struct Metadata {
    installation_id: String,
    session_id: String,
    thread_id: String,
    turn_id: String,
    window_id: String,
    turn_metadata: String,
}

impl Metadata {
    /// `_codexMetadataBase` for `request`. `handshake` builds the prewarm form
    /// (no turn, no trigger, no start stamp) the socket opens with.
    pub fn of(request: &ModelRequest, installation_id: &str, now_ms: u64, handshake: bool) -> Self {
        let options = &request.options;
        let cache_key = clean(options.prompt_cache_key.as_deref());
        let raw_session = [clean(options.session_id.as_deref()), clean(options.transport_scope.as_deref()), cache_key, MESSAGE]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or(MESSAGE);
        let thread = options.thread.as_ref();
        let thread_id_raw = thread.map(|t| t.id.to_string().trim().to_owned()).filter(|s| !s.is_empty());
        let raw_thread = thread_id_raw
            .as_deref()
            .or(Some(cache_key).filter(|s| !s.is_empty()))
            .unwrap_or(raw_session);
        let session_id = codex_uuid_v7(raw_session);
        let thread_id = codex_uuid_v7(raw_thread);
        let kind = Some(clean(options.request_kind.as_deref()))
            .filter(|k| !k.is_empty())
            .unwrap_or(if raw_session.contains(":compact") { "compaction" } else { "turn" });
        let prewarm = kind == "prewarm" || handshake;
        let explicit_turn = thread.and_then(|t| t.turn.as_ref()).map(|t| t.as_str().trim()).filter(|s| !s.is_empty());
        let turn_id = if prewarm {
            String::new()
        } else {
            codex_uuid_v7(&explicit_turn.map_or_else(|| format!("{raw_session}:turn"), str::to_owned))
        };
        let window_id = thread.map_or_else(|| format!("{thread_id}:0"), |t| format!("{}:{}", t.id, t.window));
        let started_at = session_started_at(raw_session, now_ms);
        let mut turn = Map::new();
        turn.insert("installation_id".into(), json!(installation_id));
        turn.insert("session_id".into(), json!(session_id));
        turn.insert("thread_id".into(), json!(thread_id));
        turn.insert("agent_name".into(), json!("/root"));
        turn.insert("turn_id".into(), json!(turn_id));
        turn.insert("window_id".into(), json!(window_id));
        turn.insert("request_kind".into(), json!(if prewarm { "prewarm" } else { kind }));
        turn.insert("thread_source".into(), json!("user"));
        if !prewarm {
            turn.insert("turn_trigger".into(), json!("user"));
        }
        turn.insert("sandbox".into(), json!("none"));
        turn.insert("sandbox_mode".into(), json!("danger-full-access"));
        turn.insert("auto_review_enabled".into(), json!(false));
        turn.insert("node_repl_auto_review_required".into(), json!(false));
        turn.insert("node_repl_disabled".into(), json!(false));
        if !prewarm {
            turn.insert("turn_started_at_unix_ms".into(), json!(started_at));
        }
        Self {
            installation_id: installation_id.to_owned(),
            session_id,
            thread_id,
            turn_id,
            window_id,
            turn_metadata: serde_json::to_string(&Value::Object(turn)).expect("a JSON object serializes"),
        }
    }

    /// `_codexWsCompatibilityHeaders`: what the handshake carries beyond the
    /// route's fixed headers. `tier` is the body's `service_tier`.
    pub fn handshake_headers(&self, model: &str, tier: Option<&str>) -> Vec<(String, String)> {
        let mut headers = vec![
            ("session-id".to_owned(), self.session_id.clone()),
            ("thread-id".to_owned(), self.thread_id.clone()),
            ("x-client-request-id".to_owned(), self.thread_id.clone()),
            ("x-codex-window-id".to_owned(), self.window_id.clone()),
            ("x-codex-turn-metadata".to_owned(), self.turn_metadata.clone()),
        ];
        let model = model.trim();
        if !model.is_empty() {
            let hint = match tier.map(str::trim).filter(|t| !t.is_empty()) {
                Some(tier) => format!("model={model};tier={tier}"),
                None => format!("model={model}"),
            };
            headers.push(("x-codex-routing-hint".to_owned(), hint));
        }
        headers
    }

    /// `_withCodexWsClientMetadata`: `frame` with its `client_metadata`.
    /// `turn_state` is the token the turn's earlier response issued.
    pub fn frame(&self, mut frame: Map<String, Value>, now_ms: u64, turn_state: Option<&str>) -> Map<String, Value> {
        let mut meta = Map::new();
        meta.insert("x-codex-installation-id".into(), json!(self.installation_id));
        meta.insert("session_id".into(), json!(self.session_id));
        meta.insert("thread_id".into(), json!(self.thread_id));
        meta.insert("turn_id".into(), json!(self.turn_id));
        meta.insert("x-codex-window-id".into(), json!(self.window_id));
        meta.insert("x-codex-turn-metadata".into(), json!(self.turn_metadata));
        if let Some(Value::Object(existing)) = frame.get("client_metadata") {
            meta.extend(existing.clone());
        }
        meta.insert("x-codex-ws-stream-request-start-ms".into(), json!(now_ms.to_string()));
        if let Some(token) = turn_state.filter(|t| !t.is_empty()) {
            meta.insert("x-codex-turn-state".into(), json!(token));
        }
        frame.insert("client_metadata".into(), Value::Object(meta));
        frame
    }
}
