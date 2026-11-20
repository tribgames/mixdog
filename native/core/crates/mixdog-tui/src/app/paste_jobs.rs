//! Pastes that have to read something that blocks: the clipboard (a helper process answers), an image file named in the pasted
//! text, and the core's resize of an image. Node awaits these in `handlePromptPaste` and the editor shows nothing meanwhile
//! (the render goes on); here the read runs on a worker thread, the editor is told [`PasteReply::Pending`] and takes the answer
//! with the ticket it handed out ([`crate::editor::PromptEditor::finish_paste`], which drops it when the draft moved on).
//!
//! The worker only reads: what it found is held until the loop finishes the paste, which runs the same paste handler
//! ([`crate::handlers::paste::handle_prompt_paste`]) with the readers answering from what the worker read. Registering an image
//! in the paste buffers and the hints stay with the loop.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};

use mixdog_term::os::{Platform, SystemRunner};
use mixdog_term::paste::{
    ImageAttachment, ResizeRequest, ResizedImage, base64_encode, read_clipboard_image_attachment, read_clipboard_text, read_image_attachment_from_path,
    split_pasted_image_path_candidates,
};
use serde_json::{Value, json};

use super::AppState;
use super::store::StoreCaller;
use crate::editor::prompt::{PasteSource, PasteTicket};
use crate::handlers::paste::handle_prompt_paste;
use crate::panels::btw::BtwAsk;

/// The answer of a `/btw` side question a worker waited for.
type BtwAnswer = (BtwAsk, Result<Value, String>);

type ImageRead = Result<Option<ImageAttachment>, String>;

/// What a worker read, served to the paste handler's readers when the paste is finished.
#[derive(Default)]
pub(crate) struct PasteReads {
    text: Option<Result<String, String>>,
    image: Option<ImageRead>,
    paths: BTreeMap<String, ImageRead>,
}

impl PasteReads {
    pub(crate) fn take_text(&mut self) -> Option<Result<String, String>> {
        self.text.take()
    }

    pub(crate) fn take_image(&mut self) -> Option<ImageRead> {
        self.image.take()
    }

    pub(crate) fn take_path(&mut self, raw: &str) -> Option<ImageRead> {
        self.paths.remove(raw)
    }
}

/// What a paste needs read before it can be finished.
enum Need {
    /// Ctrl+V: the clipboard's text, else its image.
    Clipboard,
    /// A bracketed paste that names image files.
    Paths,
}

struct Inflight {
    id: u64,
    source: PasteSource,
    text: String,
    ticket: Option<PasteTicket>,
}

struct Done {
    id: u64,
    reads: PasteReads,
}

/// The pastes waiting for a read, and the channel the workers answer on.
pub(crate) struct PasteJobs {
    next_id: u64,
    inflight: Vec<Inflight>,
    /// The reads of the paste being finished.
    pub(crate) reads: PasteReads,
    tx: Sender<Done>,
    rx: Receiver<Done>,
    /// The `/btw` answers, on the same wake: a side question waits for the model on a worker, never on the loop.
    btw_tx: Sender<BtwAnswer>,
    btw_rx: Receiver<BtwAnswer>,
    /// Wakes the loop when a worker is done.
    wake: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Default for PasteJobs {
    fn default() -> Self {
        let (tx, rx) = mpsc::channel();
        let (btw_tx, btw_rx) = mpsc::channel();
        Self { next_id: 0, inflight: Vec::new(), reads: PasteReads::default(), tx, rx, btw_tx, btw_rx, wake: None }
    }
}

impl PasteJobs {
    pub(crate) fn set_wake(&mut self, wake: Arc<dyn Fn() + Send + Sync>) {
        self.wake = Some(wake);
    }

    pub(crate) fn pending(&self) -> bool {
        !self.inflight.is_empty()
    }

    /// Sends the side question of `ask` on a worker; its answer comes back through [`AppState::finish_btw_asks`].
    pub(crate) fn ask_btw(&self, call: StoreCaller, ask: BtwAsk) {
        let (tx, wake, sent) = (self.btw_tx.clone(), self.wake.clone(), ask.clone());
        let spawned = std::thread::Builder::new().name("mixdog-tui-btw".to_owned()).spawn(move || {
            let result = call("askSide", &[json!(sent.question)]);
            let _ = tx.send((sent, result));
            if let Some(wake) = wake {
                wake();
            }
        });
        if spawned.is_err() {
            let _ = self.btw_tx.send((ask, Err("side question could not start".to_owned())));
        }
    }
}

/// The resize of the core, called from whatever thread holds the caller.
fn resize_with(caller: &Option<StoreCaller>, request: &ResizeRequest<'_>) -> Result<ResizedImage, String> {
    let Some(call) = caller else { return Err("image resize is unavailable".to_owned()) };
    let input = json!({ "data": base64_encode(request.bytes), "mimeType": request.mime_type, "filename": request.label });
    let answer = call("resizeImage", &[input])?;
    let text = |key: &str| match answer.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    };
    Ok(ResizedImage {
        data: text("data"),
        media_type: text("mimeType"),
        metadata_text: answer.get("metadataText").and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned),
    })
}

