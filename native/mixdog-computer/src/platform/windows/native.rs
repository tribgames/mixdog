//! Windows and processes over Win32: enumeration, geometry, activation,
//! integrity, and the window's own rendering.

use crate::platform::{Integrity, Surface, Wid, WindowInfo};
use std::ffi::c_void;
use std::time::Duration;
use windows::core::{BOOL, PWSTR};
use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED,
};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject, PROCESS_BASIC_INFORMATION,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    PROCESS_TERMINATE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, ChildWindowFromPointEx, EnumChildWindows, EnumWindows, GetAncestor,
    GetClassNameW, GetClientRect, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetWindow,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsHungAppWindow,
    IsIconic, IsWindow, IsWindowVisible, IsZoomed, MoveWindow, PostMessageW,
    SetForegroundWindow, ShowWindow, SystemParametersInfoW, WindowFromPoint, GA_ROOT,
    GUITHREADINFO, GW_OWNER, SPI_GETFOREGROUNDLOCKTIMEOUT,
    SPI_SETFOREGROUNDLOCKTIMEOUT, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WM_CLOSE,
};

pub fn hwnd(handle: Wid) -> HWND {
    HWND(handle as usize as *mut c_void)
}

pub fn wid(handle: HWND) -> Wid {
    handle.0 as usize as Wid
}

pub fn is_window(handle: Wid) -> bool {
    handle != 0 && unsafe { IsWindow(Some(hwnd(handle))) }.as_bool()
}

pub fn pid_thread(handle: Wid) -> (u32, u32) {
    let mut pid = 0u32;
    // SAFETY: pid is a valid out pointer; a stale handle yields zeros.
    let thread = unsafe { GetWindowThreadProcessId(hwnd(handle), Some(&mut pid)) };
    (pid, thread)
}

pub fn pid_of(handle: Wid) -> u32 {
    pid_thread(handle).0
}

