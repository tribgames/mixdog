// Match execution for one file: matcher construction, the cancellable
// reader/sink pair that enforces deadlines mid-scan, and the rg output
// modes (standard, files-with-matches, count).
use super::*;

pub(super) enum CompiledMatcher {
    Rust(grep::regex::RegexMatcher),
    Pcre(grep::pcre2::RegexMatcher),
}

pub(super) fn build_matcher(parsed: &ParsedArgs) -> Result<CompiledMatcher, String> {
    if parsed.pcre2 {
        let mut builder = grep::pcre2::RegexMatcherBuilder::new();
        builder
            .caseless(parsed.case_insensitive)
            .fixed_strings(parsed.fixed_strings)
            .multi_line(true)
            .dotall(parsed.multiline_dotall)
            .utf(true)
            .ucp(true)
            .jit_if_available(true);
        return builder
            .build_many(&parsed.patterns)
            .map(CompiledMatcher::Pcre)
            .map_err(|error| format!("regex parse error: {error}"));
    }
    let mut builder = grep::regex::RegexMatcherBuilder::new();
    builder
        .case_insensitive(parsed.case_insensitive)
        .fixed_strings(parsed.fixed_strings)
        .multi_line(true)
        .dot_matches_new_line(parsed.multiline_dotall);
    if !parsed.multiline {
        builder.line_terminator(Some(b'\n'));
    }
    builder
        .build_many(&parsed.patterns)
        .map(CompiledMatcher::Rust)
        .map_err(|error| format!("regex parse error: {error}"))
}

pub(super) struct CancelSink<'a, S> {
    pub(super) inner: S,
    pub(super) cancelled: &'a AtomicBool,
    pub(super) match_limit: Option<usize>,
    pub(super) matches: usize,
}

impl<S: Sink> Sink for CancelSink<'_, S> {
    type Error = S::Error;

    fn matched(&mut self, searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let keep_going = self.inner.matched(searcher, mat)?;
        self.matches += 1;
        Ok(keep_going && self.match_limit.is_none_or(|limit| self.matches < limit))
    }

    fn context(
        &mut self,
        searcher: &Searcher,
        context: &SinkContext<'_>,
    ) -> Result<bool, Self::Error> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        self.inner.context(searcher, context)
    }

    fn context_break(&mut self, searcher: &Searcher) -> Result<bool, Self::Error> {
        self.inner.context_break(searcher)
    }

    fn binary_data(
        &mut self,
        searcher: &Searcher,
        binary_byte_offset: u64,
    ) -> Result<bool, Self::Error> {
        self.inner.binary_data(searcher, binary_byte_offset)
    }

    fn begin(&mut self, searcher: &Searcher) -> Result<bool, Self::Error> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        self.inner.begin(searcher)
    }

    fn finish(&mut self, searcher: &Searcher, finish: &SinkFinish) -> Result<(), Self::Error> {
        self.inner.finish(searcher, finish)
    }
}

pub(super) struct CancellableReader<'a, R> {
    pub(super) inner: R,
    pub(super) cancelled: &'a AtomicBool,
    pub(super) deadline_at: Option<Instant>,
    pub(super) chunk_bytes: usize,
    pub(super) signature: Option<&'a mut TrigramSignature>,
}

impl<'a, R> CancellableReader<'a, R> {
    pub(super) fn new(
        inner: R,
        cancelled: &'a AtomicBool,
        deadline_at: Option<Instant>,
        signature: Option<&'a mut TrigramSignature>,
    ) -> Self {
        Self {
            inner,
            cancelled,
            deadline_at,
            chunk_bytes: search_reader_chunk_bytes(),
            signature,
        }
    }
}

impl<R: Read> Read for CancellableReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, CANCELLED));
        }
        if self
            .deadline_at
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(io::Error::new(io::ErrorKind::TimedOut, SOFT_TIMEOUT));
        }
        let bounded = buffer.len().min(self.chunk_bytes);
        let read = self.inner.read(&mut buffer[..bounded])?;
        if let Some(signature) = self.signature.as_deref_mut() {
            if read == 0 {
                signature.complete = true;
            } else {
                signature.push(&buffer[..read]);
            }
        }
        Ok(read)
    }
}

