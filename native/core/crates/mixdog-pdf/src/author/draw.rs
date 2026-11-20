//! `pdf-draw.mjs`: the page sizes, colours, rounding and images the office PDF writers draw with.
//!
//! An image is embedded as pdf-lib 1.17.1 does it: a PNG is decoded to 8-bit RGB (`DeviceRGB`, `FlateDecode`) with its
//! alpha band, when any pixel is not opaque, as a `DeviceGray` soft mask; a JPEG keeps its bytes (`DCTDecode`) and is
//! described by the size, depth and channel count its frame header states; an SVG logo, which the PDF page draws as a
//! raster, is rendered by [`mixdog_raster::svg`] well above its declared size and embedded as a PNG, and the placement
//! still uses the vector's own size so a default-placed logo keeps its scale.

use std::sync::{Arc, LazyLock};

use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, js_to_lowercase, math::to_fixed, value_to_string};
use mixdog_office_base::page_sizes::page_size_points;
use mixdog_raster::Image;
use mixdog_raster::svg::{self, SvgFonts};
use serde_json::Value;

use crate::embed::{EmbedError, be_u16};
use crate::stream::FilterSpec;
use crate::write::flate_stream;
use crate::write::store::{ObjectStore, stream_object};
use crate::{Dict, Obj, Ref};

/// `round2`: the value to two decimals, as a number.
pub fn round2(value: f64) -> f64 {
    to_fixed(value, 2).parse().unwrap_or(value)
}

/// `color(value)`: `#RRGGBB` (the `#` is optional; nothing at all is black) as red, green and blue between 0 and 1.
pub fn parse_color(value: &str) -> Result<[f64; 3], String> {
    let hex = if value.is_empty() { "000000" } else { value };
    let hex = hex.strip_prefix('#').unwrap_or(hex);
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("Invalid PDF color: {value}"));
    }
    let channel = |at: usize| f64::from(u8::from_str_radix(&hex[at..at + 2], 16).unwrap_or(0)) / 255.0;
    Ok([channel(0), channel(2), channel(4)])
}

/// What JavaScript's `||` keeps: a value that is not undefined, null, false, 0, NaN or the empty string.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

/// `pageSize(properties)`: `[width, height]` in points of the `pageSize` property (A4 when there is none), turned on its
/// side by `orientation: "landscape"`.
pub fn page_size(properties: &Value) -> Result<[f64; 2], String> {
    let asked = properties.get("pageSize").filter(|value| truthy(value)).cloned().unwrap_or_else(|| Value::String("a4".to_owned()));
    let size = page_size_points(Some(&asked), "PDF page size")?;
    let orientation = properties.get("orientation").filter(|value| truthy(value)).map(value_to_string).unwrap_or_default();
    Ok(if js_to_lowercase(&orientation) == "landscape" && size[0] < size[1] { [size[1], size[0]] } else { size })
}

/// An image in the document: the object, and the size the page places it at (a raster's pixel size; a vector's declared
/// size in points).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmbeddedImage {
    pub reference: Ref,
    pub width: u32,
    pub height: u32,
}

/// An SVG by its name, or by an opening tag in the first 512 bytes.
fn looks_like_svg(data: &[u8], extension: &str) -> bool {
    static OPENING: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<svg[\s>]", "i"));
    extension == ".svg" || OPENING.is_match(&String::from_utf8_lossy(&data[..data.len().min(512)]))
}

/// `path.extname(path).toLowerCase()`.
fn extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rfind('.') {
        Some(at) if at > 0 => js_to_lowercase(&name[at..]),
        _ => String::new(),
    }
}

fn numbers(values: &[f64]) -> Obj {
    Obj::Array(Arc::new(values.iter().map(|value| Obj::Num(*value)).collect()))
}

