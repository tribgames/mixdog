//! The pictures of a phone's whole-PC screen on their way to the encoder (Node: the sender window's desktop-capture track and its
//! drawn track, `remote-webrtc/sender-window.ts`, with `screen-webrtc-source.ts`'s helper frames).
//!
//! The phone's video is locked to the geometry the screen session announced (`pixelWidth x pixelHeight`, even, at most the
//! contract bound), and the phone checks what it received against it before it takes input from the channel. So every picture the
//! encoder sees is exactly that size:
//!
//! - [`LockedCapture`] wraps the display's capture (in-process capture, or the desktop's pixels as JPEG) and scales each picture
//!   onto the locked size (a capture track made with `width`/`height` constraints scaled it in Node);
//! - [`drawn_feed`] is the helper's track, drawn while the secure-desktop helper serves: each helper frame is raw BGRX rows, of
//!   which the part that shows the display is cropped and scaled into the locked picture where the session says (the rest stays
//!   black), as the sender drew them onto a canvas.
//!
//! Both are [`MediaFrameSource`]s a [`super::capture::SharedSource`] reads; the shared source switches between them in place
//! (`set_source`), so every connection of the screen follows. A [`DrawnSource`] reports each picture it hands to the track
//! (`delivered`), the local evidence the run's control on the secure desktop needs.

use std::ops::Range;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::media::FrameSourceKind;
use mixdog_core_api::domain::media::MediaError;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::media::PixelFormat;
use mixdog_core_api::domain::media::VideoFrame;
use tokio::sync::watch;

use super::convert::MAX_DIMENSION;

/// The pixel size the phone's video is locked to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockedSize {
    pub width: u32,
    pub height: u32,
}

/// A rectangle of pixels, fractional where scaled.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn invalid(reason: impl Into<String>) -> MediaError {
    MediaError::InvalidFrame { reason: reason.into() }
}

/// Pixels as a picture reads them: where red, green and blue sit inside one pixel, and the rows.
struct Raster<'a> {
    data: &'a [u8],
    stride: usize,
    width: usize,
    height: usize,
    bytes_per_pixel: usize,
    red: usize,
    green: usize,
    blue: usize,
}

impl<'a> Raster<'a> {
    /// B, G, R and a fourth byte that is ignored.
    fn bgrx(data: &'a [u8], stride: usize, width: usize, height: usize) -> Result<Self, MediaError> {
        if width == 0 || height == 0 || stride < width * 4 || data.len() < (height - 1) * stride + width * 4 {
            return Err(invalid("raster shorter than its geometry"));
        }
        Ok(Self { data, stride, width, height, bytes_per_pixel: 4, red: 2, green: 1, blue: 0 })
    }

    fn rgb(data: &'a [u8], width: usize, height: usize) -> Result<Self, MediaError> {
        if width == 0 || height == 0 || data.len() < width * height * 3 {
            return Err(invalid("raster shorter than its geometry"));
        }
        Ok(Self { data, stride: width * 3, width, height, bytes_per_pixel: 3, red: 0, green: 1, blue: 2 })
    }

    fn gray(data: &'a [u8], width: usize, height: usize) -> Result<Self, MediaError> {
        if width == 0 || height == 0 || data.len() < width * height {
            return Err(invalid("raster shorter than its geometry"));
        }
        Ok(Self { data, stride: width, width, height, bytes_per_pixel: 1, red: 0, green: 0, blue: 0 })
    }

    fn at(&self, x: usize, y: usize) -> [u32; 3] {
        let at = y * self.stride + x * self.bytes_per_pixel;
        [u32::from(self.data[at + self.red]), u32::from(self.data[at + self.green]), u32::from(self.data[at + self.blue])]
    }
}

/// Where one destination column or row samples from: two source indices and the weight of the second, in 1/256.
#[derive(Clone, Copy)]
struct Tap {
    first: usize,
    second: usize,
    weight: u32,
}

/// The taps of destination pixels `range`: destination `to_start..to_start + to_len` shows source `from_start..from_start + from_len` of a
/// picture `limit` pixels long (a sample never leaves the picture or the span).
fn taps(range: Range<usize>, to_start: f64, to_len: f64, from_start: f64, from_len: f64, limit: usize) -> Vec<Tap> {
    let last_pixel = (limit - 1) as f64;
    let low = from_start.clamp(0.0, last_pixel);
    let high = (from_start + from_len - 1.0).min(last_pixel).max(low);
    let last = high.floor() as usize;
    range
        .map(|index| {
            let unit = ((index as f64 + 0.5 - to_start) / to_len).clamp(0.0, 1.0);
            let at = (from_start + unit * from_len - 0.5).clamp(low, high);
            let first = at.floor() as usize;
            let second = (first + 1).min(last);
            let weight = if second == first { 0 } else { ((at - first as f64) * 256.0) as u32 };
            Tap { first, second, weight }
        })
        .collect()
}

