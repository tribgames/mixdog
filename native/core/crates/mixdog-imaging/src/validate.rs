//! Validation of an image at intake: decide what the bytes are, certify that every picture the file holds decodes, count its
//! frames or pages, and make the one rendition a destination may need (see [`Validated::rendition`]); the original is what
//! every destination that takes it receives, byte for byte. It runs once per distinct original, behind the
//! process-wide admission controller, and the verdict is stored (never recomputed on the send path).
//!
//! * PNG, JPEG, still WebP, AVIF and TIFF page 1: one whole decode under the budget (`decode_within`): the check is what the
//!   decoder says, not a signature or header walk.
//! * GIF, APNG and animated WebP: every frame is decoded and discarded under a frame count and a cumulative pixel budget, so
//!   a corrupt later frame is found and frame zero never certifies the rest.
//! * TIFF: every directory is counted (a multi-page file is `frames > 1`). AVIF with an image sequence brand is `frames > 1`.
//! * SVG: rasterized once at the size it will be sent at (see `svg_limits`); only that inert PNG is kept.
//! * HEIC: decoded by the operating system's codec (`os_heic`), upright and in sRGB, into a JPEG rendition; a HEIC the OS cannot
//!   decode, or whose orientation or colour profile it cannot honour, is refused.

use std::io::Cursor;

use image::AnimationDecoder;
use image::ImageDecoder;
use image::codecs::gif::GifDecoder;
use image::codecs::png::PngDecoder;
use image::codecs::webp::WebPDecoder;
use mixdog_image_egress::admission::Admission;
use mixdog_image_egress::admission::AdmitError;
use mixdog_image_egress::admission::Cancel;
use mixdog_image_egress::admission::WORKER_BYTES;

use crate::avif::is_hevc_heif;
use crate::decode::DECODE_PIXEL_LIMIT;
use crate::decode::Decoded;
use crate::decode::Format;
use crate::decode::decode_within;
use crate::decode::rasterize_svg;
use crate::encode::encode_in_format;
use crate::os_heic::HeicCodec;
use crate::os_heic::HeicFailure;
use crate::policy::IMAGE_MAX_HEIGHT;
use crate::policy::IMAGE_MAX_WIDTH;
use crate::resize::fit_inside_view;
use mixdog_image_egress::ImageKind;

/// Raise with any change that alters a verdict or a rendition; stored verdicts of an older version are re-run by migration.
/// 2: a still beyond the tightest destination limits gets its rendition (JPEG for a JPEG), and a HEIC's orientation and colour
/// profile are honoured or the file refused.
/// 3: a rendition that would be beyond the size limit as PNG is a JPEG.
pub const VALIDATOR_VERSION: u32 = 3;

/// Hard caps, independent of each other.
pub const MAX_FRAMES: u32 = 2000;
pub const MAX_PAGES: u32 = 1000;
pub const MAX_CUMULATIVE_PIXELS: u64 = 1 << 31;

/// What import learned about one original.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Validated {
    pub kind: ImageKind,
    pub width: u32,
    pub height: u32,
    /// Frames or pages; 1 for a single picture.
    pub frames: u32,
    /// The picture fit inside the provider box, when the original is a type some destination does not read (AVIF, TIFF, SVG,
    /// GIF, HEIC) or is beyond the tightest edge or size a destination declares: JPEG for a JPEG or a HEIC, PNG otherwise. Never
    /// made for an animation. Which destination gets it, and which gets the original, is the destination's choice at send.
    pub rendition: Option<(ImageKind, Vec<u8>)>,
}

/// A permanent refusal, or a transient failure that is not recorded as a verdict.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Reject {
    NotAnImage,
    Corrupt,
    TooLarge,
    /// A HEIC picture and this PC has no HEIC decoder.
    HeicNoDecoder,
    /// A HEIC picture the PC's decoder could not decode.
    HeicUndecodable,
    /// Transient: queue full or cancelled. Never stored as a verdict.
    Busy,
    Cancelled,
}

impl Reject {
    pub fn is_permanent(self) -> bool {
        !matches!(self, Reject::Busy | Reject::Cancelled)
    }
}

