//! Starting a Windows child. Shared by the stdio helper binary and the core library, which each
//! compile this file.
//!
//! The child is created inside its job object (`PROC_THREAD_ATTRIBUTE_JOB_LIST`), already
//! running: there is no instant at which it exists outside the job, and nothing is left suspended
//! when this process dies at any point. It inherits exactly the handles meant for it
//! (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), never the pipe ends of another child this process runs.
#![allow(dead_code)]

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::BorrowedHandle;
use std::os::windows::io::RawHandle;
use std::os::windows::process::ExitStatusExt;
use std::path::Path;
use std::process::ExitStatus;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::DUPLICATE_SAME_ACCESS;
use windows_sys::Win32::Foundation::DuplicateHandle;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
use windows_sys::Win32::System::Threading::CREATE_UNICODE_ENVIRONMENT;
use windows_sys::Win32::System::Threading::CreateProcessW;
use windows_sys::Win32::System::Threading::DeleteProcThreadAttributeList;
use windows_sys::Win32::System::Threading::EXTENDED_STARTUPINFO_PRESENT;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::System::Threading::GetExitCodeProcess;
use windows_sys::Win32::System::Threading::INFINITE;
use windows_sys::Win32::System::Threading::InitializeProcThreadAttributeList;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_HANDLE_LIST;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_JOB_LIST;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE;
use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
use windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
use windows_sys::Win32::System::Threading::STARTUPINFOEXW;
use windows_sys::Win32::System::Threading::TerminateProcess;
use windows_sys::Win32::System::Threading::UpdateProcThreadAttribute;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

/// What the child's standard streams are.
pub(crate) enum Stdio<'a> {
    /// These handles; `None` is the null device. They stay the caller's: the child gets its own
    /// inheritable duplicates, closed here as soon as it exists.
    Handles {
        stdin: Option<BorrowedHandle<'a>>,
        stdout: Option<BorrowedHandle<'a>>,
        stderr: Option<BorrowedHandle<'a>>,
    },
    /// The pseudo-console (an `HPCON`); the child inherits no handle at all.
    Console(isize),
}

pub(crate) struct Spawn<'a> {
    pub program: &'a str,
    /// The whole Windows command line, program first.
    pub command_line: &'a str,
    pub cwd: Option<&'a Path>,
    /// The child's whole environment; `None` is this process's own.
    pub env: Option<&'a [(OsString, OsString)]>,
    pub stdio: Stdio<'a>,
}

/// A process started by [`spawn`].
pub(crate) struct WinProcess {
    pub(crate) pid: u32,
    handle: HANDLE,
}

unsafe impl Send for WinProcess {}
unsafe impl Sync for WinProcess {}

impl WinProcess {
    pub(crate) fn id(&self) -> u32 {
        self.pid
    }

    pub(crate) fn terminate(&self, code: u32) -> io::Result<()> {
        if unsafe { TerminateProcess(self.handle, code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        Ok(self.wait_for(INFINITE)?.expect("an infinite wait ends with the process"))
    }

    /// The exit status if the process has ended.
    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_for(0)
    }

    fn wait_for(&self, milliseconds: u32) -> io::Result<Option<ExitStatus>> {
        unsafe {
            match WaitForSingleObject(self.handle, milliseconds) {
                WAIT_OBJECT_0 => {}
                WAIT_TIMEOUT => return Ok(None),
                _ => return Err(io::Error::last_os_error()),
            }
            let mut code = 0u32;
            if GetExitCodeProcess(self.handle, &mut code) == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Some(ExitStatus::from_raw(code)))
        }
    }
}

impl AsRawHandle for WinProcess {
    fn as_raw_handle(&self) -> RawHandle {
        self.handle.cast()
    }
}

impl Drop for WinProcess {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle) };
    }
}

