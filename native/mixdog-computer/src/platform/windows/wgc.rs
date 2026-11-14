//! Window capture through Windows.Graphics.Capture, the backend for windows
//! PrintWindow cannot render (WindowGraphicsCapture.cs, window-capture.ps1:20-97).

use super::capture_budget::Budget;
use super::native::{self, Target};
use crate::platform::{CaptureFailure, Cleanup, Surface, Wid};
use std::time::Duration;
use windows::core::{factory, Interface, HSTRING};
use windows::Foundation::Metadata::ApiInformation;
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem,
    GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{E_ACCESSDENIED, HMODULE};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_FLAG_DO_NOT_WAIT, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::{IDXGIDevice, DXGI_ERROR_WAS_STILL_DRAWING};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

/// Why a capture stopped, before it is worded (window-capture.ps1:77-84).
#[derive(Debug)]
enum Cause {
    /// A refusal of our own or of the window checks.
    Text(String),
    /// The GPU copy outlived the budget.
    GpuTimeout,
    Windows { code: i32, message: String },
}

impl From<String> for Cause {
    fn from(text: String) -> Cause {
        Cause::Text(text)
    }
}

impl From<windows::core::Error> for Cause {
    fn from(error: windows::core::Error) -> Cause {
        Cause::Windows {
            code: error.code().0,
            message: error.message(),
        }
    }
}

/// `^capture_[a-z_]+\|`: the text already carries its code.
fn is_coded(text: &str) -> bool {
    text.strip_prefix("capture_")
        .and_then(|rest| rest.split_once('|'))
        .is_some_and(|(code, _)| {
            !code.is_empty() && code.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        })
}

fn failure_text(cause: Cause) -> String {
    match cause {
        Cause::Text(text) if is_coded(&text) => text,
        Cause::Text(text) => format!("capture_wgc_unavailable|{text}"),
        Cause::GpuTimeout => {
            "capture_timeout|GPU copy exceeded the remaining capture budget".into()
        }
        Cause::Windows { code, .. } if code == E_ACCESSDENIED.0 => {
            "capture_denied|Windows denied capture of the selected window".into()
        }
        Cause::Windows { code, message } if message.is_empty() => {
            format!("capture_wgc_unavailable|HRESULT 0x{code:08X}")
        }
        Cause::Windows { message, .. } => format!("capture_wgc_unavailable|{message}"),
    }
}

fn expect_size(width: i64, height: i64, target: &Target, message: &str) -> Result<(), Cause> {
    if width == i64::from(target.width) && height == i64::from(target.height) {
        Ok(())
    } else {
        Err(Cause::Text(format!("capture_geometry_changed|{message}")))
    }
}

/// The `width` x `height` BGRA pixels of a mapped texture whose rows are
/// `row_pitch` bytes apart.
fn packed_rows(mapped: &[u8], row_pitch: usize, width: usize, height: usize) -> Option<Vec<u8>> {
    let row = width.checked_mul(4)?;
    if row == 0 || height == 0 || row_pitch < row {
        return None;
    }
    let needed = row_pitch.checked_mul(height - 1)?.checked_add(row)?;
    if mapped.len() < needed {
        return None;
    }
    let mut pixels = Vec::with_capacity(row * height);
    for line in 0..height {
        let start = line * row_pitch;
        pixels.extend_from_slice(&mapped[start..start + row]);
    }
    Some(pixels)
}

