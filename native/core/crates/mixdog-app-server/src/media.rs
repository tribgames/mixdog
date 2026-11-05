//! The real [`HostMediaSink`]: binary frames from the host connection (X17) routed by stream id
//! into the live-view encoder's feeds.
//!
//! The transport has already validated the header; it is decoded again here only to find the
//! stream and the payload. A frame never waits: a target takes the picture or drops it.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use bytes::Bytes;
use mixdog_app_protocol::media::MediaFrameHeader;
use mixdog_core_api::HostMediaSink;
use mixdog_core_api::ids::ConnectionId;

use crate::sharded::lock;

/// Takes the JPEG pictures of one `host/browser/viewFrames` stream. Must not block (the
/// live-view `FrameSink::push_jpeg` replaces the picture not yet encoded).
pub trait StreamTarget: Send + Sync {
    fn jpeg(&self, header: MediaFrameHeader, jpeg: Bytes);
}

pub struct HostMedia {
    max_media_frame_bytes: u64,
    streams: Mutex<HashMap<u32, Arc<dyn StreamTarget>>>,
}

impl HostMedia {
    pub fn new(max_media_frame_bytes: u64) -> Arc<Self> {
        Arc::new(Self {
            max_media_frame_bytes,
            streams: Mutex::new(HashMap::new()),
        })
    }

    /// Routes frames of `stream_id` to `target`, replacing an earlier target of that stream.
    pub fn bind(&self, stream_id: u32, target: Arc<dyn StreamTarget>) {
        lock(&self.streams).insert(stream_id, target);
    }

    pub fn unbind(&self, stream_id: u32) {
        lock(&self.streams).remove(&stream_id);
    }
}

impl HostMediaSink for HostMedia {
    fn frame(&self, _from: ConnectionId, frame: Bytes) {
        let Ok((header, payload)) = MediaFrameHeader::decode(&frame, self.max_media_frame_bytes)
        else {
            return;
        };
        let target = lock(&self.streams).get(&header.stream_id).cloned();
        if let Some(target) = target {
            target.jpeg(header, frame.slice(frame.len() - payload.len()..));
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_app_protocol::media::MediaFormat;
    use mixdog_app_protocol::media::MediaPurpose;

    use super::*;

    #[derive(Default)]
    struct Seen(Mutex<Vec<(u32, Bytes)>>);

    impl StreamTarget for Seen {
        fn jpeg(&self, header: MediaFrameHeader, jpeg: Bytes) {
            lock(&self.0).push((header.stream_id, jpeg));
        }
    }

    fn frame(stream_id: u32, payload: &'static [u8]) -> Bytes {
        let header = MediaFrameHeader {
            purpose: MediaPurpose::BrowserView,
            flags: 0,
            stream_id,
            width: 2,
            height: 2,
            format: MediaFormat::Jpeg,
        };
        let mut out = header.encode().to_vec();
        out.extend_from_slice(payload);
        Bytes::from(out)
    }

    #[test]
    fn frames_reach_their_stream_only_and_junk_is_dropped() {
        let media = HostMedia::new(1024);
        let one = Arc::new(Seen::default());
        let two = Arc::new(Seen::default());
        media.bind(1, one.clone());
        media.bind(2, two.clone());
        media.frame(ConnectionId(1), frame(1, b"aa"));
        media.frame(ConnectionId(1), frame(3, b"unbound"));
        media.frame(ConnectionId(1), Bytes::from_static(b"short"));
        assert_eq!(*lock(&one.0), vec![(1, Bytes::from_static(b"aa"))]);
        assert!(lock(&two.0).is_empty());
        media.unbind(1);
        media.frame(ConnectionId(1), frame(1, b"bb"));
        assert_eq!(lock(&one.0).len(), 1);
    }
}
