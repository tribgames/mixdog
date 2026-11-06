//! The browser view's end of the host media stream: pictures the host sends over X17 reach the
//! live-view encoder as the newest frame of their stream (`host/browser/viewFrames`).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use bytes::Bytes;
use mixdog_app_protocol::media::MediaFrameHeader;
use mixdog_app_server::StreamTarget;
use mixdog_remote::webrtc::sources::FrameSink;

/// The target of one `host/browser/viewFrames` stream, bound in `HostMedia` by stream id. Never
/// waits: a picture replaces the one not yet taken.
pub struct BrowserViewFeed(Mutex<FrameSink>);

impl BrowserViewFeed {
    pub fn new(sink: FrameSink) -> Arc<Self> {
        Arc::new(Self(Mutex::new(sink)))
    }
}

impl StreamTarget for BrowserViewFeed {
    fn jpeg(&self, _header: MediaFrameHeader, jpeg: Bytes) {
        // A picture that cannot describe itself is dropped like any junk frame.
        let _ = self.0.lock().unwrap_or_else(PoisonError::into_inner).push_jpeg(jpeg);
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::future::poll_fn;
    use std::pin::pin;
    use std::task::Poll;

    use mixdog_app_protocol::media::MediaFormat;
    use mixdog_app_protocol::media::MediaPurpose;
    use mixdog_app_server::HostMedia;
    use mixdog_core_api::HostMediaSink;
    use mixdog_core_api::domain::media::FrameSourceKind;
    use mixdog_core_api::domain::media::MediaFrameSource;
    use mixdog_core_api::domain::media::PixelFormat;
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_remote::webrtc::sources::frame_feed;

    use super::*;

    fn frame(stream_id: u32, payload: &[u8]) -> Bytes {
        let header = MediaFrameHeader { purpose: MediaPurpose::BrowserView, flags: 0, stream_id, width: 2, height: 2, format: MediaFormat::Jpeg };
        let mut out = header.encode().to_vec();
        out.extend_from_slice(payload);
        Bytes::from(out)
    }

    /// An X17 frame from the host connection reaches the view source of its stream only, as the
    /// JPEG the host sent.
    #[tokio::test]
    async fn host_frames_feed_the_browser_view_of_their_stream() {
        let media = HostMedia::new(1024);
        let (sink, mut source) = frame_feed(FrameSourceKind::BrowserView { tab_id: "t".into() });
        let (other_sink, mut other) = frame_feed(FrameSourceKind::BrowserView { tab_id: "u".into() });
        media.bind(7, BrowserViewFeed::new(sink));
        media.bind(8, BrowserViewFeed::new(other_sink));
        media.frame(ConnectionId(1), frame(7, b"jpeg-bytes"));
        let got = source.next_frame().await.unwrap().unwrap();
        assert_eq!((got.format, got.data), (PixelFormat::Jpeg, Bytes::from_static(b"jpeg-bytes")));
        let mut next = pin!(other.next_frame());
        let nothing = poll_fn(|cx| Poll::Ready(next.as_mut().poll(cx).is_pending())).await;
        assert!(nothing, "another stream's source gets nothing");
    }
}
