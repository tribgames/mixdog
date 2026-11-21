//! `set_media_default`: the checks against the lane catalog and the account roster, and the pin it writes.

use std::sync::Mutex;

use serde_json::Value;
use serde_json::json;

use super::*;
use crate::setup::media_default::ProviderAccounts;

struct Catalog {
    lanes: Value,
    pins: Mutex<Vec<Value>>,
}

#[async_trait]
impl DomainCalls for Catalog {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        match method {
            "media/listMediaLanes" => Ok(self.lanes.clone()),
            "media/setMediaPin" => {
                self.pins.lock().unwrap().push(params["input"].clone());
                Ok(json!({ "pinned": true }))
            }
            other => panic!("unexpected domain call {other}"),
        }
    }
}

struct Roster;

#[async_trait]
impl ProviderAccounts for Roster {
    async fn accounts(&self, provider: &str) -> Result<Value, String> {
        assert_eq!(provider, "openai");
        Ok(json!({ "accounts": [{ "id": "acc-1" }] }))
    }
}

fn setup() -> (MediaDefaultSetup, Arc<Catalog>) {
    let lanes = json!([
        { "id": "oa", "label": "OpenAI", "authenticated": true, "authType": "oauth", "authProvider": "openai",
          "image": { "models": [{ "id": "img-1" }] } },
        { "id": "key", "label": "Keyed", "authenticated": true, "authType": "apiKey", "image": { "models": [] } },
        { "id": "out", "label": "Signed out", "authenticated": false, "image": { "models": [] } },
        { "id": "broken", "label": "Broken", "authenticated": true, "catalogError": "catalog is down" },
    ]);
    let catalog = Arc::new(Catalog { lanes, pins: Mutex::default() });
    (MediaDefaultSetup::new(catalog.clone(), Arc::new(Roster)), catalog)
}

async fn run(setup: &MediaDefaultSetup, args: Value) -> Result<Value, String> {
    let thread = ThreadId::from("sess_1");
    setup.run(&SetupCall { action: "set_media_default", args: &args, thread: &thread }).await.map_err(|error| message(&error))
}

#[tokio::test]
async fn a_lane_with_a_model_and_an_account_is_pinned_whole() {
    let (setup, catalog) = setup();
    let answer = run(&setup, json!({ "kind": "image", "lane": "oa", "model": "img-1", "accountId": "acc-1" })).await.unwrap();
    assert_eq!(answer, json!({ "kind": "image", "media": { "pinned": true } }));
    assert_eq!(*catalog.pins.lock().unwrap(), vec![json!({ "kind": "image", "lane": "oa", "model": "img-1", "account": "acc-1" })]);
}

#[tokio::test]
async fn a_blank_lane_returns_the_kind_to_auto_and_refuses_a_model_without_a_lane() {
    let (setup, catalog) = setup();
    run(&setup, json!({ "kind": "video", "lane": "" })).await.unwrap();
    assert_eq!(*catalog.pins.lock().unwrap(), vec![json!({ "kind": "video", "lane": "" })]);
    assert_eq!(run(&setup, json!({ "kind": "video", "model": "m" })).await.unwrap_err(), "model and accountId need a lane");
}

#[tokio::test]
async fn a_lane_that_cannot_serve_the_kind_is_refused_in_the_catalogs_words() {
    let (setup, catalog) = setup();
    assert_eq!(run(&setup, json!({ "kind": "audio", "lane": "oa" })).await.unwrap_err(), "kind must be one of image, video");
    assert_eq!(run(&setup, json!({ "kind": "image", "lane": "nope" })).await.unwrap_err(), "Unknown media lane \"nope\"; list lanes with the media tool");
    assert_eq!(run(&setup, json!({ "kind": "image", "lane": "out" })).await.unwrap_err(), "Signed out is not signed in; open providers first");
    assert_eq!(run(&setup, json!({ "kind": "video", "lane": "oa" })).await.unwrap_err(), "oa offers no video models");
    assert_eq!(run(&setup, json!({ "kind": "video", "lane": "broken" })).await.unwrap_err(), "catalog is down");
    assert_eq!(run(&setup, json!({ "kind": "image", "lane": "oa", "model": "other" })).await.unwrap_err(), "model \"other\" is not available on oa/image");
    assert!(catalog.pins.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_account_needs_an_oauth_lane_and_a_rostered_id() {
    let (setup, _) = setup();
    assert_eq!(
        run(&setup, json!({ "kind": "image", "lane": "key", "accountId": "acc-1" })).await.unwrap_err(),
        "key signs in with an API key; it has no accounts"
    );
    assert_eq!(
        run(&setup, json!({ "kind": "image", "lane": "oa", "accountId": "acc-9" })).await.unwrap_err(),
        "Unknown openai account \"acc-9\"; list accounts with status providers"
    );
}