/// The image paths of `text` the paste handler will ask for, read now.
fn read_paths(reads: &mut PasteReads, text: &str, platform: Platform, cwd: &str, provider: &str, caller: &Option<StoreCaller>) {
    let cwd_path = std::path::PathBuf::from(cwd);
    for chunk in split_pasted_image_path_candidates(text, platform).into_iter().filter(|chunk| chunk.image_path) {
        let resize = |request: &ResizeRequest<'_>| resize_with(caller, request);
        let read = read_image_attachment_from_path(&chunk.text, Some(&cwd_path), provider, platform, &resize);
        reads.paths.insert(chunk.text, read);
    }
}

impl AppState {
    /// Whether a paste still waits for its read.
    pub fn paste_pending(&self) -> bool {
        self.paste.pending()
    }

    /// Wakes the loop when a paste read is done.
    pub fn set_wake(&mut self, wake: Arc<dyn Fn() + Send + Sync>) {
        self.paste.set_wake(wake);
    }

    /// Whether the paste (`text` from `source`) has to read something that blocks; if so a worker reads it and the editor is
    /// told the answer comes later.
    pub(crate) fn start_paste_job(&mut self, text: &str, source: PasteSource) -> bool {
        let platform = Platform::current();
        let need = if source == PasteSource::ClipboardShortcut && text.is_empty() {
            Need::Clipboard
        } else if split_pasted_image_path_candidates(text, platform).iter().any(|chunk| chunk.image_path) {
            Need::Paths
        } else {
            return false;
        };
        let id = self.paste.next_id;
        self.paste.next_id += 1;
        self.paste.inflight.push(Inflight { id, source, text: text.to_owned(), ticket: None });
        let (cwd, provider) = (self.session_cwd(), self.store.state().get("provider").and_then(Value::as_str).unwrap_or("").to_owned());
        let caller = self.store.caller();
        let (tx, wake, pasted) = (self.paste.tx.clone(), self.paste.wake.clone(), text.to_owned());
        let spawned = std::thread::Builder::new().name("mixdog-tui-paste".to_owned()).spawn(move || {
            let mut reads = PasteReads::default();
            match need {
                Need::Clipboard => {
                    let clipboard = read_clipboard_text(platform, &SystemRunner);
                    let normalized = clipboard.as_ref().map(|text| text.replace("\r\n", "\n").replace('\r', "\n")).unwrap_or_default();
                    match &clipboard {
                        Ok(_) if normalized.is_empty() => {
                            let resize = |request: &ResizeRequest<'_>| resize_with(&caller, request);
                            reads.image = Some(read_clipboard_image_attachment(platform, &SystemRunner, &provider, &resize));
                        }
                        Ok(_) => read_paths(&mut reads, &normalized, platform, &cwd, &provider, &caller),
                        Err(_) => {}
                    }
                    reads.text = Some(clipboard);
                }
                Need::Paths => read_paths(&mut reads, &pasted, platform, &cwd, &provider, &caller),
            }
            let _ = tx.send(Done { id, reads });
            if let Some(wake) = wake {
                wake();
            }
        });
        if spawned.is_err() {
            // No thread to read on: the paste is answered as the handler would with nothing read.
            self.paste.inflight.retain(|inflight| inflight.id != id);
            return false;
        }
        true
    }

    /// The side questions whose answer has come: each settles its panel.
    pub(crate) fn finish_btw_asks(&mut self) {
        while let Ok((ask, result)) = self.paste.btw_rx.try_recv() {
            let mut btw = std::mem::take(&mut self.btw);
            btw.settle(&*self, &ask, result);
            self.btw = btw;
            self.frame_requested = true;
        }
    }

    /// The tickets the editor handed out for the pastes that started during the last operation belong to those pastes, in order.
    pub(crate) fn bind_paste_tickets(&mut self, tickets: Vec<PasteTicket>) {
        let mut tickets = tickets.into_iter();
        for inflight in self.paste.inflight.iter_mut().filter(|inflight| inflight.ticket.is_none()) {
            match tickets.next() {
                Some(ticket) => inflight.ticket = Some(ticket),
                None => break,
            }
        }
    }

    /// Finishes the pastes whose read is done: the paste handler runs with the readers answering from what was read, and the
    /// editor takes the answer under its staleness guard.
    pub(crate) fn finish_paste_jobs(&mut self) {
        while let Ok(done) = self.paste.rx.try_recv() {
            let Some(at) = self.paste.inflight.iter().position(|inflight| inflight.id == done.id) else { continue };
            let inflight = self.paste.inflight.remove(at);
            let Some(ticket) = inflight.ticket else { continue };
            let Some(mut editor) = self.editor.take() else { continue };
            self.paste.reads = done.reads;
            let reply = handle_prompt_paste(self, &inflight.text, inflight.source).into_reply();
            self.paste.reads = PasteReads::default();
            editor.finish_paste(ticket, reply, &mut super::input::Bridge(self));
            editor.end_input_batch();
            self.after_editor(&mut editor);
            self.editor = Some(editor);
            self.after_prompt_input();
            self.frame_requested = true;
        }
    }
}
