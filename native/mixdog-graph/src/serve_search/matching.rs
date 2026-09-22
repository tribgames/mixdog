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

/// Everything a scan needs from the request that does not change between
/// operands or files: the parsed argv, the compiled pattern, the cancellation
/// flag and soft deadline every bounded loop checks, and the counters the
/// response reports a partial result from.
pub(super) struct ScanCtx<'a> {
    pub(super) parsed: &'a ParsedArgs,
    pub(super) matcher: &'a CompiledMatcher,
    pub(super) cancelled: &'a AtomicBool,
    pub(super) deadline_at: Option<Instant>,
    pub(super) scan_errors: &'a AtomicUsize,
    pub(super) files_scanned: &'a AtomicUsize,
}

/// The bounded line buffer a scan appends into. `collect_until` is the hard
/// stop for the response window, and `emitted_blocks` carries the
/// context-block separator state across batches and operands.
pub(super) struct ScanOutput<'a> {
    pub(super) all_lines: &'a mut Vec<String>,
    pub(super) emitted_blocks: &'a mut usize,
    pub(super) collect_until: usize,
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
        if deadline_expired(self.deadline_at) {
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

/// Drive one printer's sink through the cancellation wrapper every output
/// mode needs. The standard and summary printers hand back different sink
/// types, so the wrapper is generic over the sink instead of being rebuilt
/// once per output mode.
fn search_with_sink<M, S, R>(
    searcher: &mut Searcher,
    matcher: M,
    reader: &mut R,
    inner: S,
    cancelled: &AtomicBool,
    match_limit: Option<usize>,
) -> Result<(), S::Error>
where
    M: Matcher,
    S: Sink,
    R: Read,
{
    let mut sink = CancelSink {
        inner,
        cancelled,
        match_limit,
        matches: 0,
    };
    searcher.search_reader(matcher, reader, &mut sink)
}

/// Everything a scan of one file does around its printer: open the file,
/// build the optional trigram signature and the cancellable reader, then read
/// from the outcome whether the file counted as a scan error and whether its
/// signature may be cached. `search` runs the printer-specific pass over that
/// reader and hands back its result plus the bytes the printer wrote.
fn scan_with_printer(
    path: &Path,
    build_signature: bool,
    ctx: &ScanCtx<'_>,
    search: impl FnOnce(&mut CancellableReader<'_, File>) -> (io::Result<()>, Vec<u8>),
) -> Option<Vec<String>> {
    // An unreadable file must not read as "no matches in this file": count it
    // so the response downgrades to partial (rg reports the same condition on
    // stderr and exits 2).
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            ctx.scan_errors.fetch_add(1, Ordering::Relaxed);
            return None;
        }
    };
    let mut signature = build_signature.then(TrigramSignature::new);
    let identity = signature
        .as_ref()
        .and_then(|_| crate::serve_search_usn::file_identity(&file));
    let mut reader =
        CancellableReader::new(file, ctx.cancelled, ctx.deadline_at, signature.as_mut());
    let (result, bytes) = search(&mut reader);
    drop(reader);
    if ctx.cancelled.load(Ordering::Relaxed) {
        return None;
    }
    if result.is_err() {
        // Either the soft deadline fired mid-scan (surfaced by the response-
        // level deadline re-check) or a real read error. Count only the
        // latter so a genuine I/O failure downgrades the response to partial.
        if !deadline_expired(ctx.deadline_at) {
            ctx.scan_errors.fetch_add(1, Ordering::Relaxed);
        }
        return None;
    }
    if let Some(signature) = signature.as_ref() {
        remember_content_signature(path, signature, identity);
    }
    output_lines(bytes)
}