/// Embeds the pixels of `image` as pdf-lib's `PngEmbedder` does: 8-bit `DeviceRGB`, with a `DeviceGray` soft mask when a
/// pixel is not opaque.
fn embed_pixels(store: &mut ObjectStore, image: &Image) -> EmbeddedImage {
    let (width, height) = (image.width(), image.height());
    let reference = store.next_ref();
    let mut rgb = Vec::with_capacity(image.rgba().len() / 4 * 3);
    let mut alpha = Vec::with_capacity(image.rgba().len() / 4);
    for pixel in image.rgba().chunks_exact(4) {
        rgb.extend_from_slice(&pixel[..3]);
        alpha.push(pixel[3]);
    }
    let mask = alpha.iter().any(|value| *value < 255).then(|| {
        let mut dict = Dict::new();
        dict.set("Type", Obj::name("XObject"));
        dict.set("Subtype", Obj::name("Image"));
        dict.set("Height", Obj::Num(f64::from(height)));
        dict.set("Width", Obj::Num(f64::from(width)));
        dict.set("BitsPerComponent", Obj::Num(8.0));
        dict.set("ColorSpace", Obj::name("DeviceGray"));
        dict.set("Decode", numbers(&[0.0, 1.0]));
        store.register(flate_stream(dict, &alpha))
    });
    let mut dict = Dict::new();
    dict.set("Type", Obj::name("XObject"));
    dict.set("Subtype", Obj::name("Image"));
    dict.set("BitsPerComponent", Obj::Num(8.0));
    dict.set("Width", Obj::Num(f64::from(width)));
    dict.set("Height", Obj::Num(f64::from(height)));
    dict.set("ColorSpace", Obj::name("DeviceRGB"));
    if let Some(mask) = mask {
        dict.set("SMask", Obj::Ref(mask));
    }
    store.assign(reference, flate_stream(dict, &rgb));
    EmbeddedImage { reference, width, height }
}

/// Whether a PNG carries an animation (an `acTL` chunk of more than one frame before its image data), which pdf-lib refuses.
fn animated_png(data: &[u8]) -> bool {
    let mut at = 8usize;
    while let Some(header) = data.get(at..at.saturating_add(8)).filter(|header| header.len() == 8) {
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        match &header[4..8] {
            b"IDAT" => return false,
            b"acTL" => {
                return data.get(at + 8..at + 12).is_some_and(|frames| u32::from_be_bytes([frames[0], frames[1], frames[2], frames[3]]) > 1);
            }
            _ => {}
        }
        match at.checked_add(length).and_then(|next| next.checked_add(12)) {
            Some(next) => at = next,
            None => return false,
        }
    }
    false
}

fn embed_png(store: &mut ObjectStore, data: &[u8]) -> Result<EmbeddedImage, EmbedError> {
    if !data.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Err(EmbedError::new("The input is not a PNG file!"));
    }
    if animated_png(data) {
        return Err(EmbedError::new("Animated PNGs are not supported"));
    }
    let image = Image::decode(data).map_err(|error| EmbedError::new(format!("The PNG could not be read: {error}")))?;
    Ok(embed_pixels(store, &image))
}

/// The frame markers pdf-lib's JPEG reader stops at: every start-of-frame marker but the Huffman table one (`0xffc4`).
fn frame_marker(marker: u16) -> bool {
    (0xffc0..=0xffcf).contains(&marker) && marker != 0xffc4
}

/// What a `DataView` read past the end of the data throws.
const OUTSIDE: &str = "Offset is outside the bounds of the DataView";

fn be16(data: &[u8], at: usize) -> Result<u16, EmbedError> {
    be_u16(data, at).ok_or_else(|| EmbedError::new(OUTSIDE))
}

fn embed_jpeg(store: &mut ObjectStore, data: &[u8]) -> Result<EmbeddedImage, EmbedError> {
    if be16(data, 0)? != 0xffd8 {
        return Err(EmbedError::new("SOI not found in JPEG"));
    }
    let mut at = 2;
    let mut marker = 0;
    while at < data.len() {
        marker = be16(data, at)?;
        at += 2;
        if frame_marker(marker) {
            break;
        }
        at += usize::from(be16(data, at)?);
    }
    if !frame_marker(marker) {
        return Err(EmbedError::new("Invalid JPEG"));
    }
    at += 2;
    let byte = |at: usize| data.get(at).copied().ok_or_else(|| EmbedError::new(OUTSIDE));
    let bits = byte(at)?;
    let height = be16(data, at + 1)?;
    let width = be16(data, at + 3)?;
    let space = match byte(at + 5)? {
        1 => "DeviceGray",
        3 => "DeviceRGB",
        4 => "DeviceCMYK",
        _ => return Err(EmbedError::new("Unknown JPEG channel.")),
    };
    let mut dict = Dict::new();
    dict.set("Type", Obj::name("XObject"));
    dict.set("Subtype", Obj::name("Image"));
    dict.set("BitsPerComponent", Obj::Num(f64::from(bits)));
    dict.set("Width", Obj::Num(f64::from(width)));
    dict.set("Height", Obj::Num(f64::from(height)));
    dict.set("ColorSpace", Obj::name(space));
    dict.set("Filter", Obj::name("DCTDecode"));
    if space == "DeviceCMYK" {
        // CMYK JPEG streams are stored complemented in a PDF; a standalone file is not, so the swap is the hedge pdf-lib makes.
        dict.set("Decode", numbers(&[1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0]));
    }
    let chain = vec![FilterSpec { name: "DCTDecode".to_owned(), params: None }];
    let reference = store.register(stream_object(dict, data.to_vec(), chain));
    Ok(EmbeddedImage { reference, width: u32::from(width), height: u32::from(height) })
}

