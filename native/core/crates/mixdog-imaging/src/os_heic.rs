//! HEIC through the operating system's own codec. This build carries no HEVC decoder: Windows asks WIC for a HEIF decoder
//! (present only when Microsoft's HEIF/HEVC extensions are installed, found by asking, never by guessing), macOS uses ImageIO
//! (`CGImageSource`), Linux has none. A HEIC the OS decodes becomes pixels here and a JPEG rendition at intake; a HEIC it cannot
//! decode (no codec, or the file does not decode) is a refusal. Nothing undecoded is ever passed on to a provider.
//!
//! The codec is a trait so a test can stand in a decoder that reports "none" or one that fails midway.

use crate::decode::Raster;

/// Why the OS gave no picture.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HeicFailure {
    /// This PC has no HEIC decoder.
    NoDecoder,
    /// A decoder exists and the file does not decode (corrupt, truncated, unsupported variant).
    Failed,
    /// The picture is larger than the pixel limit given (checked from the header, before any pixel buffer).
    TooLarge,
}

/// A decoder of the primary picture of a HEIC file into RGBA, with the file's rotation and mirroring applied and in sRGB.
pub trait HeicCodec: Send + Sync {
    fn decode(&self, bytes: &[u8], max_pixels: u64) -> Result<Raster, HeicFailure>;
}

/// The codec of this operating system.
pub fn system() -> &'static dyn HeicCodec {
    static SYSTEM: System = System;
    &SYSTEM
}

struct System;

#[cfg(not(any(windows, target_os = "macos")))]
impl HeicCodec for System {
    fn decode(&self, _bytes: &[u8], _max_pixels: u64) -> Result<Raster, HeicFailure> {
        Err(HeicFailure::NoDecoder)
    }
}

#[cfg(windows)]
impl HeicCodec for System {
    fn decode(&self, bytes: &[u8], max_pixels: u64) -> Result<Raster, HeicFailure> {
        wic::decode(bytes, max_pixels)
    }
}

#[cfg(target_os = "macos")]
impl HeicCodec for System {
    fn decode(&self, bytes: &[u8], max_pixels: u64) -> Result<Raster, HeicFailure> {
        imageio::decode(bytes, max_pixels)
    }
}

#[cfg(windows)]
pub(crate) mod wic {
    use windows::Win32::Graphics::Imaging::CLSID_WICImagingFactory;
    use windows::Win32::Graphics::Imaging::GUID_ContainerFormatHeif;
    use windows::Win32::Graphics::Imaging::GUID_WICPixelFormat32bppRGBA;
    use windows::Win32::Graphics::Imaging::IWICImagingFactory;
    use windows::Win32::Graphics::Imaging::WICBitmapDitherTypeNone;
    use windows::Win32::Graphics::Imaging::WICBitmapPaletteTypeCustom;
    use windows::Win32::Graphics::Imaging::WICDecodeMetadataCacheOnDemand;
    use windows::Win32::System::Com::CLSCTX_INPROC_SERVER;
    use windows::Win32::System::Com::COINIT_MULTITHREADED;
    use windows::Win32::System::Com::CoCreateInstance;
    use windows::Win32::System::Com::CoInitializeEx;
    use windows::Win32::System::Com::CoUninitialize;

    use super::HeicFailure;
    use crate::decode::Raster;

    /// `WINCODEC_ERR_COMPONENTNOTFOUND`: WIC has no decoder for the stream.
    const COMPONENT_NOT_FOUND: i32 = 0x88982F50_u32 as i32;
    /// `MF_E_TOPO_CODEC_NOT_FOUND`: the HEIF container opens but no HEVC decoder is installed (the HEIF extension without the
    /// HEVC Video Extensions), which WIC reports only when the pixels are read.
    const HEVC_NOT_FOUND: i32 = 0xC00D5212_u32 as i32;
    /// `WINCODEC_ERR_PROPERTYNOTFOUND` and `WINCODEC_ERR_UNSUPPORTEDOPERATION`: the file records no orientation (no `irot`/`imir`
    /// property, or no metadata at all).
    const PROPERTY_NOT_FOUND: i32 = 0x88982F40_u32 as i32;
    const UNSUPPORTED_OPERATION: i32 = 0x88982F81_u32 as i32;

    /// COM on this thread for the duration of one call; `CoUninitialize` only when this call initialized it.
    struct Com(bool);

    impl Com {
        fn enter() -> Self {
            // S_OK and S_FALSE both count a successful initialization; RPC_E_CHANGED_MODE leaves COM usable as it is.
            Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
        }
    }

    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn classify(error: &windows::core::Error) -> HeicFailure {
        if matches!(error.code().0, COMPONENT_NOT_FOUND | HEVC_NOT_FOUND) { HeicFailure::NoDecoder } else { HeicFailure::Failed }
    }

