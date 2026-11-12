//! The audience of a settings announcement: the app feed carries it to every connection that subscribed, whatever its origin, so the
//! window, a paired phone that answered and another paired phone all hear it (`approval-grant-change-cases`, Node's
//! `notifySettingsChanged('permissions')` reaching this PC's window and every relay client, the answering one included).

use std::sync::Arc;

use mixdog_core_base::state::SectionFeedState;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_config::config::SETTINGS_CHANGED;
use mixdog_protocol::Origin;
use serde_json::Value;
use serde_json::json;

use super::Rig;
use super::VERSION;

/// The announcement the composition makes after an answer that remembered a grant (compose_flip's `settings_changed` over
/// compose_domains' `announce_to`), onto the app feed the server hands to every `app/subscribe`.
#[tokio::test]
async fn a_settings_change_reaches_every_app_feed_subscriber_whatever_its_origin() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/approval-grant-change-cases/golden.json")).expect("golden.json");
    let case = golden["cases"].as_array().unwrap().iter().find(|c| c["case"].as_str().unwrap().starts_with("the announcement reaches")).expect("the recorded case");
    for (answerer, observed) in case["observed"].as_object().unwrap() {
        let rig = Rig::new();
        let app = Arc::new(SectionFeedState::new(rig.core.mock.app().clone()));
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        // An absent file is an empty document: opening reads it and writes nothing.
        let (config, _) = Config::open(std::env::temp_dir().join("mixdog-settings-change-feed-absent").join("mixdog-config.json"), app.clone(), lanes).await.unwrap();
        let announcer = app.clone();
        config.announce_to(Arc::new(move |method, params| announcer.notify(method, &params)));

        // The recorded audience: this PC's window (a local connection) and each paired phone (a relay connection).
        let windows = observed["window"].as_array().unwrap().len();
        assert_eq!(windows, 1, "{answerer}: one window");
        let phones: Vec<&str> = observed["relay"][0]["to"].as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect();
        assert!(phones.contains(&"phone-1"), "{answerer}: the answering phone is among them");
        // Node hands it to the relay as a push no phone may miss (`droppable: false`); the core's word for that is the class of
        // the feed that carries it: an ordered feed's lanes never drop an event.
        for push in observed["relay"].as_array().unwrap() {
            assert_eq!(push["droppable"], json!(!mixdog_protocol::SectionFeed::App.ordered()), "{answerer}: {push}");
        }
        let mut listeners = vec![("window".to_owned(), 1, Origin::Local)];
        listeners.extend(phones.iter().enumerate().map(|(n, id)| ((*id).to_owned(), 2 + n as u64, Origin::Relay)));
        let mut clients = Vec::new();
        for (name, id, origin) in listeners {
            let client = rig.connect(id, origin);
            client.initialize(VERSION, json!({}));
            client.request(1, "app/subscribe", json!({}));
            client.drain();
            clients.push((name, client));
        }

        // The answering client's own answer is not what announces: the composition's closure does, to the app feed.
        config.announce(SETTINGS_CHANGED, json!({ "scope": observed["window"][0]["scope"] }));
        for (name, client) in &clients {
            let heard: Vec<Value> = client.drain().into_iter().map(|wire| wire.body).collect();
            assert_eq!(heard.len(), 1, "{answerer}: {name} hears one frame: {heard:?}");
            assert_eq!(heard[0]["method"], json!("ui/settings/changed"), "{answerer}: {name}");
            assert_eq!(heard[0]["params"], observed["relay"][0]["payload"]["payload"], "{answerer}: {name}");
            assert_eq!(heard[0]["params"], observed["window"][0], "{answerer}: {name}");
        }
    }
}
