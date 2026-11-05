//! The clipboard, launching applications, the Start catalogue, and Windows OCR.

use crate::platform::{AppEntry, Launched};
use serde_json::{json, Value};
use std::ffi::c_void;
use windows::core::{HSTRING, PCWSTR};
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform,
    ColorManagementMode, ExifOrientationMode, SoftwareBitmap,
};
use windows::Globalization::Language;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HGLOBAL};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Threading::GetProcessId;
use windows::Win32::UI::Shell::{
    ApplicationActivationManager, IApplicationActivationManager, IEnumShellItems, IShellItem,
    SHGetKnownFolderItem, ShellExecuteExW, AO_NOERRORUI, BHID_EnumItems, FOLDERID_AppsFolder,
    KF_FLAG_DEFAULT, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE;

const CF_UNICODETEXT: u32 = 13;

fn open_clipboard() -> Result<(), String> {
    for _ in 0..10 {
        // SAFETY: a plain open on the current task.
        if unsafe { OpenClipboard(None) }.is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Err("the clipboard is held by another application".into())
}

struct Clipboard;

impl Clipboard {
    fn open() -> Result<Clipboard, String> {
        open_clipboard().map(|_| Clipboard)
    }
}

impl Drop for Clipboard {
    fn drop(&mut self) {
        // SAFETY: closes the clipboard this value opened.
        let _ = unsafe { CloseClipboard() };
    }
}

pub fn clipboard_read() -> Result<String, String> {
    let _clipboard = Clipboard::open()?;
    // SAFETY: the clipboard is open; the global is locked only while it is read.
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() {
            return Ok(String::new());
        }
        let data = GetClipboardData(CF_UNICODETEXT).map_err(|error| error.to_string())?;
        let global = HGLOBAL(data.0);
        let pointer = GlobalLock(global) as *const u16;
        if pointer.is_null() {
            return Err("the clipboard text could not be read".into());
        }
        let mut length = 0;
        while *pointer.add(length) != 0 {
            length += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length));
        let _ = GlobalUnlock(global);
        Ok(text)
    }
}

pub fn clipboard_write(text: &str) -> Result<bool, String> {
    {
        let _clipboard = Clipboard::open()?;
        // SAFETY: the clipboard is open; ownership of the global passes to it on success.
        unsafe {
            EmptyClipboard().map_err(|error| error.to_string())?;
            if !text.is_empty() {
                let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
                let global = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2)
                    .map_err(|error| error.to_string())?;
                let pointer = GlobalLock(global) as *mut u16;
                if pointer.is_null() {
                    return Err("the clipboard text could not be staged".into());
                }
                std::ptr::copy_nonoverlapping(units.as_ptr(), pointer, units.len());
                let _ = GlobalUnlock(global);
                SetClipboardData(CF_UNICODETEXT, Some(HANDLE(global.0)))
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    let now = clipboard_read()?;
    Ok(now == text)
}

// --- launching ----------------------------------------------------------------------

fn launch_failure(target: &str, code: u32, message: &str, route: &str) -> String {
    let category = match code {
        2 | 3 => "target_not_found",
        5 => "access_denied",
        31 | 1155 => "no_file_association",
        1223 => "launch_cancelled",
        _ if route == "app_activation" => "app_activation_failed",
        _ => "shell_launch_failed",
    };
    let hint = if category == "target_not_found"
        && target
            .char_indices()
            .any(|(at, c)| c.is_whitespace() && target[at + c.len_utf8()..].starts_with(['-', '/']))
    {
        "; launch takes one executable, path, file, or URL and passes no command-line arguments"
    } else {
        ""
    };
    format!("launch failed [{category}/{code}] for '{target}': {message}{hint}")
}

/// A packaged app cannot start from its executable path: the system keeps a
/// stub there and hands the work to the activation broker. Activating the app
/// id returns the process that actually hosts it.
fn activate_app_id(app_id: &str) -> windows::core::Result<u32> {
    // SAFETY: COM is initialised on this thread by the desktop.
    unsafe {
        let manager: IApplicationActivationManager =
            CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_ALL)?;
        manager.ActivateApplication(&HSTRING::from(app_id), PCWSTR::null(), AO_NOERRORUI)
    }
}

/// The app is shown without being activated, so the person's foreground
/// window survives the launch. Returns the process id, or 0 when the shell
/// reports none.
fn shell_launch(target: &str) -> windows::core::Result<u32> {
    let file = HSTRING::from(target);
    let mut request = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI,
        lpFile: PCWSTR(file.as_ptr()),
        nShow: SW_SHOWNOACTIVATE.0,
        ..Default::default()
    };
    // SAFETY: the request points at `file`, which outlives the call.
    unsafe {
        ShellExecuteExW(&mut request)?;
        if request.hProcess.is_invalid() {
            return Ok(0);
        }
        let pid = GetProcessId(request.hProcess);
        let _ = CloseHandle(request.hProcess);
        Ok(pid)
    }
}

