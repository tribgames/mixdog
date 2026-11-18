//! The highlighter of highlight.js 10.7.3 (`lib/core.js`): the language registry, `highlight`, `highlightAuto`
//! and the parse loop (`_highlight`), producing the HTML `highlight(...).value` produces.
//!
//! Text is UTF-16 code units throughout, as in JavaScript. A language compiles on first use, once per thread,
//! and keeps the state core.js keeps on its compiled modes (a matcher's cached alternations, an `endSameAsBegin`
//! end pattern, a callback's data).

pub(crate) mod compile;
mod emitter;
mod keywords;
pub(crate) mod matcher;

use std::cell::OnceCell;
use std::collections::HashMap;
use std::rc::Rc;

use compile::{CMode, CompiledLanguage, SubLanguage, compile_language};
use emitter::{Emitter, escape_html};
use matcher::{LazyRegex, LexMatch, RuleKind};

use crate::languages::{self, RawLanguage, RegistryFacts};

/// A callback of a mode: `on:begin`, `on:end` or the internal `__beforeBegin`.
pub(crate) type Hook = fn(&MatchView<'_>, &mut Response<'_>);

/// `mode.data`, the object callbacks keep their state in.
#[derive(Debug, Default)]
pub(crate) struct ModeData {
    /// `data._beginMatch` of `END_SAME_AS_BEGIN`.
    pub(crate) begin_match: Option<Vec<u16>>,
}

/// What a callback sees of a match: the text, where it is, and its groups.
pub(crate) struct MatchView<'a> {
    pub(crate) input: &'a [u16],
    pub(crate) index: usize,
    found: &'a LexMatch,
}

impl<'a> MatchView<'a> {
    /// `match[0]`.
    pub(crate) fn lexeme(&self) -> &'a [u16] {
        &self.input[self.found.index..self.found.end]
    }

    /// `match[k]`.
    pub(crate) fn group(&self, k: usize) -> Option<&'a [u16]> {
        self.found.group(k).map(|r| &self.input[r])
    }
}

/// `CallbackResponse`.
pub(crate) struct Response<'a> {
    ignored: bool,
    pub(crate) data: &'a mut ModeData,
}

impl Response<'_> {
    pub(crate) fn ignore_match(&mut self) {
        self.ignored = true;
    }
}

/// Why a highlight call fails (core.js throws).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HighlightError {
    /// `Unknown language: "<name>"`.
    UnknownLanguage(String),
    /// A language definition could not be compiled (the message core.js would throw).
    Compile { language: String, message: String },
}

impl std::fmt::Display for HighlightError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HighlightError::UnknownLanguage(name) => write!(f, "Unknown language: \"{name}\""),
            HighlightError::Compile { language, message } => {
                write!(f, "language \"{language}\": {message}")
            }
        }
    }
}

/// The result of `highlight` and `highlightAuto`.
#[derive(Debug, Clone, PartialEq)]
pub struct HighlightResult {
    /// The highlighted HTML (`result.value`).
    pub value: String,
    /// `Math.floor(relevance)`.
    pub relevance: i64,
    /// The language of the result: the name `highlight` was given, or the detected one.
    pub language: Option<String>,
    /// An illegal match was found and not ignored.
    pub illegal: bool,
}

/// A mode on the stack: `Object.create(mode, { parent })`.
#[derive(Debug)]
pub(crate) struct Frame {
    mode: usize,
    parent: Option<Rc<Frame>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Ok,
    /// An illegal match stopped the parse: the value is the escaped code.
    Illegal,
    /// Any other error stopped the parse (SAFE_MODE): the value is the escaped code.
    Raised,
    /// The plain-text result `highlightAuto` starts from.
    Plain,
}

/// What `_highlight` returns.
#[derive(Debug, Clone)]
struct Outcome {
    relevance: i64,
    emitter: Emitter,
    language: Option<String>,
    top: Option<Rc<Frame>>,
    status: Status,
}

/// Why a run stops before the end of the text.
#[derive(Debug)]
enum Stop {
    Illegal,
    Raised,
}

struct Slot {
    raw: RawLanguage,
    superset_of: Option<String>,
    disable_autodetect: bool,
    compiled: OnceCell<Result<Rc<CompiledLanguage>, String>>,
}

