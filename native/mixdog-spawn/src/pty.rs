//! Pseudo-terminals (ConPTY on Windows, `openpty` elsewhere) and the root-process handle both
//! spawn paths share.

use std::ffi::OsString;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::process::Child;

use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::PtySize;

use crate::contain::Containment;
use crate::contain::exit_status;
use crate::launch::Launch;

/// The process a handle stands for: the root of its tree.
pub(crate) enum Root {
    Child(Child),
    #[cfg(windows)]
    Win(windows::WinProcess),
}

impl Root {
    pub(crate) fn pid(&self) -> u32 {
        match self {
            Root::Child(child) => child.id(),
            #[cfg(windows)]
            Root::Win(process) => process.pid,
        }
    }

    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        match self {
            Root::Child(child) => child.wait().map(exit_status),
            #[cfg(windows)]
            Root::Win(process) => process.wait(),
        }
    }
}

pub(crate) struct PtyParts {
    pub root: Root,
    pub pty: Pty,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
}

#[cfg(windows)]
pub(crate) use windows::Pty;
#[cfg(windows)]
pub(crate) use windows::spawn;

#[cfg(unix)]
pub(crate) use unix::Pty;
#[cfg(unix)]
pub(crate) use unix::spawn;

#[cfg(windows)]
mod windows {
    use std::fs::File;
    use std::os::windows::io::FromRawHandle;
    use std::os::windows::io::RawHandle;
    use std::sync::Mutex;
    use std::sync::MutexGuard;

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Console::COORD;
    use windows_sys::Win32::System::Console::ClosePseudoConsole;
    use windows_sys::Win32::System::Console::CreatePseudoConsole;
    use windows_sys::Win32::System::Console::HPCON;
    use windows_sys::Win32::System::Console::ResizePseudoConsole;
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
    use windows_sys::Win32::System::Threading::CREATE_UNICODE_ENVIRONMENT;
    use windows_sys::Win32::System::Threading::CreateProcessW;
    use windows_sys::Win32::System::Threading::DeleteProcThreadAttributeList;
    use windows_sys::Win32::System::Threading::EXTENDED_STARTUPINFO_PRESENT;
    use windows_sys::Win32::System::Threading::GetExitCodeProcess;
    use windows_sys::Win32::System::Threading::INFINITE;
    use windows_sys::Win32::System::Threading::InitializeProcThreadAttributeList;
    use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE;
    use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
    use windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
    use windows_sys::Win32::System::Threading::STARTUPINFOEXW;
    use windows_sys::Win32::System::Threading::TerminateProcess;
    use windows_sys::Win32::System::Threading::UpdateProcThreadAttribute;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    use super::*;

    /// A process started through `CreateProcessW`.
    pub(crate) struct WinProcess {
        pub(crate) pid: u32,
        handle: HANDLE,
    }

    unsafe impl Send for WinProcess {}

    impl WinProcess {
        /// Ends this process itself. For a process that is not (yet) in the job, which a job kill
        /// does not reach and closing this handle does not end.
        fn terminate(&self) {
            unsafe { TerminateProcess(self.handle, 137) };
        }

        pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
            unsafe {
                if WaitForSingleObject(self.handle, INFINITE) != WAIT_OBJECT_0 {
                    return Err(io::Error::last_os_error());
                }
                let mut code = 0u32;
                if GetExitCodeProcess(self.handle, &mut code) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(ExitStatus::Code(code as i32))
            }
        }
    }

    impl Drop for WinProcess {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    /// The pseudo-console. Closing it ends the output stream once the host has flushed.
    pub(crate) struct Pty {
        console: Mutex<Option<HPCON>>,
    }

    unsafe impl Send for Pty {}
    unsafe impl Sync for Pty {}

    impl Pty {
        fn console(&self) -> MutexGuard<'_, Option<HPCON>> {
            self.console.lock().unwrap_or_else(|e| e.into_inner())
        }

        pub(crate) fn resize(&self, size: PtySize) -> io::Result<()> {
            match *self.console() {
                Some(console) => {
                    let hr = unsafe { ResizePseudoConsole(console, coord(size)) };
                    if hr < 0 {
                        return Err(io::Error::from_raw_os_error(hr & 0xffff));
                    }
                    Ok(())
                }
                None => Ok(()),
            }
        }

        /// Called once the root has exited.
        pub(crate) fn close(&self) {
            // The handle leaves the mutex before the close: `ClosePseudoConsole` can wait for its
            // output to be read, and a `resize` must not wait behind it.
            let console = self.console().take();
            if let Some(console) = console {
                unsafe { ClosePseudoConsole(console) };
            }
        }
    }

    impl Drop for Pty {
        fn drop(&mut self) {
            self.close();
        }
    }

    fn coord(size: PtySize) -> COORD {
        COORD {
            X: size.cols as i16,
            Y: size.rows as i16,
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn environment_block(env: &[(OsString, OsString)]) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
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

    fn pipe() -> io::Result<(HANDLE, HANDLE)> {
        let (mut read, mut write): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
        // node-pty's pipes hold 128 KiB each way (`conpty.cc` `createDataServerPipe`); the default is one page.
        if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 128 * 1024) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((read, write))
    }

    pub(crate) fn spawn(
        launch: &Launch,
        cwd: &Path,
        env: &[(OsString, OsString)],
        size: PtySize,
        containment: &Containment,
    ) -> io::Result<PtyParts> {
        unsafe {
            let (in_read, in_write) = pipe()?;
            let (out_read, out_write) = match pipe() {
                Ok(pair) => pair,
                Err(error) => {
                    CloseHandle(in_read);
                    CloseHandle(in_write);
                    return Err(error);
                }
            };
            let mut console: HPCON = 0 as HPCON;
            let hr = CreatePseudoConsole(coord(size), in_read, out_write, 0, &mut console);
            // The console host holds its own duplicates of these two ends.
            CloseHandle(in_read);
            CloseHandle(out_write);
            if hr < 0 {
                CloseHandle(in_write);
                CloseHandle(out_read);
                return Err(io::Error::from_raw_os_error(hr & 0xffff));
            }
            let pty = Pty {
                console: Mutex::new(Some(console)),
            };
            let reader = File::from_raw_handle(out_read as RawHandle);
            let writer = File::from_raw_handle(in_write as RawHandle);

            let mut list_size = 0usize;
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut list_size);
            let mut list_buffer = vec![0u8; list_size];
            let list = list_buffer.as_mut_ptr().cast();
            if InitializeProcThreadAttributeList(list, 1, 0, &mut list_size) == 0 {
                return Err(io::Error::last_os_error());
            }
            if UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const std::ffi::c_void,
                std::mem::size_of::<HPCON>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            ) == 0
            {
                let error = io::Error::last_os_error();
                DeleteProcThreadAttributeList(list);
                return Err(error);
            }

            let mut startup: STARTUPINFOEXW = std::mem::zeroed();
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            startup.lpAttributeList = list;
            // Without this a child whose parent has redirected standard handles (a service, a
            // test harness) would write to them instead of the pseudo-console. Null handles, as
            // node-pty's `conpty.cc` passes: the child then opens the pseudo-console's own.
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = std::ptr::null_mut();
            startup.StartupInfo.hStdOutput = std::ptr::null_mut();
            startup.StartupInfo.hStdError = std::ptr::null_mut();
            let mut command_line = wide(&launch.command_line());
            let environment = environment_block(env);
            let directory = wide(&cwd.to_string_lossy());
            let mut info: PROCESS_INFORMATION = std::mem::zeroed();
            let created = CreateProcessW(
                std::ptr::null(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                environment.as_ptr().cast(),
                directory.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            );
            let create_error = (created == 0).then(io::Error::last_os_error);
            DeleteProcThreadAttributeList(list);
            if let Some(error) = create_error {
                return Err(error);
            }
            CloseHandle(info.hThread);
            let process = WinProcess {
                pid: info.dwProcessId,
                handle: info.hProcess,
            };
            if let Err(error) = containment.adopt_and_resume(process.handle) {
                // The job kill covers a process that was assigned and then failed to resume;
                // one whose assignment failed is outside the job and is suspended for good
                // unless it is ended here.
                containment.kill();
                process.terminate();
                return Err(error);
            }
            Ok(PtyParts {
                root: Root::Win(process),
                pty,
                reader: Box::new(reader),
                writer: Box::new(writer),
            })
        }
    }
}

#[cfg(unix)]
mod unix {
    use std::fs::File;
    use std::os::fd::AsRawFd;
    use std::os::fd::FromRawFd;
    use std::os::fd::OwnedFd;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    use super::*;

    /// The master side of a pseudo-terminal.
    pub(crate) struct Pty {
        master: OwnedFd,
    }

    impl Pty {
        pub(crate) fn resize(&self, size: PtySize) -> io::Result<()> {
            let ws = winsize(size);
            if unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &ws) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// The kernel ends the stream when the session leader exits.
        pub(crate) fn close(&self) {}
    }

    fn winsize(size: PtySize) -> libc::winsize {
        libc::winsize {
            ws_row: size.rows,
            ws_col: size.cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }

    pub(crate) fn spawn(
        launch: &Launch,
        cwd: &Path,
        env: &[(OsString, OsString)],
        size: PtySize,
        containment: &Containment,
    ) -> io::Result<PtyParts> {
        let (mut master, mut slave) = (-1, -1);
        let ws = winsize(size);
        if unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                &ws,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        let master = unsafe { OwnedFd::from_raw_fd(master) };
        let slave = unsafe { OwnedFd::from_raw_fd(slave) };
        unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
        let mut cmd = launch.command(cwd, env);
        cmd.stdin(Stdio::from(slave.try_clone()?));
        cmd.stdout(Stdio::from(slave.try_clone()?));
        cmd.stderr(Stdio::from(slave));
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = cmd.spawn()?;
        // The slave ends held by `cmd` close here, so the master sees the end of the session.
        drop(cmd);
        containment.adopt(child.id());
        let reader = File::from(master.try_clone()?);
        let writer = File::from(master.try_clone()?);
        Ok(PtyParts {
            root: Root::Child(child),
            pty: Pty { master },
            reader: Box::new(reader),
            writer: Box::new(writer),
        })
    }
}
