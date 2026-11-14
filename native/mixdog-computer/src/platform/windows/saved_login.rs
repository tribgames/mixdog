//! The reads behind a saved-login fill: the browser's signer, process and
//! address bar, and its one ValuePattern write (runtime-saved-login.ps1,
//! MixWin32Process.cs:164-310). What the reads mean is the host's to decide.

use super::native::{self, hwnd, Process};
use super::uia::element::{native_handle, runtime_key};
use crate::platform::{
    saved_login_changed, saved_login_refused, SavedLoginField, SavedLoginFocus, SavedLoginImage,
    SavedLoginReads, Wid, SAVED_LOGIN_NO_FOCUS,
};
use std::ffi::c_void;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::time::Duration;
use windows::core::{BSTR, PCWSTR};
use windows::Win32::Foundation::{FILETIME, HANDLE, HWND};
use windows::Win32::Security::Cryptography::{
    CertCloseStore, CertFindCertificateInStore, CertFreeCertificateContext, CertGetNameStringW,
    CryptMsgClose, CryptMsgGetParam, CryptQueryObject, CERT_FIND_SUBJECT_CERT, CERT_INFO,
    CERT_NAME_ATTR_TYPE, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
    CERT_QUERY_ENCODING_TYPE, CERT_QUERY_FORMAT_FLAG_BINARY, CERT_QUERY_OBJECT_FILE,
    CMSG_SIGNER_INFO, CMSG_SIGNER_INFO_PARAM, HCERTSTORE, PKCS_7_ASN_ENCODING,
    X509_ASN_ENCODING, szOID_ORGANIZATION_NAME,
};
use windows::Win32::Security::WinTrust::{
    WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
    WINTRUST_DATA_PROVIDER_FLAGS, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL,
    WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
    WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};
use windows::Win32::Storage::FileSystem::FILE_SHARE_READ;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::*;

/// The window class Chromium hosts web content in; page elements never have one.
const CONTENT_CLASS: &str = "Chrome_RenderWidgetHostHWND";
/// The toolbar's address edit, as Chromium exposes it through UIA.
const OMNIBOX_CLASS: &str = "OmniboxViewViews";
/// GetExitCodeProcess of a process that is still running.
const STILL_ACTIVE: u32 = 259;
/// The ancestors one walk may climb: the raw tree is finite, this only keeps
/// a provider that loops from hanging the host.
const MAX_ANCESTORS: usize = 4096;
/// The readback after the write: Chromium publishes the new value to UIA
/// after SetValue returns (Read-ValueUntil, input-semantic.ps1:488).
const READBACK_ATTEMPTS: u32 = 8;
const READBACK_SETTLE: Duration = Duration::from_millis(25);

pub struct Reads;

fn unreadable() -> String {
    saved_login_refused("the browser window could not be read through accessibility")
}

/// A UIA read that fails refuses (Invoke-SavedLoginRead).
fn read<T>(result: windows::core::Result<T>) -> Result<T, String> {
    result.map_err(|_| unreadable())
}

/// A tree-walker step: the next element, None at the end of a level (a null
/// element, which windows-rs reports as an error coded S_OK or E_POINTER),
/// and a refusal for any other failure, so a provider error never skips a
/// subtree that may hold another address bar (Get-SavedLoginAddressBars).
fn step<T>(result: windows::core::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(next) => Ok(Some(next)),
        Err(error) if error.code() == windows::core::HRESULT(0) || error.code() == windows::Win32::Foundation::E_POINTER => Ok(None),
        Err(_) => Err(unreadable()),
    }
}

fn automation() -> Result<IUIAutomation, String> {
    // SAFETY: COM is initialised on the request thread by the desktop.
    read(unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) })
}

fn class_of(element: &IUIAutomationElement) -> Result<String, String> {
    // SAFETY: a plain property read.
    read(unsafe { element.CurrentClassName() }).map(|name| name.to_string())
}

fn control_of(element: &IUIAutomationElement) -> Result<UIA_CONTROLTYPE_ID, String> {
    // SAFETY: a plain property read.
    read(unsafe { element.CurrentControlType() })
}

fn value_pattern(element: &IUIAutomationElement) -> Option<IUIAutomationValuePattern> {
    // SAFETY: a plain pattern query on a live element.
    unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }.ok()
}

