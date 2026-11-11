//! `orchestrationInstructions(mode)` of `runtime-core/orchestration.mjs`: the text a coding
//! Lead's prompt carries for an orchestration mode, and the instruction-file decode under it
//! (`lib/instruction-text.cjs` `decodeInstructionFile`, `readInstructionFile`).
//!
//! The user's `<data>/orchestration/<mode>.md` wins when it holds text; a file that is empty,
//! too large, not text or unreadable is passed over for the shipped `<root>/orchestration/<mode>.md`,
//! and no file at all gives the empty text. Node memoises a read on the file's identity once
//! the file is settled; the memo never changes an answer, so a read here is always fresh.

use std::io;
use std::path::Path;
use std::path::PathBuf;

use mixdog_core_base::support::on_lane;
use mixdog_core_config::workflow::ids::ORCHESTRATION_MODES;
use mixdog_core_session::session::thread_switches::SurfaceFailure;
use mixdog_js::js_trim_end;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;

/// Largest instruction file read or written (the agent editor's 256 KB text limit).
pub const INSTRUCTION_FILE_MAX_BYTES: usize = 256 * 1024;

/// Why a file cannot serve as the prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    TooLarge,
    /// Nothing but NUL bytes and white space: what a crash leaves of a file.
    Empty,
    /// NUL bytes or invalid UTF-8.
    NotText,
    Unreadable,
}

impl Problem {
    /// Node's name for the problem.
    pub fn name(self) -> &'static str {
        match self {
            Problem::TooLarge => "too-large",
            Problem::Empty => "empty",
            Problem::NotText => "not-text",
            Problem::Unreadable => "unreadable",
        }
    }
}

/// `readInstructionFile` for a file that exists: its text (CRLF as LF, trailing white space
/// dropped) or the reason it cannot serve.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Instruction {
    Text(String),
    Problem(Problem),
}

/// `decodeInstructionFile(buffer)`: the bytes as text with the byte-order mark dropped, or the
/// problem. `bytes` is the file's first `INSTRUCTION_FILE_MAX_BYTES + 1` bytes at most.
pub fn decode(bytes: &[u8]) -> Result<String, Problem> {
    if bytes.len() > INSTRUCTION_FILE_MAX_BYTES {
        return Err(Problem::TooLarge);
    }
    if mixdog_statefile::holds_no_data(bytes) {
        return Err(Problem::Empty);
    }
    if bytes.contains(&0) {
        return Err(Problem::NotText);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Problem::NotText)?;
    // The fatal `TextDecoder` drops one leading mark, the `/^\uFEFF/` replace a second.
    let once = text.strip_prefix('\u{feff}').unwrap_or(text);
    Ok(once.strip_prefix('\u{feff}').unwrap_or(once).to_owned())
}

/// `readInstructionFile(file)`: `None` for a file that is not there. A file larger than the limit
/// is read up to one byte past it, which is all the decode needs to call it too large.
pub fn read_instruction_file(lane: &InLane<InteractiveIo>, path: &Path) -> Option<Instruction> {
    let stat = match mixdog_statefile::metadata(lane, path) {
        Ok(stat) => stat,
        Err(error) if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) => return None,
        Err(_) => return Some(Instruction::Problem(Problem::Unreadable)),
    };
    if !stat.is_file() {
        return Some(Instruction::Problem(Problem::Unreadable));
    }
    Some(match mixdog_statefile::read_range(lane, path, 0, INSTRUCTION_FILE_MAX_BYTES + 1) {
        Ok(bytes) => match decode(&bytes) {
            Ok(text) => Instruction::Text(js_trim_end(&text.replace("\r\n", "\n")).to_owned()),
            Err(problem) => Instruction::Problem(problem),
        },
        Err(_) => Instruction::Problem(Problem::Unreadable),
    })
}

/// `<mode>.md` of `normalizeOrchestrationMode(mode)`: a mode that is none of the four is `none`.
fn mode_file(mode: &str) -> String {
    let mode = ORCHESTRATION_MODES.into_iter().find(|known| *known == mode).unwrap_or("none");
    format!("{mode}.md")
}

/// `orchestrationModeSource(mode).text`: the user's text when the file holds any, else the
/// shipped file's.
fn mode_text(lane: &InLane<InteractiveIo>, user: &Path, shipped: &Path) -> String {
    if let Some(Instruction::Text(text)) = read_instruction_file(lane, user)
        && !text.is_empty()
    {
        return text;
    }
    match read_instruction_file(lane, shipped) {
        Some(Instruction::Text(text)) => text,
        _ => String::new(),
    }
}

/// The mode texts of one install: the shipped ones under `root`, the user's under `data`.
#[derive(Clone)]
pub struct OrchestrationTexts {
    lane: InteractiveIo,
    root: PathBuf,
    data: PathBuf,
}

impl OrchestrationTexts {
    /// `root` is the install root (`mixdogRoot()`), `data` the data dir (`resolvePluginData()`).
    pub fn new(lane: InteractiveIo, root: impl Into<PathBuf>, data: impl Into<PathBuf>) -> Self {
        Self { lane, root: root.into(), data: data.into() }
    }

    /// `orchestrationInstructions(mode)`. Both files are read in one lane job. A lane that cannot
    /// run it is a typed failure, never an empty text.
    pub async fn orchestration_instructions(&self, mode: &str) -> Result<String, SurfaceFailure> {
        let file = mode_file(mode);
        let user = self.data.join("orchestration").join(&file);
        let shipped = self.root.join("orchestration").join(&file);
        on_lane(self.lane, &CancellationToken::new(), move |lane| mode_text(lane, &user, &shipped))
            .await
            .map_err(|error| SurfaceFailure(format!("the orchestration text of mode \"{mode}\" could not be read: {error:?}")))
    }
}
