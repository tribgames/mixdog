//! Push to paired devices: the relay's Web Push identity and APNs/FCM credentials, and the
//! browsers that subscribed to this PC's own VAPID key ([`legacy`]). The decision whether to push
//! at all is the engine's (`mixdog-core` `notify::decision`); this crate only delivers.

pub mod legacy;
pub mod native;
pub mod native_crypto;
pub mod web;