/// The element's ValuePattern text; None when it has none or it cannot be read.
fn value_of(element: &IUIAutomationElement) -> Option<BSTR> {
    // SAFETY: a plain property read.
    value_pattern(element).and_then(|pattern| unsafe { pattern.CurrentValue() }.ok())
}

fn focused_of(automation: &IUIAutomation, pid: u32) -> Option<IUIAutomationElement> {
    // SAFETY: plain reads; no focused element is None.
    let focused = unsafe { automation.GetFocusedElement() }.ok()?;
    (unsafe { focused.CurrentProcessId() }.ok()? as u32 == pid).then_some(focused)
}

/// The page document holding `element`, walking up the window's own
/// accessibility tree: the nearest document must be the web content root,
/// hosted directly by the browser's render widget window, and the walk must
/// end at this browser window. A field in an embedded frame or a nested
/// document, or in the browser's own UI such as the address bar, is refused
/// (Get-SavedLoginDocument).
fn document_of(
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    window: Wid,
    pid: u32,
) -> Result<IUIAutomationElement, String> {
    let mut document: Option<IUIAutomationElement> = None;
    let mut current = element.clone();
    for _ in 0..MAX_ANCESTORS {
        // SAFETY: plain tree-walker reads; the root has no parent.
        let Ok(parent) = (unsafe { walker.GetParentElement(&current) }) else {
            break;
        };
        current = parent;
        if native_handle(&current) == window {
            match document {
                Some(document) => return Ok(document),
                None => break,
            }
        }
        if document.is_some() || control_of(&current)? != UIA_DocumentControlTypeId {
            continue;
        }
        // SAFETY: as above.
        let container = unsafe { walker.GetParentElement(&current) }.ok();
        let handle = container.as_ref().map_or(0, native_handle);
        let hosted = handle != 0
            && native::is_window(handle)
            && native::class_name(handle) == CONTENT_CLASS
            && native::pid_of(handle) == pid;
        let Some(container) = container.filter(|_| hosted) else {
            return Err(saved_login_refused(
                "the focused field is inside an embedded frame or nested document, not the page itself",
            ));
        };
        document = Some(current);
        current = container;
    }
    Err(saved_login_refused("focus is not on a web page of this browser window"))
}

/// The facts the field rule judges, read from the focused element
/// (Get-SavedLoginFieldFacts).
fn field_of(element: &IUIAutomationElement) -> Result<SavedLoginField, String> {
    let pattern = value_pattern(element);
    // SAFETY: plain property reads.
    unsafe {
        Ok(SavedLoginField {
            edit: control_of(element)? == UIA_EditControlTypeId,
            focused: read(element.CurrentHasKeyboardFocus())?.as_bool(),
            enabled: read(element.CurrentIsEnabled())?.as_bool()
                && read(element.CurrentIsKeyboardFocusable())?.as_bool(),
            read_only: pattern
                .as_ref()
                .and_then(|pattern| pattern.CurrentIsReadOnly().ok())
                .is_none_or(|flag| flag.as_bool()),
            password: read(element.CurrentIsPassword())?.as_bool(),
            value_length: pattern
                .and_then(|pattern| pattern.CurrentValue().ok())
                .map_or(-1, |value| value.len() as i64),
        })
    }
}

fn id_of(element: &IUIAutomationElement) -> Result<String, String> {
    match runtime_key(element) {
        id if id.is_empty() => Err(unreadable()),
        id => Ok(id),
    }
}

fn filetime(time: FILETIME) -> i64 {
    ((time.dwHighDateTime as i64) << 32) | time.dwLowDateTime as i64
}

