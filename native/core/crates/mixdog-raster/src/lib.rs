//! The raster operations the Office stack asked sharp (libvips) for, over RGBA8 pixels.
//!
//! [`Image`] holds straight-alpha RGBA8 and the band count sharp would report (grey, grey and alpha, RGB, RGBA). It
//! is decoded by `mixdog-imaging` (format sniffing, the pixel limit, ICC to sRGB, 16-bit and palette to 8-bit), so there is
//! one decoder and one resampler family in the product. This crate adds what the office code calls on top of it: the
//! fits `cover`, `contain`, `fill`, `inside` and `outside` with every kernel and gravity (and libvips's entropy and
//! attention crops), `extract`, `extend`, `composite` with `over`, `dest-in` and `multiply`, `flatten`, `greyscale`,
//! `linear`, `modulate`, `trim`, EXIF auto-orientation, raw access and the per-channel `stats`.
//!
//! Every operation is a plain function over an [`Image`]. The blocking ones are offered as async wrappers that run as a job
//! on a `mixdog-rt` lane ([`on_lane`], [`decode_on`], [`resize_on`], [`png_on`], [`stats_on`], [`composite_on`]): the
//! workspace bans running them on the async workers.

use std::fmt;

use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;

pub mod composite;
pub mod image;
pub mod ops;
pub mod smartcrop;
pub mod stats;

pub use crate::composite::Blend;
pub use crate::composite::Overlay;
pub use crate::composite::Placement;
pub use crate::composite::composite;
pub use crate::image::Image;
pub use crate::image::Metadata;
pub use crate::ops::Fit;
pub use crate::ops::Kernel;
pub use crate::ops::Position;
pub use crate::ops::ResizeOptions;
pub use crate::ops::Trimmed;
pub use crate::stats::ChannelStats;
pub use crate::stats::stats;

/// A failed raster call, with the sentence sharp gives for the same failure where there is one.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RasterError {
    message: String,
}

impl RasterError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for RasterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RasterError {}

/// Runs `job` on `lane` and answers its result. Dropping the future takes a job that has not started out of the queue.
pub async fn on_lane<L, R>(lane: L, job: impl FnOnce() -> R + Send + 'static) -> Result<R, RasterError>
where
    L: LaneToken,
    R: Send + 'static,
{
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let handle = lane.submit_wait(&cancel, move |_| job()).await.map_err(|error| RasterError::new(format!("the image job was not run: {error}")))?;
    handle.await.map_err(|_| RasterError::new("the image job was dropped before it finished"))
}

/// [`Image::decode`] as a lane job.
pub async fn decode_on<L: LaneToken>(lane: L, bytes: Vec<u8>) -> Result<Image, RasterError> {
    on_lane(lane, move || Image::decode(&bytes)).await?
}

/// [`ops::resize`] as a lane job.
pub async fn resize_on<L: LaneToken>(lane: L, image: Image, options: ResizeOptions) -> Result<Image, RasterError> {
    on_lane(lane, move || ops::resize(&image, &options)).await?
}

/// [`Image::to_png`] as a lane job.
pub async fn png_on<L: LaneToken>(lane: L, image: Image) -> Result<Vec<u8>, RasterError> {
    on_lane(lane, move || image.to_png()).await?
}

/// [`stats()`] as a lane job.
pub async fn stats_on<L: LaneToken>(lane: L, image: Image) -> Result<Vec<ChannelStats>, RasterError> {
    on_lane(lane, move || stats(&image)).await
}

/// [`composite()`] as a lane job.
pub async fn composite_on<L: LaneToken>(lane: L, base: Image, overlays: Vec<Overlay>) -> Result<Image, RasterError> {
    on_lane(lane, move || composite(&base, &overlays)).await
}
