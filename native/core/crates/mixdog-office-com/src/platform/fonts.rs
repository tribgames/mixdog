//! `Installed-OfficeFonts`: the GDI+ installed font collection, as `System.Drawing.Text.InstalledFontCollection` reads it.
//!
//! GDI+ reports culture-localised family names (a Korean Windows says the Korean name of Malgun Gothic), while Office
//! documents usually store the invariant English name, so both spellings are registered: the name in the user's language
//! (`FontFamily.Name`) and the name in 1033 (`FontFamily.GetName(1033)`). Per-user fonts are part of the collection.
//! System.Drawing started GDI+ on its own; here it is started before and shut down after the `Gdip*` calls.

use std::ptr::null_mut;

use windows::Win32::Globalization::GetUserDefaultUILanguage;
use windows::Win32::Graphics::GdiPlus::GdipDeleteFontFamily;
use windows::Win32::Graphics::GdiPlus::GdipGetFamilyName;
use windows::Win32::Graphics::GdiPlus::GdipGetFontCollectionFamilyCount;
use windows::Win32::Graphics::GdiPlus::GdipGetFontCollectionFamilyList;
use windows::Win32::Graphics::GdiPlus::GdipNewInstalledFontCollection;
use windows::Win32::Graphics::GdiPlus::GdiplusShutdown;
use windows::Win32::Graphics::GdiPlus::GdiplusStartup;
use windows::Win32::Graphics::GdiPlus::GdiplusStartupInput;
use windows::Win32::Graphics::GdiPlus::GpFontCollection;
use windows::Win32::Graphics::GdiPlus::GpFontFamily;
use windows::Win32::Graphics::GdiPlus::Ok as GDIPLUS_OK;

use super::FontSet;

/// `GetName(1033)`: English (United States).
const ENGLISH_US: u16 = 1033;

/// A failure anywhere ends the listing with what was read so far, as the `try { } catch { }` of the script did.
pub(super) fn installed_office_fonts() -> FontSet {
    let mut fonts = FontSet::default();
    let input = GdiplusStartupInput { GdiplusVersion: 1, ..Default::default() };
    let mut token = 0usize;
    // SAFETY: `token` and `input` are valid for the call; no output structure is requested (the background thread stays on).
    if unsafe { GdiplusStartup(&mut token, &input, null_mut()) } != GDIPLUS_OK {
        return fonts;
    }
    read_families(&mut fonts);
    // SAFETY: the token comes from the successful startup above, and every family was deleted by `read_families`.
    unsafe { GdiplusShutdown(token) };
    fonts
}

fn read_families(fonts: &mut FontSet) {
    // SAFETY: GDI+ is started; every pointer passed is valid for its call, the list buffer has the length the count gave,
    // and each family handed out by the list is deleted exactly once.
    unsafe {
        let mut collection: *mut GpFontCollection = null_mut();
        if GdipNewInstalledFontCollection(&mut collection) != GDIPLUS_OK {
            return;
        }
        let mut count = 0i32;
        if GdipGetFontCollectionFamilyCount(collection, &mut count) != GDIPLUS_OK || count <= 0 {
            return;
        }
        let mut families: Vec<*mut GpFontFamily> = vec![null_mut(); count as usize];
        let mut found = 0i32;
        if GdipGetFontCollectionFamilyList(collection, &mut families, &mut found) != GDIPLUS_OK {
            return;
        }
        let user_language = GetUserDefaultUILanguage();
        for family in families.into_iter().take(found.max(0) as usize) {
            if let Some(name) = family_name(family, user_language) {
                fonts.insert(&name);
                if let Some(english) = family_name(family, ENGLISH_US) {
                    fonts.insert(&english);
                }
            }
            let _ = GdipDeleteFontFamily(family);
        }
    }
}

/// # Safety
/// `family` is a live GDI+ font family.
unsafe fn family_name(family: *const GpFontFamily, language: u16) -> Option<String> {
    let mut name = [0u16; 32];
    // SAFETY: the buffer is the 32 units (LF_FACESIZE) GDI+ writes at most.
    if unsafe { GdipGetFamilyName(family, &mut name, language) } != GDIPLUS_OK {
        return None;
    }
    let length = name.iter().position(|unit| *unit == 0).unwrap_or(name.len());
    Some(String::from_utf16_lossy(&name[..length]))
}
