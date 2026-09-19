// Resident search server: JSONL over stdio, one request per line.
//
// Motivation (measured): every grep pays ~100ms of Windows process spawn +
// AV on-access scan for rg while the actual match work is ~5-10ms. This mode
// keeps ONE warm process and answers rg-COMPATIBLE content searches without a
// spawn. The Node side forwards the exact rg argv it would have used;
// unsupported requests fail explicitly; there is no external rg fallback.
//
// Request : {"id":1,"cwd":"C:/repo","args":["--color","never",...],"offset":0,"limit":400}
// Response: {"id":1,"lines":[...],"complete":true,"totalSeen":N}
//         | {"id":1,"unsupported":"reason"} | {"id":1,"error":"..."}
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, OnceLock, RwLock, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use grep::matcher::Matcher;
use grep::printer::{StandardBuilder, SummaryBuilder, SummaryKind};
use grep::searcher::{
    BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkFinish, SinkMatch,
};
use ignore::overrides::{Override, OverrideBuilder};
use ignore::types::{Types, TypesBuilder};
use ignore::WalkBuilder;
use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config as FuzzyConfig, Matcher as FuzzyMatcher, Utf32String};
use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};
use serde::Deserialize;

use crate::serve_search_lifecycle::InventoryLease;

// One resident server, split by responsibility. Every child module reads
// the shared imports and sibling items through `use super::*`, so the
// namespace is exactly the one this file had as a single unit.
mod config;
mod fuzzy;
mod keys;
mod matching;
mod mtime;
mod paths;
mod protocol;
mod response;
mod scheduler;
mod search;
mod server;
mod signature;
mod snapshot;
mod store;
mod walk;
mod watch;

use config::*;
use fuzzy::*;
use keys::*;
use matching::*;
use mtime::*;
use paths::*;
use protocol::*;
use response::*;
use scheduler::*;
use search::*;
use server::*;
use signature::*;
use snapshot::*;
use store::*;
use walk::*;
#[cfg(test)]
use watch::*;

pub use server::{run, IdlePolicy, SearchServer};

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests_inventory;
#[cfg(test)]
mod tests_runtime;
#[cfg(test)]
mod tests_search;
#[cfg(test)]
mod tests_signature;