/// Draws the `from` part of `source` into the `to` part of `target` (BGRX, `width x height`, rows `width * 4` apart), bilinear; the
/// rest of `target` is left as it is.
fn draw(target: &mut [u8], width: usize, height: usize, source: &Raster<'_>, from: Area, to: Area) {
    if !(from.width > 0.0 && from.height > 0.0 && to.width > 0.0 && to.height > 0.0) {
        return;
    }
    let columns = (to.x.floor().max(0.0) as usize)..((to.x + to.width).ceil().clamp(0.0, width as f64) as usize);
    let rows = (to.y.floor().max(0.0) as usize)..((to.y + to.height).ceil().clamp(0.0, height as f64) as usize);
    if columns.is_empty() || rows.is_empty() {
        return;
    }
    let across = taps(columns.clone(), to.x, to.width, from.x, from.width, source.width);
    let down = taps(rows.clone(), to.y, to.height, from.y, from.height, source.height);
    for (row, vertical) in rows.zip(&down) {
        let out = &mut target[row * width * 4..(row + 1) * width * 4];
        for (column, horizontal) in columns.clone().zip(&across) {
            let mut channels = [0u32; 3];
            let (top_first, top_second) = (source.at(horizontal.first, vertical.first), source.at(horizontal.second, vertical.first));
            let (bottom_first, bottom_second) = (source.at(horizontal.first, vertical.second), source.at(horizontal.second, vertical.second));
            for channel in 0..3 {
                let top = (top_first[channel] * (256 - horizontal.weight) + top_second[channel] * horizontal.weight) >> 8;
                let bottom = (bottom_first[channel] * (256 - horizontal.weight) + bottom_second[channel] * horizontal.weight) >> 8;
                channels[channel] = (top * (256 - vertical.weight) + bottom * vertical.weight) >> 8;
            }
            let at = column * 4;
            // B, G, R (the fourth byte is ignored by the encoder).
            out[at] = channels[2] as u8;
            out[at + 1] = channels[1] as u8;
            out[at + 2] = channels[0] as u8;
            out[at + 3] = 0xff;
        }
    }
}

fn checked_size(size: LockedSize) -> Result<(usize, usize), MediaError> {
    if size.width == 0 || size.height == 0 || size.width > MAX_DIMENSION || size.height > MAX_DIMENSION {
        return Err(invalid("locked size out of bounds"));
    }
    Ok((size.width as usize, size.height as usize))
}

fn bgrx_frame(pixels: Vec<u8>, size: LockedSize, seq: u64, captured_at: std::time::Duration) -> VideoFrame {
    VideoFrame { width: size.width, height: size.height, stride: size.width * 4, format: PixelFormat::Bgrx, data: Bytes::from(pixels), seq, captured_at }
}

/// `frame` as a picture of exactly `size`: itself when it already is one, otherwise scaled whole onto it.
pub fn lock_frame(frame: &VideoFrame, size: LockedSize) -> Result<VideoFrame, MediaError> {
    let (width, height) = checked_size(size)?;
    if frame.width == size.width && frame.height == size.height {
        return Ok(frame.clone());
    }
    let mut pixels = vec![0u8; width * height * 4];
    let whole = |raster: &Raster<'_>| Area { x: 0.0, y: 0.0, width: raster.width as f64, height: raster.height as f64 };
    let target = Area { x: 0.0, y: 0.0, width: width as f64, height: height as f64 };
    match frame.format {
        PixelFormat::Bgra | PixelFormat::Bgrx => {
            let raster = Raster::bgrx(&frame.data, frame.stride as usize, frame.width as usize, frame.height as usize)?;
            draw(&mut pixels, width, height, &raster, whole(&raster), target);
        }
        PixelFormat::Jpeg => {
            let mut decoder = jpeg_decoder::Decoder::new(&frame.data[..]);
            let decoded = decoder.decode().map_err(|error| invalid(format!("jpeg: {error}")))?;
            let info = decoder.info().ok_or_else(|| invalid("jpeg: no header"))?;
            let (picture_width, picture_height) = (usize::from(info.width), usize::from(info.height));
            let raster = match info.pixel_format {
                jpeg_decoder::PixelFormat::RGB24 => Raster::rgb(&decoded, picture_width, picture_height)?,
                jpeg_decoder::PixelFormat::L8 => Raster::gray(&decoded, picture_width, picture_height)?,
                other => return Err(invalid(format!("jpeg pixel format {other:?}"))),
            };
            draw(&mut pixels, width, height, &raster, whole(&raster), target);
        }
        PixelFormat::I420 => return Err(invalid("an I420 picture of another size cannot be scaled")),
    }
    Ok(bgrx_frame(pixels, size, frame.seq, frame.captured_at))
}

