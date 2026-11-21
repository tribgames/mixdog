//! The media byte lane: `/media/<assetId>?variant=` proxied over the desktop leg. Payloads pass through un-inspected: the desktop
//! seals every body with a key only the paired phone holds.
//!
//! Build one [`MediaProxy`] per process with [`MediaProxy::start`] (it registers the `media-` frame prefix), route every request
//! whose path starts with `/media/` to [`MediaProxy::handle_request`] and finish a failure with `http1::fail_request("media", ..)`.
//! A desktop leg that is replaced or closed fails its streams through the hub (`MediaSlot::take_all`).

mod headers;
mod proxy;

pub use self::headers::media_response_headers;
pub use self::proxy::{
    MAX_MEDIA_STREAMS, MEDIA_HEAD_TIMEOUT, MEDIA_KILL_BUFFER_BYTES, MEDIA_PAUSE_BUFFER_BYTES, MEDIA_STALL_TIMEOUT, MediaOptions, MediaProxy,
};