impl From<AdmitError> for Reject {
    fn from(error: AdmitError) -> Self {
        match error {
            AdmitError::TooLarge => Reject::TooLarge,
            AdmitError::Busy => Reject::Busy,
            AdmitError::Cancelled => Reject::Cancelled,
        }
    }
}

fn from_decode(error: crate::error::ImagingError) -> Reject {
    if error.sentence() == crate::error::PIXEL_LIMIT { Reject::TooLarge } else { Reject::Corrupt }
}

/// Whether the `ftyp` box names an AVIF image sequence (`avis`) among its brands.
fn is_avif_sequence(bytes: &[u8]) -> bool {
    let Some(size) = bytes.get(0..4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize) else { return false };
    if bytes.get(4..8) != Some(b"ftyp") || size < 16 || size > bytes.len() {
        return false;
    }
    let brands = &bytes[8..size];
    brands.as_chunks::<4>().0.iter().any(|brand| brand == b"avis")
}

fn count_frames<'a, D: AnimationDecoder<'a>>(decoder: D, cancel: &Cancel) -> Result<u32, Reject> {
    let (mut frames, mut pixels) = (0u32, 0u64);
    for frame in decoder.into_frames() {
        if cancel.is_cancelled() {
            return Err(Reject::Cancelled);
        }
        let frame = frame.map_err(|_| Reject::Corrupt)?;
        frames += 1;
        pixels += u64::from(frame.buffer().width()) * u64::from(frame.buffer().height());
        if frames > MAX_FRAMES || pixels > MAX_CUMULATIVE_PIXELS {
            return Err(Reject::TooLarge);
        }
    }
    Ok(frames)
}

fn check_canvas(width: u32, height: u32) -> Result<(), Reject> {
    // The decoder's canvas plus one RGBA frame.
    if u64::from(width) * u64::from(height) > DECODE_PIXEL_LIMIT / 4 { Err(Reject::TooLarge) } else { Ok(()) }
}

fn tiff_pages(bytes: &[u8], cancel: &Cancel) -> Result<u32, Reject> {
    let mut decoder = tiff::decoder::Decoder::new(Cursor::new(bytes)).map_err(|_| Reject::Corrupt)?;
    let mut pages = 1u32;
    while decoder.more_images() {
        if cancel.is_cancelled() {
            return Err(Reject::Cancelled);
        }
        decoder.next_image().map_err(|_| Reject::Corrupt)?;
        pages += 1;
        if pages > MAX_PAGES {
            return Err(Reject::TooLarge);
        }
    }
    Ok(pages)
}

/// The image kind of a decoder format.
pub fn kind_of(format: Format) -> ImageKind {
    match format {
        Format::Png => ImageKind::Png,
        Format::Jpeg => ImageKind::Jpeg,
        Format::Webp => ImageKind::Webp,
        Format::Gif => ImageKind::Gif,
        Format::Avif => ImageKind::Avif,
        Format::Tiff => ImageKind::Tiff,
        Format::Svg => ImageKind::Svg,
    }
}

/// The most bytes the fit of a width x height RGBA raster holds at once: the raster, the floats of the resize's first
/// pass and of its second.
fn fit_peak(width: u32, height: u32) -> u64 {
    let (out_width, out_height) = crate::resize::output_size(width, height, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, true);
    let (w, h, ow, oh) = (u64::from(width), u64::from(height), u64::from(out_width), u64::from(out_height));
    w * h * 4 + ((ow * h).min(w * oh) + ow * oh) * 4 * 4
}

/// Decode a HEIC with the OS codec and make its JPEG rendition, no larger than the provider box. The pixel cap given to the
/// codec keeps the decoded raster within the budget before it is allocated; the resize peak is checked once the size is known.
fn convert_heic(bytes: &[u8], budget: u64, codec: &dyn HeicCodec) -> Result<Validated, Reject> {
    let raster = codec.decode(bytes, budget / 8).map_err(|failure| match failure {
        HeicFailure::NoDecoder => Reject::HeicNoDecoder,
        HeicFailure::Failed => Reject::HeicUndecodable,
        HeicFailure::TooLarge => Reject::TooLarge,
    })?;
    if raster.width == 0 || raster.height == 0 || raster.data.len() as u64 != u64::from(raster.width) * u64::from(raster.height) * 4 {
        return Err(Reject::HeicUndecodable);
    }
    if fit_peak(raster.width, raster.height) > budget {
        return Err(Reject::TooLarge);
    }
    let (width, height) = (raster.width, raster.height);
    let fitted = fit_inside_view(&raster, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, true);
    let jpeg = crate::encode::encode_jpeg(&fitted, crate::encode::DEFAULT_JPEG_QUALITY, 255);
    Ok(Validated { kind: ImageKind::Heic, width, height, frames: 1, rendition: Some((ImageKind::Jpeg, jpeg)) })
}