pub fn title(handle: Wid) -> String {
    let mut buffer = [0u16; 1024];
    // SAFETY: the slice is the buffer's whole length.
    let length = unsafe { GetWindowTextW(hwnd(handle), &mut buffer) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

pub fn class_name(handle: Wid) -> String {
    let mut buffer = [0u16; 256];
    // SAFETY: the slice is the buffer's whole length.
    let length = unsafe { GetClassNameW(hwnd(handle), &mut buffer) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

pub fn rect(handle: Wid) -> Option<RECT> {
    let mut rect = RECT::default();
    // SAFETY: rect is a valid out pointer.
    unsafe { GetWindowRect(hwnd(handle), &mut rect) }
        .ok()
        .map(|_| rect)
}

pub fn is_iconic(handle: Wid) -> bool {
    unsafe { IsIconic(hwnd(handle)) }.as_bool()
}

pub fn is_zoomed(handle: Wid) -> bool {
    unsafe { IsZoomed(hwnd(handle)) }.as_bool()
}

pub fn foreground() -> Wid {
    wid(unsafe { GetForegroundWindow() })
}

pub fn root_of(handle: Wid) -> Wid {
    wid(unsafe { GetAncestor(hwnd(handle), GA_ROOT) })
}

pub fn owner_of(handle: Wid) -> Wid {
    wid(unsafe { GetWindow(hwnd(handle), GW_OWNER) }.unwrap_or_default())
}

pub fn cursor() -> (i32, i32) {
    let mut point = POINT::default();
    // SAFETY: point is a valid out pointer.
    let _ = unsafe { GetCursorPos(&mut point) };
    (point.x, point.y)
}

pub fn window_at_point(x: i32, y: i32) -> Wid {
    // SAFETY: plain value argument.
    let hit = unsafe { WindowFromPoint(POINT { x, y }) };
    if hit.0.is_null() {
        0
    } else {
        wid(unsafe { GetAncestor(hit, GA_ROOT) })
    }
}

/// DWM cloaks windows on other virtual desktops and those of suspended
/// packaged apps: they pass `IsWindowVisible` yet nobody sees them.
pub fn is_cloaked(handle: Wid) -> bool {
    let mut cloaked = 0i32;
    // SAFETY: the out pointer and size describe one i32.
    unsafe {
        DwmGetWindowAttribute(
            hwnd(handle),
            DWMWA_CLOAKED,
            &mut cloaked as *mut i32 as *mut c_void,
            4,
        )
    }
    .is_ok()
        && cloaked != 0
}

pub struct Process(pub HANDLE);

impl Process {
    pub fn open(pid: u32, access: u32) -> Option<Process> {
        if pid == 0 {
            return None;
        }
        // SAFETY: a plain open; failure is a None.
        unsafe {
            OpenProcess(
                windows::Win32::System::Threading::PROCESS_ACCESS_RIGHTS(access),
                false,
                pid,
            )
        }
        .ok()
        .map(Process)
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by this value.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

pub fn process_name(pid: u32) -> String {
    let Some(process) = Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION.0) else {
        return String::new();
    };
    let mut buffer = [0u16; 1024];
    let mut size = buffer.len() as u32;
    // SAFETY: buffer and size describe the same allocation.
    let ok = unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
    }
    .is_ok();
    if !ok {
        return String::new();
    }
    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    std::path::Path::new(&path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub fn parent_pid(pid: u32) -> u32 {
    let Some(process) = Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION.0) else {
        return 0;
    };
    let mut information = PROCESS_BASIC_INFORMATION::default();
    let mut returned = 0u32;
    // SAFETY: the buffer is a PROCESS_BASIC_INFORMATION of the stated size.
    let status = unsafe {
        NtQueryInformationProcess(
            process.0,
            ProcessBasicInformation,
            &mut information as *mut _ as *mut c_void,
            std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32,
            &mut returned,
        )
    };
    if status.0 == 0 {
        information.InheritedFromUniqueProcessId as u32
    } else {
        0
    }
}

pub fn terminate(pid: u32) -> Result<(), String> {
    let process = Process::open(pid, PROCESS_TERMINATE.0 | PROCESS_SYNCHRONIZE.0)
        .ok_or_else(|| format!("could not open pid {pid}: {}", std::io::Error::last_os_error()))?;
    // SAFETY: the handle carries PROCESS_TERMINATE.
    unsafe { TerminateProcess(process.0, 1) }.map_err(|error| error.to_string())?;
    // SAFETY: the handle carries SYNCHRONIZE.
    unsafe { WaitForSingleObject(process.0, 2000) };
    Ok(())
}

fn rid_of(process: HANDLE) -> i32 {
    let mut token = HANDLE::default();
    // SAFETY: token is a valid out pointer.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.is_err() {
        return 0;
    }
    let owned = Process(token);
    let mut required = 0u32;
    // SAFETY: a size probe with no buffer.
    let _ = unsafe { GetTokenInformation(owned.0, TokenIntegrityLevel, None, 0, &mut required) };
    if required == 0 {
        return 0;
    }
    let mut buffer = vec![0u8; required as usize];
    // SAFETY: the buffer is `required` bytes.
    let read = unsafe {
        GetTokenInformation(
            owned.0,
            TokenIntegrityLevel,
            Some(buffer.as_mut_ptr() as *mut c_void),
            required,
            &mut required,
        )
    };
    if read.is_err() {
        return 0;
    }
    // SAFETY: the call filled a TOKEN_MANDATORY_LABEL whose SID points into the buffer.
    unsafe {
        let label = &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let count = GetSidSubAuthorityCount(label.Label.Sid);
        if count.is_null() || *count == 0 {
            return 0;
        }
        let rid = GetSidSubAuthority(label.Label.Sid, (*count - 1) as u32);
        if rid.is_null() {
            0
        } else {
            *rid as i32
        }
    }
}

fn integrity_name(rid: i32) -> &'static str {
    match rid {
        r if r >= 0x4000 => "System",
        r if r >= 0x3000 => "High",
        r if r >= 0x2100 => "Medium+",
        r if r >= 0x2000 => "Medium",
        r if r >= 0x1000 => "Low",
        r if r > 0 => "Untrusted",
        _ => "Unknown",
    }
}

pub fn integrity(handle: Wid) -> Integrity {
    // SAFETY: the pseudo-handle needs no close.
    let own_rid = rid_of(unsafe { GetCurrentProcess() });
    let target_rid = Process::open(pid_of(handle), PROCESS_QUERY_LIMITED_INFORMATION.0)
        .map_or(0, |process| rid_of(process.0));
    Integrity {
        own_rid,
        target_rid,
        own_name: integrity_name(own_rid),
        target_name: integrity_name(target_rid),
    }
}

/// The packaged app's content process hosted in an `ApplicationFrameWindow`.
fn content_pid(handle: Wid, host_pid: u32, class: &str) -> i64 {
    if class != "ApplicationFrameWindow" {
        return 0;
    }
    struct Search {
        host: u32,
        found: u32,
    }
    unsafe extern "system" fn visit(child: HWND, state: LPARAM) -> BOOL {
        let search = &mut *(state.0 as *mut Search);
        if class_name(wid(child)) != "Windows.UI.Core.CoreWindow" {
            return BOOL(1);
        }
        let pid = pid_of(wid(child));
        if pid == 0 || pid == search.host {
            return BOOL(1);
        }
        search.found = pid;
        BOOL(0)
    }
    let mut search = Search {
        host: host_pid,
        found: 0,
    };
    // SAFETY: the callback only runs during this call and reads `search`.
    let _ = unsafe {
        EnumChildWindows(
            Some(hwnd(handle)),
            Some(visit),
            LPARAM(&mut search as *mut Search as isize),
        )
    };
    search.found as i64
}

pub fn info(handle: Wid, with_app: bool) -> Option<WindowInfo> {
    if !is_window(handle) {
        return None;
    }
    let (pid, thread) = pid_thread(handle);
    let frame = rect(handle).unwrap_or_default();
    let mut client = RECT::default();
    let mut origin = POINT::default();
    // SAFETY: both are valid out pointers.
    let has_client = unsafe { GetClientRect(hwnd(handle), &mut client) }.is_ok()
        && unsafe { windows::Win32::Graphics::Gdi::ClientToScreen(hwnd(handle), &mut origin) }
            .as_bool();
    let class = class_name(handle);
    let mut owner = owner_of(handle);
    // A native popup menu can have no owner; the GUI thread's menu owner is it.
    if owner == 0 && class == "#32768" {
        let mut gui = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: gui is initialised with its size.
        if unsafe { GetGUIThreadInfo(thread, &mut gui) }.is_ok() {
            let menu_owner = wid(gui.hwndMenuOwner);
            if menu_owner != handle && is_window(menu_owner) && pid_of(menu_owner) == pid {
                owner = menu_owner;
            }
        }
    }
    let width = (frame.right - frame.left).max(0);
    let height = (frame.bottom - frame.top).max(0);
    Some(WindowInfo {
        handle,
        title: title(handle),
        content_pid: content_pid(handle, pid, &class),
        class_name: class,
        app: if with_app { process_name(pid) } else { String::new() },
        pid: pid as i64,
        parent_pid: parent_pid(pid) as i64,
        owner,
        focused: foreground() == handle,
        minimized: is_iconic(handle),
        maximized: is_zoomed(handle),
        x: frame.left,
        y: frame.top,
        width,
        height,
        client: if has_client {
            (
                origin.x,
                origin.y,
                (client.right - client.left).max(0),
                (client.bottom - client.top).max(0),
            )
        } else {
            (frame.left, frame.top, width, height)
        },
    })
}

fn is_shown(info: &WindowInfo, handle: Wid) -> bool {
    unsafe { IsWindowVisible(hwnd(handle)) }.as_bool()
        && !is_cloaked(handle)
        && info.width > 0
        && info.height > 0
}

fn enumerate(mut visit: impl FnMut(Wid)) {
    unsafe extern "system" fn each(handle: HWND, state: LPARAM) -> BOOL {
        let visit = &mut *(state.0 as *mut &mut dyn FnMut(Wid));
        visit(wid(handle));
        BOOL(1)
    }
    let mut dynamic: &mut dyn FnMut(Wid) = &mut visit;
    // SAFETY: the callback only runs during this call.
    let _ = unsafe {
        EnumWindows(
            Some(each),
            LPARAM(&mut dynamic as *mut &mut dyn FnMut(Wid) as isize),
        )
    };
}

/// Every window a person could see, with process names looked up once per process.
pub fn shown_windows(with_app: bool) -> Vec<WindowInfo> {
    let mut handles = Vec::new();
    enumerate(|handle| handles.push(handle));
    let mut apps: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    let mut shown = Vec::new();
    for handle in handles {
        let Some(mut window) = info(handle, false) else {
            continue;
        };
        if !is_shown(&window, handle) {
            continue;
        }
        if with_app {
            window.app = apps
                .entry(window.pid)
                .or_insert_with(|| process_name(window.pid as u32))
                .clone();
        }
        shown.push(window);
    }
    shown
}

/// Whether `candidate` is reached from `owner` along the owner chain.
pub fn is_owned_by(candidate: Wid, owner: Wid) -> bool {
    if !is_window(candidate) || !is_window(owner) || candidate == owner {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    let mut current = candidate;
    while current != 0 && seen.insert(current) {
        current = owner_of(current);
        if current == owner {
            return true;
        }
    }
    false
}

pub fn related_windows(target: Wid) -> Vec<Wid> {
    if !is_window(target) {
        return Vec::new();
    }
    let mut related = Vec::new();
    enumerate(|handle| {
        if handle != target
            && unsafe { IsWindowVisible(hwnd(handle)) }.as_bool()
            && !is_cloaked(handle)
            && is_owned_by(handle, target)
        {
            related.push(handle);
        }
    });
    related
}

pub fn shares_process(first: Wid, second: Wid) -> bool {
    if !is_window(first) || !is_window(second) {
        return false;
    }
    let pid = pid_of(first);
    pid != 0 && pid == pid_of(second)
}

/// Same process, and drawn entirely inside the surface's frame.
pub fn is_contained_same_process(candidate: Wid, surface: Wid) -> bool {
    if !shares_process(candidate, surface) {
        return false;
    }
    let (Some(inner), Some(outer)) = (rect(candidate), rect(surface)) else {
        return false;
    };
    inner.right > inner.left
        && inner.bottom > inner.top
        && inner.left >= outer.left
        && inner.top >= outer.top
        && inner.right <= outer.right
        && inner.bottom <= outer.bottom
}

pub fn is_responding(handle: Wid) -> bool {
    is_window(handle) && !unsafe { IsHungAppWindow(hwnd(handle)) }.as_bool()
}

pub fn move_window(handle: Wid, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    // SAFETY: plain value arguments.
    unsafe {
        let _ = ShowWindow(hwnd(handle), SW_RESTORE);
        MoveWindow(hwnd(handle), x, y, width, height, true)
    }
    .map_err(|_| format!("could not move window: {}", crate::platform::window_id(handle)))
}

pub fn show(handle: Wid, command: crate::platform::WinState) {
    use crate::platform::WinState;
    let command = match command {
        WinState::Minimize => SW_MINIMIZE,
        WinState::Maximize => SW_MAXIMIZE,
        WinState::Restore => SW_RESTORE,
    };
    // SAFETY: plain value arguments.
    let _ = unsafe { ShowWindow(hwnd(handle), command) };
}

/// Queues the close request; the caller observes closure separately, since a
/// save dialog can hold the real close for a long time.
pub fn close(handle: Wid) -> Result<bool, String> {
    if !is_window(handle) {
        return Ok(false);
    }
    // SAFETY: plain value arguments.
    match unsafe { PostMessageW(Some(hwnd(handle)), WM_CLOSE, Default::default(), Default::default()) } {
        Ok(()) => Ok(true),
        Err(error) if error.code().0 as u32 & 0xFFFF == 5 => Err(
            "background_blocked_uipi|Windows integrity isolation blocked the close request".into(),
        ),
        Err(error) => Err(format!(
            "background_message_rejected|close request failed: {error}"
        )),
    }
}

fn in_front(handle: Wid, foreground: Wid) -> bool {
    foreground == handle && !is_iconic(handle)
}

fn restore_if_minimized(handle: Wid) {
    if is_iconic(handle) {
        // SAFETY: plain value arguments.
        let _ = unsafe { ShowWindow(hwnd(handle), SW_RESTORE) };
    }
}

/// One activation try through the input queues of the current foreground and
/// the target; the foreground lock refuses a plain `SetForegroundWindow`.
pub fn try_focus_attached(handle: Wid) -> bool {
    let current_foreground = foreground();
    if in_front(handle, current_foreground) {
        return true;
    }
    let foreground_thread = pid_thread(current_foreground).1;
    let target_thread = pid_thread(handle).1;
    // SAFETY: plain call.
    let this_thread = unsafe { GetCurrentThreadId() };
    let attached_foreground = foreground_thread != 0
        && foreground_thread != this_thread
        && unsafe { AttachThreadInput(this_thread, foreground_thread, true) }.as_bool();
    let attached_target = target_thread != 0
        && target_thread != this_thread
        && target_thread != foreground_thread
        && unsafe { AttachThreadInput(this_thread, target_thread, true) }.as_bool();
    restore_if_minimized(handle);
    // SAFETY: plain value arguments.
    unsafe {
        let _ = BringWindowToTop(hwnd(handle));
        let _ = SetForegroundWindow(hwnd(handle));
        let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetActiveWindow(hwnd(handle));
        let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(Some(hwnd(handle)));
    }
    let landed = foreground() == handle;
    // SAFETY: undoes the attachments made above.
    unsafe {
        if attached_target {
            let _ = AttachThreadInput(this_thread, target_thread, false);
        }
        if attached_foreground {
            let _ = AttachThreadInput(this_thread, foreground_thread, false);
        }
    }
    landed
}

fn foreground_lock_timeout() -> Option<u32> {
    let mut value = 0u32;
    // SAFETY: value is a valid out pointer for this query.
    unsafe {
        SystemParametersInfoW(
            SPI_GETFOREGROUNDLOCKTIMEOUT,
            0,
            Some(&mut value as *mut u32 as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    }
    .ok()
    .map(|_| value)
}

fn set_foreground_lock_timeout(value: u32) {
    // SAFETY: the value travels in the pointer argument by contract.
    let _ = unsafe {
        SystemParametersInfoW(
            SPI_SETFOREGROUNDLOCKTIMEOUT,
            0,
            Some(value as usize as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
}

/// The foreground lock is a timeout, not a permission: a background process
/// may drop it for the length of one switch.
pub fn focus(handle: Wid) -> bool {
    if !is_window(handle) {
        return false;
    }
    if in_front(handle, foreground()) {
        return true;
    }
    restore_if_minimized(handle);
    // SAFETY: plain value argument.
    let _ = unsafe { SetForegroundWindow(hwnd(handle)) };
    if foreground() == handle || try_focus_attached(handle) {
        return true;
    }
    let previous = foreground_lock_timeout().filter(|value| *value != 0);
    if previous.is_some() {
        set_foreground_lock_timeout(0);
    }
    let mut landed = false;
    for _ in 0..3 {
        if try_focus_attached(handle) {
            landed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    if let Some(value) = previous {
        set_foreground_lock_timeout(value);
    }
    landed
}

/// The child window at a screen point inside `top`, descending only while the
/// child belongs to the same process as `top`.
pub fn child_at(parent: Wid, x: i32, y: i32) -> Option<Wid> {
    let mut point = POINT { x, y };
    // SAFETY: point is a valid in/out pointer.
    if !unsafe { windows::Win32::Graphics::Gdi::ScreenToClient(hwnd(parent), &mut point) }.as_bool()
    {
        return None;
    }
    // CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT
    let child = unsafe {
        ChildWindowFromPointEx(
            hwnd(parent),
            point,
            windows::Win32::UI::WindowsAndMessaging::CWP_FLAGS(0x7),
        )
    };
    let child = wid(child);
    (child != 0 && child != parent).then_some(child)
}

// --- the window's own rendering ------------------------------------------

fn capture_failure(code: &str, message: &str) -> String {
    format!("{code}|{message}")
}

struct Target {
    pid: u32,
    thread: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn begin_capture(handle: Wid) -> Result<Target, String> {
    if !is_window(handle) {
        return Err(capture_failure(
            "capture_source_unavailable",
            "exact native window is stale or invalid",
        ));
    }
    if is_iconic(handle) {
        return Err(capture_failure(
            "capture_minimized",
            "minimized native window has no rendered surface",
        ));
    }
    if is_cloaked(handle) {
        return Err(capture_failure(
            "capture_cloaked",
            "native window is cloaked and has no available surface",
        ));
    }
    let bounds = rect(handle).ok_or_else(|| {
        capture_failure(
            "capture_source_unavailable",
            "could not read exact native window bounds",
        )
    })?;
    let width = bounds.right - bounds.left;
    let height = bounds.bottom - bounds.top;
    if width <= 0 || height <= 0 || (width as i64) * (height as i64) > 16_777_216 {
        return Err(capture_failure(
            "capture_source_unavailable",
            "exact native window bounds exceed the capture budget",
        ));
    }
    let (pid, thread) = pid_thread(handle);
    if pid == 0 || thread == 0 {
        return Err(capture_failure(
            "capture_source_unavailable",
            "native window identity is unavailable",
        ));
    }
    Ok(Target {
        pid,
        thread,
        x: bounds.left,
        y: bounds.top,
        width,
        height,
    })
}

/// At least 99.5% of up to 4096 sampled pixels with every channel at or below 4.
fn is_blank_black(bgra: &[u8], width: usize, height: usize) -> bool {
    let total = width * height;
    let stride = (total / 4096).max(1);
    let (mut sampled, mut black) = (0usize, 0usize);
    let mut pixel = 0;
    while pixel < total {
        let offset = pixel * 4;
        sampled += 1;
        if bgra[offset] <= 4 && bgra[offset + 1] <= 4 && bgra[offset + 2] <= 4 {
            black += 1;
        }
        pixel += stride;
    }
    black as f64 >= sampled as f64 * 0.995
}

/// Asks the window to render into our bitmap; never reads a desktop DC for pixels.
pub fn window_surface(handle: Wid) -> Result<Surface, String> {
    let before = begin_capture(handle)?;
    let (width, height) = (before.width as usize, before.height as usize);
    let header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: before.width,
        biHeight: -before.height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let info = BITMAPINFO {
        bmiHeader: header,
        ..Default::default()
    };
    // SAFETY: every GDI object created here is released before returning.
    unsafe {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0);
        let outcome = (|| -> Result<Vec<u8>, String> {
            let bitmap = bitmap.map_err(|_| {
                capture_failure("capture_source_unavailable", "window bitmap is unavailable")
            })?;
            let previous = SelectObject(dc, bitmap.into());
            let pixels = std::slice::from_raw_parts_mut(bits as *mut u8, width * height * 4);
            // PW_RENDERFULLCONTENT reads the composed surface; a window never
            // composed renders black that way but still paints on request.
            let mut rendered = PrintWindow(hwnd(handle), dc, PRINT_WINDOW_FLAGS(0x2)).as_bool();
            if !rendered || is_blank_black(pixels, width, height) {
                pixels.fill(0);
                rendered = PrintWindow(hwnd(handle), dc, PRINT_WINDOW_FLAGS(0)).as_bool();
            }
            let copy = pixels.to_vec();
            SelectObject(dc, previous);
            let _ = DeleteObject(bitmap.into());
            if !rendered {
                return Err(capture_failure(
                    "capture_source_unavailable",
                    "window-owned rendering is unavailable",
                ));
            }
            Ok(copy)
        })();
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        let mut bgra = outcome?;
        let after = begin_capture(handle)?;
        if (before.pid, before.thread, before.x, before.y, before.width, before.height)
            != (after.pid, after.thread, after.x, after.y, after.width, after.height)
        {
            return Err(capture_failure(
                "capture_geometry_changed",
                "native window changed during capture",
            ));
        }
        for pixel in bgra.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, before.width as u32, before.height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .and_then(|mut writer| writer.write_image_data(&bgra))
            .map_err(|error| {
                capture_failure("capture_source_unavailable", &format!("png encoding failed: {error}"))
            })?;
        Ok(Surface {
            png,
            x: before.x,
            y: before.y,
            width: before.width,
            height: before.height,
        })
    }
}