pub fn launch(target: &str, app: Option<&AppEntry>) -> Result<Launched, String> {
    let (route, app_id, launched) = match app {
        Some(entry) if entry.app_id.contains('!') => (
            "app_activation",
            entry.app_id.clone(),
            activate_app_id(&entry.app_id),
        ),
        Some(entry) => (
            "apps_folder",
            entry.app_id.clone(),
            shell_launch(&format!("shell:AppsFolder\\{}", entry.app_id)),
        ),
        None if target.contains('!') => (
            "app_activation",
            target.to_string(),
            activate_app_id(target),
        ),
        None => ("windows_shell", String::new(), shell_launch(target)),
    };
    let pid = launched.map_err(|error| {
        // An activation failure arrives as an HRESULT wrapping the Win32 code.
        let hresult = error.code().0 as u32;
        let code = if hresult & 0xFFFF_0000 == 0x8007_0000 { hresult & 0xFFFF } else { hresult };
        launch_failure(target, code, error.message().trim(), route)
    })?;
    Ok(Launched {
        route,
        pid: pid as i64,
        app_id,
        app_hint: if pid > 0 {
            super::native::process_name(pid)
        } else {
            String::new()
        },
    })
}

fn display_name(item: &IShellItem, kind: SIGDN) -> String {
    // SAFETY: the returned string is CoTaskMem-allocated and freed once read.
    unsafe {
        match item.GetDisplayName(kind) {
            Ok(name) => {
                let text = name.to_string().unwrap_or_default();
                CoTaskMemFree(Some(name.0 as *const c_void));
                text
            }
            Err(_) => String::new(),
        }
    }
}

/// The Start catalogue: the one list that pairs the name a person says with
/// the id the system can activate.
pub fn installed_apps() -> Result<Vec<AppEntry>, String> {
    // SAFETY: COM is initialised on this thread by the desktop.
    unsafe {
        let folder: IShellItem = SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)
            .map_err(|error| error.message())?;
        let items: IEnumShellItems = folder
            .BindToHandler(None, &BHID_EnumItems)
            .map_err(|error| error.message())?;
        let mut apps = Vec::new();
        loop {
            let mut batch = [None];
            let mut fetched = 0u32;
            items
                .Next(&mut batch, Some(&mut fetched))
                .map_err(|error| error.message())?;
            let Some(item) = batch[0].take() else { break };
            if fetched == 0 {
                break;
            }
            let name = display_name(&item, SIGDN_NORMALDISPLAY);
            let id = display_name(&item, SIGDN_PARENTRELATIVEPARSING);
            if !id.trim().is_empty() {
                apps.push(AppEntry { name, app_id: id });
            }
        }
        apps.sort_by_key(|app| app.name.to_lowercase());
        Ok(apps)
    }
}

// --- OCR ----------------------------------------------------------------------------

fn engine_for(language: &str) -> Result<Option<OcrEngine>, String> {
    let engine = if language.is_empty() {
        OcrEngine::TryCreateFromUserProfileLanguages()
    } else {
        let language = Language::CreateLanguage(&HSTRING::from(language))
            .map_err(|error| error.message())?;
        OcrEngine::TryCreateFromLanguage(&language)
    };
    Ok(engine.ok())
}

fn winrt(error: windows::core::Error) -> String {
    error.message()
}

fn decode(image: &[u8]) -> windows::core::Result<(BitmapDecoder, InMemoryRandomAccessStream)> {
    // Screenshots stay in volatile memory, including when the host is killed.
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(image)?;
    writer.StoreAsync()?.join()?;
    writer.DetachStream()?;
    stream.Seek(0)?;
    let decoder = BitmapDecoder::CreateAsync(&stream)?.join()?;
    Ok((decoder, stream))
}