/// The picture fit inside the provider box: a JPEG stays a JPEG (a photograph as PNG would outgrow the limits it is made for),
/// anything else becomes PNG, unless that PNG is itself beyond the tightest size a destination declares (a photograph saved
/// as PNG): then it is the JPEG, as 1.4.5's resizer made it, so the rendition always reaches every destination.
fn fit_rendition(decoded: &Decoded, format: Format) -> Result<(ImageKind, Vec<u8>), Reject> {
    let raster = fit_inside_view(&decoded.raster, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, true);
    // Transparency goes to black, as that resizer's JPEG had it.
    let jpeg = |quality: u8| (ImageKind::Jpeg, crate::encode::encode_jpeg(&raster, quality, 0));
    if format == Format::Jpeg {
        return Ok(jpeg(crate::encode::DEFAULT_JPEG_QUALITY));
    }
    let png = encode_in_format(&raster, Format::Png).map_err(|_| Reject::Corrupt)?;
    let (_, base64) = mixdog_image_egress::policy::tightest_limits();
    if mixdog_image_egress::policy::base64_len(png.len() as u64) > base64 {
        // Quality 50: what that resizer wrote for a rendition over its budget.
        return Ok(jpeg(50));
    }
    Ok((ImageKind::Png, png))
}

/// Validate `bytes` and make the PNG rendition they need. Acquires the process-wide worker slot before any decoder, parser
/// or allocation; everything held is released on every exit.
pub fn validate(bytes: &[u8], admission: &Admission, cancel: &Cancel) -> Result<Validated, Reject> {
    validate_with(bytes, admission, cancel, crate::os_heic::system())
}

/// [alidate] with the HEIC codec named (a test stands one in).
pub fn validate_with(bytes: &[u8], admission: &Admission, cancel: &Cancel, codec: &dyn HeicCodec) -> Result<Validated, Reject> {
    if bytes.is_empty() {
        return Err(Reject::NotAnImage);
    }
    Format::sniff(bytes).ok_or(Reject::NotAnImage)?;
    let input = bytes.len() as u64;
    if input >= WORKER_BYTES {
        return Err(Reject::TooLarge);
    }
    let _permit = admission.acquire(WORKER_BYTES, cancel)?;
    validate_held(bytes, 0, admission, cancel, codec)
}

/// The most bytes of base64 text one import takes (it is decoded under the worker charge together with its binary).
pub const MAX_BASE64_BYTES: u64 = WORKER_BYTES / 4;

/// Strict, complete, canonical base64 of at most [MAX_BASE64_BYTES], decoded under the worker slot the caller holds. The
/// length is bounded before anything is allocated; an empty, padded-wrong, whitespace-bearing or oversize text is rejected.
pub fn decode_base64_held(text: &str) -> Result<Vec<u8>, Reject> {
    use base64::Engine;
    if text.is_empty() {
        return Err(Reject::NotAnImage);
    }
    if text.len() as u64 > MAX_BASE64_BYTES {
        return Err(Reject::TooLarge);
    }
    base64::engine::general_purpose::STANDARD.decode(text).map_err(|_| Reject::NotAnImage)
}

/// Acquire the worker slot, decode base64 strictly, and hand the binary to `then` while the slot is held (so the base64
/// text, the binary and the decoder are never allocated outside the budget). `then` receives the bytes and the bytes already
/// charged, and normally calls [`validate_held`].
pub fn with_base64<T>(base64: &str, admission: &Admission, cancel: &Cancel, then: impl FnOnce(Vec<u8>, u64) -> Result<T, Reject>) -> Result<T, Reject> {
    if base64.len() as u64 > MAX_BASE64_BYTES {
        return Err(Reject::TooLarge);
    }
    let _permit = admission.acquire(WORKER_BYTES, cancel)?;
    let bytes = decode_base64_held(base64)?;
    let held = base64.len() as u64;
    then(bytes, held)
}