/// Premultiplied BGRA to the straight RGBA a PNG holds (what GDI+ writes from
/// Format32bppPArgb, WindowGraphicsCapture.cs:67-80).
fn straight_rgba(pixels: &mut [u8]) {
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        let alpha = u32::from(pixel[3]);
        if alpha == 0 {
            pixel[..3].fill(0);
        } else if alpha < 255 {
            for channel in &mut pixel[..3] {
                *channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
    }
}

/// EncodePixels (WindowGraphicsCapture.cs:60-83).
fn encode(mut pixels: Vec<u8>, width: i32, height: i32) -> Result<Vec<u8>, String> {
    let area = i64::from(width) * i64::from(height);
    if width <= 0 || height <= 0 || area > native::PIXEL_BUDGET || pixels.len() as i64 != area * 4 {
        return Err("capture_geometry_invalid|invalid BGRA surface dimensions".into());
    }
    straight_rgba(&mut pixels);
    native::encode_png(&pixels, width, height)
}

/// Runs every closer in order, whatever the earlier ones answered
/// (Close-WindowCaptureResources, window-capture.ps1:7-18).
fn close_all(
    closers: Vec<Box<dyn FnOnce() -> bool + '_>>,
    cancellation: Option<&'static str>,
) -> Cleanup {
    let mut status = match cancellation {
        Some(state) if state != "settled" => "unconfirmed",
        _ => "confirmed",
    };
    for close in closers {
        if !close() {
            status = "failed";
        }
    }
    Cleanup {
        status,
        cancellation,
    }
}

/// What one capture holds open, closed in reverse order of creation.
#[derive(Default)]
struct Resources {
    device: Option<IDirect3DDevice>,
    pool: Option<Direct3D11CaptureFramePool>,
    session: Option<GraphicsCaptureSession>,
    frame: Option<Direct3D11CaptureFrame>,
    /// Set when the GPU copy was left running (the WinRtCancellation of
    /// Await-WinRt, session.ps1:106-113; D3D11 has no cancel to settle it).
    cancellation: Option<&'static str>,
}

impl Resources {
    fn close(&self) -> Cleanup {
        let mut closers: Vec<Box<dyn FnOnce() -> bool + '_>> = Vec::new();
        if let Some(frame) = &self.frame {
            closers.push(Box::new(|| frame.Close().is_ok()));
        }
        if let Some(session) = &self.session {
            closers.push(Box::new(|| session.Close().is_ok()));
        }
        if let Some(pool) = &self.pool {
            closers.push(Box::new(|| pool.Close().is_ok()));
        }
        if let Some(device) = &self.device {
            closers.push(Box::new(|| device.Close().is_ok()));
        }
        close_all(closers, self.cancellation)
    }
}

/// CreateDevice (WindowGraphicsCapture.cs:38-58).
fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext, IDirect3DDevice), Cause> {
    let mut device = None;
    let mut context = None;
    // SAFETY: both out pointers outlive the call.
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }?;
    let unavailable = || Cause::Text("Direct3D device is unavailable".into());
    let device = device.ok_or_else(unavailable)?;
    let context = context.ok_or_else(unavailable)?;
    let dxgi: IDXGIDevice = device.cast()?;
    // SAFETY: dxgi is a live DXGI device.
    let wrapper = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }?.cast()?;
    Ok((device, context, wrapper))
}

/// The frame's pixels through a staging texture, tightly packed BGRA.
fn read_frame(
    frame: &Direct3D11CaptureFrame,
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    target: &Target,
    budget: &Budget,
    cancellation: &mut Option<&'static str>,
) -> Result<Vec<u8>, Cause> {
    let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
    // SAFETY: the surface of a capture frame is a D3D11 texture of our device.
    let texture: ID3D11Texture2D = unsafe { access.GetInterface() }?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: desc is a valid out pointer.
    unsafe { texture.GetDesc(&mut desc) };
    expect_size(
        desc.Width.into(),
        desc.Height.into(),
        target,
        "compositor texture dimensions changed",
    )?;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    desc.MiscFlags = 0;
    let mut staging = None;
    // SAFETY: desc and the out pointer outlive the call.
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }?;
    let staging = staging.ok_or_else(|| Cause::Text("staging texture is unavailable".into()))?;
    // Await-WinRt (session.ps1:103-111) keeps up to 100 ms of the budget to
    // see whether an abandoned copy settles.
    let grace = budget.remaining()?.min(100);
    // SAFETY: both textures belong to this device and share one description.
    unsafe {
        context.CopyResource(&staging, &texture);
        context.Flush();
    }
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    let map = |mapped: &mut D3D11_MAPPED_SUBRESOURCE| {
        // SAFETY: mapped is a valid out pointer; DO_NOT_WAIT never blocks.
        unsafe {
            context.Map(
                &staging,
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(mapped),
            )
        }
    };
    loop {
        match map(&mut mapped) {
            Ok(()) => break,
            Err(error) if error.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
                if budget.remaining().is_ok_and(|left| left > grace) {
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }
                // Timed out: the grace tells a copy that settled from one
                // still in flight.
                *cancellation = Some("unconfirmed");
                while budget.remaining().is_ok() {
                    match map(&mut mapped) {
                        Ok(()) => {
                            // SAFETY: the staging texture was mapped just now.
                            unsafe { context.Unmap(&staging, 0) };
                            *cancellation = Some("settled");
                            break;
                        }
                        Err(error) if error.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        Err(_) => break,
                    }
                }
                return Err(Cause::GpuTimeout);
            }
            Err(error) => return Err(error.into()),
        }
    }
    let (width, height) = (target.width as usize, target.height as usize);
    let row_pitch = mapped.RowPitch as usize;
    let length = row_pitch
        .checked_mul(height.saturating_sub(1))
        .and_then(|rows| rows.checked_add(width * 4));
    let pixels = match length {
        // A pitch narrower than a row would put the slice's end past the
        // mapping, so it is refused before the slice is made.
        Some(length) if !mapped.pData.is_null() && row_pitch >= width * 4 => {
            // SAFETY: a mapped B8G8R8A8 texture holds `height` rows `row_pitch`
            // apart, the last at least `width * 4` bytes long, until Unmap.
            let bytes = unsafe { std::slice::from_raw_parts(mapped.pData as *const u8, length) };
            packed_rows(bytes, row_pitch, width, height)
        }
        _ => None,
    };
    // SAFETY: the staging texture was mapped above.
    unsafe { context.Unmap(&staging, 0) };
    pixels.ok_or_else(|| {
        Cause::Text("capture_geometry_invalid|invalid BGRA surface dimensions".into())
    })
}

