//! The password hash iteration of [MS-OFFCRYPTO] 2.3.4.7 (standard) and 2.3.4.11 (agile), and the verifier check that
//! says whether a password is right (2.3.4.9, 2.3.4.13).
//!
//! H0 = H(salt + password as UTF-16LE), Hn = H(iterator + Hn-1) for iterator 0 .. spinCount - 1: up to 10,000,000
//! hashes. Each derivation runs on a dedicated thread of its own that checks an atomic cancel flag inside the loop, so
//! a cancelled request ends it at once; at most [`MAX_KEY_DERIVATIONS`] run at a time, later ones wait in the order they
//! were started, and one cancelled while waiting never starts.

use std::collections::{BTreeSet, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;

use crate::decrypt::{CryptoError, Mode, aes_decrypt, fitted, uint32};
use crate::descriptor::{AgileDescriptor, Descriptor, StandardDescriptor};
use crate::hashes::{HashAlgorithm, HashError, Hasher, constant_time_equal, hash};

/// 2.3.4.13: the block keys of the verifier input, the verifier hash and the encrypted key.
const VERIFIER_INPUT_BLOCK: [u8; 8] = [0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79];
const VERIFIER_HASH_BLOCK: [u8; 8] = [0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e];
const ENCRYPTED_KEY_BLOCK: [u8; 8] = [0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6];
/// 2.3.4.7: standard encryption hashes the password 50,000 times.
const STANDARD_SPIN_COUNT: u32 = 50_000;
/// Password derivations that may run at once, each on its own thread; later ones wait for a free one.
pub const MAX_KEY_DERIVATIONS: usize = 2;

/// Why a key could not be derived.
#[derive(Debug)]
pub enum KeyError {
    /// The request was cancelled before or while the password was hashed.
    Cancelled,
    /// The derivation thread ended without an answer.
    EndedEarly,
    /// The derivation thread could not be started.
    Spawn(String),
    Crypto(CryptoError),
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => f.write_str("The password derivation was cancelled."),
            Self::EndedEarly => f.write_str("The password derivation ended early (exit code 1)."),
            Self::Spawn(reason) => f.write_str(reason),
            Self::Crypto(error) => fmt::Display::fmt(error, f),
        }
    }
}

impl std::error::Error for KeyError {}

impl From<CryptoError> for KeyError {
    fn from(error: CryptoError) -> Self {
        Self::Crypto(error)
    }
}

impl From<HashError> for KeyError {
    fn from(error: HashError) -> Self {
        Self::Crypto(CryptoError::Hash(error))
    }
}

/// Password derivations running on their threads and waiting for one (for diagnostics and tests).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DerivationCounts {
    pub running: usize,
    pub waiting: usize,
}

#[derive(Default)]
struct Scheduler {
    running: usize,
    next_ticket: u64,
    queue: VecDeque<u64>,
    granted: BTreeSet<u64>,
}

static SCHEDULER: Mutex<Scheduler> = Mutex::new(Scheduler {
    running: 0,
    next_ticket: 0,
    queue: VecDeque::new(),
    granted: BTreeSet::new(),
});
static SLOT_FREED: Condvar = Condvar::new();

fn scheduler() -> MutexGuard<'static, Scheduler> {
    SCHEDULER.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The derivations running and waiting right now.
#[must_use]
pub fn key_derivations() -> DerivationCounts {
    let state = scheduler();
    DerivationCounts {
        running: state.running,
        waiting: state.queue.len(),
    }
}

/// A flag a request raises to end its password derivation; clones share it.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Ends the derivation at its next hash, or keeps a waiting one from starting.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
        // Taken and released so a waiter between its check of the flag and its wait cannot miss the wake-up.
        drop(scheduler());
        SLOT_FREED.notify_all();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// A place in the line for one of the derivation slots, taken when the derivation is started.
#[derive(Clone, Copy)]
struct Ticket {
    id: u64,
}