pub(crate) struct Engine {
    slots: HashMap<String, Slot>,
    /// Registration order of the languages carried (`Object.keys(languages)`).
    order: Vec<String>,
    aliases: HashMap<String, String>,
}

impl Engine {
    pub(crate) fn new() -> Self {
        let RegistryFacts { order, aliases } = languages::load_registry();
        let loaded = languages::load_languages();
        let mut slots = HashMap::new();
        for raw in loaded {
            let root = &raw.objects[raw.root];
            let superset_of = root.string("supersetOf").map(str::to_string);
            let disable_autodetect = root.flag("disableAutodetect");
            slots.insert(
                raw.name.clone(),
                Slot {
                    raw,
                    superset_of,
                    disable_autodetect,
                    compiled: OnceCell::new(),
                },
            );
        }
        // The registration order of highlight.js, restricted to the carried languages.
        let order: Vec<String> = order
            .into_iter()
            .filter(|name| slots.contains_key(name))
            .collect();
        Self {
            slots,
            order,
            aliases: aliases.into_iter().collect(),
        }
    }

    /// `getLanguage(name)`: a name or an alias, case-insensitively.
    fn get_language(&self, name: &str) -> Option<&Slot> {
        let lower = mixdog_js::js_to_lowercase(name);
        self.slots.get(&lower).or_else(|| {
            self.aliases
                .get(&lower)
                .and_then(|target| self.slots.get(target))
        })
    }

    pub(crate) fn supports_language(&self, name: &str) -> bool {
        self.get_language(name).is_some()
    }

    pub(crate) fn list_languages(&self) -> Vec<String> {
        self.order.clone()
    }

    fn compiled(&self, slot: &Slot) -> Result<Rc<CompiledLanguage>, String> {
        slot.compiled
            .get_or_init(|| compile_language(&slot.raw).map(Rc::new))
            .clone()
    }

    /// `highlight(code, { language, ignoreIllegals })`.
    pub(crate) fn highlight(
        &self,
        code: &str,
        language: &str,
        ignore_illegals: bool,
    ) -> Result<HighlightResult, HighlightError> {
        let text: Vec<u16> = code.encode_utf16().collect();
        let outcome = self.run(language, &text, ignore_illegals, None)?;
        Ok(self.finish(outcome, &text))
    }

    /// `highlightAuto(code, languageSubset)`.
    pub(crate) fn highlight_auto(
        &self,
        code: &str,
        subset: Option<&[&str]>,
    ) -> Result<HighlightResult, HighlightError> {
        let text: Vec<u16> = code.encode_utf16().collect();
        let subset: Option<Vec<String>> =
            subset.map(|names| names.iter().map(|n| (*n).to_string()).collect());
        let outcome = self.auto(&text, subset.as_deref())?;
        Ok(self.finish(outcome, &text))
    }

    fn finish(&self, outcome: Outcome, code: &[u16]) -> HighlightResult {
        let value = match outcome.status {
            Status::Ok | Status::Plain => outcome.emitter.to_html(),
            Status::Illegal | Status::Raised => escape_html(code),
        };
        HighlightResult {
            value: String::from_utf16_lossy(&value),
            relevance: outcome.relevance,
            language: outcome.language,
            illegal: outcome.status == Status::Illegal,
        }
    }

    /// `justTextHighlightResult(code)`.
    fn just_text(code: &[u16]) -> Outcome {
        let mut emitter = Emitter::new();
        emitter.add_text(code);
        Outcome {
            relevance: 0,
            emitter,
            language: None,
            top: None,
            status: Status::Plain,
        }
    }

    fn auto(&self, code: &[u16], subset: Option<&[String]>) -> Result<Outcome, HighlightError> {
        let names: Vec<String> = match subset {
            Some(list) => list.to_vec(),
            None => self.order.clone(),
        };
        let mut results = vec![Self::just_text(code)];
        for name in &names {
            let Some(slot) = self.get_language(name) else {
                continue;
            };
            if slot.disable_autodetect {
                continue;
            }
            results.push(self.run(name, code, false, None)?);
        }
        let mut order: Vec<usize> = (0..results.len()).collect();
        mixdog_js::js_sort_by(&mut order, |&a, &b| {
            self.compare_results(&results[a], &results[b])
        });
        let best = order[0];
        Ok(results.swap_remove(best))
    }