fn wide(text: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    text.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// The environment block `CreateProcessW` takes: sorted by upper-cased name, double-NUL ended.
pub(crate) fn environment_block(env: &[(OsString, OsString)]) -> Vec<u16> {
    let mut sorted: Vec<&(OsString, OsString)> = env.iter().collect();
    sorted.sort_by_key(|(k, _)| k.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (key, value) in sorted {
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    block
}

/// One command-line argument, quoted by the MSVCRT rules.
pub(crate) fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.to_owned();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// The executable a bare program name means, looked up in the child's own `PATH` (its environment
/// is replaced, so the lookup is by that one and not this process's). `None` leaves the lookup to
/// `CreateProcessW`.
fn find_application(program: &str, env: Option<&[(OsString, OsString)]>) -> Option<Vec<u16>> {
    if program.contains(['\\', '/', ':']) {
        return None;
    }
    let path = match env {
        Some(env) => env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v.clone()),
        None => std::env::var_os("PATH"),
    }?;
    let file = match Path::new(program).extension() {
        None => format!("{program}.exe"),
        Some(extension) if extension.eq_ignore_ascii_case("exe") => program.to_owned(),
        Some(_) => return None,
    };
    std::env::split_paths(&path)
        .map(|dir| dir.join(&file))
        .find(|candidate| candidate.is_file())
        .map(wide)
}

/// A handle the child may inherit, closed on drop.
struct Inheritable(HANDLE);

impl Inheritable {
    fn of(source: BorrowedHandle<'_>) -> io::Result<Self> {
        let mut duplicate: HANDLE = std::ptr::null_mut();
        let process = unsafe { GetCurrentProcess() };
        let ok = unsafe {
            DuplicateHandle(
                process,
                source.as_raw_handle().cast(),
                process,
                &mut duplicate,
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(duplicate))
    }
}

impl Drop for Inheritable {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// The attribute list, deleted on drop. `storage` is the list itself.
struct AttributeList {
    storage: Vec<usize>,
}

impl AttributeList {
    fn new(count: u32) -> io::Result<Self> {
        let mut size = 0usize;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), count, 0, &mut size) };
        let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        if unsafe { InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), count, 0, &mut size) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { storage })
    }

    fn raw(&mut self) -> *mut std::ffi::c_void {
        self.storage.as_mut_ptr().cast()
    }

    /// `value` must stay where it is until the process is created.
    fn set(&mut self, attribute: u32, value: *const std::ffi::c_void, size: usize) -> io::Result<()> {
        let ok = unsafe {
            UpdateProcThreadAttribute(self.raw(), 0, attribute as usize, value, size, std::ptr::null_mut(), std::ptr::null())
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.raw()) };
    }
}

/// Starts `spec` inside `job`.
pub(crate) fn spawn(job: HANDLE, spec: &Spawn<'_>) -> io::Result<WinProcess> {
    let null_device;
    let (flags, inherit, duplicates) = match &spec.stdio {
        Stdio::Handles { stdin, stdout, stderr } => {
            let needs_null = stdin.is_none() || stdout.is_none() || stderr.is_none();
            null_device = if needs_null {
                Some(File::options().read(true).write(true).open("NUL")?)
            } else {
                None
            };
            let one = |handle: &Option<BorrowedHandle<'_>>| match (handle, &null_device) {
                (Some(handle), _) => Inheritable::of(*handle),
                (None, Some(null)) => Inheritable::of(borrow(null)),
                (None, None) => unreachable!("a missing stream opens the null device"),
            };
            (
                CREATE_NO_WINDOW,
                1,
                Some([one(stdin)?, one(stdout)?, one(stderr)?]),
            )
        }
        Stdio::Console(_) => (0, 0, None),
    };

    let mut list = AttributeList::new(2)?;
    let job_list = [job];
    list.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, job_list.as_ptr().cast(), std::mem::size_of::<HANDLE>())?;
    let handle_list = duplicates.as_ref().map(|d| [d[0].0, d[1].0, d[2].0]);
    match (&spec.stdio, &handle_list) {
        (Stdio::Handles { .. }, Some(handles)) => {
            list.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles.as_ptr().cast(), std::mem::size_of_val(handles))?;
        }
        (Stdio::Console(console), _) => {
            list.set(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, (*console as *const std::ffi::c_void).cast(), std::mem::size_of::<isize>())?;
        }
        (Stdio::Handles { .. }, None) => unreachable!("handles carry a handle list"),
    }

    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = list.raw();
    // Without STARTF_USESTDHANDLES a child whose parent has redirected standard handles (a
    // service, a test harness) would write to them instead of its console. Null handles with a
    // pseudo-console: the child then opens the pseudo-console's own.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    if let Some(d) = &duplicates {
        startup.StartupInfo.hStdInput = d[0].0;
        startup.StartupInfo.hStdOutput = d[1].0;
        startup.StartupInfo.hStdError = d[2].0;
    }

    let application = find_application(spec.program, spec.env);
    let mut command_line = wide(spec.command_line);
    let environment = spec.env.map(environment_block);
    let directory = spec.cwd.map(wide);
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            application.as_ref().map_or(std::ptr::null(), |a| a.as_ptr()),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            inherit,
            flags | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            environment.as_ref().map_or(std::ptr::null(), |e| e.as_ptr().cast()),
            directory.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
            &startup.StartupInfo,
            &mut info,
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    unsafe { CloseHandle(info.hThread) };
    Ok(WinProcess {
        pid: info.dwProcessId,
        handle: info.hProcess,
    })
}

fn borrow(file: &File) -> BorrowedHandle<'_> {
    use std::os::windows::io::AsHandle;
    file.as_handle()
}
