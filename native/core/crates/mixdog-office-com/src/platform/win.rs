//! The Windows implementation of [`Platform`]: the port of `MixdogOfficeInterop` and of the process helpers of the
//! PowerShell hosts.

use std::ffi::c_void;
use std::io;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::path::PathBuf;
use std::time::Instant;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Foundation::GENERIC_READ;
use windows::Win32::Foundation::GENERIC_WRITE;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Foundation::HWND;
use windows::Win32::Foundation::LPARAM;
use windows::Win32::Foundation::FILETIME;
use windows::Win32::Foundation::WAIT_OBJECT_0;
use windows::Win32::Foundation::WAIT_TIMEOUT;
use windows::Win32::Storage::FileSystem::CreateFileW;
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::Storage::FileSystem::FILE_BEGIN;
use windows::Win32::Storage::FileSystem::FILE_CURRENT;
use windows::Win32::Storage::FileSystem::FILE_END;
use windows::Win32::Storage::FileSystem::FILE_SHARE_NONE;
use windows::Win32::Storage::FileSystem::GetTempPathW;
use windows::Win32::Storage::FileSystem::OPEN_EXISTING;
use windows::Win32::Storage::FileSystem::ReadFile;
use windows::Win32::Storage::FileSystem::SetFilePointerEx;
use windows::Win32::Storage::FileSystem::WriteFile;
use windows::Win32::System::Com::COWAIT_DISPATCH_WINDOW_MESSAGES;
use windows::Win32::System::Com::CLSIDFromProgID;
use windows::Win32::System::Com::CoCreateGuid;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Com::CoWaitForMultipleHandles;
use windows::Win32::System::Com::CreateBindCtx;
use windows::Win32::System::Com::GetRunningObjectTable;
use windows::Win32::System::Com::IMoniker;
use windows::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot;
use windows::Win32::System::Diagnostics::ToolHelp::PROCESSENTRY32W;
use windows::Win32::System::Diagnostics::ToolHelp::Process32FirstW;
use windows::Win32::System::Diagnostics::ToolHelp::Process32NextW;
use windows::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPPROCESS;
use windows::Win32::System::Threading::AttachThreadInput;
use windows::Win32::System::Threading::CreateEventW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::System::Threading::GetProcessTimes;
use windows::Win32::System::Threading::OpenProcess;
use windows::Win32::System::Threading::PROCESS_ACCESS_RIGHTS;
use windows::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
use windows::Win32::System::Threading::PROCESS_SYNCHRONIZE;
use windows::Win32::System::Threading::PROCESS_TERMINATE;
use windows::Win32::System::Threading::TerminateProcess;
use windows::Win32::System::Threading::WaitForSingleObject;
use windows::Win32::UI::WindowsAndMessaging::BringWindowToTop;
use windows::Win32::UI::WindowsAndMessaging::EnumWindows;
use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
use windows::Win32::UI::WindowsAndMessaging::IsIconic;
use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
use windows::Win32::UI::WindowsAndMessaging::SW_RESTORE;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOW;
use windows::Win32::UI::WindowsAndMessaging::SendMessageW;
use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
use windows::Win32::UI::WindowsAndMessaging::ShowWindowAsync;
use windows::core::BOOL;
use windows::core::HRESULT;
use windows::core::PCWSTR;

use super::ExclusiveStream;
use super::FontSet;
use super::Platform;
use super::RunningObject;
use super::WM_USER_REGISTER_EXCEL;
use super::fonts;
use super::guid_text_n;
use super::normalize_path;
use super::ticks_from_filetime;

/// `ERROR_ACCESS_DENIED`: the process exists but may not be opened this way.
const ACCESS_DENIED: u32 = 5;

/// The Windows layer. Create it on the thread that uses it (the host's STA thread).
pub struct WindowsPlatform {
    /// An event nothing ever sets: [`Platform::sleep`] waits on it.
    never_set: OwnedHandle,
}