/// Get-WindowGraphicsCapture's try block (window-capture.ps1:27-75).
fn run(handle: Wid, budget: &Budget, held: &mut Resources) -> Result<Surface, Cause> {
    let target = native::begin_capture(handle, true)?;
    if !GraphicsCaptureSession::IsSupported()? {
        return Err(Cause::Text(
            "capture_wgc_unavailable|Windows graphics capture is not supported".into(),
        ));
    }
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    // SAFETY: begin_capture found the handle a live window.
    let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(native::hwnd(handle)) }?;
    let size = item.Size()?;
    expect_size(
        size.Width.into(),
        size.Height.into(),
        &target,
        "compositor dimensions do not match the exact visible window bounds",
    )?;
    let (device, context, wrapper) = create_device()?;
    let wrapper = held.device.insert(wrapper);
    budget.remaining()?;
    let pool = held.pool.insert(Direct3D11CaptureFramePool::CreateFreeThreaded(
        &*wrapper,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        size,
    )?);
    let session = held.session.insert(pool.CreateCaptureSession(&item)?);
    // The OS capture border stays: borderless capture is never requested.
    if ApiInformation::IsPropertyPresent(
        &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
        &HSTRING::from("IsCursorCaptureEnabled"),
    )? {
        session.SetIsCursorCaptureEnabled(false)?;
    }
    session.StartCapture()?;
    let frame = loop {
        let remaining = budget.remaining()?;
        match pool.TryGetNextFrame() {
            Ok(frame) => break held.frame.insert(frame),
            // No frame yet: a null object with a success code.
            Err(error) if error.code().is_ok() => {
                std::thread::sleep(Duration::from_millis(remaining.min(20).into()));
            }
            Err(error) => return Err(error.into()),
        }
    };
    let content = frame.ContentSize()?;
    expect_size(
        content.Width.into(),
        content.Height.into(),
        &target,
        "window resized while awaiting its compositor frame",
    )?;
    let pixels = read_frame(frame, &device, &context, &target, budget, &mut held.cancellation)?;
    native::assert_capture_stable(handle, &target)?;
    let png = encode(pixels, target.width, target.height)?;
    budget.remaining()?;
    Ok(Surface {
        png,
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height,
        print_window_flags: None,
    })
}