pub(super) fn searcher(parsed: &ParsedArgs) -> Searcher {
    let mut builder = SearcherBuilder::new();
    builder
        .line_number(parsed.line_numbers)
        .multi_line(parsed.multiline)
        .before_context(parsed.before)
        .after_context(parsed.after)
        .heap_limit(Some(search_heap_bytes()))
        .binary_detection(if parsed.text {
            BinaryDetection::none()
        } else {
            BinaryDetection::quit(b'\x00')
        });
    builder.build()
}

pub(super) fn output_lines(bytes: Vec<u8>) -> Option<Vec<String>> {
    let lines: Vec<String> = String::from_utf8_lossy(&bytes)
        .lines()
        .map(str::to_string)
        .collect();
    (!lines.is_empty()).then_some(lines)
}

pub(super) fn scan_standard<M: Matcher>(
    path: &Path,
    prefix: &str,
    matcher: &M,
    p: &ParsedArgs,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    match_limit: Option<usize>,
    build_signature: bool,
    scan_errors: &AtomicUsize,
) -> Option<Vec<String>> {
    let mut printer_builder = StandardBuilder::new();
    printer_builder
        .heading(false)
        .path(!prefix.is_empty())
        .only_matching(p.only_matching)
        .max_columns((p.max_columns > 0).then_some(p.max_columns as u64))
        .max_columns_preview(true);
    let mut printer = printer_builder.build_no_color(Vec::new());
    let mut searcher = searcher(p);
    // An unreadable file must not read as "no matches in this file": count it
    // so the response downgrades to partial (rg reports the same condition on
    // stderr and exits 2).
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            scan_errors.fetch_add(1, Ordering::Relaxed);
            return None;
        }
    };
    let mut signature = build_signature.then(TrigramSignature::new);
    let identity = signature
        .as_ref()
        .and_then(|_| crate::serve_search_usn::file_identity(&file));
    let mut reader = CancellableReader::new(file, cancelled, deadline_at, signature.as_mut());
    let result = if prefix.is_empty() {
        let inner = printer.sink(matcher);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit,
            matches: 0,
        };
        searcher.search_reader(matcher, &mut reader, &mut sink)
    } else {
        let printer_path = PathBuf::from(prefix);
        let inner = printer.sink_with_path(matcher, &printer_path);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit,
            matches: 0,
        };
        searcher.search_reader(matcher, &mut reader, &mut sink)
    };
    drop(reader);
    if cancelled.load(Ordering::Relaxed) {
        return None;
    }
    if result.is_err() {
        // Either the soft deadline fired mid-scan (surfaced by the response-
        // level deadline re-check) or a real read error. Count only the
        // latter so a genuine I/O failure downgrades the response to partial.
        if !deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
            scan_errors.fetch_add(1, Ordering::Relaxed);
        }
        return None;
    }
    if let Some(signature) = signature.as_ref() {
        remember_content_signature(path, signature, identity);
    }
    output_lines(printer.into_inner().into_inner())
}

pub(super) fn scan_summary<M: Matcher>(
    path: &Path,
    prefix: &str,
    matcher: &M,
    p: &ParsedArgs,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    build_signature: bool,
    scan_errors: &AtomicUsize,
) -> Option<Vec<String>> {
    let kind = if p.files_with_matches {
        SummaryKind::PathWithMatch
    } else {
        SummaryKind::Count
    };
    let mut printer_builder = SummaryBuilder::new();
    printer_builder
        .kind(kind)
        .path(!prefix.is_empty())
        .exclude_zero(true);
    let mut printer = printer_builder.build_no_color(Vec::new());
    let mut searcher = searcher(p);
    // Same unreadable-file accounting as scan_standard.
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            scan_errors.fetch_add(1, Ordering::Relaxed);
            return None;
        }
    };
    let mut signature = build_signature.then(TrigramSignature::new);
    let identity = signature
        .as_ref()
        .and_then(|_| crate::serve_search_usn::file_identity(&file));
    let mut reader = CancellableReader::new(file, cancelled, deadline_at, signature.as_mut());
    let result = if prefix.is_empty() {
        let inner = printer.sink(matcher);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit: None,
            matches: 0,
        };
        searcher.search_reader(matcher, &mut reader, &mut sink)
    } else {
        let printer_path = PathBuf::from(prefix);
        let inner = printer.sink_with_path(matcher, &printer_path);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit: None,
            matches: 0,
        };
        searcher.search_reader(matcher, &mut reader, &mut sink)
    };
    drop(reader);
    if cancelled.load(Ordering::Relaxed) {
        return None;
    }
    if result.is_err() {
        // Same deadline-vs-real-error split as scan_standard.
        if !deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
            scan_errors.fetch_add(1, Ordering::Relaxed);
        }
        return None;
    }
    if let Some(signature) = signature.as_ref() {
        remember_content_signature(path, signature, identity);
    }
    output_lines(printer.into_inner().into_inner())
}

