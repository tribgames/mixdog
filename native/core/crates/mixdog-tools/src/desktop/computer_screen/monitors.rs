//! The monitors of the PC and the capture of one of them, in this process (Windows).
//!
//! Every monitor is read and captured at its own size and in its own pixels: the calling thread is made per-monitor DPI aware for
//! the length of the call, so the rectangles `EnumDisplayMonitors` reports and the coordinates `BitBlt` takes are the physical ones
//! whatever the process's own awareness is. A monitor is captured from a thread of its own that follows the input desktop; its
//! pictures come at [`FRAME_INTERVAL`] (thirty a second, the rate of the phone's screen track), each one the monitor's whole
//! rectangle, with no scaling and no re-encoding.

use std::ffi::c_void;
use std::io;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::DisplayId;
use mixdog_core_api::domain::computer::DisplayInfo;
use mixdog_core_api::domain::media::FrameSourceKind;
use mixdog_core_api::domain::media::MediaError;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::media::PixelFormat;
use mixdog_core_api::domain::media::VideoFrame;
use mixdog_secure_desktop::capture;
use mixdog_secure_desktop::desktop;
use mixdog_secure_desktop::winutil::OwnedDesktop;
use tokio::sync::mpsc as async_mpsc;
use windows_sys::Win32::Foundation::LPARAM;
use windows_sys::Win32::Foundation::RECT;
use windows_sys::Win32::Graphics::Gdi::BITMAPINFO;
use windows_sys::Win32::Graphics::Gdi::BITMAPINFOHEADER;
use windows_sys::Win32::Graphics::Gdi::BI_RGB;
use windows_sys::Win32::Graphics::Gdi::BitBlt;
use windows_sys::Win32::Graphics::Gdi::CAPTUREBLT;
use windows_sys::Win32::Graphics::Gdi::CreateCompatibleDC;
use windows_sys::Win32::Graphics::Gdi::CreateDCW;
use windows_sys::Win32::Graphics::Gdi::CreateDIBSection;
use windows_sys::Win32::Graphics::Gdi::DIB_RGB_COLORS;
use windows_sys::Win32::Graphics::Gdi::DeleteDC;
use windows_sys::Win32::Graphics::Gdi::DeleteObject;
use windows_sys::Win32::Graphics::Gdi::EnumDisplayMonitors;
use windows_sys::Win32::Graphics::Gdi::GdiFlush;
use windows_sys::Win32::Graphics::Gdi::GetMonitorInfoW;
use windows_sys::Win32::Graphics::Gdi::HBITMAP;
use windows_sys::Win32::Graphics::Gdi::HDC;
use windows_sys::Win32::Graphics::Gdi::HGDIOBJ;
use windows_sys::Win32::Graphics::Gdi::HMONITOR;
use windows_sys::Win32::Graphics::Gdi::MONITORINFO;
use windows_sys::Win32::Graphics::Gdi::SRCCOPY;
use windows_sys::Win32::Graphics::Gdi::SelectObject;
use windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT;
use windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2;
use windows_sys::Win32::UI::HiDpi::GetDpiForMonitor;
use windows_sys::Win32::UI::HiDpi::MDT_EFFECTIVE_DPI;
use windows_sys::Win32::UI::HiDpi::SetThreadDpiAwarenessContext;
use windows_sys::core::BOOL;

/// The pause from the start of one picture to the start of the next: thirty pictures a second. A picture that took longer
/// is followed by the next one at once.
const FRAME_INTERVAL: Duration = Duration::from_micros(33_333);

/// `MONITORINFO::dwFlags` of the primary monitor (`MONITORINFOF_PRIMARY`).
const PRIMARY: u32 = 1;

/// The Windows default DPI, which is a scale of 100 percent.
const BASE_DPI: u32 = 96;

/// The calling thread reads physical pixels until this is dropped.
struct PhysicalPixels(DPI_AWARENESS_CONTEXT);

impl PhysicalPixels {
    fn enter() -> Self {
        // SAFETY: a plain call that changes the awareness of the calling thread only; it returns the previous context.
        Self(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) })
    }
}

