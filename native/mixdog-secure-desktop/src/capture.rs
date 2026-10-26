//! Screen capture via GDI `BitBlt` + `GetDIBits`.
//!
//! Capture-API decision (see docs/ipc-spec.md for the full rationale): this
//! helper captures with GDI, not DXGI Desktop Duplication. DXGI is faster and
//! supports dirty regions, but an `IDXGIOutputDuplication` is bound to the
//! desktop it was created on and returns `DXGI_ERROR_ACCESS_LOST` the instant
//! the session switches to the secure desktop; recreating it against the
//! `Winlogon` desktop is not supported, so the UAC / lock screen — the whole
//! point of this component — cannot be captured that way. GDI `BitBlt` from a
//! `CreateDCW("DISPLAY")` DC follows the calling thread's attached desktop, so
//! once the thread is attached to the input desktop (see [`crate::desktop`]) it
//! captures `Default` and `Winlogon` with the same code path. The WebRTC effort
//! may layer DXGI on top for the `Default` desktop as a performance
//! optimization; GDI remains the mandatory secure-desktop path.
//!
//! Frames are top-down 32-bit BGRA. GDI exposes no cheap dirty-region
//! information, so every frame is a full-frame update (empty `dirty`).

use std::io;

use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDCW, DeleteDC, DeleteObject,
    GetDIBits, SelectObject, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, DIB_RGB_COLORS, HGDIOBJ, ROP_CODE,
    SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::winutil::wide;

/// A captured BGRA image of the virtual screen.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// Bytes per row; 32-bit BGRA is inherently DWORD-aligned, so `width * 4`.
    pub stride: u32,
    pub origin_x: i32,
    pub origin_y: i32,
    pub pixels: Vec<u8>,
}

/// Capture the whole virtual screen (all monitors) from the thread's current
/// desktop. Must be called with the thread attached to the input desktop.
pub fn capture_virtual_screen() -> io::Result<Frame> {
    unsafe {
        let origin_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let origin_y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1);

        let display = wide("DISPLAY");
        let screen_dc = CreateDCW(PCWSTR(display.as_ptr()), PCWSTR::null(), PCWSTR::null(), None);
        if screen_dc.is_invalid() {
            return Err(io::Error::new(io::ErrorKind::Other, "CreateDCW(DISPLAY) failed"));
        }
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        if mem_dc.is_invalid() {
            let _ = DeleteDC(screen_dc);
            return Err(io::Error::new(io::ErrorKind::Other, "CreateCompatibleDC failed"));
        }
        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        if bitmap.is_invalid() {
            let _ = DeleteDC(mem_dc);
            let _ = DeleteDC(screen_dc);
            return Err(io::Error::new(io::ErrorKind::Other, "CreateCompatibleBitmap failed"));
        }
        let previous = SelectObject(mem_dc, HGDIOBJ(bitmap.0));

        // CAPTUREBLT includes layered (WS_EX_LAYERED) windows in the copy
        // (https://learn.microsoft.com/windows/win32/api/wingdi/nf-wingdi-bitblt);
        // without it, layered UI such as parts of the sign-in and consent
        // screens is missing from the frame. Known cost: on some systems the
        // mouse cursor flickers while CAPTUREBLT copies are taken.
        let blt = BitBlt(
            mem_dc,
            0,
            0,
            width,
            height,
            Some(screen_dc),
            origin_x,
            origin_y,
            ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0),
        );

        let stride = (width as u32) * 4;
        let mut pixels = vec![0u8; stride as usize * height as usize];
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative height requests a top-down image, so row 0 is the
                // top row and the BGRA buffer matches the wire layout directly.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0, // BI_RGB
                ..Default::default()
            },
            ..Default::default()
        };
        let scanlines = GetDIBits(
            mem_dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        );

        // Restore and release every GDI object before evaluating success.
        SelectObject(mem_dc, previous);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem_dc);
        let _ = DeleteDC(screen_dc);

        if blt.is_err() {
            return Err(io::Error::new(io::ErrorKind::Other, "BitBlt failed"));
        }
        if scanlines == 0 {
            return Err(io::Error::new(io::ErrorKind::Other, "GetDIBits returned no scanlines"));
        }

        Ok(Frame {
            width: width as u32,
            height: height as u32,
            stride,
            origin_x,
            origin_y,
            pixels,
        })
    }
}