pub(super) fn scan_file(
    path: &Path,
    prefix: &str,
    matcher: &CompiledMatcher,
    parsed: &ParsedArgs,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    match_limit: Option<usize>,
    trust: &TrustSnapshot,
    scan_errors: &AtomicUsize,
) -> Option<Vec<String>> {
    let signature_state = cached_signature_state(
        path,
        parsed.literal_trigrams.as_deref().unwrap_or(&[]),
        parsed.case_insensitive,
        trust,
    );
    if signature_state == CachedSignatureState::Excludes {
        return None;
    }
    let build_signature = signature_state == CachedSignatureState::Missing;
    macro_rules! scan {
        ($matcher:expr) => {
            if parsed.files_with_matches || parsed.count {
                scan_summary(
                    path,
                    prefix,
                    $matcher,
                    parsed,
                    cancelled,
                    deadline_at,
                    build_signature,
                    scan_errors,
                )
            } else {
                scan_standard(
                    path,
                    prefix,
                    $matcher,
                    parsed,
                    cancelled,
                    deadline_at,
                    match_limit,
                    build_signature,
                    scan_errors,
                )
            }
        };
    }
    match matcher {
        CompiledMatcher::Rust(matcher) => scan!(matcher),
        CompiledMatcher::Pcre(matcher) => scan!(matcher),
    }
}

pub(super) fn append_scanned_matches_unordered(
    files: &[PathBuf],
    operand: &str,
    operand_path: &Path,
    use_prefix: bool,
    matcher: &CompiledMatcher,
    parsed: &ParsedArgs,
    filter: &PathFilter,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    all_lines: &mut Vec<String>,
    emitted_blocks: &mut usize,
    collect_until: usize,
    trust: &TrustSnapshot,
    scan_errors: &AtomicUsize,
    files_scanned: &AtomicUsize,
) -> bool {
    let remaining = collect_until.saturating_sub(all_lines.len());
    if files.is_empty() || remaining == 0 {
        return remaining == 0;
    }
    let done = AtomicBool::new(false);
    let gathered = Mutex::new((Vec::new(), 0usize));
    files.par_iter().for_each(|file| {
        if done.load(Ordering::Relaxed)
            || cancelled.load(Ordering::Relaxed)
            || deadline_at.is_some_and(|deadline| Instant::now() >= deadline)
            || !filter.allows(file)
        {
            return;
        }
        let prefix = if use_prefix {
            display_path(operand, operand_path, file)
        } else {
            String::new()
        };
        files_scanned.fetch_add(1, Ordering::Relaxed);
        let Some(block) = scan_file(
            file,
            &prefix,
            matcher,
            parsed,
            cancelled,
            deadline_at,
            (collect_until != usize::MAX).then_some(remaining),
            trust,
            scan_errors,
        ) else {
            return;
        };
        let mut state = gathered.lock().unwrap_or_else(|e| e.into_inner());
        if state.0.len() >= remaining {
            done.store(true, Ordering::Relaxed);
            return;
        }
        if *emitted_blocks + state.1 > 0
            && (parsed.before > 0 || parsed.after > 0)
            && !parsed.files_with_matches
        {
            state.0.push("--".to_string());
        }
        state.1 += 1;
        let available = remaining.saturating_sub(state.0.len());
        state.0.extend(block.into_iter().take(available));
        if state.0.len() >= remaining {
            done.store(true, Ordering::Relaxed);
        }
    });
    let (lines, blocks) = gathered.into_inner().unwrap_or_else(|e| e.into_inner());
    *emitted_blocks += blocks;
    all_lines.extend(lines);
    all_lines.len() >= collect_until
}