impl Drop for PhysicalPixels {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: restores the context this thread had when `enter` ran.
            let _ = unsafe { SetThreadDpiAwarenessContext(self.0) };
        }
    }
}

/// One monitor as the enumerator gives it.
struct Found {
    area: RECT,
    primary: bool,
    scale_percent: u32,
}

unsafe extern "system" fn collect(monitor: HMONITOR, _: HDC, _: *mut RECT, found: LPARAM) -> BOOL {
    // SAFETY: `found` is the `Vec` that `enumerate` passed and keeps alive for the whole enumeration.
    let found = unsafe { &mut *(found as *mut Vec<Found>) };
    // SAFETY: an all-zero MONITORINFO is a valid value; its size is set as the call requires.
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = size_of::<MONITORINFO>() as u32;
    // SAFETY: `monitor` is the handle the enumerator handed in and `info` is a MONITORINFO of the size it says.
    if unsafe { GetMonitorInfoW(monitor, &mut info) } != 0 {
        let (mut dpi_x, mut dpi_y) = (0u32, 0u32);
        // SAFETY: the two out-values are live. A failed read leaves the 100 percent default.
        let scale_percent = if unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) } >= 0 && dpi_x > 0 {
            percent_of_dpi(dpi_x)
        } else {
            100
        };
        found.push(Found { area: info.rcMonitor, primary: info.dwFlags & PRIMARY != 0, scale_percent });
    }
    1
}

/// A DPI as a scale in percent (96 is 100).
fn percent_of_dpi(dpi: u32) -> u32 {
    (dpi * 100 + BASE_DPI / 2) / BASE_DPI
}

/// The monitors now, the primary one first and the others as the system lists them: ids are their places in that order.
fn enumerate() -> Vec<DisplayInfo> {
    let mut found: Vec<Found> = Vec::new();
    // SAFETY: the callback only reads what the enumerator gives it and pushes onto `found`, which outlives the call.
    let ok = unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(collect), &mut found as *mut Vec<Found> as LPARAM) };
    if ok == 0 {
        return Vec::new();
    }
    found.sort_by_key(|monitor| !monitor.primary);
    found.iter().enumerate().filter_map(|(index, monitor)| display_of(index, monitor)).collect()
}

fn display_of(index: usize, monitor: &Found) -> Option<DisplayInfo> {
    let width = u32::try_from(monitor.area.right.checked_sub(monitor.area.left)?).ok().filter(|width| *width > 0)?;
    let height = u32::try_from(monitor.area.bottom.checked_sub(monitor.area.top)?).ok().filter(|height| *height > 0)?;
    Some(DisplayInfo { id: DisplayId(u32::try_from(index).ok()?), x: monitor.area.left, y: monitor.area.top, width, height, scale_percent: monitor.scale_percent })
}

/// The monitors of the PC, each with its rectangle in physical pixels of the virtual screen. A PC the system lists none of has its
/// whole virtual screen as one display.
pub(super) fn displays() -> Vec<DisplayInfo> {
    let _physical = PhysicalPixels::enter();
    let listed = enumerate();
    if !listed.is_empty() {
        return listed;
    }
    let (x, y, width, height) = capture::virtual_screen_rect();
    vec![DisplayInfo { id: DisplayId(0), x, y, width, height, scale_percent: 100 }]
}

/// The pictures of display `display`, at its size, thirty a second, until the source is dropped.
pub(super) fn source(display: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
    let shown = displays().into_iter().find(|listed| listed.id == display).ok_or_else(|| ComputerError::InvalidInput { reason: format!("unknown display {}", display.0) })?;
    let (tx, rx) = async_mpsc::channel(1);
    let (stop, stopped) = mpsc::channel();
    std::thread::spawn(move || capture_loop(&shown, &tx, &stopped));
    Ok(Box::new(MonitorSource { display, rx, _stop: stop }))
}

