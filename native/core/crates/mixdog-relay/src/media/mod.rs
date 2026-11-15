//! The media byte lane (`lib/relay-media-proxy.mjs`): `/media/<assetId>?variant=` proxied over the desktop leg, so a phone gets a
//! cacheable, range-able HTTP response instead of a base64 RPC answer and the relay only forwards frames. Payloads pass through
//! un-inspected: the desktop seals every body with a key only the paired phone holds, so what streams through here is ciphertext.
//!
//! What the server and the wiring do with it:
//! - build one [`MediaProxy`] per process with [`MediaProxy::start`] (it registers the `media-` frame prefix with the hub's
//!   dispatch, so the frames of every desktop leg reach it);
//! - route every request whose path starts with `/media/` to [`MediaProxy::handle_request`] (it answers the whole request),
//!   finishing a failure with `http1::fail_request("media", ..)`.
//!
//! A desktop leg that is replaced or closed fails its streams through the hub (`MediaSlot::take_all`), so nothing else has to be
//! told.

mod headers;
mod proxy;

pub use self::headers::media_response_headers;
pub use self::proxy::{
    MAX_MEDIA_STREAMS, MEDIA_HEAD_TIMEOUT, MEDIA_KILL_BUFFER_BYTES, MEDIA_PAUSE_BUFFER_BYTES, MEDIA_STALL_TIMEOUT, MediaOptions, MediaProxy,
};