    pub fn decode(bytes: &[u8], max_pixels: u64) -> Result<Raster, HeicFailure> {
        let _com = Com::enter();
        run(bytes, max_pixels)
    }

    fn run(bytes: &[u8], max_pixels: u64) -> Result<Raster, HeicFailure> {
        let fail = |e: windows::core::Error| classify(&e);
        // SAFETY: plain COM calls on interfaces created here; every buffer handed to WIC outlives the call that reads it.
        unsafe {
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(|_| HeicFailure::Failed)?;
            // Asked, not guessed: with no HEIF decoder installed WIC has no component for the HEIF container.
            factory.CreateDecoder(&GUID_ContainerFormatHeif, std::ptr::null()).map_err(|_| HeicFailure::NoDecoder)?;
            let stream = factory.CreateStream().map_err(fail)?;
            stream.InitializeFromMemory(bytes).map_err(fail)?;
            let decoder = factory.CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand).map_err(fail)?;
            if decoder.GetContainerFormat().map_err(fail)? != GUID_ContainerFormatHeif {
                return Err(HeicFailure::Failed);
            }
            let frame = decoder.GetFrame(0).map_err(fail)?;
            let (mut width, mut height) = (0u32, 0u32);
            frame.GetSize(&mut width, &mut height).map_err(fail)?;
            if width == 0 || height == 0 {
                return Err(HeicFailure::Failed);
            }
            if u64::from(width) * u64::from(height) > max_pixels {
                return Err(HeicFailure::TooLarge);
            }
            let converter = factory.CreateFormatConverter().map_err(fail)?;
            converter
                .Initialize(&frame, &GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)
                .map_err(fail)?;
            let stride = width.checked_mul(4).ok_or(HeicFailure::TooLarge)?;
            // Read before the pixels, so a profile or orientation that cannot be honoured refuses the file before the raster
            // is allocated.
            let orientation = orientation_of(&frame)?;
            let icc = profile_of(&factory, &frame, max_pixels.saturating_mul(4))?;
            let mut data = vec![0u8; stride as usize * height as usize];
            converter.CopyPixels(std::ptr::null(), stride, &mut data).map_err(fail)?;
            // The format conversion above changes the pixel layout, not the colour space: the file's own profile, when it
            // embeds one, takes the pixels to sRGB. A profile that cannot be applied is a file this PC cannot show correctly,
            // refused like one that does not decode (never sent with its colours unconverted). A picture with none is sRGB.
            if let Some(icc) = icc {
                crate::color::rgb_to_srgb_exactly(&mut data, true, &icc).map_err(|_| HeicFailure::Failed)?;
            }
            // WIC hands frame zero as coded: the file's `irot`/`imir`, which WIC reports as the photo orientation, turns it upright.
            Ok(crate::still::orient(Raster { width, height, has_alpha: true, data }, orientation))
        }
    }

    /// The EXIF-style orientation (1 to 8) WIC reports for the frame's `irot`/`imir` (`System.Photo.Orientation`); 1 when the file
    /// records none. A value outside 1 to 8, or metadata that cannot be read, is a file whose upright picture is not known.
    ///
    /// # Safety
    /// COM must be initialized on this thread.
    unsafe fn orientation_of(frame: &windows::Win32::Graphics::Imaging::IWICBitmapFrameDecode) -> Result<u8, HeicFailure> {
        use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
        use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
        use windows::Win32::System::Com::StructuredStorage::PropVariantToUInt16;
        let absent = |error: &windows::core::Error| matches!(error.code().0, PROPERTY_NOT_FOUND | UNSUPPORTED_OPERATION);
        // SAFETY: per the contract; `value` outlives the call that fills it and is cleared once read.
        unsafe {
            let reader = match frame.GetMetadataQueryReader() {
                Ok(reader) => reader,
                Err(error) if absent(&error) => return Ok(1),
                Err(_) => return Err(HeicFailure::Failed),
            };
            let mut value = PROPVARIANT::default();
            match reader.GetMetadataByName(windows::core::w!("System.Photo.Orientation"), &mut value) {
                Ok(()) => {}
                Err(error) if absent(&error) => return Ok(1),
                Err(_) => return Err(HeicFailure::Failed),
            }
            let read = PropVariantToUInt16(&value);
            let _ = PropVariantClear(&mut value);
            match read {
                Ok(orientation @ 1..=8) => Ok(orientation as u8),
                _ => Err(HeicFailure::Failed),
            }
        }
    }

    /// The ICC profile bytes of the frame's embedded profile (WIC `GetColorContexts`), `None` when it embeds none. A profile WIC
    /// cannot hand over is a failure, never skipped; one larger than `max_bytes` (the raster budget the caller gave) cannot be
    /// held and is too large.
    ///
    /// # Safety
    /// COM must be initialized on this thread.
    unsafe fn profile_of(
        factory: &IWICImagingFactory,
        frame: &windows::Win32::Graphics::Imaging::IWICBitmapFrameDecode,
        max_bytes: u64,
    ) -> Result<Option<Vec<u8>>, HeicFailure> {
        use windows::Win32::Graphics::Imaging::WICColorContextProfile;
        let failed = |_| HeicFailure::Failed;
        let mut count = 0u32;
        // SAFETY: per the contract; `contexts` and `buffer` outlive the calls that fill them.
        unsafe {
            frame.GetColorContexts(&mut [], &mut count).map_err(failed)?;
            if count == 0 {
                return Ok(None);
            }
            let mut contexts: Vec<Option<windows::Win32::Graphics::Imaging::IWICColorContext>> = Vec::new();
            for _ in 0..count {
                contexts.push(Some(factory.CreateColorContext().map_err(failed)?));
            }
            let mut filled = 0u32;
            frame.GetColorContexts(&mut contexts, &mut filled).map_err(failed)?;
            // An EXIF colour-space context names sRGB or "uncalibrated" and carries no profile; the ICC context is the one.
            for context in contexts.iter().take(filled as usize).flatten() {
                if context.GetType().map_err(failed)? != WICColorContextProfile {
                    continue;
                }
                let mut size = 0u32;
                context.GetProfileBytes(&mut [], &mut size).map_err(failed)?;
                if u64::from(size) > max_bytes {
                    return Err(HeicFailure::TooLarge);
                }
                let mut buffer = vec![0u8; size as usize];
                context.GetProfileBytes(&mut buffer, &mut size).map_err(failed)?;
                return Ok(Some(buffer));
            }
        }
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
pub(crate) mod imageio {
    //! ImageIO through its C API. The thumbnail call with `kCGImageSourceCreateThumbnailWithTransform` returns the picture
    //! with its rotation applied; drawing it into an sRGB bitmap context converts its colour space.
    use std::ffi::c_void;

    use super::HeicFailure;
    use crate::decode::Raster;

    type Ref = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        static kCFBooleanTrue: Ref;
        fn CFDataCreate(allocator: Ref, bytes: *const u8, length: isize) -> Ref;
        fn CFDictionaryCreate(allocator: Ref, keys: *const Ref, values: *const Ref, count: isize, key_cb: *const c_void, value_cb: *const c_void) -> Ref;
        fn CFNumberCreate(allocator: Ref, the_type: isize, value: *const c_void) -> Ref;
        fn CFRelease(object: Ref);
    }

    #[link(name = "ImageIO", kind = "framework")]
    unsafe extern "C" {
        static kCGImageSourceCreateThumbnailFromImageAlways: Ref;
        static kCGImageSourceCreateThumbnailWithTransform: Ref;
        static kCGImageSourceThumbnailMaxPixelSize: Ref;
        fn CGImageSourceCreateWithData(data: Ref, options: Ref) -> Ref;
        fn CGImageSourceCopyPropertiesAtIndex(source: Ref, index: usize, options: Ref) -> Ref;
        fn CGImageSourceCreateThumbnailAtIndex(source: Ref, index: usize, options: Ref) -> Ref;
        static kCGImagePropertyPixelWidth: Ref;
        static kCGImagePropertyPixelHeight: Ref;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        static kCGColorSpaceSRGB: Ref;
        fn CGColorSpaceCreateWithName(name: Ref) -> Ref;
        fn CGBitmapContextCreate(data: *mut c_void, width: usize, height: usize, bits: usize, row_bytes: usize, space: Ref, info: u32) -> Ref;
        fn CGContextDrawImage(context: Ref, rect: CGRect, image: Ref);
        fn CGContextRelease(context: Ref);
        fn CGColorSpaceRelease(space: Ref);
        fn CGImageGetWidth(image: Ref) -> usize;
        fn CGImageGetHeight(image: Ref) -> usize;
        fn CGImageRelease(image: Ref);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFDictionaryGetValue(dict: Ref, key: Ref) -> Ref;
        fn CFNumberGetValue(number: Ref, the_type: isize, value: *mut c_void) -> bool;
    }

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    const K_CF_NUMBER_SINT64: isize = 4;
    /// `kCGImageAlphaPremultipliedLast` (1) `| kCGBitmapByteOrder32Big` (4 << 12): each pixel is the bytes R, G, B, A in that
    /// order with premultiplied alpha, which is how the buffer is read below.
    const RGBA_PREMULTIPLIED: u32 = 1 | (4 << 12);

    struct Owned(Ref);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: a +1 reference this module created.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    pub fn decode(bytes: &[u8], max_pixels: u64) -> Result<Raster, HeicFailure> {
        // SAFETY: Core Foundation / ImageIO / Core Graphics calls on objects created and released here; the pixel buffer
        // passed to the bitmap context outlives the context.
        unsafe {
            let data = Owned(CFDataCreate(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize));
            let source = Owned(CGImageSourceCreateWithData(data.0, std::ptr::null()));
            if source.0.is_null() {
                return Err(HeicFailure::NoDecoder);
            }
            let props = Owned(CGImageSourceCopyPropertiesAtIndex(source.0, 0, std::ptr::null()));
            if props.0.is_null() {
                return Err(HeicFailure::Failed);
            }
            let number = |key: Ref| -> Option<i64> {
                let value = CFDictionaryGetValue(props.0, key);
                let mut out = 0i64;
                (!value.is_null() && CFNumberGetValue(value, K_CF_NUMBER_SINT64, (&mut out as *mut i64).cast())).then_some(out)
            };
            let (w, h) = (number(kCGImagePropertyPixelWidth).ok_or(HeicFailure::Failed)?, number(kCGImagePropertyPixelHeight).ok_or(HeicFailure::Failed)?);
            if w <= 0 || h <= 0 {
                return Err(HeicFailure::Failed);
            }
            if (w as u64) * (h as u64) > max_pixels {
                return Err(HeicFailure::TooLarge);
            }
            let max_edge = w.max(h);
            let max_edge_number = Owned(CFNumberCreate(std::ptr::null(), K_CF_NUMBER_SINT64, (&max_edge as *const i64).cast()));
            let keys = [kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceThumbnailMaxPixelSize];
            let values = [kCFBooleanTrue, kCFBooleanTrue, max_edge_number.0];
            let options = Owned(CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                3,
                (&raw const kCFTypeDictionaryKeyCallBacks).cast(),
                (&raw const kCFTypeDictionaryValueCallBacks).cast(),
            ));
            let image = CGImageSourceCreateThumbnailAtIndex(source.0, 0, options.0);
            if image.is_null() {
                return Err(HeicFailure::Failed);
            }
            let (width, height) = (CGImageGetWidth(image), CGImageGetHeight(image));
            if width == 0 || height == 0 || (width as u64) * (height as u64) > max_pixels {
                CGImageRelease(image);
                return Err(HeicFailure::Failed);
            }
            let mut data = vec![0u8; width * height * 4];
            let space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
            let context = CGBitmapContextCreate(data.as_mut_ptr().cast(), width, height, 8, width * 4, space, RGBA_PREMULTIPLIED);
            CGColorSpaceRelease(space);
            if context.is_null() {
                CGImageRelease(image);
                return Err(HeicFailure::Failed);
            }
            CGContextDrawImage(context, CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: width as f64, height: height as f64 } }, image);
            CGContextRelease(context);
            CGImageRelease(image);
            // The context holds premultiplied alpha; the raster keeps straight alpha like every other decoder here.
            let (pixels, _) = data.as_chunks_mut::<4>();
            for px in pixels {
                let a = u32::from(px[3]);
                if a != 0 && a != 255 {
                    for c in &mut px[..3] {
                        *c = (u32::from(*c) * 255 / a).min(255) as u8;
                    }
                }
            }
            Ok(Raster { width: width as u32, height: height as u32, has_alpha: true, data })
        }
    }
}

