//! `fixtures/services/media-accounts-twin.json` (`record-media-accounts.mjs`): Node's
//! `withProviderAccount` scopes over a real account roster. For every scope the account and
//! credential file each lane resolves to, the refusals, and the lane catalog listed in that scope
//! (pinned and unpinned) must equal Node's. The recording holds `{data}` for its data folder.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::accounts::{AccountProbe, AccountScope, ScopedLaneSources, SelectedAccounts, media_lane_account_provider};
use super::catalog::CatalogFailure;
use super::lanes::{CatalogRows, MediaLanes, lane_auth_provider};

const GOLDEN: &str = include_str!("../../../../fixtures/services/media-accounts-twin.json");

fn fill(value: &Value, data: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace("{data}", data)),
        Value::Array(items) => Value::Array(items.iter().map(|item| fill(item, data)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), fill(item, data))).collect()),
        other => other.clone(),
    }
}

struct Selected(Value);

#[async_trait]
impl SelectedAccounts for Selected {
    async fn selected(&self, provider: &str) -> Option<String> {
        self.0[provider].as_str().map(str::to_owned)
    }
}

/// The recorder's credentials: an account's file counts when it exists, the default account's
/// when its provider is one of `default_creds`.
struct Probe {
    default_creds: Vec<String>,
}

#[async_trait]
impl AccountProbe for Probe {
    async fn authenticated(&self, lane_id: &str, account: Option<&Path>) -> bool {
        match account {
            Some(path) => path.exists(),
            None => lane_auth_provider(lane_id).is_some_and(|provider| self.default_creds.iter().any(|d| d == provider)),
        }
    }

    async fn models(&self, _: &str, _: Option<&Path>) -> Result<CatalogRows, CatalogFailure> {
        Ok(CatalogRows::default())
    }
}

#[test]
fn the_account_provider_of_a_lane_matches_nodes() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["providerOf"].as_array().unwrap() {
        let lane = case["lane"].as_str().unwrap_or_default();
        // `null`, `undefined` and `7` are not lane ids: `String(laneId || '')` makes them ''
        // or a name no lane has.
        let lane = if case["lane"].is_number() { "7" } else { lane };
        assert_eq!(media_lane_account_provider(lane), case["provider"].as_str().unwrap(), "{}", case["lane"]);
    }
}

#[tokio::test]
async fn scopes_resolve_accounts_and_lists_as_nodes_do() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let data = scratch.path().to_path_buf();
    let shown = data.to_string_lossy().into_owned();
    for file in golden["files"].as_array().unwrap() {
        let path = data.join(file.as_str().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "{}").unwrap();
    }
    let selected: Arc<dyn SelectedAccounts> = Arc::new(Selected(golden["selected"].clone()));
    let probe: Arc<dyn AccountProbe> = Arc::new(Probe { default_creds: golden["defaultCreds"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect() });
    for recorded in golden["scopes"].as_array().unwrap() {
        let chain = &recorded["chain"];
        let host: Vec<(String, std::path::PathBuf)> = recorded["host"]
            .as_object()
            .map(|bound| bound.iter().map(|(provider, path)| (provider.clone(), std::path::PathBuf::from(path.as_str().unwrap().replace("{data}", &shown)))).collect())
            .unwrap_or_default();
        let mut scope = Ok(AccountScope::under_host(host));
        for pair in chain.as_array().unwrap() {
            scope = scope.and_then(|scope| scope.with(&data, pair[0].as_str().unwrap(), pair[1].as_str().unwrap()));
        }
        let scope = match (scope, recorded.get("error")) {
            (Err(got), Some(want)) => {
                assert_eq!(json!(got), *want, "{chain}");
                continue;
            }
            (Ok(scope), None) => scope,
            (got, want) => panic!("{chain}: {got:?} vs recorded {want:?}"),
        };
        let want = fill(recorded, &shown);
        let chain = &json!({ "host": recorded["host"], "chain": chain });
        let mut lanes: Vec<Value> = Vec::new();
        for row in want["lanes"].as_array().unwrap() {
            let lane = row["lane"].as_str().unwrap();
            let provider = media_lane_account_provider(lane);
            let (id, path) = if provider.is_empty() {
                (None, None)
            } else {
                (Some(scope.account_id(provider, selected.as_ref()).await), scope.auth_path(&data, provider, selected.as_ref()).await)
            };
            lanes.push(json!({ "lane": lane, "provider": provider, "id": id, "path": path.map(|p| p.to_string_lossy().into_owned()) }));
        }
        assert_eq!(serde_json::to_string(&lanes).unwrap(), serde_json::to_string(&want["lanes"]).unwrap(), "{chain}: accounts and files");
        let sources = ScopedLaneSources { data_dir: data.clone(), scope, selected: selected.clone(), probe: probe.clone() };
        let listed = MediaLanes::new(Arc::new(sources)).list(None).await;
        assert_eq!(serde_json::to_string(&listed).unwrap(), serde_json::to_string(&want["listed"]).unwrap(), "{chain}: lane catalog");
    }
}