/// The GDI objects that read one rectangle of the screen: a screen device context and a memory one over a DIB section the size of the
/// rectangle, so a picture is one `BitBlt` and one copy. They belong to the desktop their thread was attached to when they were made.
struct Grabber {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *const u8,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl Grabber {
    fn new(area: &DisplayInfo) -> io::Result<Self> {
        let failed = |what: &str| io::Error::other(format!("{what} failed"));
        let (width, height) = (i32::try_from(area.width).map_err(|_| failed("the size"))?, i32::try_from(area.height).map_err(|_| failed("the size"))?);
        let device: Vec<u16> = "DISPLAY\0".encode_utf16().collect();
        // SAFETY: `device` is a NUL-terminated wide string that lives through the call; the null arguments are the documented ones.
        let screen = unsafe { CreateDCW(device.as_ptr(), std::ptr::null(), std::ptr::null(), std::ptr::null()) };
        if screen.is_null() {
            return Err(failed("CreateDCW(DISPLAY)"));
        }
        // SAFETY: `screen` is the live device context made above.
        let memory = unsafe { CreateCompatibleDC(screen) };
        if memory.is_null() {
            // SAFETY: deletes the context made above, once.
            let _ = unsafe { DeleteDC(screen) };
            return Err(failed("CreateCompatibleDC"));
        }
        // SAFETY: an all-zero BITMAPINFO is a valid value; the header is filled below.
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative: a top-down image, row 0 on top, as the frame's layout wants.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        // SAFETY: `info` describes a 32-bit top-down image; `bits` receives the section's memory, which lives as long as the bitmap.
        let bitmap = unsafe { CreateDIBSection(screen, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0) };
        if bitmap.is_null() || bits.is_null() {
            // SAFETY: deletes the two contexts made above, once each.
            unsafe {
                let _ = DeleteDC(memory);
                let _ = DeleteDC(screen);
            }
            return Err(failed("CreateDIBSection"));
        }
        // SAFETY: both are live and the bitmap is not selected anywhere else.
        let previous = unsafe { SelectObject(memory, bitmap) };
        Ok(Self { screen, memory, bitmap, previous, bits: bits.cast_const().cast(), x: area.x, y: area.y, width, height })
    }