/// The window's composited rendering, within `work_ms` of work
/// (Get-WindowGraphicsCapture, window-capture.ps1:20-97).
pub fn window_surface(handle: Wid, work_ms: u32) -> Result<Surface, CaptureFailure> {
    let budget = Budget::new(work_ms);
    let mut held = Resources::default();
    let outcome = run(handle, &budget, &mut held);
    let cleanup = held.close();
    match outcome {
        Ok(surface) if cleanup.status == "confirmed" => Ok(surface),
        Ok(_) => Err(CaptureFailure {
            text: "capture_cleanup_failed|window capture resources did not all close".into(),
            cleanup,
        }),
        Err(cause) => Err(CaptureFailure {
            text: failure_text(cause),
            cleanup,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn target(width: i32, height: i32) -> Target {
        Target {
            pid: 1,
            thread: 1,
            composited: true,
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    #[test]
    fn failures_are_worded_as_the_worker_worded_them() {
        let coded = "capture_geometry_changed|native window changed during capture";
        assert_eq!(failure_text(Cause::Text(coded.into())), coded);
        let budget = "capture_timeout|window capture exhausted its work budget";
        assert_eq!(failure_text(Cause::Text(budget.into())), budget);
        assert_eq!(
            failure_text(Cause::Text("staging texture is unavailable".into())),
            "capture_wgc_unavailable|staging texture is unavailable"
        );
        assert_eq!(
            failure_text(Cause::Text("capture_Bad|x".into())),
            "capture_wgc_unavailable|capture_Bad|x"
        );
        assert_eq!(
            failure_text(Cause::GpuTimeout),
            "capture_timeout|GPU copy exceeded the remaining capture budget"
        );
        assert_eq!(
            failure_text(Cause::Windows {
                code: 0x8007_0005_u32 as i32,
                message: "Access is denied.".into(),
            }),
            "capture_denied|Windows denied capture of the selected window"
        );
        assert_eq!(
            failure_text(Cause::Windows {
                code: 0x8007_0057_u32 as i32,
                message: "The parameter is incorrect.".into(),
            }),
            "capture_wgc_unavailable|The parameter is incorrect."
        );
        assert_eq!(
            failure_text(Cause::Windows {
                code: 0x8000_4005_u32 as i32,
                message: String::new(),
            }),
            "capture_wgc_unavailable|HRESULT 0x80004005"
        );
    }

    #[test]
    fn only_a_lowercase_capture_code_passes_through() {
        assert!(is_coded("capture_denied|x"));
        assert!(is_coded("capture_wgc_unavailable|"));
        assert!(!is_coded("capture_|x"));
        assert!(!is_coded("capture_denied"));
        assert!(!is_coded("winrt_timeout|x"));
        assert!(!is_coded("capture_v2|x"));
    }

    #[test]
    fn a_size_other_than_the_target_is_a_geometry_change() {
        let target = target(640, 480);
        assert!(expect_size(640, 480, &target, "m").is_ok());
        for (width, height) in [(641, 480), (640, 479), (480, 640), (0, 0)] {
            let refused =
                expect_size(width, height, &target, "compositor texture dimensions changed");
            assert_eq!(
                refused.map_err(failure_text),
                Err("capture_geometry_changed|compositor texture dimensions changed".to_string())
            );
        }
    }

    #[test]
    fn rows_are_copied_by_pitch_and_cropped_to_the_width() {
        // 2 x 2 pixels, 12-byte pitch: 4 bytes of padding after the first row.
        let mapped = [
            1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 99, 99, //
            9, 10, 11, 12, 13, 14, 15, 16,
        ];
        assert_eq!(
            packed_rows(&mapped, 12, 2, 2),
            Some(vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
        );
        assert_eq!(packed_rows(&mapped[..8], 8, 2, 1), Some(mapped[..8].to_vec()));
        assert_eq!(packed_rows(&mapped, 4, 2, 2), None);
        assert_eq!(packed_rows(&mapped[..19], 12, 2, 2), None);
        assert_eq!(packed_rows(&mapped, 12, 0, 2), None);
        assert_eq!(packed_rows(&mapped, 12, 2, 0), None);
    }

    #[test]
    fn premultiplied_bgra_becomes_straight_rgba() {
        let mut pixels = [
            10, 20, 30, 255, // opaque: channels swap only
            64, 32, 16, 128, // half: divided by alpha
            200, 200, 200, 100, // over-bright: clamped
            9, 9, 9, 0, // transparent: cleared
        ];
        straight_rgba(&mut pixels);
        assert_eq!(
            pixels,
            [30, 20, 10, 255, 32, 64, 128, 128, 255, 255, 255, 100, 0, 0, 0, 0]
        );
    }

    #[test]
    fn a_surface_outside_the_pixel_budget_is_refused() {
        let refusal = Err("capture_geometry_invalid|invalid BGRA surface dimensions".to_string());
        assert_eq!(encode(vec![0; 16], 0, 4), refusal);
        assert_eq!(encode(vec![0; 16], 2, -2), refusal);
        assert_eq!(encode(vec![0; 12], 2, 2), refusal);
        assert_eq!(encode(Vec::new(), 4097, 4096), refusal);
        let png = encode(vec![0, 0, 255, 255, 0, 255, 0, 255], 2, 1).unwrap_or_default();
        assert_eq!(png.get(..8), Some(&b"\x89PNG\r\n\x1a\n"[..]));
    }

    #[test]
    fn every_resource_is_closed_in_order_and_one_failure_marks_the_cleanup() {
        let order = RefCell::new(Vec::new());
        let closer = |name: &'static str, closed: bool| -> Box<dyn FnOnce() -> bool + '_> {
            let order = &order;
            Box::new(move || {
                order.borrow_mut().push(name);
                closed
            })
        };
        let all = close_all(
            vec![
                closer("frame", true),
                closer("session", true),
                closer("pool", true),
                closer("device", true),
            ],
            None,
        );
        assert_eq!(all, Cleanup { status: "confirmed", cancellation: None });
        assert_eq!(*order.borrow(), ["frame", "session", "pool", "device"]);
        order.borrow_mut().clear();
        let failed = close_all(
            vec![closer("frame", true), closer("session", false), closer("pool", true)],
            Some("unconfirmed"),
        );
        assert_eq!(failed, Cleanup { status: "failed", cancellation: Some("unconfirmed") });
        assert_eq!(*order.borrow(), ["frame", "session", "pool"]);
        assert_eq!(
            close_all(Vec::new(), Some("unconfirmed")),
            Cleanup { status: "unconfirmed", cancellation: Some("unconfirmed") }
        );
        assert_eq!(
            close_all(Vec::new(), Some("settled")),
            Cleanup { status: "confirmed", cancellation: Some("settled") }
        );
    }
}