/// The creation time (FILETIME) of an open process; 0 when it cannot be read.
fn created(process: HANDLE) -> i64 {
    let mut time = FILETIME::default();
    let (mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: every pointer is a valid out FILETIME.
    unsafe { GetProcessTimes(process, &mut time, &mut exited, &mut kernel, &mut user) }
        .map_or(0, |_| filetime(time))
}

fn running(process: HANDLE) -> bool {
    let mut code = 0u32;
    // SAFETY: code is a valid out pointer.
    unsafe { GetExitCodeProcess(process, &mut code) }.is_ok() && code == STILL_ACTIVE
}

/// WinVerifyTrust over the open file's embedded Authenticode signature: the
/// hash must match and the signer chain to a trusted root, with no revocation
/// pass and no network retrieval (cache only), so the check never waits on the
/// network; a chain that cannot be built offline fails.
fn authenticode_valid(path: &[u16], file: HANDLE) -> bool {
    let mut info = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(path.as_ptr()),
        hFile: file,
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut info },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WINTRUST_DATA_PROVIDER_FLAGS(
            WTD_REVOCATION_CHECK_NONE.0 | WTD_CACHE_ONLY_URL_RETRIEVAL.0,
        ),
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: data and info outlive both calls; the state is closed whatever
    // the outcome.
    unsafe {
        let result = WinVerifyTrust(HWND::default(), &mut action, &mut data as *mut WINTRUST_DATA as *mut c_void);
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(HWND::default(), &mut action, &mut data as *mut WINTRUST_DATA as *mut c_void);
        result == 0
    }
}

/// The signer certificate's organisation (O=) of the file's embedded
/// signature; None when it has none.
fn signer_organization(path: &[u16]) -> Option<String> {
    let mut store = HCERTSTORE(std::ptr::null_mut());
    let mut message: *mut c_void = std::ptr::null_mut();
    // SAFETY: path is NUL-terminated; the out pointers are valid. The store
    // and message are closed below on every path that opened them.
    unsafe {
        CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            path.as_ptr() as *const c_void,
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            None,
            None,
            None,
            Some(&mut store),
            Some(&mut message),
            None,
        )
        .ok()?;
        let organization = signer_name(store, message);
        let _ = CryptMsgClose(Some(message));
        let _ = CertCloseStore(Some(store), 0);
        organization
    }
}

/// # Safety
/// `store` and `message` come from one successful CryptQueryObject.
unsafe fn signer_name(store: HCERTSTORE, message: *mut c_void) -> Option<String> {
    let mut size = 0u32;
    CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, None, &mut size).ok()?;
    // The signer info holds pointers into its own buffer: keep it aligned.
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    CryptMsgGetParam(
        message,
        CMSG_SIGNER_INFO_PARAM,
        0,
        Some(buffer.as_mut_ptr() as *mut c_void),
        &mut size,
    )
    .ok()?;
    let signer = &*(buffer.as_ptr() as *const CMSG_SIGNER_INFO);
    let find = CERT_INFO {
        Issuer: signer.Issuer,
        SerialNumber: signer.SerialNumber,
        ..Default::default()
    };
    let certificate = CertFindCertificateInStore(
        store,
        CERT_QUERY_ENCODING_TYPE(X509_ASN_ENCODING.0 | PKCS_7_ASN_ENCODING.0),
        0,
        CERT_FIND_SUBJECT_CERT,
        Some(&find as *const CERT_INFO as *const c_void),
        None,
    );
    if certificate.is_null() {
        return None;
    }
    let mut name = [0u16; 256];
    let length = CertGetNameStringW(
        certificate,
        CERT_NAME_ATTR_TYPE,
        0,
        Some(szOID_ORGANIZATION_NAME.as_ptr() as *const c_void),
        Some(&mut name),
    ) as usize;
    let _ = CertFreeCertificateContext(Some(certificate));
    // The count includes the terminating NUL.
    (length > 1).then(|| String::from_utf16_lossy(&name[..length - 1]))
}

/// The process image of live process `pid`, verified afresh and bound to that
/// process: the handle stays open throughout (its id cannot be reused
/// meanwhile), the path is the kernel's for that handle, the file is held open
/// with writes denied while WinVerifyTrust checks it through that handle, and
/// the process must still be running afterwards (VerifiedProcessImage).
fn image_of(pid: u32) -> Option<SavedLoginImage> {
    let process = Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION.0)?;
    let start_time = created(process.0);
    if start_time == 0 {
        return None;
    }
    let mut buffer = [0u16; 1024];
    let mut size = buffer.len() as u32;
    // SAFETY: buffer and size describe the same allocation.
    unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
    }
    .ok()?;
    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0)
        .open(&path)
        .ok()?;
    if !authenticode_valid(&wide, HANDLE(file.as_raw_handle())) {
        return None;
    }
    let signer = signer_organization(&wide)?;
    running(process.0).then_some(SavedLoginImage { path, signer, start_time })
}