/// [alidate] for a caller that already holds the worker slot; held is what that caller has charged besides ytes.
pub fn validate_held(bytes: &[u8], held: u64, admission: &Admission, cancel: &Cancel, codec: &dyn HeicCodec) -> Result<Validated, Reject> {
    let input = bytes.len() as u64;
    if input + held >= WORKER_BYTES {
        return Err(Reject::TooLarge);
    }
    let format = Format::sniff(bytes).ok_or(Reject::NotAnImage)?;
    admission.note_decode();
    let budget = WORKER_BYTES - input - held;
    if format == Format::Avif && is_hevc_heif(bytes) {
        return convert_heic(bytes, budget, codec);
    }

    if format == Format::Svg {
        let decoded = rasterize_svg(bytes, DECODE_PIXEL_LIMIT, Some((IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT))).map_err(from_decode)?;
        let png = encode_in_format(&decoded.raster, Format::Png).map_err(|_| Reject::Corrupt)?;
        return Ok(Validated { kind: ImageKind::Svg, width: decoded.width, height: decoded.height, frames: 1, rendition: Some((ImageKind::Png, png)) });
    }

    let mut known = (0u32, 0u32);
    let frames = match format {
        Format::Gif => {
            let decoder = GifDecoder::new(Cursor::new(bytes)).map_err(|_| Reject::Corrupt)?;
            let (w, h) = decoder.dimensions();
            check_canvas(w, h)?;
            known = (w, h);
            count_frames(decoder, cancel)?
        }
        Format::Png => {
            let decoder = PngDecoder::new(Cursor::new(bytes)).map_err(|_| Reject::Corrupt)?;
            let (w, h) = decoder.dimensions();
            check_canvas(w, h)?;
            known = (w, h);
            if decoder.is_apng().map_err(|_| Reject::Corrupt)? {
                let decoder = PngDecoder::new(Cursor::new(bytes)).map_err(|_| Reject::Corrupt)?;
                count_frames(decoder.apng().map_err(|_| Reject::Corrupt)?, cancel)?
            } else {
                1
            }
        }
        Format::Webp => {
            let decoder = WebPDecoder::new(Cursor::new(bytes)).map_err(|_| Reject::Corrupt)?;
            let (w, h) = decoder.dimensions();
            check_canvas(w, h)?;
            known = (w, h);
            if decoder.has_animation() { count_frames(decoder, cancel)? } else { 1 }
        }
        Format::Tiff => tiff_pages(bytes, cancel)?,
        Format::Avif => {
            if is_avif_sequence(bytes) {
                2
            } else {
                1
            }
        }
        Format::Jpeg | Format::Svg => 1,
    };
    if frames == 0 {
        return Err(Reject::Corrupt);
    }
    if frames > 1 {
        // Every frame or page was checked above; the size is the canvas, or for TIFF and AVIF the first picture's.
        let (width, height) = if known.0 > 0 {
            known
        } else {
            let first = decode_within(bytes, DECODE_PIXEL_LIMIT, budget).map_err(from_decode)?;
            (first.width, first.height)
        };
        return Ok(Validated { kind: kind_of(format), width, height, frames, rendition: None });
    }
    let decoded = decode_within(bytes, DECODE_PIXEL_LIMIT, budget).map_err(from_decode)?;
    let direct = matches!(format, Format::Png | Format::Jpeg | Format::Webp);
    let (edge, base64) = mixdog_image_egress::policy::tightest_limits();
    let oversize = decoded.width.max(decoded.height) > edge || mixdog_image_egress::policy::base64_len(input) > base64;
    let rendition = if direct && !oversize { None } else { Some(fit_rendition(&decoded, format)?) };
    Ok(Validated { kind: kind_of(format), width: decoded.width, height: decoded.height, frames: 1, rendition })
}

#[cfg(test)]
mod tests {
    use mixdog_image_egress::admission::global;

    use super::*;
    use crate::decode::Raster;

    fn picture(width: u32, height: u32) -> Raster {
        let data = (0..width * height).flat_map(|i| [(i % 251) as u8, (i % 13) as u8 * 19, (i % 7) as u8 * 36]).collect();
        Raster { width, height, has_alpha: false, data }
    }