    /// One picture of the rectangle: BGRA rows of `width * 4` bytes, top down.
    fn grab(&self) -> io::Result<Vec<u8>> {
        // SAFETY: both contexts are live; the copy is of the rectangle this grabber was made for.
        let copied = unsafe { BitBlt(self.memory, 0, 0, self.width, self.height, self.screen, self.x, self.y, SRCCOPY | CAPTUREBLT) };
        // The section's memory is read below: the batched drawing is finished first.
        // SAFETY: a plain call.
        let _ = unsafe { GdiFlush() };
        if copied == 0 {
            return Err(io::Error::other("BitBlt failed"));
        }
        let length = self.width as usize * self.height as usize * 4;
        // SAFETY: the section holds `width * height` 32-bit pixels (see `new`) for as long as the bitmap lives, and the copy is made
        // before anything draws into it again (the same thread does both).
        Ok(unsafe { std::slice::from_raw_parts(self.bits, length) }.to_vec())
    }
}

impl Drop for Grabber {
    fn drop(&mut self) {
        // SAFETY: the handles are the live ones `new` made, released once, the bitmap after it was deselected.
        unsafe {
            SelectObject(self.memory, self.previous);
            let _ = DeleteObject(self.bitmap);
            let _ = DeleteDC(self.memory);
            let _ = DeleteDC(self.screen);
        }
    }
}

/// The pause between two pictures: it ends at once, with `false`, when the source is dropped (its end of `stopped` goes away);
/// `true` means `wait` passed.
fn next_frame_due(stopped: &mpsc::Receiver<()>, wait: Duration) -> bool {
    matches!(stopped.recv_timeout(wait), Err(mpsc::RecvTimeoutError::Timeout))
}

/// Captures `area` from the thread attached to the current input desktop until the source is dropped.
fn capture_loop(area: &DisplayInfo, tx: &async_mpsc::Sender<Result<VideoFrame, MediaError>>, stopped: &mpsc::Receiver<()>) {
    let _physical = PhysicalPixels::enter();
    let started = Instant::now();
    let mut attached: Option<(OwnedDesktop, String)> = None;
    let mut grabber: Option<Grabber> = None;
    let mut seq = 0u64;
    loop {
        let began = Instant::now();
        let current = desktop::input_desktop_name();
        if current.is_some() && attached.as_ref().map(|(_, name)| name) != current.as_ref() {
            // The GDI objects of the desktop that went away are released before the thread leaves it.
            grabber = None;
            attached = desktop::attach_to_input_desktop().ok();
        }
        let picture = match grabber.as_ref() {
            Some(held) => held.grab(),
            None => Grabber::new(area).and_then(|made| {
                let picture = made.grab();
                grabber = Some(made);
                picture
            }),
        };
        let sent = match picture {
            Ok(pixels) => {
                seq += 1;
                tx.blocking_send(Ok(VideoFrame {
                    width: area.width,
                    height: area.height,
                    stride: area.width * 4,
                    format: PixelFormat::Bgra,
                    data: Bytes::from(pixels),
                    seq,
                    captured_at: started.elapsed(),
                }))
            }
            Err(error) => {
                grabber = None;
                tx.blocking_send(Err(MediaError::Unavailable { reason: error.to_string() }))
            }
        };
        if sent.is_err() || !next_frame_due(stopped, FRAME_INTERVAL.saturating_sub(began.elapsed())) {
            return;
        }
    }
}

struct MonitorSource {
    display: DisplayId,
    rx: async_mpsc::Receiver<Result<VideoFrame, MediaError>>,
    /// Dropped with the source, which wakes the capture thread out of its pause.
    _stop: mpsc::Sender<()>,
}

#[async_trait]
impl MediaFrameSource for MonitorSource {
    fn kind(&self) -> FrameSourceKind {
        FrameSourceKind::Screen { display: self.display.0 }
    }

    async fn next_frame(&mut self) -> Result<Option<VideoFrame>, MediaError> {
        self.rx.recv().await.transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(left: i32, top: i32, right: i32, bottom: i32, primary: bool, scale_percent: u32) -> Found {
        Found { area: RECT { left, top, right, bottom }, primary, scale_percent }
    }

    #[test]
    fn the_pause_between_pictures_is_the_time_left_of_the_interval_and_ends_at_once_when_the_source_is_dropped() {
        let (stop, stopped) = mpsc::channel::<()>();
        let started = Instant::now();
        assert!(next_frame_due(&stopped, FRAME_INTERVAL));
        assert!(started.elapsed() >= FRAME_INTERVAL);
        // A picture that took the whole interval is followed at once.
        let started = Instant::now();
        assert!(next_frame_due(&stopped, Duration::ZERO));
        assert!(started.elapsed() < FRAME_INTERVAL);
        drop(stop);
        let started = Instant::now();
        assert!(!next_frame_due(&stopped, FRAME_INTERVAL));
        assert!(started.elapsed() < FRAME_INTERVAL);
    }

    #[test]
    fn a_dpi_is_a_scale_in_percent() {
        assert_eq!([percent_of_dpi(96), percent_of_dpi(120), percent_of_dpi(144), percent_of_dpi(192)], [100, 125, 150, 200]);
    }

    #[test]
    fn a_monitor_is_its_rectangle_in_pixels_with_the_scale_it_was_read_at() {
        let left = display_of(1, &found(-2560, -200, 0, 1240, false, 150)).expect("a display");
        assert_eq!(left, DisplayInfo { id: DisplayId(1), x: -2560, y: -200, width: 2560, height: 1440, scale_percent: 150 });
    }

    #[test]
    fn a_monitor_with_no_area_is_not_a_display() {
        assert_eq!(display_of(0, &found(0, 0, 0, 1080, true, 100)), None);
        assert_eq!(display_of(0, &found(10, 10, 5, 20, true, 100)), None);
    }
}
