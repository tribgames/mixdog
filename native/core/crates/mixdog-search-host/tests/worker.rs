//! The helper's serve loop over pipes, as the core's end drives it: a stream runs ahead of a consumer that takes nothing by
//! the engine's queue alone, and the answers a search ends with cross whole.
#![allow(clippy::disallowed_methods, reason = "the test writes its folder with blocking calls on the test thread")]

use std::io::PipeReader;
use std::io::PipeWriter;
use std::io::Write;
use std::time::Instant;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::SearchClass;
use mixdog_core_api::domain::fs::SearchRequest;
use mixdog_graph_host::frame;
use mixdog_graph_host::frame::FrameReader;
use mixdog_search_host::wire::FromWorker;
use mixdog_search_host::wire::Item;
use mixdog_search_host::wire::PROTOCOL_VERSION;
use mixdog_search_host::wire::Search;
use mixdog_search_host::wire::ToWorker;
use mixdog_search_host::worker;
use mixdog_workspace::localfs::QUEUE;

struct Helper {
    input: Option<PipeWriter>,
    output: FrameReader<PipeReader>,
    serving: std::thread::JoinHandle<i32>,
}

impl Helper {
    fn start() -> Self {
        let (input_end, input) = std::io::pipe().expect("the input pipe");
        let (output, output_end) = std::io::pipe().expect("the output pipe");
        let serving = std::thread::spawn(move || worker::serve(input_end, output_end));
        let mut helper = Self { input: Some(input), output: FrameReader::new(output), serving };
        let FromWorker::Ready { ready } = helper.read() else { panic!("the first message is not Ready") };
        assert_eq!(ready.version, PROTOCOL_VERSION);
        helper
    }

    fn send(&mut self, message: &ToWorker) {
        let input = self.input.as_mut().expect("the input is open");
        input.write_all(&frame::encode(message).unwrap()).and_then(|()| input.flush()).expect("the helper reads its input");
    }

    fn read(&mut self) -> FromWorker {
        self.output.read::<FromWorker>().expect("a frame").expect("the helper's output is open")
    }

    fn lines(&mut self, id: u64, n: usize) -> Vec<u64> {
        (0..n)
            .map(|_| match self.read() {
                FromWorker::Item { id: from, item: Item::Match { line, .. } } if from == id => line,
                other => panic!("not a match of stream {id}: {other:?}"),
            })
            .collect()
    }

    fn end(mut self) -> i32 {
        drop(self.input.take());
        self.serving.join().expect("the serve loop")
    }
}

fn needles(lines: usize) -> (tempfile::TempDir, AbsPath) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("many.txt"), "needle\n".repeat(lines)).unwrap();
    let root = AbsPath::new(dir.path().canonicalize().unwrap()).unwrap();
    (dir, root)
}

fn search(root: &AbsPath, pattern: &str, deadline: Option<Instant>) -> SearchRequest {
    SearchRequest {
        root: root.clone(),
        pattern: pattern.to_owned(),
        regex: true,
        case_sensitive: true,
        include_globs: Vec::new(),
        exclude_globs: Vec::new(),
        include_hidden: true,
        respect_ignore: false,
        multiline: false,
        pcre2: false,
        binary_as_text: false,
        limit: None,
        first_per_file: false,
        deadline,
        class: SearchClass::Interactive,
    }
}

/// A consumer that takes nothing holds its producer at the engine's queue: after QUEUE items the helper sends nothing more
/// until told of a take, so the stream's close is answered next; each take lets exactly one more through.
#[test]
fn a_stream_runs_ahead_of_its_consumer_by_the_engines_queue_alone() {
    let (_dir, root) = needles(3 * QUEUE);
    let mut helper = Helper::start();
    let open = |id| ToWorker::Search { id, search: Search::of(&search(&root, "needle", None), Instant::now()), summary: false };

    helper.send(&open(1));
    assert_eq!(helper.lines(1, QUEUE), (1..=QUEUE as u64).collect::<Vec<_>>(), "the queue's worth, in line order");
    helper.send(&ToWorker::Close { id: 1 });
    assert_eq!(helper.read(), FromWorker::Closed { id: 1 }, "nothing past the queue was sent without a take");

    helper.send(&open(2));
    assert_eq!(helper.lines(2, QUEUE).len(), QUEUE);
    helper.send(&ToWorker::Taken { id: 2, items: 10 });
    assert_eq!(helper.lines(2, 10), (QUEUE as u64 + 1..=QUEUE as u64 + 10).collect::<Vec<_>>(), "ten takes, ten more");
    helper.send(&ToWorker::Close { id: 2 });
    assert_eq!(helper.read(), FromWorker::Closed { id: 2 });
    assert_eq!(helper.end(), worker::EXIT_DONE, "the helper ends when its input closes");
}

/// A search whose deadline has passed ends with the deadline's answer, and one whose pattern does not parse with the
/// parser's text; then each ends.
#[test]
fn a_searchs_deadline_and_refusal_cross_as_the_engine_answers_them() {
    let (_dir, root) = needles(4);
    let mut helper = Helper::start();
    helper.send(&ToWorker::Search { id: 1, search: Search::of(&search(&root, "needle", Some(Instant::now())), Instant::now()), summary: false });
    let mut last = None;
    loop {
        match helper.read() {
            FromWorker::Item { id: 1, item } => last = Some(item),
            FromWorker::End { id: 1 } => break,
            other => panic!("{other:?}"),
        }
    }
    let Some(Item::Failure { failure }) = last else { panic!("no failure last: {last:?}") };
    assert_eq!(failure.error().unwrap().kind, FsErrorKind::TimedOut);

    helper.send(&ToWorker::Search { id: 2, search: Search::of(&search(&root, "(needle", None), Instant::now()), summary: true });
    let FromWorker::Item { id: 2, item: Item::Failure { failure } } = helper.read() else { panic!("no refusal") };
    assert!(matches!(failure.error().unwrap().kind, FsErrorKind::InvalidPattern { message } if message.contains("regex parse error")));
    assert_eq!(helper.read(), FromWorker::End { id: 2 });
    helper.send(&ToWorker::Release { id: 1 });
    helper.send(&ToWorker::Release { id: 2 });
    assert_eq!(helper.end(), worker::EXIT_DONE);
}
