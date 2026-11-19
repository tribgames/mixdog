//! `pdf.render` (`pdfRender` of `src/ext-host/methods.mjs`): a PDF's pages as PNG images, over a file inside the approved paths.
//!
//! The rasteriser runs on the lanes of a process that boots them on the first call (a worker has no daemon to hand it tokens) and
//! draws page numbers and sheet labels with the system fonts, scanned once. Nothing is written beside the PDF: each image's
//! bytes travel as chunks in `images` order, and its entry carries `{bytes: n}` in place of `data`. This module also holds the
//! lanes, the font registry and the error mapping `pdf.ocr` shares.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use mixdog_fonts::discovery::{HostEnv, scan};
use mixdog_fonts::registry::Registry as FontRegistry;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_office_pdf::{AnalysisError, RenderPagesOptions, render_pdf_pages};
use mixdog_rt::{CancellationToken, LaneToken, LaneTokens};
use mixdog_rt::exec::{Executors, RtConfig, boot};
use serde_json::Value;

use super::js_string;
use crate::ctx::CallCtx;
use crate::error::CodedError;
use crate::registry::{HandlerResult, Outcome, Registry};

/// The messages the engines answer a cancelled call with.
const CANCELLED_MESSAGES: [&str; 2] = ["PDF rendering was cancelled", "PDF OCR was cancelled"];

/// The executors and the tokens of this process: started by the first call that needs a lane and kept until the process ends.
struct Lanes {
    tokens: LaneTokens,
    _executors: Arc<Executors>,
}

static LANES: OnceLock<Result<Lanes, String>> = OnceLock::new();
static FONTS: tokio::sync::OnceCell<Arc<FontRegistry>> = tokio::sync::OnceCell::const_new();

/// The lane tokens of this process, starting its executors the first time.
pub(super) fn lanes() -> Result<LaneTokens, CodedError> {
    let started = LANES.get_or_init(|| {
        boot(RtConfig::detect()).map(|(executors, tokens)| Lanes { tokens, _executors: executors }).map_err(|error| error.to_string())
    });
    match started {
        Ok(lanes) => Ok(lanes.tokens),
        Err(reason) => Err(CodedError::failed(reason.clone())),
    }
}

/// What a failed render or recognition answers: the cancel when the call was cancelled, else code `failed` with the message.
pub(super) fn failure(ctx: &CallCtx, error: &AnalysisError) -> CodedError {
    if ctx.cancel.is_cancelled() || CANCELLED_MESSAGES.contains(&error.message.as_str()) {
        CodedError::cancelled()
    } else {
        CodedError::failed(error.message.clone())
    }
}

/// `value ?? default` then `Number(...)`: a missing or null parameter is the default.
fn number_or(value: Option<&Value>, default: f64) -> f64 {
    match value {
        None | Some(Value::Null) => default,
        Some(value) => mixdog_js::to_number(value),
    }
}

/// `pages = null`: the page numbers of an array (each as `Number(page)`); anything else names none.
fn pages(value: Option<&Value>) -> Option<Vec<f64>> {
    match value {
        Some(Value::Array(items)) => Some(items.iter().map(mixdog_js::to_number).collect()),
        _ => None,
    }
}

fn render_options(params: &Value, cancel: &CancellationToken) -> RenderPagesOptions {
    let defaults = RenderPagesOptions::default();
    RenderPagesOptions {
        pages: pages(params.get("pages")),
        max_width: number_or(params.get("maxWidth"), defaults.max_width),
        maximum_scale: number_or(params.get("maximumScale"), defaults.maximum_scale),
        cancel: Some(cancel.clone()),
        write_images: false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_missing_or_null_option_is_its_default() {
        let cancel = CancellationToken::new();
        let options = render_options(&json!({"maxWidth": null}), &cancel);
        assert_eq!((options.max_width, options.maximum_scale, options.write_images), (1400.0, 2.0, false));
        assert!(options.pages.is_none());
        let options = render_options(&json!({"pages": [3, "1", 3], "maxWidth": 200, "maximumScale": 3}), &cancel);
        assert_eq!((options.max_width, options.maximum_scale), (200.0, 3.0));
        assert_eq!(options.pages, Some(vec![3.0, 1.0, 3.0]));
    }

    #[test]
    fn pages_that_are_no_array_name_none() {
        assert_eq!(pages(Some(&json!(2))), None);
        assert_eq!(pages(None), None);
        assert_eq!(pages(Some(&json!([]))), Some(Vec::new()));
    }


    #[tokio::test]
    async fn concurrent_callers_share_one_font_scan() {
        let lanes = lanes().expect("lanes");
        let cancel = CancellationToken::new();
        let (a, b) = tokio::join!(fonts(lanes, &cancel), fonts(lanes, &cancel));
        assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
    }
}


pub(super) fn register(registry: &mut Registry) {
    registry.register("pdf.render", render);
}
/// The system fonts the repainted page numbers and the sheet labels are set with, scanned once (on the interactive I/O lane) and
/// shared.
pub(super) async fn fonts(lanes: LaneTokens, cancel: &CancellationToken) -> Result<Arc<FontRegistry>, CodedError> {
    // One scan at a time: callers arriving while it runs wait for it, so no second registry is ever built.
    FONTS
        .get_or_try_init(|| async {
            let lost = |error: String| if cancel.is_cancelled() { CodedError::cancelled() } else { CodedError::failed(format!("the font scan failed: {error}")) };
            let home = std::env::home_dir().unwrap_or_default();
            let env = HostEnv::current(&|name| std::env::var(name).ok(), &home);
            let job = lanes
                .interactive_io
                .submit_wait(cancel, move |lane| Arc::new(scan(lane, &env).registry))
                .await
                .map_err(|error| lost(error.to_string()))?;
            job.await.map_err(|error| lost(error.to_string()))
        })
        .await
        .map(Arc::clone)
}
async fn render(ctx: CallCtx) -> HandlerResult {
    let file: PathBuf = ctx.approved_path(&js_string(ctx.params.get("path")), "")?;
    let lanes = lanes()?;
    let registry = fonts(lanes, &ctx.cancel).await?;
    let options = render_options(&ctx.params, &ctx.cancel);
    let rendered = render_pdf_pages(lanes, registry, Arc::new(NoWriteNote), &file, options).await.map_err(|error| failure(&ctx, &error))?;
    let value = rendered.streamed_json();
    for image in rendered.images {
        ctx.emit(image.png()).await?;
    }
    Ok(Outcome::value(value))
}
