//! Scenario files: `tests/twin/scenarios/<suite>/<id>.json`. One scenario is everything both relays are given: the
//! relay knobs (the `startRelay` options `tests/twin/node/relay-host.mjs` accepts, written with the names and units of
//! its header), the files placed before the relay starts, the fakes' scripted answers, and the steps that drive it.
//!
//! Strings in a step (path, header names and values, bodies, frame text) may hold `${name}`: a value captured by an
//! earlier step, or one of `port`, `host` (127.0.0.1:port), `scheme` and `origin` of the relay running at that moment.
//! Timestamps a scenario places in files must be more than 400 days away from the run (the normaliser treats numbers
//! and ISO dates inside that window as run-relative times).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use mixdog_fsio::Unlaned;
use serde::Deserialize;
use serde_json::{Map, Value};

/// Bytes written to a file or the wire: a string is UTF-8 text, `{"base64": "..."}` is binary.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Base64 { base64: String },
}

impl Content {
    /// The bytes, after `${name}` substitution of a text content by `subst`.
    pub fn bytes(&self, subst: &dyn Fn(&str) -> Result<String, String>) -> Result<Vec<u8>, String> {
        match self {
            Self::Text(text) => subst(text).map(String::into_bytes),
            Self::Base64 { base64 } => {
                base64::engine::general_purpose::STANDARD.decode(base64).map_err(|e| format!("bad base64 content: {e}"))
            }
        }
    }

    /// The bytes of a content that holds no `${...}` (files placed before the relay starts).
    pub fn literal_bytes(&self) -> Result<Vec<u8>, String> {
        self.bytes(&|text| Ok(text.to_owned()))
    }
}

/// The files placed under the scratch directory of each run before the first relay start.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Files {
    /// Content of DATA_DIR, by relative path.
    #[serde(default)]
    pub data: BTreeMap<String, Content>,
    /// The renderer tree (`rendererDir`).
    #[serde(default)]
    pub renderer: BTreeMap<String, Content>,
    /// The releases registry tree (`rendererReleasesDir`): `index.json` and one directory per release.
    #[serde(default)]
    pub releases: BTreeMap<String, Content>,
    /// The `mobile-release.json` object (the host writes it beside the relay program).
    #[serde(default)]
    pub mobile_release: Option<Value>,
    /// Serve over TLS with a throwaway certificate the harness client trusts.
    #[serde(default)]
    pub tls: bool,
}

/// Public keys signatures in the transcript are verified against.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Keys {
    /// Base64url, uncompressed SEC1 point, of the keys ES256 JWTs (VAPID) are signed with.
    #[serde(default)]
    pub vapid_public: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    #[default]
    Plain,
    Desktop,
    Hook,
    Phone,
}

