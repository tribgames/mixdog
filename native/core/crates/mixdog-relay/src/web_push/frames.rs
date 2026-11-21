//! The desktop-leg side of relay-owned Web Push: what the leg is told, what it may ask, and what a revocation takes with it. The
//! rules live on [`WebPush`]; this module plugs them into the frame registry of the legs ([`crate::legs::dispatch`]).
//!
//! * the `webPush` capability of `relay-capabilities`, offered only when the relay holds an identity;
//! * the `webpush-subscriptions` frame of a PC, sent right after its capabilities and again by [`publish`] whenever its set changes;
//! * `webpush-ready`: this PC delivers through the relay;
//! * `webpush-send`, answered with `webpush-result` once the push service has answered (the leg is not held meanwhile);
//! * the revocation hooks: a revoked device loses its associations and its readiness, a revoked browser loses its own, and the PC
//!   is told its new set.

use std::sync::{Arc, Weak};

use super::WebPush;
use crate::legs::dispatch::{CapabilityOffer, Handler, HandlerFuture, LegCall, Rejected, RevokeHook};
use crate::legs::hub::Hub;

/// `webPush.publish(deviceId)`: the PC's current set, to its live leg (nothing when it has none).
pub fn publish(hub: &Hub, web_push: &WebPush, device_id: &str) {
    let frame = web_push.subscriptions_frame(device_id, |device, client| hub.store().has_client(device, client));
    hub.send_to_desktop(device_id, &frame);
}

struct Revocations {
    hub: Weak<Hub>,
    web_push: Arc<WebPush>,
}

impl RevokeHook for Revocations {
    fn device_revoked(&self, device_id: &str) {
        self.web_push.registry().drop_client(device_id, None);
    }

    fn client_revoked(&self, device_id: &str, client_id: &str) {
        let dropped = self.web_push.registry().drop_client(device_id, Some(client_id));
        if dropped && let Some(hub) = self.hub.upgrade() {
            publish(&hub, &self.web_push, device_id);
        }
    }
}

/// Registers everything the desktop leg needs for Web Push. Called once, with the hub the relay serves and the identity it holds.
pub fn register(hub: &Arc<Hub>, web_push: Arc<WebPush>) -> Result<(), Rejected> {
    let dispatch = hub.dispatch();
    dispatch.register_capability(Arc::new(|| CapabilityOffer { web_push: true, ..CapabilityOffer::default() }));

    let (weak, held) = (Arc::downgrade(hub), Arc::clone(&web_push));
    dispatch.register_connect_frame(Arc::new(move |device_id| {
        let hub = weak.upgrade()?;
        Some(held.subscriptions_frame(device_id, |device, client| hub.store().has_client(device, client)))
    }));

    let ready = Arc::clone(&web_push);
    let ready: Handler = Arc::new(move |call: LegCall| -> HandlerFuture {
        let web_push = Arc::clone(&ready);
        Box::pin(async move { web_push.mark_ready(&call.device_id) })
    });
    dispatch.register("webpush-ready", ready)?;

    let sending = Arc::clone(&web_push);
    let send: Handler = Arc::new(move |call: LegCall| -> HandlerFuture {
        let web_push = Arc::clone(&sending);
        Box::pin(async move {
            // The push service may be slow: the answer is written when it comes, and the leg reads on. The sends start in the
            // order of the frames, after the frames already read (the order the fake or the real push service sees them in).
            let later = Arc::clone(&call.later);
            later.run(
                "relay-webpush-send",
                Box::pin(async move {
                    let hub = Arc::clone(&call.hub);
                    let known = |device: &str, client: &str| hub.store().has_client(device, client);
                    let announce = |holder: &str| publish(&hub, &web_push, holder);
                    let reply = web_push.send_from_desktop(&call.device_id, &call.message, known, announce).await;
                    hub.send_to_desktop(&call.device_id, &reply);
                }),
            );
        })
    });
    dispatch.register("webpush-send", send)?;

    dispatch.register_revoke_hook(Arc::new(Revocations { hub: Arc::downgrade(hub), web_push }));
    Ok(())
}
