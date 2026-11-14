//! JPEG encoding of captured frames through WIC, with PNG as the fallback
//! (Electron's NativeImage.toJPEG at DEFAULT_SCREENSHOT_QUALITY; the PS worker
//! sent PNG).

use std::ffi::c_void;
use windows::core::{GUID, PWSTR};
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_WICPixelFormat24bppBGR, IWICImagingFactory,
    WICBitmapEncoderNoCache,
};
use windows::Win32::System::Com::{
    CoCreateInstance, StructuredStorage::{CreateStreamOnHGlobal, PROPBAG2}, CLSCTX_INPROC_SERVER,
    STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET,
};
use windows::Win32::System::Variant::VARIANT;

/// An encoded image: its MIME type and bytes.
pub type Encoded = (&'static str, Vec<u8>);

/// The frame (four-byte RGBA pixels) as a JPEG of `quality` 0..=100, or as
/// PNG when WIC cannot encode it.
pub fn encode(rgba: &[u8], width: u32, height: u32, quality: u8) -> Option<Encoded> {
    choose(jpeg(rgba, width, height, quality), || png(rgba, width, height))
}

/// A JPEG that came out empty is as good as one that failed.
fn choose(
    jpeg: Result<Vec<u8>, String>,
    png: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Option<Encoded> {
    match jpeg {
        Ok(bytes) if !bytes.is_empty() => Some(("image/jpeg", bytes)),
        _ => png().ok().map(|bytes| ("image/png", bytes)),
    }
}

/// The frame as a PNG.
pub fn png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = ::png::Encoder::new(&mut out, width, height);
    encoder.set_color(::png::ColorType::Rgba);
    encoder.set_depth(::png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer.write_image_data(rgba).map_err(|error| error.to_string())?;
    writer.finish().map_err(|error| error.to_string())?;
    Ok(out)
}

/// Packed 24-bit BGR rows of RGBA pixels (alpha dropped).
fn bgr(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4).flat_map(|px| [px[2], px[1], px[0]]).collect()
}

fn wic(error: windows::core::Error) -> String {
    format!("wic: {}", error.message())
}

fn jpeg(rgba: &[u8], width: u32, height: u32, quality: u8) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
        return Err("wic: frame size does not match its pixels".into());
    }
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(wic)?;
        let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true).map_err(wic)?;
        let encoder = factory
            .CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null::<GUID>())
            .map_err(wic)?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache).map_err(wic)?;
        let (mut frame, mut options) = (None, None);
        encoder.CreateNewFrame(&mut frame, &mut options).map_err(wic)?;
        let (frame, options) = frame.zip(options).ok_or("wic: no frame encoder")?;
        let mut name: Vec<u16> = "ImageQuality\0".encode_utf16().collect();
        let property = PROPBAG2 {
            pstrName: PWSTR(name.as_mut_ptr()),
            ..Default::default()
        };
        options
            .Write(1, &property, &VARIANT::from(f32::from(quality.min(100)) / 100.0))
            .map_err(wic)?;
        frame.Initialize(&options).map_err(wic)?;
        frame.SetSize(width, height).map_err(wic)?;
        let mut format = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut format).map_err(wic)?;
        if format != GUID_WICPixelFormat24bppBGR {
            return Err("wic: the JPEG encoder wants another pixel format".into());
        }
        frame.WritePixels(height, width * 3, &bgr(rgba)).map_err(wic)?;
        frame.Commit().map_err(wic)?;
        encoder.Commit().map_err(wic)?;
        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME).map_err(wic)?;
        stream.Seek(0, STREAM_SEEK_SET, None).map_err(wic)?;
        let mut bytes = vec![0u8; stat.cbSize as usize];
        let mut read = 0u32;
        stream
            .Read(bytes.as_mut_ptr() as *mut c_void, bytes.len() as u32, Some(&mut read))
            .ok()
            .map_err(wic)?;
        bytes.truncate(read as usize);
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    fn rgba(width: usize, height: usize) -> Vec<u8> {
        (0..width * height)
            .flat_map(|i| [(i % width) as u8 * 8, (i / width) as u8 * 8, 90, 255])
            .collect()
    }

    #[test]
    fn colour_channels_are_reordered_without_alpha() {
        assert_eq!(bgr(&[1, 2, 3, 255, 4, 5, 6, 0]), vec![3, 2, 1, 6, 5, 4]);
    }

    #[test]
    fn a_jpeg_is_preferred_and_png_covers_its_failure() {
        let png_ok = || Ok(vec![9]);
        assert_eq!(choose(Ok(vec![1]), png_ok), Some(("image/jpeg", vec![1])));
        assert_eq!(choose(Err("wic".into()), png_ok), Some(("image/png", vec![9])));
        assert_eq!(choose(Ok(Vec::new()), png_ok), Some(("image/png", vec![9])));
        assert_eq!(choose(Err("wic".into()), || Err("png".into())), None);
    }

    #[test]
    fn a_png_round_trips_through_the_decoder() {
        let pixels = rgba(4, 3);
        let bytes = png(&pixels, 4, 3).expect("png");
        let mut reader = ::png::Decoder::new(std::io::Cursor::new(bytes)).read_info().expect("header");
        let mut out = vec![0; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut out).expect("frame");
        assert_eq!((frame.width, frame.height), (4, 3));
        assert_eq!(&out[..frame.buffer_size()], &pixels[..]);
    }

    #[test]
    fn a_frame_that_is_not_its_size_is_not_encoded() {
        assert!(jpeg(&[0; 8], 4, 4, 55).is_err());
    }

    /// WIC runs in memory only: no window, device or file is touched.
    #[test]
    fn a_small_synthetic_bitmap_is_encoded_as_jpeg() {
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let (mime, bytes) = encode(&rgba(16, 16), 16, 16, 55).expect("encoded");
        assert_eq!(mime, "image/jpeg");
        assert_eq!(&bytes[..2], &[0xff, 0xd8]);
        assert_eq!(&bytes[bytes.len() - 2..], &[0xff, 0xd9]);
    }
}