impl WindowsPlatform {
    pub fn new() -> io::Result<Self> {
        // SAFETY: a manual-reset, unsignalled, unnamed event; the handle is owned by the returned value.
        let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.map_err(io::Error::other)?;
        Ok(Self { never_set: OwnedHandle(event) })
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: the handle is valid and closed once, here.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn to_hwnd(hwnd: i64) -> HWND {
    HWND(hwnd as isize as *mut c_void)
}

fn from_hwnd(hwnd: HWND) -> i64 {
    hwnd.0 as isize as i64
}

unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: `lparam` is the address of the `&mut dyn FnMut` that `enum_windows` keeps alive for the whole call.
    let visit = unsafe { &mut *(lparam.0 as *mut &mut dyn FnMut(HWND) -> bool) };
    BOOL::from(visit(hwnd))
}

/// `EnumWindows`: calls `visit` for every top-level window until it returns false.
fn enum_windows(mut visit: impl FnMut(HWND) -> bool) {
    let mut visit: &mut dyn FnMut(HWND) -> bool = &mut visit;
    // SAFETY: the callback only reads the closure behind the pointer, which outlives the call. EnumWindows reports an
    // error when the callback stops the walk, which is how a search ends.
    let _ = unsafe { EnumWindows(Some(enum_callback), LPARAM(&mut visit as *mut &mut dyn FnMut(HWND) -> bool as isize)) };
}

fn window_process_id(hwnd: HWND) -> u32 {
    let mut owner = 0u32;
    // SAFETY: `owner` is a valid out pointer.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner)) };
    owner
}

fn is_visible(hwnd: HWND) -> bool {
    // SAFETY: any window handle value is accepted.
    unsafe { IsWindowVisible(hwnd) }.as_bool()
}

fn class_name(hwnd: HWND, capacity: usize) -> String {
    let mut buffer = vec![0u16; capacity];
    // SAFETY: the slice is the buffer's whole length.
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

fn window_text(hwnd: HWND, capacity: usize) -> String {
    let mut buffer = vec![0u16; capacity];
    // SAFETY: the slice is the buffer's whole length.
    let length = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

fn windows_of_process(process_id: i32) -> Vec<HWND> {
    let mut found = Vec::new();
    if process_id <= 0 {
        return found;
    }
    enum_windows(|hwnd| {
        if window_process_id(hwnd) == process_id as u32 && is_visible(hwnd) {
            found.push(hwnd);
        }
        true
    });
    found
}

fn upper(text: &str) -> String {
    text.to_uppercase()
}

fn open_process(rights: PROCESS_ACCESS_RIGHTS, process_id: i32) -> windows::core::Result<OwnedHandle> {
    // SAFETY: plain value arguments.
    unsafe { OpenProcess(rights, false, process_id as u32) }.map(OwnedHandle)
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// A file held with share mode none; closed when dropped.
struct ExclusiveFile(OwnedHandle);

impl ExclusiveFile {
    fn move_pointer(&mut self, distance: i64, method: windows::Win32::Storage::FileSystem::SET_FILE_POINTER_MOVE_METHOD) -> io::Result<u64> {
        let mut position = 0i64;
        // SAFETY: the handle is open; `position` is a valid out pointer.
        unsafe { SetFilePointerEx(self.0.0, distance, Some(&mut position), method) }.map_err(io::Error::other)?;
        Ok(position as u64)
    }
}

impl Read for ExclusiveFile {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let mut read = 0u32;
        let wanted = buffer.len().min(u32::MAX as usize);
        // SAFETY: the buffer holds at least `wanted` bytes; `read` is a valid out pointer; no overlapped I/O.
        unsafe { ReadFile(self.0.0, Some(&mut buffer[..wanted]), Some(&mut read), None) }.map_err(io::Error::other)?;
        Ok(read as usize)
    }
}

impl Write for ExclusiveFile {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let mut written = 0u32;
        let wanted = buffer.len().min(u32::MAX as usize);
        // SAFETY: the buffer holds at least `wanted` bytes; `written` is a valid out pointer; no overlapped I/O.
        unsafe { WriteFile(self.0.0, Some(&buffer[..wanted]), Some(&mut written), None) }.map_err(io::Error::other)?;
        Ok(written as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for ExclusiveFile {
    fn seek(&mut self, target: SeekFrom) -> io::Result<u64> {
        match target {
            SeekFrom::Start(offset) => self.move_pointer(offset as i64, FILE_BEGIN),
            SeekFrom::Current(offset) => self.move_pointer(offset, FILE_CURRENT),
            SeekFrom::End(offset) => self.move_pointer(offset, FILE_END),
        }
    }
}

impl Platform for WindowsPlatform {
    fn try_get_running_file(&self, path: &str) -> Option<RunningObject> {
        // SAFETY: COM calls on the calling thread's apartment; every interface is released when it drops.
        unsafe {
            let table = GetRunningObjectTable(0).ok()?;
            let context = CreateBindCtx(0).ok()?;
            let enumerator = table.EnumRunning().ok()?;
            let _ = enumerator.Reset();
            let expected = upper(&normalize_path(path));
            loop {
                let mut monikers: [Option<IMoniker>; 1] = [None];
                if enumerator.Next(&mut monikers, None).0 != 0 {
                    return None;
                }
                let Some(moniker) = monikers[0].take() else { continue };
                // A failure on one moniker skips it, as the catch of the C# loop did.
                let Ok(name) = moniker.GetDisplayName(&context, None::<&IMoniker>) else { continue };
                let display = String::from_utf16_lossy(name.as_wide());
                CoTaskMemFree(Some(name.0 as *const c_void));
                if upper(&normalize_path(&display)) != expected {
                    continue;
                }
                if let Ok(object) = table.GetObject(&moniker) {
                    return Some(RunningObject::new(object));
                }
            }
        }
    }

    fn register_excel_instances(&self) {
        enum_windows(|hwnd| {
            if class_name(hwnd, 64).eq_ignore_ascii_case("XLMAIN") {
                // SAFETY: a window message to a top-level window; the answer is not used.
                unsafe { SendMessageW(hwnd, WM_USER_REGISTER_EXCEL, None, None) };
            }
            true
        });
    }

    fn process_id_for_window(&self, hwnd: i64) -> i32 {
        window_process_id(to_hwnd(hwnd)) as i32
    }

    fn foreground_window(&self) -> i64 {
        // SAFETY: no arguments.
        from_hwnd(unsafe { GetForegroundWindow() })
    }

    fn hide_visible_windows_for_process(&self, process_id: i32) -> i32 {
        let mut hidden = 0;
        for hwnd in windows_of_process(process_id) {
            // SAFETY: a window handle taken from the enumeration.
            if unsafe { ShowWindowAsync(hwnd, SW_HIDE) }.as_bool() {
                hidden += 1;
            }
        }
        hidden
    }

    fn visible_window_count_for_process(&self, process_id: i32) -> i32 {
        windows_of_process(process_id).len() as i32
    }

    fn visible_window_descriptions_for_process(&self, process_id: i32) -> Vec<String> {
        windows_of_process(process_id)
            .into_iter()
            .map(|hwnd| format!("{}|{}", class_name(hwnd, 128), window_text(hwnd, 1024)))
            .collect()
    }

    fn find_window_by_class_and_title(&self, class: &str, title_part: &str) -> i64 {
        let part = upper(title_part);
        let mut found = 0i64;
        enum_windows(|hwnd| {
            if !is_visible(hwnd) || !class_name(hwnd, 64).eq_ignore_ascii_case(class) {
                return true;
            }
            if !upper(&window_text(hwnd, 1024)).contains(&part) {
                return true;
            }
            found = from_hwnd(hwnd);
            false
        });
        found
    }

    fn activate_window(&self, hwnd: i64) -> bool {
        let target = to_hwnd(hwnd);
        if target.0.is_null() {
            return false;
        }
        // SAFETY: plain window and thread calls; every attachment made here is detached before returning, in reverse order.
        unsafe {
            let current_thread = GetCurrentThreadId();
            let foreground_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
            let target_thread = GetWindowThreadProcessId(target, None);
            let mut attached_foreground = false;
            let mut attached_target = false;
            if foreground_thread != 0 && foreground_thread != current_thread {
                attached_foreground = AttachThreadInput(current_thread, foreground_thread, true).as_bool();
            }
            if target_thread != 0 && target_thread != current_thread {
                attached_target = AttachThreadInput(current_thread, target_thread, true).as_bool();
            }
            let _ = ShowWindowAsync(target, if IsIconic(target).as_bool() { SW_RESTORE } else { SW_SHOW });
            let _ = BringWindowToTop(target);
            let _ = SetForegroundWindow(target);
            let active = GetForegroundWindow() == target;
            if attached_target {
                let _ = AttachThreadInput(current_thread, target_thread, false);
            }
            if attached_foreground {
                let _ = AttachThreadInput(current_thread, foreground_thread, false);
            }
            active
        }
    }

    fn hide_window(&self, hwnd: i64) -> bool {
        let target = to_hwnd(hwnd);
        // SAFETY: any window handle value is accepted.
        !target.0.is_null() && unsafe { ShowWindowAsync(target, SW_HIDE) }.as_bool()
    }

    fn window_visible(&self, hwnd: i64) -> bool {
        let target = to_hwnd(hwnd);
        !target.0.is_null() && is_visible(target)
    }

    fn process_ids_by_name(&self, name: &str) -> Vec<i32> {
        let mut ids = Vec::new();
        // SAFETY: the snapshot handle is owned and closed on drop; the entry is sized as the API requires.
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map(OwnedHandle) else { return ids };
            let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut more = Process32FirstW(snapshot.0, &mut entry).is_ok();
            while more {
                let length = entry.szExeFile.iter().position(|unit| *unit == 0).unwrap_or(entry.szExeFile.len());
                let image = String::from_utf16_lossy(&entry.szExeFile[..length]);
                // .NET's process name is the image name without a trailing ".exe".
                let process_name = match image.len().checked_sub(4).and_then(|at| image.get(at..)) {
                    Some(tail) if tail.eq_ignore_ascii_case(".exe") => &image[..image.len() - 4],
                    _ => image.as_str(),
                };
                if process_name.eq_ignore_ascii_case(name) {
                    ids.push(entry.th32ProcessID as i32);
                }
                more = Process32NextW(snapshot.0, &mut entry).is_ok();
            }
        }
        ids
    }

    fn process_start_ticks(&self, process_id: i32) -> i64 {
        let Ok(process) = open_process(PROCESS_QUERY_LIMITED_INFORMATION, process_id) else { return 0 };
        let mut created = FILETIME::default();
        let mut unused = FILETIME::default();
        let (mut exited, mut kernel) = (unused, unused);
        // SAFETY: the handle is open and every out pointer is valid.
        let times = unsafe { GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut unused) };
        if times.is_err() {
            return 0;
        }
        ticks_from_filetime((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    fn process_exists(&self, process_id: i32) -> bool {
        let rights = PROCESS_ACCESS_RIGHTS(PROCESS_QUERY_LIMITED_INFORMATION.0 | PROCESS_SYNCHRONIZE.0);
        match open_process(rights, process_id) {
            // SAFETY: the handle is open.
            Ok(process) => (unsafe { WaitForSingleObject(process.0, 0) }) == WAIT_TIMEOUT,
            Err(error) => error.code() == HRESULT::from_win32(ACCESS_DENIED),
        }
    }

    fn wait_for_exit(&self, process_id: i32, timeout_ms: u32) -> bool {
        match open_process(PROCESS_SYNCHRONIZE, process_id) {
            // SAFETY: the handle is open.
            Ok(process) => (unsafe { WaitForSingleObject(process.0, timeout_ms) }) == WAIT_OBJECT_0,
            Err(_) => true,
        }
    }

    fn kill_process(&self, process_id: i32) -> bool {
        match open_process(PROCESS_TERMINATE, process_id) {
            // SAFETY: the handle is open; -1 is the exit code .NET's Process.Kill uses.
            Ok(process) => unsafe { TerminateProcess(process.0, u32::MAX) }.is_ok(),
            Err(_) => false,
        }
    }

    fn installed(&self, prog_id: &str) -> bool {
        if prog_id.is_empty() {
            return false;
        }
        let wide: Vec<u16> = prog_id.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is NUL-terminated and outlives the call.
        unsafe { CLSIDFromProgID(PCWSTR(wide.as_ptr())) }.is_ok()
    }

    fn installed_office_fonts(&self) -> FontSet {
        fonts::installed_office_fonts()
    }

    fn open_exclusive(&self, path: &Path) -> io::Result<Box<dyn ExclusiveStream>> {
        let wide = wide_path(path);
        // SAFETY: `wide` is NUL-terminated and outlives the call. Share mode 0 is the point of the call: mixdog-fsio's
        // OpenOptions has no share mode and std::fs is banned.
        let handle = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                GENERIC_READ.0 | GENERIC_WRITE.0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .map_err(io::Error::other)?;
        Ok(Box::new(ExclusiveFile(OwnedHandle(handle))))
    }

    fn temp_dir(&self) -> PathBuf {
        let mut buffer = vec![0u16; 261];
        loop {
            // SAFETY: the slice is the buffer's whole length.
            let length = unsafe { GetTempPathW(Some(&mut buffer)) } as usize;
            if length <= buffer.len() {
                buffer.truncate(length);
                return PathBuf::from(String::from_utf16_lossy(&buffer));
            }
            buffer.resize(length, 0);
        }
    }

    fn new_guid_n(&self) -> String {
        // SAFETY: no arguments.
        let guid = unsafe { CoCreateGuid() }.unwrap_or_default();
        guid_text_n(guid.data1, guid.data2, guid.data3, guid.data4)
    }

    fn sleep(&self, milliseconds: u32) {
        // The wait times out by design (the event is never set); the call returns an error for the timeout.
        // SAFETY: the event handle is open.
        let _ = unsafe { CoWaitForMultipleHandles(COWAIT_DISPATCH_WINDOW_MESSAGES.0 as u32, milliseconds, &[self.never_set.0]) };
    }

    fn now(&self) -> Instant {
        Instant::now()
    }
}