    /// The comparison `highlightAuto` sorts by: relevance, then the superset language wins a tie.
    fn compare_results(&self, a: &Outcome, b: &Outcome) -> f64 {
        if a.relevance != b.relevance {
            return (b.relevance - a.relevance) as f64;
        }
        if let (Some(a_name), Some(b_name)) = (&a.language, &b.language)
            && !a_name.is_empty()
            && !b_name.is_empty()
        {
            if self
                .get_language(a_name)
                .and_then(|s| s.superset_of.as_deref())
                == Some(b_name.as_str())
            {
                return 1.0;
            } else if self
                .get_language(b_name)
                .and_then(|s| s.superset_of.as_deref())
                == Some(a_name.as_str())
            {
                return -1.0;
            }
        }
        0.0
    }

    /// `_highlight(languageName, code, ignoreIllegals, continuation)`.
    fn run(
        &self,
        language_name: &str,
        code: &[u16],
        ignore_illegals: bool,
        continuation: Option<Rc<Frame>>,
    ) -> Result<Outcome, HighlightError> {
        let slot = self
            .get_language(language_name)
            .ok_or_else(|| HighlightError::UnknownLanguage(language_name.to_string()))?;
        let lang = self
            .compiled(slot)
            .map_err(|message| HighlightError::Compile {
                language: slot.raw.name.clone(),
                message,
            })?;
        let top = continuation.unwrap_or_else(|| {
            Rc::new(Frame {
                mode: lang.root,
                parent: None,
            })
        });
        let mut run = Run {
            engine: self,
            lang,
            code,
            ignore_illegals,
            emitter: Emitter::new(),
            top,
            mode_buffer: Vec::new(),
            relevance: 0.0,
            iterations: 0,
            resume_scan_at_same_position: false,
            last_match: None,
            continuations: HashMap::new(),
        };
        run.process_continuations();
        let stop = run.execute();
        Ok(match stop {
            None => Outcome {
                relevance: run.relevance.floor() as i64,
                emitter: run.emitter,
                language: Some(language_name.to_string()),
                top: Some(run.top),
                status: Status::Ok,
            },
            Some(Stop::Illegal) => Outcome {
                relevance: 0,
                emitter: run.emitter,
                language: None,
                top: None,
                status: Status::Illegal,
            },
            Some(Stop::Raised) => Outcome {
                relevance: 0,
                emitter: run.emitter,
                language: Some(language_name.to_string()),
                top: Some(run.top),
                status: Status::Raised,
            },
        })
    }
}

/// The match of the previous `processLexeme`, for the zero-width check.
struct LastMatch {
    kind: RuleKind,
    index: usize,
}

/// The state of one `_highlight` call.
struct Run<'a> {
    engine: &'a Engine,
    lang: Rc<CompiledLanguage>,
    code: &'a [u16],
    ignore_illegals: bool,
    emitter: Emitter,
    top: Rc<Frame>,
    mode_buffer: Vec<u16>,
    relevance: f64,
    iterations: usize,
    resume_scan_at_same_position: bool,
    last_match: Option<LastMatch>,
    continuations: HashMap<String, Option<Rc<Frame>>>,
}

fn same_frame(a: &Option<Rc<Frame>>, b: &Option<Rc<Frame>>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => Rc::ptr_eq(x, y),
        (None, None) => true,
        _ => false,
    }
}