/// A display's capture as the encoder reads it: every picture of the locked size. A picture that cannot be scaled (a torn JPEG) is
/// skipped, as a junk frame is anywhere else.
pub struct LockedCapture {
    inner: Box<dyn MediaFrameSource>,
    size: LockedSize,
    /// Called once, when the first picture of this capture is on its way to the encoder.
    first: Option<Box<dyn FnOnce() + Send>>,
}

impl LockedCapture {
    pub fn new(inner: Box<dyn MediaFrameSource>, size: LockedSize, first: Box<dyn FnOnce() + Send>) -> Self {
        Self { inner, size, first: Some(first) }
    }
}

#[async_trait]
impl MediaFrameSource for LockedCapture {
    fn kind(&self) -> FrameSourceKind {
        self.inner.kind()
    }

    /// Cancel-safe when the capture is: a picture is taken from it only in the poll that returns it (a skipped one is gone).
    async fn next_frame(&mut self) -> Result<Option<VideoFrame>, MediaError> {
        loop {
            let Some(frame) = self.inner.next_frame().await? else { return Ok(None) };
            match lock_frame(&frame, self.size) {
                Ok(locked) => {
                    if let Some(first) = self.first.take() {
                        first();
                    }
                    return Ok(Some(locked));
                }
                Err(error) => tracing::debug!(?error, "a screen picture was skipped"),
            }
        }
    }
}

/// The part of a secure-desktop helper frame that shows the display (`HelperPictureFrame`).
#[derive(Clone, Debug, PartialEq)]
pub struct HelperPicture {
    /// The frame's pixels; the picture's rows are `rows` of it.
    pub pixels: Arc<Vec<u8>>,
    pub rows: Range<usize>,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    /// The display's part of those rows, in their pixels.
    pub source: Area,
    /// Where that part lands in the locked picture; the rest stays black.
    pub target: Area,
}

/// A helper picture of video run `epoch`, to be drawn into a picture of `size`.
#[derive(Clone, Debug, PartialEq)]
pub struct DrawnPicture {
    pub epoch: u64,
    pub size: LockedSize,
    pub picture: HelperPicture,
}

/// The producer end of the helper's track: only the newest picture is kept.
pub struct DrawnSink {
    tx: watch::Sender<Option<DrawnPicture>>,
}

impl DrawnSink {
    pub fn push(&self, picture: DrawnPicture) {
        self.tx.send_replace(Some(picture));
    }
}

/// The consumer end, read by the shared source while the helper serves.
pub struct DrawnSource {
    rx: watch::Receiver<Option<DrawnPicture>>,
    origin: Instant,
    seq: u64,
    delivered: Arc<dyn Fn(u64) + Send + Sync>,
}

/// The helper's track. `delivered(epoch)` is called for each picture of run `epoch` once it is drawn and handed to the encoder's
/// feed.
pub fn drawn_feed(delivered: Arc<dyn Fn(u64) + Send + Sync>) -> (DrawnSink, DrawnSource) {
    let (tx, rx) = watch::channel(None);
    (DrawnSink { tx }, DrawnSource { rx, origin: Instant::now(), seq: 0, delivered })
}

fn compose(drawn: &DrawnPicture) -> Result<(Vec<u8>, LockedSize), MediaError> {
    let (width, height) = checked_size(drawn.size)?;
    let picture = &drawn.picture;
    let stride = picture.stride as usize;
    let rows = picture.rows.start * stride..picture.rows.end * stride;
    let data = picture.pixels.get(rows).ok_or_else(|| invalid("helper rows outside the frame"))?;
    let raster = Raster::bgrx(data, stride, picture.width as usize, picture.height as usize)?;
    let mut pixels = vec![0u8; width * height * 4];
    for pixel in pixels.chunks_exact_mut(4) {
        pixel[3] = 0xff;
    }
    draw(&mut pixels, width, height, &raster, picture.source, picture.target);
    Ok((pixels, drawn.size))
}

#[async_trait]
impl MediaFrameSource for DrawnSource {
    fn kind(&self) -> FrameSourceKind {
        FrameSourceKind::SecureDesktop
    }