pub fn ocr(image: &[u8], language: &str, max_words: usize) -> Result<Value, String> {
    let (decoder, _stream) = decode(image).map_err(winrt)?;
    let (width, height) = (
        decoder.PixelWidth().map_err(winrt)?,
        decoder.PixelHeight().map_err(winrt)?,
    );
    let maximum = OcrEngine::MaxImageDimension().map_err(winrt)?;
    let largest = width.max(height);
    // Window text a dozen pixels tall defeats the recognizer; doubling it
    // recovered those words while a triple did worse. The boxes are divided
    // back, so callers keep seeing pixels of the image they sent.
    let upscale: u32 = if largest <= 1600 && largest * 2 <= maximum { 2 } else { 1 };
    let bitmap: SoftwareBitmap = if largest > maximum || upscale > 1 {
        let scale = if upscale > 1 {
            upscale as f64
        } else {
            maximum as f64 / largest as f64
        };
        let transform = BitmapTransform::new().map_err(winrt)?;
        transform
            .SetInterpolationMode(BitmapInterpolationMode::Cubic)
            .map_err(winrt)?;
        transform
            .SetScaledWidth(((width as f64 * scale).floor() as u32).max(1))
            .map_err(winrt)?;
        transform
            .SetScaledHeight(((height as f64 * scale).floor() as u32).max(1))
            .map_err(winrt)?;
        decoder
            .GetSoftwareBitmapTransformedAsync(
                BitmapPixelFormat::Bgra8,
                BitmapAlphaMode::Ignore,
                &transform,
                ExifOrientationMode::IgnoreExifOrientation,
                ColorManagementMode::DoNotColorManage,
            )
            .map_err(winrt)?
            .join()
            .map_err(winrt)?
    } else {
        decoder
            .GetSoftwareBitmapAsync()
            .map_err(winrt)?
            .join()
            .map_err(winrt)?
    };
    let engine = engine_for(language)?
        .ok_or_else(|| format!("Windows OCR has no recognizer for language '{language}'"))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(winrt)?
        .join()
        .map_err(winrt)?;
    let scale = upscale as f64;
    let (mut words, mut lines, mut total) = (Vec::new(), Vec::new(), 0usize);
    for (index, line) in result.Lines().map_err(winrt)?.into_iter().enumerate() {
        let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
        let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        for word in line.Words().map_err(winrt)? {
            let bounds = word.BoundingRect().map_err(winrt)?;
            let (x, y) = (bounds.X as f64 / scale, bounds.Y as f64 / scale);
            let (w, h) = (bounds.Width as f64 / scale, bounds.Height as f64 / scale);
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x + w);
            max_y = max_y.max(y + h);
            if total < max_words {
                words.push(json!({
                    "text": word.Text().map_err(winrt)?.to_string(),
                    "line": index,
                    "x": x.round() as i64,
                    "y": y.round() as i64,
                    "width": w.round() as i64,
                    "height": h.round() as i64,
                    "center_x": (x + w / 2.0).round() as i64,
                    "center_y": (y + h / 2.0).round() as i64,
                }));
            }
            total += 1;
        }
        let known = min_x.is_finite();
        lines.push(json!({
            "line": index,
            "text": line.Text().map_err(winrt)?.to_string(),
            "x": if known { min_x.round() as i64 } else { 0 },
            "y": if known { min_y.round() as i64 } else { 0 },
            "width": if known { (max_x - min_x).round() as i64 } else { 0 },
            "height": if known { (max_y - min_y).round() as i64 } else { 0 },
        }));
    }
    let tag = engine
        .RecognizerLanguage()
        .and_then(|language| language.LanguageTag())
        .map(|tag| tag.to_string())
        .unwrap_or_default();
    Ok(json!({
        "text": format!("OCR: {} lines, {} words", lines.len(), total),
        "language": tag,
        "image_width": bitmap.PixelWidth().map_err(winrt)? / upscale as i32,
        "image_height": bitmap.PixelHeight().map_err(winrt)? / upscale as i32,
        "lines": lines,
        "words": words,
        "total_words": total,
        "truncated_words": total.saturating_sub(words.len()),
    }))
}

pub fn ocr_status(language: &str) -> Value {
    let installed: Vec<String> = OcrEngine::AvailableRecognizerLanguages()
        .map(|languages| {
            languages
                .into_iter()
                .filter_map(|language| language.LanguageTag().ok())
                .map(|tag| tag.to_string())
                .collect()
        })
        .unwrap_or_default();
    let engine = engine_for(language).ok().flatten();
    json!({
        "text": "Windows OCR readiness",
        "available": engine.is_some(),
        "requested_language": if language.is_empty() { Value::Null } else { json!(language) },
        "active_language": engine
            .as_ref()
            .and_then(|engine| engine.RecognizerLanguage().ok())
            .and_then(|language| language.LanguageTag().ok())
            .map(|tag| json!(tag.to_string()))
            .unwrap_or(Value::Null),
        "installed_languages": installed,
    })
}
