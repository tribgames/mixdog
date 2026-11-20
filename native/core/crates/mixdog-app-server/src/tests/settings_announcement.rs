//! The audience of a settings announcement: the app feed carries it to every connection that subscribed, whatever its origin, so the
//! window, a paired phone that answered and another paired phone all hear it, once each, on a feed that never drops an event.

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

/// The announcement the composition makes after an answer that remembered a grant, onto the app feed the server hands to every
/// `app/subscribe`.
#[tokio::test]
async fn a_settings_change_reaches_every_app_feed_subscriber_whatever_its_origin() {
    let rig = Rig::new();
    let app = Arc::new(SectionFeedState::new(rig.core.mock.app().clone()));
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    // An absent file is an empty document: opening reads it and writes nothing.
    let (config, _) =
        Config::open(std::env::temp_dir().join("mixdog-settings-change-feed-absent").join("mixdog-config.json"), app.clone(), lanes).await.unwrap();
    let announcer = app.clone();
    config.announce_to(Arc::new(move |method, params| announcer.notify(method, &params)));
    assert!(mixdog_protocol::SectionFeed::App.ordered(), "the app feed never drops an event");

    let mut clients = Vec::new();
    for (name, id, origin) in [("window", 1, Origin::Local), ("phone-1", 2, Origin::Relay), ("phone-2", 3, Origin::Relay)] {
        let client = rig.connect(id, origin);
        client.initialize(VERSION, json!({}));
        client.request(1, "app/subscribe", json!({}));
        client.drain();
        clients.push((name, client));
    }

    config.announce(SETTINGS_CHANGED, json!({ "scope": "permissions" }));
    for (name, client) in &clients {
        let heard: Vec<Value> = client.drain().into_iter().map(|wire| wire.body).collect();
        assert_eq!(heard.len(), 1, "{name} hears one frame: {heard:?}");
        assert_eq!(heard[0]["method"], json!("ui/settings/changed"), "{name}");
        assert_eq!(heard[0]["params"], json!({ "scope": "permissions" }), "{name}");
    }
}