    /// Cancel-safe: a picture is taken only in the poll that returns it.
    async fn next_frame(&mut self) -> Result<Option<VideoFrame>, MediaError> {
        loop {
            if self.rx.changed().await.is_err() {
                return Ok(None);
            }
            let Some(drawn) = self.rx.borrow_and_update().clone() else { continue };
            match compose(&drawn) {
                Ok((pixels, size)) => {
                    let frame = bgrx_frame(pixels, size, self.seq, self.origin.elapsed());
                    self.seq += 1;
                    (self.delivered)(drawn.epoch);
                    return Ok(Some(frame));
                }
                Err(error) => tracing::debug!(?error, "a helper picture was skipped"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use futures::FutureExt;

    use super::*;

    fn solid(width: u32, height: u32, bgr: [u8; 3]) -> VideoFrame {
        let data: Vec<u8> = (0..width * height).flat_map(|_| [bgr[0], bgr[1], bgr[2], 0]).collect();
        VideoFrame { width, height, stride: width * 4, format: PixelFormat::Bgrx, data: Bytes::from(data), seq: 3, captured_at: Duration::from_millis(7) }
    }

    fn pixel(frame: &VideoFrame, x: usize, y: usize) -> [u8; 3] {
        let at = y * frame.stride as usize + x * 4;
        [frame.data[at], frame.data[at + 1], frame.data[at + 2]]
    }

    #[test]
    fn a_picture_of_another_size_is_scaled_onto_the_locked_one() {
        let locked = lock_frame(&solid(8, 6, [10, 20, 30]), LockedSize { width: 4, height: 2 }).unwrap();
        assert_eq!((locked.width, locked.height, locked.stride, locked.format), (4, 2, 16, PixelFormat::Bgrx));
        assert_eq!((locked.seq, locked.captured_at), (3, Duration::from_millis(7)));
        for y in 0..2 {
            for x in 0..4 {
                assert_eq!(pixel(&locked, x, y), [10, 20, 30]);
            }
        }
    }

    #[test]
    fn a_picture_of_the_locked_size_passes_untouched() {
        let frame = solid(4, 4, [1, 2, 3]);
        let locked = lock_frame(&frame, LockedSize { width: 4, height: 4 }).unwrap();
        assert_eq!(locked, frame);
    }

    #[test]
    fn scaling_keeps_where_things_are() {
        // Left half white, right half black, 8 pixels wide, scaled to 4.
        let mut data = Vec::new();
        for _ in 0..2 {
            for x in 0..8 {
                let value = if x < 4 { 255 } else { 0 };
                data.extend_from_slice(&[value, value, value, 0]);
            }
        }
        let frame = VideoFrame { width: 8, height: 2, stride: 32, format: PixelFormat::Bgrx, data: Bytes::from(data), seq: 0, captured_at: Duration::ZERO };
        let locked = lock_frame(&frame, LockedSize { width: 4, height: 2 }).unwrap();
        assert_eq!(pixel(&locked, 0, 0), [255, 255, 255]);
        assert_eq!(pixel(&locked, 3, 1), [0, 0, 0]);
    }

    #[test]
    fn a_torn_picture_and_a_size_out_of_bounds_are_refused() {
        let torn = VideoFrame { width: 8, height: 8, stride: 32, format: PixelFormat::Bgrx, data: Bytes::from_static(&[0; 10]), seq: 0, captured_at: Duration::ZERO };
        assert!(lock_frame(&torn, LockedSize { width: 4, height: 4 }).is_err());
        assert!(lock_frame(&solid(2, 2, [0; 3]), LockedSize { width: 0, height: 4 }).is_err());
        assert!(lock_frame(&solid(2, 2, [0; 3]), LockedSize { width: MAX_DIMENSION + 2, height: 4 }).is_err());
        let jpeg = VideoFrame { width: 4, height: 4, stride: 0, format: PixelFormat::Jpeg, data: Bytes::from_static(&[1, 2, 3]), seq: 0, captured_at: Duration::ZERO };
        assert!(lock_frame(&jpeg, LockedSize { width: 2, height: 2 }).is_err());
    }

    struct Scripted {
        frames: std::collections::VecDeque<Result<VideoFrame, MediaError>>,
    }

    #[async_trait]
    impl MediaFrameSource for Scripted {
        fn kind(&self) -> FrameSourceKind {
            FrameSourceKind::Screen { display: 0 }
        }

        async fn next_frame(&mut self) -> Result<Option<VideoFrame>, MediaError> {
            self.frames.pop_front().transpose()
        }
    }

    #[tokio::test]
    async fn the_capture_says_once_that_its_first_picture_is_on_its_way_and_skips_a_torn_one() {
        let torn = VideoFrame { width: 8, height: 8, stride: 32, format: PixelFormat::Bgrx, data: Bytes::from_static(&[0; 10]), seq: 0, captured_at: Duration::ZERO };
        let scripted = Scripted { frames: vec![Ok(torn), Ok(solid(8, 8, [5, 6, 7])), Ok(solid(8, 8, [5, 6, 7]))].into() };
        let said = Arc::new(Mutex::new(0));
        let counter = said.clone();
        let mut capture = LockedCapture::new(Box::new(scripted), LockedSize { width: 4, height: 4 }, Box::new(move || *counter.lock().unwrap() += 1));
        assert_eq!(capture.kind(), FrameSourceKind::Screen { display: 0 });
        let first = capture.next_frame().await.unwrap().unwrap();
        assert_eq!((first.width, first.height), (4, 4));
        assert_eq!(*said.lock().unwrap(), 1);
        capture.next_frame().await.unwrap().unwrap();
        assert_eq!(*said.lock().unwrap(), 1);
        assert_eq!(capture.next_frame().await, Ok(None));
    }

    fn helper_picture(width: u32, height: u32, bgr: [u8; 3], source: Area, target: Area) -> HelperPicture {
        // Two rows of padding above the picture, and a stride wider than a row.
        let stride = width as usize * 4 + 8;
        let mut pixels = vec![9u8; stride * (height as usize + 2)];
        for row in 0..height as usize {
            for column in 0..width as usize {
                let at = (row + 2) * stride + column * 4;
                pixels[at..at + 4].copy_from_slice(&[bgr[0], bgr[1], bgr[2], 0]);
            }
        }
        HelperPicture { pixels: Arc::new(pixels), rows: 2..2 + height as usize, width, height, stride: stride as u32, source, target }
    }

    #[tokio::test]
    async fn a_helper_picture_lands_where_the_session_locates_it_and_the_rest_is_black() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let (sink, mut source) = drawn_feed(Arc::new(move |epoch| log.lock().unwrap().push(epoch)));
        assert_eq!(source.kind(), FrameSourceKind::SecureDesktop);
        assert!(source.next_frame().now_or_never().is_none(), "nothing is drawn before a picture arrives");
        let picture = helper_picture(
            4,
            4,
            [200, 100, 50],
            Area { x: 0.0, y: 0.0, width: 4.0, height: 4.0 },
            Area { x: 2.0, y: 2.0, width: 4.0, height: 4.0 },
        );
        sink.push(DrawnPicture { epoch: 9, size: LockedSize { width: 8, height: 8 }, picture });
        let frame = source.next_frame().await.unwrap().unwrap();
        assert_eq!((frame.width, frame.height, frame.seq), (8, 8, 0));
        assert_eq!(pixel(&frame, 0, 0), [0, 0, 0]);
        assert_eq!(pixel(&frame, 1, 7), [0, 0, 0]);
        assert_eq!(pixel(&frame, 3, 3), [200, 100, 50]);
        assert_eq!(pixel(&frame, 5, 5), [200, 100, 50]);
        assert_eq!(pixel(&frame, 6, 6), [0, 0, 0]);
        assert_eq!(*seen.lock().unwrap(), vec![9]);
    }

    #[tokio::test]
    async fn only_the_newest_helper_picture_is_drawn_and_a_dropped_sink_ends_the_track() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let (sink, mut source) = drawn_feed(Arc::new(move |epoch| log.lock().unwrap().push(epoch)));
        let area = Area { x: 0.0, y: 0.0, width: 2.0, height: 2.0 };
        for epoch in [1, 2] {
            sink.push(DrawnPicture { epoch, size: LockedSize { width: 2, height: 2 }, picture: helper_picture(2, 2, [1, 1, 1], area, area) });
        }
        source.next_frame().await.unwrap().unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![2]);
        drop(sink);
        assert_eq!(source.next_frame().await, Ok(None));
    }

    #[tokio::test]
    async fn a_helper_picture_whose_rows_are_outside_its_frame_is_skipped() {
        let (sink, mut source) = drawn_feed(Arc::new(|_| {}));
        let area = Area { x: 0.0, y: 0.0, width: 2.0, height: 2.0 };
        let mut bad = helper_picture(2, 2, [1, 1, 1], area, area);
        bad.rows = 0..40;
        sink.push(DrawnPicture { epoch: 1, size: LockedSize { width: 2, height: 2 }, picture: bad });
        assert!(source.next_frame().now_or_never().is_none());
        sink.push(DrawnPicture { epoch: 2, size: LockedSize { width: 2, height: 2 }, picture: helper_picture(2, 2, [1, 1, 1], area, area) });
        assert!(source.next_frame().await.unwrap().is_some());
    }
}
