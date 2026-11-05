//! Frame sources the host pushes into: the in-app browser view (JPEG paint frames that Electron
//! main sends as X17 binary frames, `purpose = browserView`) and the secure-desktop helper's
//! BGRX frames. Computer capture comes from `ComputerBackend::screen_source` and needs no
//! adapter.
//!
//! A [`FrameSink`] keeps only the newest frame: a source nobody is encoding for, or an encoder
//! behind the producer, never queues pictures.

use std::time::Instant;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::media::FrameSourceKind;
use mixdog_core_api::domain::media::MediaError;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::media::PixelFormat;
use mixdog_core_api::domain::media::VideoFrame;
use tokio::sync::watch;

/// The producer end. Dropping it ends the source.
pub struct FrameSink {
    tx: watch::Sender<Option<VideoFrame>>,
    origin: Instant,
    seq: u64,
}

impl FrameSink {
    /// Publishes a picture, replacing the one not yet taken. `Err` for geometry that cannot
    /// describe `data`.
    pub fn push(
        &mut self,
        format: PixelFormat,
        width: u32,
        height: u32,
        stride: u32,
        data: Bytes,
    ) -> Result<(), MediaError> {
        let frame = VideoFrame {
            width,
            height,
            stride,
            format,
            data,
            seq: self.seq,
            captured_at: self.origin.elapsed(),
        };
        if let Some(required) = frame.required_len()
            && frame.data.len() < required
        {
            return Err(MediaError::InvalidFrame {
                reason: "frame data shorter than its geometry".into(),
            });
        }
        self.seq += 1;
        self.tx.send_replace(Some(frame));
        Ok(())
    }

    /// A browser paint frame (JPEG; the decoder reads the size from the picture).
    pub fn push_jpeg(&mut self, data: Bytes) -> Result<(), MediaError> {
        self.push(PixelFormat::Jpeg, 0, 0, 0, data)
    }
}

/// The consumer end, handed to a [`super::track::Vp8Track`].
pub struct FeedSource {
    kind: FrameSourceKind,
    rx: watch::Receiver<Option<VideoFrame>>,
}

/// A source fed by [`FrameSink`]; `kind` names what it carries.
pub fn frame_feed(kind: FrameSourceKind) -> (FrameSink, FeedSource) {
    let (tx, rx) = watch::channel(None);
    (
        FrameSink {
            tx,
            origin: Instant::now(),
            seq: 0,
        },
        FeedSource { kind, rx },
    )
}

#[async_trait]
impl MediaFrameSource for FeedSource {
    fn kind(&self) -> FrameSourceKind {
        self.kind.clone()
    }

    /// Cancel-safe: a frame is taken only when the future completes.
    async fn next_frame(&mut self) -> Result<Option<VideoFrame>, MediaError> {
        loop {
            if self.rx.changed().await.is_err() {
                return Ok(None);
            }
            if let Some(frame) = self.rx.borrow_and_update().clone() {
                return Ok(Some(frame));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use futures::FutureExt;

    use super::*;

    #[tokio::test]
    async fn only_the_newest_picture_is_kept() {
        let (mut sink, mut source) = frame_feed(FrameSourceKind::BrowserView { tab_id: "t".into() });
        sink.push(PixelFormat::Bgrx, 1, 1, 4, Bytes::from_static(&[0; 4])).unwrap();
        sink.push(PixelFormat::Bgrx, 2, 1, 8, Bytes::from_static(&[0; 8])).unwrap();
        let frame = source.next_frame().await.unwrap().unwrap();
        assert_eq!((frame.width, frame.seq), (2, 1));
        assert!(source.next_frame().now_or_never().is_none(), "nothing newer is waiting");
    }

    #[tokio::test]
    async fn dropping_the_sink_ends_the_source() {
        let (sink, mut source) = frame_feed(FrameSourceKind::SecureDesktop);
        drop(sink);
        assert_eq!(source.next_frame().await, Ok(None));
    }

    #[test]
    fn a_short_frame_is_refused_at_the_producer() {
        let (mut sink, _source) = frame_feed(FrameSourceKind::SecureDesktop);
        assert!(sink.push(PixelFormat::Bgrx, 4, 4, 16, Bytes::from_static(&[0; 8])).is_err());
    }
}
