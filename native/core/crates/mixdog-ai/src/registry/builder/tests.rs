use serde_json::json;

use super::*;
use crate::oauth::CredentialIo;
use crate::providers::google::traits::ThinkingControl;
use crate::providers::openai::config::NoFacts;
use crate::registry::keys::Environment;
use crate::registry::keys::MemoryVault;
use crate::registry::keys::ProcessEnv;
use crate::transport::KeepaliveDialer;
use crate::transport::KeepaliveSchedule;
use crate::transport::ReqwestLink;

struct Traits;

impl ModelTraits for Traits {
    fn is_gemini_family(&self, _: &str) -> bool {
        true
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

fn builder(dir: &tempfile::TempDir) -> DefaultProviderBuilder {
    builder_with(dir, Arc::new(ProcessEnv))
}

fn builder_with(dir: &tempfile::TempDir, env: Arc<dyn Environment>) -> DefaultProviderBuilder {
    let tokens = mixdog_rt::testing::tokens();
    let link = Arc::new(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap());
    DefaultProviderBuilder::new(BuilderEnv {
        http: link.clone(),
        bidi: link,
        dial: Arc::new(KeepaliveDialer::new(KeepaliveSchedule::SPEC)),
        keys: ApiKeyStore::new(Arc::new(MemoryVault::default()), env.clone(), false),
        accounts: AccountStore::new(
            dir.path().to_path_buf(),
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        ),
        anthropic_caps: Arc::new(|_| None),
        google_traits: Arc::new(Traits),
        openai_facts: Arc::new(NoFacts),
        openai_context: Arc::new(SessionContext::new()),
        codex_identity: CodexIdentity {
            installation_id: "i".into(),
            user_agent: "ua".into(),
            version: "1".into(),
            beta_features: String::new(),
        },
        pace: Arc::new(crate::oauth::pace::FakePace::default()),
        gzip_lane: tokens.cpu_bulk,
        client_version: "1.0.0".into(),
        client_versions: None,
        grok_client_version: None,
        cursor_client_version: None,
        antigravity_client_version: "1.0.0".into(),
        listing: crate::catalog::ListingLookup::new(),
        env,
        home_dir: dir.path().to_path_buf(),
        io: CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        gated_off: Arc::new(|name| name == "gated"),
    })
}

async fn id_of(b: &DefaultProviderBuilder, name: &str, cfg: Value) -> String {
    b.build(name, &cfg).await.unwrap_or_else(|e| panic!("{name}: {e}")).id().to_string()
}

#[tokio::test]
async fn each_family_builds_under_its_own_id() {
    let dir = tempfile::tempdir().unwrap();
    let b = builder(&dir);
    for name in ["anthropic", "openai", "gemini", "xai", "deepseek", "openrouter", "cursor-api"] {
        assert_eq!(id_of(&b, name, json!({"enabled": true, "apiKey": "k"})).await, name);
    }
    let custom = json!({"type": "custom", "protocol": "openai-chat", "baseURL": "http://localhost:1/v1/",
        "apiKey": "k", "headers": {"X-A": "1"}, "requestBody": {"top_k": 5}});
    assert_eq!(id_of(&b, "custom-abc", custom).await, "custom-abc");
}

/// `describeVertexAdc` against Node's (`fixtures/vertex-adc/golden.json`, `record-vertex-adc.mjs`):
/// the gcloud login the settings show, over ADC files and gcloud configuration seeded in a folder.
mod adc {
    use std::collections::HashMap;

    use super::*;

    const GOLDEN: &str = include_str!("../../../../../fixtures/vertex-adc/golden.json");

    struct MapEnv(HashMap<String, String>);

    impl Environment for MapEnv {
        fn var(&self, name: &str) -> Option<String> {
            self.0.get(name).cloned()
        }
    }

    /// Paths as the recording wrote them: the folder is `{dir}`, `/` separates.
    fn normalized(value: &Value, dir: &str) -> Value {
        match value {
            Value::String(text) => Value::String(text.replace(dir, "{dir}").replace('\\', "/")),
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), normalized(v, dir))).collect()),
            other => other.clone(),
        }
    }

    #[tokio::test]
    async fn every_login_is_described_as_node_does() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let scenarios = golden["scenarios"].as_array().unwrap();
        assert_eq!(scenarios.len(), 28);
        for scenario in scenarios {
            let dir = tempfile::tempdir().unwrap();
            for (relative, text) in scenario["files"].as_object().unwrap() {
                let path = dir.path().join(relative);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, text.as_str().unwrap()).unwrap();
            }
            let mut env: HashMap<String, String> =
                scenario["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
            if scenario["mode"] == "explicit" {
                env.insert("GOOGLE_APPLICATION_CREDENTIALS".into(), dir.path().join("creds").join("key.json").to_string_lossy().into_owned());
            } else {
                env.insert("CLOUDSDK_CONFIG".into(), dir.path().to_string_lossy().into_owned());
            }
            let builder = builder_with(&dir, Arc::new(MapEnv(env)));
            // A metadata server an earlier probe found (or did not).
            if scenario.get("metadata").is_some() {
                builder.metadata_project.set(scenario["metadata"].as_str().map(str::to_owned)).unwrap();
            }
            let described = builder.adc_describe(scenario["override"].as_str().unwrap(), false).await;
            let got = normalized(&described, &dir.path().to_string_lossy());
            assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&scenario["described"]).unwrap(), "{}", scenario["name"]);
        }
    }
}
#[tokio::test]
async fn a_name_without_an_adapter_says_why() {
    let dir = tempfile::tempdir().unwrap();
    let b = builder(&dir);
    let err = |name: &str, cfg: Value| {
        let b = &b;
        let name = name.to_owned();
        async move { b.build(&name, &cfg).await.err().unwrap() }
    };
    assert_eq!(err("nope", json!({})).await, "unknown enabled provider: nope");
    assert_eq!(
        err("mixdog-local", json!({})).await,
        "mixdog-local is built per turn from the managed runtime's endpoint"
    );
    let wires = |protocol: &str, extra: Value| {
        let mut cfg = json!({"type": "custom", "protocol": protocol, "baseURL": "http://x/v1"});
        cfg.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        cfg
    };
    let bad = err("custom-1", wires("anthropic", json!({"wires": ["messages"]}))).await;
    assert_eq!(bad, "[custom-provider] wires requires an 'openai-chat' or 'openai-responses' protocol");
    assert_eq!(
        err("custom-1", wires("openai-chat", json!({"wires": ["responses"]}))).await,
        "[custom-provider] wires must include the protocol wire: chat"
    );
    assert_eq!(
        err("custom-1", wires("openai-chat", json!({"wires": ["chat", "messages"], "modelWires": {"m": "responses"}}))).await,
        "[custom-provider] modelWires[m] must be one of the served wires: chat, messages"
    );
    // The anthropic protocol and a multi-wire endpoint both build.
    let ok = |cfg: Value| {
        let b = &b;
        async move { b.build("custom-1", &cfg).await.is_ok() }
    };
    assert!(ok(wires("anthropic", json!({}))).await);
    assert!(ok(wires("openai-chat", json!({"wires": ["messages", "chat"], "modelWires": {"c": "messages"}}))).await);
    assert!(!b.available("gated") && b.available("openai"));
    assert!(!b.oauth_credentials_usable("openai-oauth").await.unwrap());
}