impl Role {
    pub fn name(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Desktop => "desktop",
            Self::Hook => "hook",
            Self::Phone => "phone",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureFrom {
    /// A dotted path into the JSON body.
    BodyJson,
    /// Group 1 of a regex over the body text.
    BodyRegex,
    /// A response header by name, optionally narrowed by group 1 of a regex.
    Header,
    /// A dotted path into the JSON of a frame received in this step (`index`, default the last).
    FrameJson,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capture {
    pub var: String,
    pub from: CaptureFrom,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub regex: Option<String>,
    #[serde(default)]
    pub index: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataOp {
    Text,
    Binary,
}

/// One frame (or a run of bytes) a client writes. Frames are masked with a fixed key.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FrameSpec {
    Text {
        text: String,
    },
    Binary {
        data: Content,
    },
    Ping {
        #[serde(default)]
        data: Option<Content>,
    },
    Pong {
        #[serde(default)]
        data: Option<Content>,
    },
    Close {
        #[serde(default)]
        code: Option<u16>,
        #[serde(default)]
        reason: Option<String>,
    },
    /// The bytes as they are: no framing is added.
    Raw {
        data: Content,
    },
    /// A frame whose header declares `declared` payload bytes while only `send` of them follow.
    Oversize {
        op: DataOp,
        declared: u64,
        send: u64,
    },
    /// One message sent as a first frame and continuation frames, one per part.
    Fragmented {
        op: DataOp,
        parts: Vec<Content>,
    },
    /// Several frames written with one write.
    Coalesced {
        frames: Vec<FrameSpec>,
    },
}

fn default_method() -> String {
    "GET".to_owned()
}
fn default_probe_ms() -> u64 {
    300
}
fn default_timeout_ms() -> u64 {
    10_000
}
fn default_conn() -> String {
    "c".to_owned()
}
fn default_expect_timeout_ms() -> u64 {
    5_000
}
fn default_tolerance_ms() -> u64 {
    10_000
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HttpStep {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<Content>,
    /// The whole request as bytes (replaces method, path, headers and body).
    #[serde(default)]
    pub raw: Option<Content>,
    #[serde(default)]
    pub expect_status: Option<u16>,
    #[serde(default)]
    pub capture: Vec<Capture>,
    /// How long to wait, after the answer, to see whether the relay closes the connection.
    #[serde(default = "default_probe_ms")]
    pub close_probe_ms: u64,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WsOpenStep {
    #[serde(default = "default_conn")]
    pub conn: String,
    pub path: String,
    #[serde(default)]
    pub role: Role,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// `[user, password]`: sends `Authorization: Basic`.
    #[serde(default)]
    pub basic: Option<(String, String)>,
    /// The status of the upgrade answer (101 when the socket opens).
    #[serde(default)]
    pub expect_status: Option<u16>,
    #[serde(default)]
    pub capture: Vec<Capture>,
    #[serde(default = "default_probe_ms")]
    pub close_probe_ms: u64,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendStep {
    #[serde(default = "default_conn")]
    pub conn: String,
    pub frame: FrameSpec,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExpectStep {
    #[serde(default = "default_conn")]
    pub conn: String,
    /// Text and binary messages to wait for.
    #[serde(default)]
    pub frames: usize,
    /// Wait for the TCP close.
    #[serde(default)]
    pub close: bool,
    /// The code of the first close frame received.
    #[serde(default)]
    pub close_code: Option<u16>,
    #[serde(default = "default_expect_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub capture: Vec<Capture>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Step {
    Http(HttpStep),
    WsOpen(WsOpenStep),
    Send(SendStep),
    Expect(ExpectStep),
    Wait {
        ms: u64,
    },
    /// Stop the relay and start it again over the same DATA_DIR.
    Restart,
    /// Stop the relay and start the other runtime over the same DATA_DIR (twin_crossover); elsewhere a restart.
    Crossover,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub id: String,
    #[serde(default)]
    pub description: String,
    /// The relay knobs, with the names and units of `relay-host.mjs`. `dataDir`, `rendererDir`,
    /// `rendererReleasesDir`, `tlsCert`, `tlsKey`, `mobileRelease` and `fakes` are written by the harness.
    #[serde(default)]
    pub knobs: Map<String, Value>,
    #[serde(default)]
    pub files: Files,
    /// The `fakes` of the host contract.
    #[serde(default)]
    pub fakes: Value,
    #[serde(default)]
    pub keys: Keys,
    /// How far apart two times of one event may be between the runs.
    #[serde(default = "default_tolerance_ms")]
    pub time_tolerance_ms: u64,
    pub steps: Vec<Step>,
}

impl Scenario {
    pub fn has_crossover(&self) -> bool {
        self.steps.iter().any(|step| matches!(step, Step::Crossover))
    }
}

/// A scenario file, its suite (the directory) and its id (the file stem, equal to the `id` field).
pub fn parse(suite: &str, file_stem: &str, text: &str) -> Result<Scenario, String> {
    let scenario: Scenario = serde_json::from_str(text).map_err(|e| format!("{suite}/{file_stem}: {e}"))?;
    if scenario.id != file_stem {
        return Err(format!("{suite}/{file_stem}: id \"{}\" differs from the file name", scenario.id));
    }
    for key in ["dataDir", "rendererDir", "rendererReleasesDir", "tlsCert", "tlsKey", "mobileRelease", "fakes", "port"]
    {
        if scenario.knobs.contains_key(key) {
            return Err(format!("{suite}/{file_stem}: knob {key} is written by the harness"));
        }
    }
    Ok(scenario)
}

pub fn scenarios_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/twin/scenarios")
}

/// Every scenario of every suite, sorted by suite and id.
pub fn load_all() -> Result<Vec<(String, Scenario)>, String> {
    let mut found = Vec::new();
    let suites = mixdog_fsio::read_dir(&Unlaned, scenarios_dir()).map_err(|e| format!("scenarios dir: {e}"))?;
    for suite in suites {
        let suite = suite.map_err(|e| e.to_string())?;
        if !suite.file_type(&Unlaned).map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let name = suite.file_name().to_string_lossy().into_owned();
        for file in mixdog_fsio::read_dir(&Unlaned, suite.path()).map_err(|e| e.to_string())? {
            let path = file.map_err(|e| e.to_string())?.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let text = mixdog_fsio::read_to_string(&Unlaned, &path).map_err(|e| format!("{}: {e}", path.display()))?;
            found.push((name.clone(), parse(&name, &stem, &text)?));
        }
    }
    found.sort_by(|a, b| (&a.0, &a.1.id).cmp(&(&b.0, &b.1.id)));
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scenario_parses_with_every_step_kind() {
        let text = r#"{
          "id": "all", "knobs": {"handshakeStallMs": 50},
          "files": {"data": {"a.json": "{}"}, "renderer": {"x.bin": {"base64": "AAE="}}, "tls": true},
          "steps": [
            {"do": "http", "path": "/healthz", "headers": [["Accept", "*/*"]], "expect_status": 200},
            {"do": "ws_open", "path": "/ws", "role": "phone", "basic": ["u", "p"]},
            {"do": "send", "frame": {"kind": "coalesced", "frames": [{"kind": "text", "text": "a"}, {"kind": "ping"}]}},
            {"do": "send", "frame": {"kind": "oversize", "op": "binary", "declared": 70000, "send": 3}},
            {"do": "send", "frame": {"kind": "fragmented", "op": "text", "parts": ["a", "b"]}},
            {"do": "expect", "frames": 1, "close": true, "close_code": 1009},
            {"do": "wait", "ms": 5}, {"do": "restart"}, {"do": "crossover"}
          ]}"#;
        let scenario = parse("suite", "all", text).unwrap();
        assert_eq!(scenario.steps.len(), 9);
        assert!(scenario.has_crossover());
        assert!(scenario.files.tls);
        assert_eq!(scenario.files.renderer["x.bin"].literal_bytes().unwrap(), vec![0, 1]);
    }

    #[test]
    fn a_misspelt_key_or_a_mismatched_id_is_refused() {
        assert!(parse("s", "x", r#"{"id":"x","steps":[{"do":"http","pth":"/"}]}"#).is_err());
        assert!(parse("s", "y", r#"{"id":"x","steps":[]}"#).is_err());
        assert!(parse("s", "x", r#"{"id":"x","knobs":{"dataDir":"/a"},"steps":[]}"#).is_err());
    }

    #[test]
    fn substitution_applies_to_text_only() {
        let replace = |s: &str| Ok(s.replace("${a}", "1"));
        assert_eq!(Content::Text("x${a}".into()).bytes(&replace).unwrap(), b"x1");
        assert_eq!(Content::Base64 { base64: "JHthfQ==".into() }.bytes(&replace).unwrap(), b"${a}");
    }
}
