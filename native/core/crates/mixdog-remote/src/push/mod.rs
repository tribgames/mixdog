//! Push to paired devices. Relay-owned only: browser push goes through the relay's Web Push
//! identity and app push through its APNs/FCM credentials; this PC never posts to a push service
//! itself. The decision whether to push at all is [`decision`], shared with every channel.

pub mod decision;
pub mod legacy;
pub mod native;
pub mod native_crypto;
pub mod web;
