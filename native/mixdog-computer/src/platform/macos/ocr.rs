//! Text recognition with the Vision framework. Boxes come back normalized
//! with a bottom-left origin and are converted to pixels of the sent image.

use super::ffi::CGRect;
use objc2::encode::{Encode, Encoding};
use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{class, msg_send, sel};
use objc2_foundation::NSString;
use serde_json::{json, Value};
use std::ffi::c_void;

#[link(name = "Vision", kind = "framework")]
extern "C" {}

#[repr(C)]
#[derive(Clone, Copy)]
struct Range {
    location: usize,
    length: usize,
}

// SAFETY: matches NSRange's layout and Objective-C encoding.
unsafe impl Encode for Range {
    const ENCODING: Encoding = Encoding::Struct("_NSRange", &[usize::ENCODING, usize::ENCODING]);
}

fn nsstring(object: *mut AnyObject) -> String {
    if object.is_null() {
        return String::new();
    }
    // SAFETY: the caller passes an NSString.
    unsafe { (*(object as *const NSString)).to_string() }
}

fn responds(object: *mut AnyObject, selector: Sel) -> bool {
    // SAFETY: respondsToSelector: is defined on every NSObject.
    unsafe { msg_send![object, respondsToSelector: selector] }
}

fn to_pixels(rect: CGRect, width: f64, height: f64) -> (f64, f64, f64, f64) {
    let x = rect.origin.x * width;
    let w = rect.size.width * width;
    let h = rect.size.height * height;
    let y = (1.0 - rect.origin.y - rect.size.height) * height;
    (x, y, w, h)
}

/// UTF-16 ranges of the whitespace-separated words in `text`.
fn word_ranges(text: &str) -> Vec<(String, Range)> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    let mut current = String::new();
    let mut start = 0usize;
    for c in text.chars() {
        if c.is_whitespace() {
            if !current.is_empty() {
                out.push((std::mem::take(&mut current), Range { location: start, length: offset - start }));
            }
            offset += c.len_utf16();
            start = offset;
        } else {
            if current.is_empty() {
                start = offset;
            }
            current.push(c);
            offset += c.len_utf16();
        }
    }
    if !current.is_empty() {
        out.push((current, Range { location: start, length: offset - start }));
    }
    out
}

pub fn status(language: &str) -> Value {
    let Some(class) = AnyClass::get(c"VNRecognizeTextRequest") else {
        return json!({ "text": "macOS OCR readiness", "available": false, "requested_language": null, "active_language": null, "installed_languages": [] });
    };
    let mut installed = Vec::new();
    autoreleasepool(|_| {
        // SAFETY: allocating and querying a Vision request.
        unsafe {
            let request: *mut AnyObject = msg_send![class, alloc];
            let request: *mut AnyObject = msg_send![request, init];
            if responds(request, sel!(supportedRecognitionLanguagesAndReturnError:)) {
                let mut error: *mut AnyObject = std::ptr::null_mut();
                let list: *mut AnyObject = msg_send![request, supportedRecognitionLanguagesAndReturnError: &mut error];
                if !list.is_null() {
                    let count: usize = msg_send![list, count];
                    for index in 0..count {
                        installed.push(nsstring(msg_send![list, objectAtIndex: index]));
                    }
                }
            }
            let _: () = msg_send![request, release];
        }
    });
    let requested = (!language.is_empty()).then(|| language.to_string());
    let available = requested.as_ref().is_none_or(|wanted| {
        installed.is_empty() || installed.iter().any(|tag| tag.eq_ignore_ascii_case(wanted) || tag.to_lowercase().starts_with(&format!("{}-", wanted.to_lowercase())))
    });
    json!({
        "text": "macOS OCR readiness",
        "available": available,
        "requested_language": requested,
        "active_language": if available { requested.clone().or_else(|| Some("auto".into())) } else { None },
        "installed_languages": installed,
    })
}