impl SavedLoginReads for Reads {
    fn top_level(&self, window: Wid) -> bool {
        native::root_of(window) == window
    }

    fn verified_image(&self, pid: u32) -> Option<SavedLoginImage> {
        image_of(pid)
    }

    /// The creation time of the live process, or 0: the same id with another
    /// creation time is another process (ProcessStartTime).
    fn start_time(&self, pid: u32) -> i64 {
        Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION.0)
            .filter(|process| running(process.0))
            .map_or(0, |process| created(process.0))
    }

    fn focus(&self, window: Wid, pid: u32) -> Result<SavedLoginFocus, String> {
        let automation = automation()?;
        let Some(focused) = focused_of(&automation, pid) else {
            return Err(saved_login_refused(SAVED_LOGIN_NO_FOCUS));
        };
        // SAFETY: plain factory call.
        let walker = read(unsafe { automation.RawViewWalker() })?;
        let document = document_of(&walker, &focused, window, pid)?;
        Ok(SavedLoginFocus {
            runtime_id: id_of(&focused)?,
            document_id: id_of(&document)?,
            document_url: value_of(&document).map(|url| url.to_string()).unwrap_or_default(),
            field: field_of(&focused)?,
        })
    }

    /// The window's address bars, in the browser's own UI only: web content
    /// can give its elements any class name, so a match under a document or
    /// the render widget window is never an address bar. The whole window is
    /// walked; no node budget (Get-SavedLoginAddressBars).
    fn address_bars(&self, window: Wid) -> Result<Vec<String>, String> {
        let automation = automation()?;
        // SAFETY: plain factory and lookup calls.
        let walker = read(unsafe { automation.RawViewWalker() })?;
        let root = read(unsafe { automation.ElementFromHandle(hwnd(window)) })?;
        let mut bars = Vec::new();
        let mut pending = vec![root];
        while let Some(parent) = pending.pop() {
            // SAFETY: plain tree-walker reads; the end of a level is a null element.
            let mut child = step(unsafe { walker.GetFirstChildElement(&parent) })?;
            while let Some(node) = child {
                let control = control_of(&node)?;
                let class = class_of(&node)?;
                let content = control == UIA_DocumentControlTypeId
                    || (native_handle(&node) != 0 && class == CONTENT_CLASS);
                if !content {
                    if control == UIA_EditControlTypeId && class == OMNIBOX_CLASS {
                        bars.push(value_of(&node).map(|text| text.to_string()).unwrap_or_default());
                    } else {
                        pending.push(node.clone());
                    }
                }
                child = step(unsafe { walker.GetNextSiblingElement(&node) })?;
            }
        }
        Ok(bars)
    }

    /// Exactly one SetValue, never a keystroke (Do-SavedLoginType). A SetValue
    /// that fails, or a length the field does not confirm, is not retried.
    fn set_value(
        &self,
        pid: u32,
        runtime_id: &str,
        value: &str,
        authorize: &dyn Fn() -> Result<(), String>,
    ) -> Result<bool, String> {
        let automation = automation()?;
        let focused = focused_of(&automation, pid)
            .filter(|focused| runtime_key(focused) == runtime_id)
            .ok_or_else(|| saved_login_changed("focus moved to another element"))?;
        let Some(pattern) = value_pattern(&focused) else {
            return Err(saved_login_refused(
                "the field takes no direct value write, and saved logins are never typed as keystrokes",
            ));
        };
        // SAFETY: a plain property read.
        if read(unsafe { pattern.CurrentIsReadOnly() })?.as_bool() {
            return Err(saved_login_refused("the field is read-only to direct value writes"));
        }
        authorize()?;
        let text = BSTR::from(value);
        // SAFETY: the pattern is live; from here on a write may have happened.
        let wrote = unsafe { pattern.SetValue(&text) }.is_ok();
        let length = value.encode_utf16().count();
        for attempt in 0..READBACK_ATTEMPTS {
            if !wrote {
                break;
            }
            // Length only: a password field reads back masked.
            if unsafe { pattern.CurrentValue() }.is_ok_and(|actual| actual.len() == length) {
                return Ok(true);
            }
            if attempt + 1 < READBACK_ATTEMPTS {
                std::thread::sleep(READBACK_SETTLE);
            }
        }
        Ok(false)
    }
}