impl Run<'_> {
    fn mode(&self, frame: &Frame) -> &CMode {
        &self.lang.modes[frame.mode]
    }

    fn top_mode(&self) -> &CMode {
        self.mode(&self.top)
    }

    /// `processContinuations`: re-open the nodes of the modes a continuation was left in.
    fn process_continuations(&mut self) {
        let mut names = Vec::new();
        let mut current = self.top.clone();
        while let Some(parent) = current.parent.clone() {
            if let Some(name) = &self.mode(&current).class_name {
                names.push(name.clone());
            }
            current = parent;
        }
        for name in names.iter().rev() {
            self.emitter.open_node(name);
        }
    }

    /// The loop of `_highlight` inside its `try`: why it stopped early, if it did.
    fn execute(&mut self) -> Option<Stop> {
        self.parse().err()
    }

    fn parse(&mut self) -> Result<(), Stop> {
        let mut index = 0;
        self.top_mode().matcher.consider_all();
        let code = self.code;
        loop {
            self.iterations += 1;
            let lang = self.lang.clone();
            let matcher = &lang.modes[self.top.mode].matcher;
            if self.resume_scan_at_same_position {
                self.resume_scan_at_same_position = false;
            } else {
                matcher.consider_all();
            }
            matcher.last_index.set(index);
            let Some(found) = matcher.exec(code).map_err(|()| Stop::Raised)? else {
                break;
            };
            let before = &code[index.min(found.index)..found.index];
            let processed = self.process_lexeme(before, Some(&found))?;
            index = found.index + processed;
        }
        let rest = code.get(index..).unwrap_or(&[]);
        self.process_lexeme(rest, None)?;
        self.emitter.close_all_nodes();
        Ok(())
    }

    /// `processLexeme(textBeforeMatch, match)`.
    fn process_lexeme(
        &mut self,
        text_before: &[u16],
        found: Option<&LexMatch>,
    ) -> Result<usize, Stop> {
        self.mode_buffer.extend_from_slice(text_before);
        let Some(found) = found else {
            self.process_buffer()?;
            return Ok(0);
        };
        let code = self.code;
        let lexeme = &code[found.index..found.end];

        // A zero-width match that follows a begin at the same place: step over a character.
        if let Some(last) = &self.last_match
            && matches!(last.kind, RuleKind::Begin(_))
            && found.kind == RuleKind::End
            && last.index == found.index
            && lexeme.is_empty()
        {
            if let Some(unit) = code.get(found.index) {
                self.mode_buffer.push(*unit);
            }
            return Ok(1);
        }
        self.last_match = Some(LastMatch {
            kind: found.kind,
            index: found.index,
        });

        match found.kind {
            RuleKind::Begin(rule) => return self.do_begin_match(found, rule),
            RuleKind::Illegal if !self.ignore_illegals => return Err(Stop::Illegal),
            RuleKind::End => {
                if let Some(processed) = self.do_end_match(found)? {
                    return Ok(processed);
                }
            }
            RuleKind::Illegal => {}
        }

        // An illegal match of `$` is a zero-width match that is not a begin or an end.
        if found.kind == RuleKind::Illegal && lexeme.is_empty() {
            return Ok(1);
        }
        if self.iterations > 100_000 && self.iterations > found.index * 3 {
            return Err(Stop::Raised);
        }
        self.mode_buffer.extend_from_slice(lexeme);
        Ok(lexeme.len())
    }

    /// `startNewMode(mode)`.
    fn start_new_mode(&mut self, mode: usize) {
        let lang = self.lang.clone();
        if let Some(class_name) = &lang.modes[mode].class_name {
            self.emitter.open_node(lang.class_alias(class_name));
        }
        self.top = Rc::new(Frame {
            mode,
            parent: Some(self.top.clone()),
        });
    }

    /// `doIgnore(lexeme)`.
    fn do_ignore(&mut self, lexeme: &[u16]) -> usize {
        if self.top_mode().matcher.regex_index.get() == 0 {
            match lexeme.first() {
                Some(unit) => self.mode_buffer.push(*unit),
                // `modeBuffer += lexeme[0]` of an empty lexeme appends "undefined".
                None => self.mode_buffer.extend("undefined".encode_utf16()),
            }
            1
        } else {
            self.resume_scan_at_same_position = true;
            0
        }
    }

    /// `doBeginMatch(match)`.
    fn do_begin_match(&mut self, found: &LexMatch, rule: usize) -> Result<usize, Stop> {
        let code = self.code;
        let lexeme = &code[found.index..found.end];
        let lang = self.lang.clone();
        let new_mode = &lang.modes[rule];

        // First the internal callback, then the public one.
        for hook in [new_mode.before_begin, new_mode.on_begin]
            .into_iter()
            .flatten()
        {
            let view = MatchView {
                input: code,
                index: found.index,
                found,
            };
            let mut data = new_mode.data.borrow_mut();
            let mut response = Response {
                ignored: false,
                data: &mut data,
            };
            hook(&view, &mut response);
            if response.ignored {
                drop(data);
                return Ok(self.do_ignore(lexeme));
            }
        }

        if new_mode.end_same_as_begin {
            *new_mode.end_re.borrow_mut() = Some(Rc::new(LazyRegex::escaped(lexeme)));
        }

        if new_mode.skip {
            self.mode_buffer.extend_from_slice(lexeme);
        } else {
            if new_mode.exclude_begin {
                self.mode_buffer.extend_from_slice(lexeme);
            }
            self.process_buffer()?;
            if !new_mode.return_begin && !new_mode.exclude_begin {
                self.mode_buffer = lexeme.to_vec();
            }
        }
        self.start_new_mode(rule);
        Ok(if new_mode.return_begin {
            0
        } else {
            lexeme.len()
        })
    }

    /// `startsWith(re, text)`: the expression matches at the start of the text.
    fn starts_with(re: &Option<Rc<LazyRegex>>, text: &[u16]) -> Result<bool, Stop> {
        let Some(re) = re else { return Ok(false) };
        if re.get().is_none() {
            return Err(Stop::Raised);
        }
        Ok(re.find_from(text, 0).is_some_and(|m| m.start() == 0))
    }

    /// `endOfMode(mode, match, matchPlusRemainder)`: the frame whose mode this match ends, if any.
    fn end_of_mode(
        &self,
        frame: &Rc<Frame>,
        found: &LexMatch,
        rest: &[u16],
    ) -> Result<Option<Rc<Frame>>, Stop> {
        let mode = self.mode(frame);
        let end_re = mode.end_re.borrow().clone();
        let mut matched = Self::starts_with(&end_re, rest)?;
        if matched {
            if let Some(hook) = mode.on_end {
                let view = MatchView {
                    input: self.code,
                    index: found.index,
                    found,
                };
                let mut data = mode.data.borrow_mut();
                let mut response = Response {
                    ignored: false,
                    data: &mut data,
                };
                hook(&view, &mut response);
                if response.ignored {
                    matched = false;
                }
            }
            if matched {
                let mut ended = frame.clone();
                while self.mode(&ended).ends_parent {
                    let Some(parent) = ended.parent.clone() else {
                        break;
                    };
                    ended = parent;
                }
                return Ok(Some(ended));
            }
        }
        // Even when `on:end` ignored it, a parent may still end here.
        if mode.ends_with_parent {
            let Some(parent) = &frame.parent else {
                return Err(Stop::Raised);
            };
            return self.end_of_mode(parent, found, rest);
        }
        Ok(None)
    }

    /// `doEndMatch(match)`: `None` is NO_MATCH.
    fn do_end_match(&mut self, found: &LexMatch) -> Result<Option<usize>, Stop> {
        let code = self.code;
        let lexeme = &code[found.index..found.end];
        let rest = &code[found.index..];
        let top = self.top.clone();
        let Some(end_mode) = self.end_of_mode(&top, found, rest)? else {
            return Ok(None);
        };

        let lang = self.lang.clone();
        let origin = &lang.modes[top.mode];
        if origin.skip {
            self.mode_buffer.extend_from_slice(lexeme);
        } else {
            if !(origin.return_end || origin.exclude_end) {
                self.mode_buffer.extend_from_slice(lexeme);
            }
            self.process_buffer()?;
            if origin.exclude_end {
                self.mode_buffer = lexeme.to_vec();
            }
        }
        let stop_at = end_mode.parent.clone();
        loop {
            let mode = &lang.modes[self.top.mode];
            if mode.class_name.is_some() {
                self.emitter.close_node();
            }
            let has_sub_language = match &mode.sub_language {
                None => false,
                Some(SubLanguage::Name(name)) => !name.is_empty(),
                Some(SubLanguage::List(_)) => true,
            };
            if !mode.skip && !has_sub_language {
                self.relevance += mode.relevance;
            }
            let Some(parent) = self.top.parent.clone() else {
                return Err(Stop::Raised);
            };
            self.top = parent;
            if same_frame(&Some(self.top.clone()), &stop_at) {
                break;
            }
        }
        let ended = &lang.modes[end_mode.mode];
        if let Some(starts) = ended.starts {
            if ended.end_same_as_begin {
                let end_re = ended.end_re.borrow().clone();
                *lang.modes[starts].end_re.borrow_mut() = end_re;
            }
            self.start_new_mode(starts);
        }
        Ok(Some(if origin.return_end { 0 } else { lexeme.len() }))
    }

    /// `processBuffer`.
    fn process_buffer(&mut self) -> Result<(), Stop> {
        if self.top_mode().sub_language.is_some() {
            self.process_sub_language()?;
        } else {
            self.process_keywords()?;
        }
        self.mode_buffer.clear();
        Ok(())
    }

    /// `processKeywords`.
    fn process_keywords(&mut self) -> Result<(), Stop> {
        let lang = self.lang.clone();
        let mode = &lang.modes[self.top.mode];
        let buffer = std::mem::take(&mut self.mode_buffer);
        let Some(table) = &mode.keywords else {
            self.emitter.add_text(&buffer);
            return Ok(());
        };
        let pattern = mode.keyword_pattern.clone();
        if pattern.get().is_none() {
            return Err(Stop::Raised);
        }
        let case_insensitive = lang.case_insensitive;
        let mut last_index = 0;
        let mut search_from = 0;
        let mut buf: Vec<u16> = Vec::new();
        while let Some(found) = pattern.find_from(&buffer, search_from) {
            buf.extend_from_slice(&buffer[last_index.min(found.start())..found.start()]);
            let text = &buffer[found.start()..found.end()];
            let key = String::from_utf16_lossy(text);
            let key = if case_insensitive {
                mixdog_js::js_to_lowercase(&key)
            } else {
                key
            };
            if let Some((kind, keyword_relevance)) = table.get(&key) {
                self.emitter.add_text(&buf);
                buf.clear();
                self.relevance += keyword_relevance;
                if kind.starts_with('_') {
                    // Implied for relevance only: no class.
                    buf.extend_from_slice(text);
                } else {
                    self.emitter.add_keyword(text, lang.class_alias(kind));
                }
            } else {
                buf.extend_from_slice(text);
            }
            last_index = found.end();
            // A pattern that matches nothing would leave `lastIndex` where it is and never end.
            search_from = if found.end() == found.start() {
                found.end() + 1
            } else {
                found.end()
            };
        }
        buf.extend_from_slice(buffer.get(last_index..).unwrap_or(&[]));
        self.emitter.add_text(&buf);
        Ok(())
    }

    /// `processSubLanguage`.
    fn process_sub_language(&mut self) -> Result<(), Stop> {
        if self.mode_buffer.is_empty() {
            return Ok(());
        }
        let lang = self.lang.clone();
        let mode = &lang.modes[self.top.mode];
        let buffer = std::mem::take(&mut self.mode_buffer);
        let result = match &mode.sub_language {
            Some(SubLanguage::Name(name)) => {
                if !self.engine.slots.contains_key(name) {
                    self.emitter.add_text(&buffer);
                    return Ok(());
                }
                let continuation = self.continuations.get(name).cloned().flatten();
                let outcome = self
                    .engine
                    .run(name, &buffer, true, continuation)
                    .map_err(|_| Stop::Raised)?;
                self.continuations.insert(name.clone(), outcome.top.clone());
                outcome
            }
            Some(SubLanguage::List(list)) => {
                let subset = if list.is_empty() {
                    None
                } else {
                    Some(list.as_slice())
                };
                self.engine
                    .auto(&buffer, subset)
                    .map_err(|_| Stop::Raised)?
            }
            None => return Ok(()),
        };
        // Counting the embedded language towards the host may be disabled by zeroing the mode's relevance.
        if mode.relevance > 0.0 {
            self.relevance += result.relevance as f64;
        }
        self.emitter
            .add_sublanguage(result.emitter, result.language.as_deref());
        Ok(())
    }
}

#[cfg(test)]
mod tests;


impl std::error::Error for HighlightError {}