fn take_ticket() -> Ticket {
    let mut state = scheduler();
    let id = state.next_ticket;
    state.next_ticket += 1;
    if state.running < MAX_KEY_DERIVATIONS {
        state.running += 1;
        state.granted.insert(id);
    } else {
        state.queue.push_back(id);
    }
    Ticket { id }
}

/// Frees a held slot and gives it to the first one waiting. Dropped on every way the derivation thread can end.
struct Slot;

impl Drop for Slot {
    fn drop(&mut self) {
        let mut state = scheduler();
        state.running -= 1;
        if let Some(next) = state.queue.pop_front() {
            state.running += 1;
            state.granted.insert(next);
        }
        drop(state);
        SLOT_FREED.notify_all();
    }
}

/// Waits for the ticket's slot; a request cancelled while it waits leaves the line without starting.
fn wait_for_slot(ticket: &Ticket, cancel: &CancelToken) -> Result<Slot, KeyError> {
    let mut state = scheduler();
    loop {
        if state.granted.remove(&ticket.id) {
            return Ok(Slot);
        }
        if cancel.is_cancelled() {
            state.queue.retain(|id| *id != ticket.id);
            return Err(KeyError::Cancelled);
        }
        state = SLOT_FREED
            .wait(state)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
}

/// The ticket of a derivation whose thread could not be started is given back.
fn abandon(ticket: &Ticket) {
    let held = {
        let mut state = scheduler();
        state.queue.retain(|id| *id != ticket.id);
        state.granted.remove(&ticket.id)
    };
    if held {
        drop(Slot);
    }
}

fn utf16le(password: &str) -> Vec<u8> {
    password.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

/// 2.3.4.7 / 2.3.4.11: H0 = H(salt + password), Hn = H(iterator + Hn-1). The cancel flag is read before every hash.
fn iterated_hash(
    algorithm: HashAlgorithm,
    salt: &[u8],
    password: &str,
    spin_count: u32,
    cancel: &CancelToken,
) -> Result<Vec<u8>, KeyError> {
    if cancel.is_cancelled() {
        return Err(KeyError::Cancelled);
    }
    let mut start = Hasher::new(algorithm)?;
    start.update(salt);
    start.update(&utf16le(password));
    let mut value = start.finish();
    for index in 0..spin_count {
        if cancel.is_cancelled() {
            return Err(KeyError::Cancelled);
        }
        let mut round = Hasher::new(algorithm)?;
        round.update(&uint32(index));
        round.update(&value);
        value = round.finish();
    }
    Ok(value.to_vec())
}

fn agile_key(descriptor: &AgileDescriptor, password: &str, cancel: &CancelToken) -> Result<Option<Vec<u8>>, KeyError> {
    let key = &descriptor.key;
    let spun = iterated_hash(key.algorithm, &key.salt, password, descriptor.spin_count, cancel)?;
    let iv = fitted(&key.salt, key.block_size);
    let open = |block: &[u8], data: &[u8]| -> Result<Vec<u8>, KeyError> {
        let block_key = fitted(&hash(key.algorithm, &[&spun, block])?, key.key_bits / 8);
        Ok(aes_decrypt(Mode::Cbc, &block_key, &iv, data)?)
    };
    // 2.3.4.13: the decrypted verifier input, hashed, must equal the decrypted verifier hash.
    let opened_input = open(&VERIFIER_INPUT_BLOCK, &descriptor.verifier_input)?;
    let input = &opened_input[..key.salt_size.min(opened_input.len())];
    let expected = hash(key.algorithm, &[input])?;
    let opened_hash = open(&VERIFIER_HASH_BLOCK, &descriptor.verifier_hash)?;
    let actual = &opened_hash[..key.hash_size.min(opened_hash.len())];
    if !constant_time_equal(actual, &expected) {
        return Ok(None);
    }
    // 2.3.4.13: the intermediate key that encrypts the package.
    let opened_key = open(&ENCRYPTED_KEY_BLOCK, &descriptor.encrypted_key)?;
    let length = (descriptor.data.key_bits / 8).min(opened_key.len());
    Ok(Some(opened_key[..length].to_vec()))
}

/// 2.3.4.7: the key derived from the iterated SHA-1 hash, and 2.3.4.9: the verifier check.
fn standard_key(
    descriptor: &StandardDescriptor,
    password: &str,
    cancel: &CancelToken,
) -> Result<Option<Vec<u8>>, KeyError> {
    let spun = iterated_hash(
        HashAlgorithm::Sha1,
        &descriptor.salt,
        password,
        STANDARD_SPIN_COUNT,
        cancel,
    )?;
    let final_hash = hash(HashAlgorithm::Sha1, &[&spun, &uint32(0)])?;
    let derive = |fill: u8| -> Result<Vec<u8>, KeyError> {
        let mut buffer = [fill; 64];
        for (byte, mask) in buffer.iter_mut().zip(final_hash.iter()) {
            *byte ^= mask;
        }
        Ok(hash(HashAlgorithm::Sha1, &[&buffer])?.to_vec())
    };
    let mut key = derive(0x36)?;
    key.extend_from_slice(&derive(0x5c)?);
    key.truncate(descriptor.key_bits / 8);
    let verifier = aes_decrypt(Mode::Ecb, &key, &[], &descriptor.verifier)?;
    let expected = hash(HashAlgorithm::Sha1, &[&verifier])?;
    let opened_hash = aes_decrypt(Mode::Ecb, &key, &[], &descriptor.verifier_hash)?;
    let actual = &opened_hash[..descriptor.verifier_hash_size.min(opened_hash.len())];
    Ok(constant_time_equal(actual, &expected).then_some(key))
}

/// A password derivation running on its thread. `wait` gives the key when the password is right and `None` when it is
/// wrong; cancelling ends the thread.
pub struct KeyDerivation {
    cancel: CancelToken,
    thread: JoinHandle<Result<Option<Vec<u8>>, KeyError>>,
}

impl KeyDerivation {
    /// Starts the derivation of the key that decrypts the package when `password` is right. The verifier alone decides;
    /// the package is not touched. A request already cancelled does not start, and takes no slot.
    pub fn start(descriptor: &Descriptor, password: &str, cancel: &CancelToken) -> Result<Self, KeyError> {
        if cancel.is_cancelled() {
            return Err(KeyError::Cancelled);
        }
        let ticket = take_ticket();
        let (descriptor, password, token) = (descriptor.clone(), password.to_owned(), cancel.clone());
        let spawned = std::thread::Builder::new()
            .name("office-key-derivation".to_owned())
            .spawn(move || {
                let _slot = wait_for_slot(&ticket, &token)?;
                match &descriptor {
                    Descriptor::Agile(agile) => agile_key(agile, &password, &token),
                    Descriptor::Standard(standard) => standard_key(standard, &password, &token),
                }
            });
        match spawned {
            Ok(thread) => Ok(Self {
                cancel: cancel.clone(),
                thread,
            }),
            Err(error) => {
                abandon(&ticket);
                Err(KeyError::Spawn(error.to_string()))
            }
        }
    }

    /// Ends the derivation at its next hash.
    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.thread.is_finished()
    }

    /// Blocks until the derivation ends. A thread that ended without answering is [`KeyError::EndedEarly`].
    pub fn wait(self) -> Result<Option<Vec<u8>>, KeyError> {
        self.thread.join().unwrap_or(Err(KeyError::EndedEarly))
    }
}

/// The key that decrypts the package when `password` is right, else `None`: [`KeyDerivation::start`] and its wait.
pub fn password_key(
    descriptor: &Descriptor,
    password: &str,
    cancel: &CancelToken,
) -> Result<Option<Vec<u8>>, KeyError> {
    KeyDerivation::start(descriptor, password, cancel)?.wait()
}