fn embed_svg(store: &mut ObjectStore, fonts: &SvgFonts, data: &[u8], image_path: &str) -> Result<EmbeddedImage, EmbedError> {
    svg::metadata(fonts, data, svg::DEFAULT_DENSITY).map_err(|error| EmbedError::new(format!("PDF could not read the SVG {image_path}: {error}")))?;
    let logo = svg::rasterize_logo(fonts, data).map_err(|error| EmbedError::new(error.to_string()))?;
    let raster = embed_pixels(store, &logo.image);
    Ok(EmbeddedImage { width: logo.width, height: logo.height, ..raster })
}

/// `embedImage(document, imagePath)`: the file at `image_path` embedded into `store`, chosen by sniffing (a `.png` or a
/// PNG signature, then a `.jpg`, `.jpeg` or JPEG signature, then an SVG) and returned with the size the page places it at.
pub fn embed_image<P: ReadProof>(proof: &P, store: &mut ObjectStore, fonts: &SvgFonts, image_path: &str) -> Result<EmbeddedImage, EmbedError> {
    let data = mixdog_fsio::read(proof, image_path).map_err(|error| EmbedError::new(error.to_string()))?;
    let extension = extension(image_path);
    if extension == ".png" || data.starts_with(&[0x89, 0x50]) {
        return embed_png(store, &data);
    }
    if extension == ".jpg" || extension == ".jpeg" || data.starts_with(&[0xff, 0xd8]) {
        return embed_jpeg(store, &data);
    }
    if looks_like_svg(&data, &extension) {
        return embed_svg(store, fonts, &data, image_path);
    }
    Err(EmbedError::new(format!("PDF images must be PNG, JPEG, or SVG: {image_path}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dict_of(store: &ObjectStore, reference: Ref) -> Arc<Dict> {
        store.get(reference).and_then(Obj::dict_or_stream_dict).expect("an image object").clone()
    }

    #[test]
    fn colours_are_six_hex_digits() {
        assert_eq!(parse_color("#FF8000").unwrap(), [1.0, 128.0 / 255.0, 0.0]);
        assert_eq!(parse_color("").unwrap(), [0.0, 0.0, 0.0]);
        assert_eq!(parse_color("00ff00").unwrap(), [0.0, 1.0, 0.0]);
        assert_eq!(parse_color("#fff").unwrap_err(), "Invalid PDF color: #fff");
        assert_eq!(parse_color("##000000").unwrap_err(), "Invalid PDF color: ##000000");
    }

    #[test]
    fn rounding_is_to_fixed_two() {
        assert_eq!(round2(1.005), 1.0);
        assert_eq!(round2(2.675), 2.67);
        assert_eq!(round2(0.125), 0.13);
        assert_eq!(round2(-0.004), 0.0);
    }

    #[test]
    fn page_sizes_follow_the_orientation() {
        assert_eq!(page_size(&json!({})).unwrap(), [595.28, 841.89]);
        assert_eq!(page_size(&json!({ "pageSize": "Letter", "orientation": "Landscape" })).unwrap(), [792.0, 612.0]);
        assert_eq!(page_size(&json!({ "pageSize": [300, 200], "orientation": "landscape" })).unwrap(), [300.0, 200.0]);
        assert_eq!(
            page_size(&json!({ "pageSize": "b5" })).unwrap_err(),
            "Unknown PDF page size: b5; use a3, a4, a5, letter, legal, tabloid or [width, height] in points"
        );
    }

    #[test]
    fn a_jpeg_keeps_its_bytes_and_states_its_frame() {
        // SOI, an APP0 segment of 4 bytes, then SOF0: 8 bits, 20 high, 30 wide, 3 channels.
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x14, 0x00, 0x1e, 0x03];
        let mut store = ObjectStore::new();
        let image = embed_jpeg(&mut store, &jpeg).unwrap();
        assert_eq!((image.width, image.height), (30, 20));
        let dict = dict_of(&store, image.reference);
        assert!(dict.get_raw("ColorSpace").is_some_and(|space| space.is_name("DeviceRGB")));
        assert!(dict.get_raw("Filter").is_some_and(|filter| filter.is_name("DCTDecode")));
        assert!(!dict.has("Decode"));
    }

    #[test]
    fn a_broken_jpeg_is_refused_with_pdf_libs_words() {
        let mut store = ObjectStore::new();
        assert_eq!(embed_jpeg(&mut store, &[0x00, 0x01, 0x02]).unwrap_err().to_string(), "SOI not found in JPEG");
        assert_eq!(embed_jpeg(&mut store, &[0xff, 0xd8]).unwrap_err().to_string(), "Invalid JPEG");
        assert_eq!(embed_jpeg(&mut store, &[0xff]).unwrap_err().to_string(), OUTSIDE);
        let two_channels = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x02];
        assert_eq!(embed_jpeg(&mut store, &two_channels).unwrap_err().to_string(), "Unknown JPEG channel.");
    }

    #[test]
    fn a_cmyk_jpeg_is_complemented() {
        let jpeg = [0xff, 0xd8, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x04];
        let mut store = ObjectStore::new();
        let image = embed_jpeg(&mut store, &jpeg).unwrap();
        let dict = dict_of(&store, image.reference);
        assert_eq!(dict.get_raw("Decode").and_then(Obj::as_array).map(|decode| decode.len()), Some(8));
    }

    #[test]
    fn pixels_split_into_colour_and_soft_mask_when_something_is_see_through() {
        let opaque = Image::from_raw(2, 1, 4, &[1, 2, 3, 255, 4, 5, 6, 255]).unwrap();
        let mut store = ObjectStore::new();
        let image = embed_pixels(&mut store, &opaque);
        assert_eq!((image.width, image.height), (2, 1));
        assert!(!dict_of(&store, image.reference).has("SMask"));

        let clear = Image::from_raw(2, 1, 4, &[1, 2, 3, 255, 4, 5, 6, 0]).unwrap();
        let image = embed_pixels(&mut store, &clear);
        let dict = dict_of(&store, image.reference);
        let mask = dict.get_raw("SMask").and_then(Obj::as_ref_value).expect("a soft mask");
        assert!(dict_of(&store, mask).get_raw("ColorSpace").is_some_and(|space| space.is_name("DeviceGray")));
    }

    #[test]
    fn the_kind_of_a_file_is_sniffed() {
        assert_eq!(extension("C:\\logos\\Logo.PNG"), ".png");
        assert_eq!(extension("/a.b/logo"), "");
        assert_eq!(extension("/a/.png"), "");
        assert!(looks_like_svg(b"<?xml?><SVG xmlns=''/>", ".txt"));
        assert!(!looks_like_svg(b"<svgx>", ".txt"));
        assert!(looks_like_svg(b"nothing", ".svg"));
    }

    #[test]
    fn an_animated_png_is_recognised_by_its_frame_count() {
        fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut out = u32::try_from(body.len()).unwrap().to_be_bytes().to_vec();
            out.extend_from_slice(kind);
            out.extend_from_slice(body);
            out.extend_from_slice(&[0, 0, 0, 0]);
            out
        }
        let signature = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let mut animated = signature.to_vec();
        animated.extend(chunk(b"IHDR", &[0; 13]));
        animated.extend(chunk(b"acTL", &[0, 0, 0, 2, 0, 0, 0, 0]));
        animated.extend(chunk(b"IDAT", &[]));
        assert!(animated_png(&animated));
        let mut still = signature.to_vec();
        still.extend(chunk(b"IHDR", &[0; 13]));
        still.extend(chunk(b"IDAT", &[]));
        still.extend(chunk(b"acTL", &[0, 0, 0, 2, 0, 0, 0, 0]));
        assert!(!animated_png(&still));
    }
}
