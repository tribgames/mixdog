//! `OAuthProvider::forget` against Node's `forget<Provider>OAuthCredentials`
//! (`fixtures/oauth-forget/golden.json`, `record-oauth-forget.mjs`): the answer and what the
//! credential file holds afterwards, for all ten providers.

use mixdog_ai::oauth::{CredentialFile, CredentialIo, Probe};
use serde_json::Value;

use super::oauth_status::PROVIDERS;
use super::production::forget_file;

const GOLDEN: &str = include_str!("../../../../../fixtures/oauth-forget/golden.json");

async fn after(file: &CredentialFile) -> Value {
    match file.load_document().await {
        Probe::Present(document) => Value::Object(document),
        Probe::Absent | Probe::Unreadable => Value::Null,
    }
}

#[tokio::test]
async fn every_provider_forgets_as_node_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 31);
    let mut providers = std::collections::BTreeSet::new();
    for scenario in scenarios {
        let provider = scenario["provider"].as_str().unwrap();
        providers.insert(provider.to_owned());
        let dir = tempfile::tempdir().unwrap();
        let file = CredentialFile::new(dir.path().join("credentials.json"), io);
        if let Value::Object(before) = &scenario["before"] {
            file.save(&Value::Object(before.clone())).await.unwrap();
        }
        // Node's forget never touches the CLI's own credentials file (a sibling here).
        let cli = CredentialFile::new(dir.path().join(".claude").join("credentials.json"), io);
        if let Value::Object(side) = &scenario["cliFileBefore"] {
            cli.save(&Value::Object(side.clone())).await.unwrap();
        }
        let answer = forget_file(provider, &file).await.unwrap();
        if scenario.get("cliFileAfter").is_some() {
            assert_eq!(after(&cli).await, scenario["cliFileAfter"], "{provider}: {}", scenario["name"]);
        }
        let name = &scenario["name"];
        assert_eq!(answer, scenario["answer"], "{provider}: {name}");
        assert_eq!(after(&file).await, scenario["after"], "{provider}: {name}");
    }
    let wired: std::collections::BTreeSet<String> = PROVIDERS.iter().map(|id| (*id).to_owned()).collect();
    assert_eq!(providers, wired, "the golden covers every provider the admin lists");
}