pub fn recognize(image: &[u8], language: &str, max_words: usize) -> Result<Value, String> {
    let Some(request_class) = AnyClass::get(c"VNRecognizeTextRequest") else {
        return Err("ocr_unavailable: Vision text recognition needs macOS 10.15 or later".into());
    };
    autoreleasepool(|_| {
        // SAFETY: Vision and AppKit calls on objects created here; the +1
        // request and handler are released before returning.
        unsafe {
            let data: *mut AnyObject = msg_send![class!(NSData), dataWithBytes: image.as_ptr() as *const c_void, length: image.len()];
            let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: data];
            if rep.is_null() {
                return Err("ocr_image: the image could not be decoded".to_string());
            }
            let width: isize = msg_send![rep, pixelsWide];
            let height: isize = msg_send![rep, pixelsHigh];
            let (width, height) = (width.max(1) as f64, height.max(1) as f64);
            let request: *mut AnyObject = msg_send![request_class, alloc];
            let request: *mut AnyObject = msg_send![request, init];
            let _: () = msg_send![request, setRecognitionLevel: 0isize];
            let _: () = msg_send![request, setUsesLanguageCorrection: true];
            if language.is_empty() {
                if responds(request, sel!(setAutomaticallyDetectsLanguage:)) {
                    let _: () = msg_send![request, setAutomaticallyDetectsLanguage: true];
                }
            } else {
                let tag = NSString::from_str(language);
                let list: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: &*tag];
                let _: () = msg_send![request, setRecognitionLanguages: list];
            }
            let options: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            let handler: *mut AnyObject = msg_send![class!(VNImageRequestHandler), alloc];
            let handler: *mut AnyObject = msg_send![handler, initWithData: data, options: options];
            let requests: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: request];
            let mut error: *mut AnyObject = std::ptr::null_mut();
            let performed: bool = msg_send![handler, performRequests: requests, error: &mut error];
            let outcome = if !performed {
                let detail = if error.is_null() { String::new() } else { nsstring(msg_send![error, localizedDescription]) };
                Err(format!("ocr_failed: Vision could not read the image: {detail}"))
            } else {
                Ok(collect(request, width, height, language, max_words))
            };
            let _: () = msg_send![handler, release];
            let _: () = msg_send![request, release];
            outcome
        }
    })
}

/// # Safety
/// `request` must be a performed VNRecognizeTextRequest.
unsafe fn collect(request: *mut AnyObject, width: f64, height: f64, language: &str, max_words: usize) -> Value {
    let results: *mut AnyObject = msg_send![request, results];
    let count: usize = if results.is_null() { 0 } else { msg_send![results, count] };
    let mut lines = Vec::new();
    let mut words = Vec::new();
    let mut total_words = 0usize;
    for index in 0..count {
        let observation: *mut AnyObject = msg_send![results, objectAtIndex: index];
        let candidates: *mut AnyObject = msg_send![observation, topCandidates: 1usize];
        let candidate_count: usize = if candidates.is_null() { 0 } else { msg_send![candidates, count] };
        if candidate_count == 0 {
            continue;
        }
        let candidate: *mut AnyObject = msg_send![candidates, objectAtIndex: 0usize];
        let text = nsstring(msg_send![candidate, string]);
        let bounds: CGRect = msg_send![observation, boundingBox];
        let (x, y, w, h) = to_pixels(bounds, width, height);
        let line = lines.len();
        lines.push(json!({ "line": line, "text": text, "x": x.round() as i64, "y": y.round() as i64, "width": w.round() as i64, "height": h.round() as i64 }));
        for (word, range) in word_ranges(&text) {
            if words.len() < max_words {
                let mut error: *mut AnyObject = std::ptr::null_mut();
                let rectangle: *mut AnyObject = msg_send![candidate, boundingBoxForRange: range, error: &mut error];
                let (wx, wy, ww, wh) = if rectangle.is_null() {
                    (x, y, w, h)
                } else {
                    let rect: CGRect = msg_send![rectangle, boundingBox];
                    to_pixels(rect, width, height)
                };
                words.push(json!({
                    "text": word,
                    "line": line,
                    "x": wx.round() as i64,
                    "y": wy.round() as i64,
                    "width": ww.round() as i64,
                    "height": wh.round() as i64,
                    "center_x": (wx + ww / 2.0).round() as i64,
                    "center_y": (wy + wh / 2.0).round() as i64,
                }));
            }
            total_words += 1;
        }
    }
    json!({
        "text": format!("OCR: {} lines, {total_words} words", lines.len()),
        "language": if language.is_empty() { "auto" } else { language },
        "image_width": width as i64,
        "image_height": height as i64,
        "lines": lines,
        "truncated_words": total_words.saturating_sub(words.len()),
        "words": words,
        "total_words": total_words,
    })
}