pub(super) fn scan_standard<M: Matcher>(
    path: &Path,
    prefix: &str,
    matcher: &M,
    match_limit: Option<usize>,
    build_signature: bool,
    ctx: &ScanCtx<'_>,
) -> Option<Vec<String>> {
    let p = ctx.parsed;
    let cancelled = ctx.cancelled;
    let mut printer_builder = StandardBuilder::new();
    printer_builder
        .heading(false)
        .path(!prefix.is_empty())
        .only_matching(p.only_matching)
        .max_columns((p.max_columns > 0).then_some(p.max_columns as u64))
        .max_columns_preview(true);
    let mut printer = printer_builder.build_no_color(Vec::new());
    let mut searcher = searcher(p);
    scan_with_printer(path, build_signature, ctx, |reader| {
        let result = if prefix.is_empty() {
            let inner = printer.sink(matcher);
            search_with_sink(
                &mut searcher,
                matcher,
                reader,
                inner,
                cancelled,
                match_limit,
            )
        } else {
            let printer_path = PathBuf::from(prefix);
            let inner = printer.sink_with_path(matcher, &printer_path);
            search_with_sink(
                &mut searcher,
                matcher,
                reader,
                inner,
                cancelled,
                match_limit,
            )
        };
        (result, printer.into_inner().into_inner())
    })
}

pub(super) fn scan_summary<M: Matcher>(
    path: &Path,
    prefix: &str,
    matcher: &M,
    build_signature: bool,
    ctx: &ScanCtx<'_>,
) -> Option<Vec<String>> {
    let p = ctx.parsed;
    let cancelled = ctx.cancelled;
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
    // The summary printer never takes a match limit: it reports one line per
    // file, so there is no per-file line budget to stop at.
    scan_with_printer(path, build_signature, ctx, |reader| {
        let result = if prefix.is_empty() {
            let inner = printer.sink(matcher);
            search_with_sink(&mut searcher, matcher, reader, inner, cancelled, None)
        } else {
            let printer_path = PathBuf::from(prefix);
            let inner = printer.sink_with_path(matcher, &printer_path);
            search_with_sink(&mut searcher, matcher, reader, inner, cancelled, None)
        };
        (result, printer.into_inner().into_inner())
    })
}

pub(super) fn scan_file(
    path: &Path,
    prefix: &str,
    match_limit: Option<usize>,
    trust: &TrustSnapshot,
    ctx: &ScanCtx<'_>,
) -> Option<Vec<String>> {
    let parsed = ctx.parsed;
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
                scan_summary(path, prefix, $matcher, build_signature, ctx)
            } else {
                scan_standard(path, prefix, $matcher, match_limit, build_signature, ctx)
            }
        };
    }
    match ctx.matcher {
        CompiledMatcher::Rust(matcher) => scan!(matcher),
        CompiledMatcher::Pcre(matcher) => scan!(matcher),
    }
}

pub(super) fn append_scanned_matches_unordered(
    files: &[PathBuf],
    scope: &OperandScope<'_>,
    use_prefix: bool,
    trust: &TrustSnapshot,
    ctx: &ScanCtx<'_>,
    out: &mut ScanOutput<'_>,
) -> bool {
    let parsed = ctx.parsed;
    let collect_until = out.collect_until;
    let remaining = collect_until.saturating_sub(out.all_lines.len());
    if files.is_empty() || remaining == 0 {
        return remaining == 0;
    }
    // Read once: the separator counter is only written after the parallel pass.
    let emitted_blocks = *out.emitted_blocks;
    let done = AtomicBool::new(false);
    let gathered = Mutex::new((Vec::new(), 0usize));
    files.par_iter().for_each(|file| {
        if done.load(Ordering::Relaxed)
            || ctx.cancelled.load(Ordering::Relaxed)
            || deadline_expired(ctx.deadline_at)
            || !scope.filter.allows(file)
        {
            return;
        }
        let prefix = if use_prefix {
            display_path(scope.operand, scope.operand_path, file)
        } else {
            String::new()
        };
        ctx.files_scanned.fetch_add(1, Ordering::Relaxed);
        let Some(block) = scan_file(
            file,
            &prefix,
            (collect_until != usize::MAX).then_some(remaining),
            trust,
            ctx,
        ) else {
            return;
        };
        let mut state = lock_recover(&gathered);
        if state.0.len() >= remaining {
            done.store(true, Ordering::Relaxed);
            return;
        }
        if emitted_blocks + state.1 > 0
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
    *out.emitted_blocks += blocks;
    out.all_lines.extend(lines);
    out.all_lines.len() >= collect_until
}