    fn as_format(format: Format, width: u32, height: u32) -> Vec<u8> {
        encode_in_format(&picture(width, height), format).unwrap()
    }

    fn run(bytes: &[u8]) -> Result<Validated, Reject> {
        validate(bytes, global(), &Cancel::default())
    }

    fn gif_frames(count: u32) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut out);
            for i in 0..count {
                let rgba = image::RgbaImage::from_fn(8, 8, |x, y| image::Rgba([(x * 30) as u8, (y * 30) as u8, (i * 80) as u8, 255]));
                encoder.encode_frame(image::Frame::new(rgba)).unwrap();
            }
        }
        out
    }

    #[test]
    fn valid_stills_pass_with_their_sniffed_type_and_real_dimensions() {
        for format in [Format::Png, Format::Jpeg, Format::Webp] {
            let verdict = run(&as_format(format, 33, 21)).unwrap_or_else(|e| panic!("{format:?}: {e:?}"));
            assert_eq!((verdict.kind, verdict.width, verdict.height, verdict.frames), (kind_of(format), 33, 21, 1));
            assert!(verdict.rendition.is_none(), "{format:?} needs no rendition");
        }
    }

    #[test]
    fn avif_and_tiff_get_a_decodable_png_rendition_and_a_still_gif_too() {
        for format in [Format::Avif, Format::Tiff, Format::Gif] {
            let verdict = run(&as_format(format, 24, 16)).unwrap_or_else(|e| panic!("{format:?}: {e:?}"));
            let (kind, png) = verdict.rendition.as_ref().expect("rendition");
            assert_eq!(*kind, ImageKind::Png);
            let png = &png[..];
            assert_eq!(Format::sniff(png), Some(Format::Png));
            assert!(decode_within(png, DECODE_PIXEL_LIMIT, u64::MAX).is_ok());
        }
    }

    #[test]
    fn a_still_beyond_the_tightest_destination_edge_gets_a_fitted_rendition_in_its_own_family() {
        for (format, kind) in [(Format::Jpeg, ImageKind::Jpeg), (Format::Png, ImageKind::Png)] {
            let verdict = run(&as_format(format, 2001, 8)).unwrap_or_else(|e| panic!("{format:?}: {e:?}"));
            let (made, bytes) = verdict.rendition.as_ref().expect("rendition");
            assert_eq!(*made, kind, "{format:?}");
            let fitted = decode_within(bytes, DECODE_PIXEL_LIMIT, u64::MAX).unwrap();
            assert!(fitted.width <= IMAGE_MAX_WIDTH, "{format:?}: {}", fitted.width);
            // Within every destination's edge, nothing extra is made.
            assert!(run(&as_format(format, 2000, 8)).unwrap().rendition.is_none(), "{format:?}");
        }
    }

    #[test]
    fn svg_becomes_an_inert_png_only() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/><script>alert(1)</script></svg>"#;
        let verdict = run(svg).unwrap();
        assert_eq!(Format::sniff(&verdict.rendition.as_ref().unwrap().1), Some(Format::Png));
    }

    #[test]
    fn mislabeled_and_unknown_bytes_are_judged_by_content() {
        assert_eq!(run(b"not an image at all"), Err(Reject::NotAnImage));
        assert_eq!(run(&[]), Err(Reject::NotAnImage));
        // A PNG is a PNG whatever it is called.
        assert_eq!(run(&as_format(Format::Png, 4, 4)).unwrap().kind, ImageKind::Png);
    }

    #[test]
    fn truncated_late_payloads_are_corrupt() {
        for format in [Format::Png, Format::Jpeg, Format::Webp, Format::Tiff] {
            let bytes = as_format(format, 64, 64);
            let cut = &bytes[..bytes.len() - bytes.len() / 4];
            assert_eq!(run(cut), Err(Reject::Corrupt), "{format:?}");
        }
    }

    #[test]
    fn an_animation_is_counted_and_a_cut_later_frame_is_corrupt() {
        let gif = gif_frames(3);
        let verdict = run(&gif).unwrap();
        assert_eq!((verdict.frames, verdict.rendition.is_none()), (3, true));
        let cut = &gif[..gif.len() - gif.len() / 3];
        assert_eq!(run(cut), Err(Reject::Corrupt), "frame zero does not certify the rest");
    }

    #[test]
    fn oversized_headers_are_refused_before_decoding() {
        // A PNG header declaring 60000 x 60000.
        let mut png = as_format(Format::Png, 4, 4);
        png[16..20].copy_from_slice(&60000u32.to_be_bytes());
        png[20..24].copy_from_slice(&60000u32.to_be_bytes());
        assert!(matches!(run(&png), Err(Reject::TooLarge | Reject::Corrupt)));
    }

    fn rgba(width: u32, height: u32) -> Raster {
        let data = (0..width * height).flat_map(|i| [(i % 251) as u8, (i % 13) as u8 * 19, (i % 7) as u8 * 36, 255]).collect();
        Raster { width, height, has_alpha: true, data }
    }

    fn heic_bytes() -> Vec<u8> {
        let mut heic = vec![0, 0, 0, 24, b'f', b't', b'y', b'p', b'h', b'e', b'i', b'c', 0, 0, 0, 0, b'm', b'i', b'f', b'1', b'h', b'e', b'i', b'c'];
        heic.extend_from_slice(&[0; 32]);
        heic
    }

    #[test]
    fn heic_converts_through_the_codec_to_a_jpeg_rendition() {
        let codec = crate::os_heic::fakes::Fixed(rgba(3000, 2000));
        let verdict = validate_with(&heic_bytes(), global(), &Cancel::default(), &codec).unwrap();
        assert_eq!((verdict.kind, verdict.width, verdict.height, verdict.frames), (ImageKind::Heic, 3000, 2000, 1));
        let (kind, jpeg) = verdict.rendition.expect("rendition");
        assert_eq!((kind, Format::sniff(&jpeg)), (ImageKind::Jpeg, Some(Format::Jpeg)));
        let decoded = decode_within(&jpeg, DECODE_PIXEL_LIMIT, u64::MAX).unwrap();
        assert!(decoded.width.max(decoded.height) <= IMAGE_MAX_WIDTH, "fit inside the provider box");
    }

    #[test]
    fn heic_with_no_codec_or_a_codec_that_fails_midway_is_a_refusal() {
        let none = validate_with(&heic_bytes(), global(), &Cancel::default(), &crate::os_heic::fakes::NoDecoder);
        assert_eq!(none, Err(Reject::HeicNoDecoder));
        let broken = validate_with(&heic_bytes(), global(), &Cancel::default(), &crate::os_heic::fakes::FailsMidDecode);
        assert_eq!(broken, Err(Reject::HeicUndecodable));
        assert!(none.unwrap_err().is_permanent());
    }

    /// Runs the real operating-system codec on `tests/fixtures/gradient-64x48.heic`: a 64x48 synthetic gradient (R = x*4, G = y*5,
    /// B = 90) encoded with x265 through pillow-heif for this test, so the file carries no third-party content. Skipped, with
    /// the reason printed, where the OS has no HEIC decoder (Linux; Windows without the HEIF/HEVC extensions): CI's skip list
    /// names this test.
    #[test]
    fn heic_system_codec_round_trip_or_explicit_skip() {
        let heic = include_bytes!("../tests/fixtures/gradient-64x48.heic").to_vec();
        match validate(&heic, global(), &Cancel::default()) {
            Ok(verdict) => {
                assert_eq!((verdict.kind, verdict.width, verdict.height), (ImageKind::Heic, 64, 48));
                let (kind, jpeg) = verdict.rendition.unwrap();
                assert_eq!((kind, Format::sniff(&jpeg)), (ImageKind::Jpeg, Some(Format::Jpeg)));
            }
            Err(Reject::HeicNoDecoder) => eprintln!("SKIP heic_system_codec_round_trip_or_explicit_skip: this OS has no HEIC decoder"),
            Err(other) => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_cancelled_import_leaves_nothing_held() {
        let cancel = Cancel::default();
        cancel.cancel();
        let admission = Admission::with_total(mixdog_image_egress::admission::TOTAL_BYTES);
        assert_eq!(validate(&as_format(Format::Png, 4, 4), &admission, &cancel), Err(Reject::Cancelled));
        assert_eq!(admission.charged(), 0);
    }
}