/// Test doubles, shared with the vault and migration tests of other crates.
#[cfg(any(test, feature = "test-support"))]
pub mod fakes {
    use super::*;

    /// A PC without a HEIC decoder.
    pub struct NoDecoder;

    impl HeicCodec for NoDecoder {
        fn decode(&self, _bytes: &[u8], _max_pixels: u64) -> Result<Raster, HeicFailure> {
            Err(HeicFailure::NoDecoder)
        }
    }

    /// A decoder that starts and fails midway.
    pub struct FailsMidDecode;

    impl HeicCodec for FailsMidDecode {
        fn decode(&self, _bytes: &[u8], _max_pixels: u64) -> Result<Raster, HeicFailure> {
            Err(HeicFailure::Failed)
        }
    }

    /// A decoder that returns a fixed picture.
    pub struct Fixed(pub Raster);

    impl HeicCodec for Fixed {
        fn decode(&self, _bytes: &[u8], max_pixels: u64) -> Result<Raster, HeicFailure> {
            if u64::from(self.0.width) * u64::from(self.0.height) > max_pixels {
                return Err(HeicFailure::TooLarge);
            }
            Ok(Raster { width: self.0.width, height: self.0.height, has_alpha: self.0.has_alpha, data: self.0.data.clone() })
        }
    }
}
