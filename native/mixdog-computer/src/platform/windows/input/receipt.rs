//! Checked input delivery and the input ownership receipt, free of Win32
//! (MixNativeInput, InputTransport.cs). The system call that takes events
//! (SendInput) and the key-state probe (GetAsyncKeyState) come in as
//! closures, and the receipt's storage and lock as values, so every rule here
//! runs without input.
//!
//! The receipt is memory shared by every process using one input marker: a
//! header {state, count}, up to 256 release records {type, vk, scan, flags}
//! for what this host holds, and one byte per virtual key the person holds.
//! Records change only under the cross-process lock. The person-held bytes
//! are written by the low-level input hook, which must never wait on that
//! lock, so the storage is atomic bytes.

use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT_KEYBOARD, INPUT_MOUSE, KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
};

pub const SIZE: usize = 8192;
/// The file the section is backed by, when the desktop names one: the records outlive every process that
/// held them, so the core's next start can release what a crashed core left held. The header is two
/// little-endian words, `{state, count}`; a file with both zero holds nothing.
pub const FILE_ENV: &str = "MIXDOG_COMPUTER_RECEIPT_FILE";
const STATE: usize = 0;
const COUNT: usize = 4;
const RECORDS: usize = 8;
const RECORD: usize = 16;
const CAPACITY: usize = 256;
const PERSON_HELD: usize = 5000;

const CLEAN: u32 = 0;
const IN_FLIGHT: u32 = 1;
const FAILED: u32 = 2;

const KEY: u32 = INPUT_KEYBOARD.0;
const MOUSE: u32 = INPUT_MOUSE.0;
const KEY_UP: u32 = KEYEVENTF_KEYUP.0;
/// Each button's up flag is its down flag shifted left once.
const BUTTON_DOWNS: [u32; 3] = [
    MOUSEEVENTF_LEFTDOWN.0,
    MOUSEEVENTF_RIGHTDOWN.0,
    MOUSEEVENTF_MIDDLEDOWN.0,
];
const BUTTON_UPS: u32 = MOUSEEVENTF_LEFTUP.0 | MOUSEEVENTF_RIGHTUP.0 | MOUSEEVENTF_MIDDLEUP.0;

/// How long held keys may keep an uncertain receipt from settling (HeldKeyReleaseWaitMs).
const SETTLE: Duration = Duration::from_millis(2000);
const SETTLE_POLL: Duration = Duration::from_millis(50);

pub const DELIVERY_FAILED: &str =
    "input_delivery_failed: native input was not fully delivered; completed input was not replayed";
pub const RELEASE_REJECTED: &str =
    "input_cleanup_unconfirmed: native input release was not accepted";
pub const BUSY: &str = "input_cleanup_unconfirmed: input ownership is busy";
const INVALID_DELIVERY: &str = "input_cleanup_unconfirmed: invalid native delivery receipt";
const UNCERTAIN: &str = "input_cleanup_unconfirmed: native delivery receipt is uncertain";
const INVALID_RECEIPT: &str = "input_cleanup_unconfirmed: invalid input ownership receipt";
const INVALID_RELEASE: &str = "input_cleanup_unconfirmed: invalid owned release";
const CAPACITY_EXCEEDED: &str = "input_cleanup_unconfirmed: input ownership capacity exceeded";

/// One `SendInput` event, without the marker the transport adds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// Virtual key, scan code (the UTF-16 unit of a `KEYEVENTF_UNICODE` event)
    /// and `KEYEVENTF_*` flags.
    Key { vk: u16, scan: u16, flags: u32 },
    /// `MOUSEEVENTF_*` flags, position and wheel data.
    Mouse {
        flags: u32,
        dx: i32,
        dy: i32,
        data: i32,
    },
}

impl Event {
    pub fn key(vk: u16, scan: u16, flags: u32) -> Event {
        Event::Key { vk, scan, flags }
    }

    pub fn mouse(flags: u32) -> Event {
        Event::Mouse {
            flags,
            dx: 0,
            dy: 0,
            data: 0,
        }
    }

    /// IsRelease: a key up, or a mouse event made only of button ups.
    fn is_release(&self) -> bool {
        match *self {
            Event::Key { flags, .. } => flags & KEY_UP != 0,
            Event::Mouse { flags, .. } => flags != 0 && flags & !BUTTON_UPS == 0,
        }
    }

    /// ReleasedKey: the virtual key a single release lets go of, the mouse
    /// buttons numbered as `GetAsyncKeyState` numbers them; 0 for anything else.
    fn released_key(&self) -> u16 {
        match *self {
            _ if !self.is_release() => 0,
            Event::Key { vk, .. } => vk,
            Event::Mouse { flags, .. } if flags == MOUSEEVENTF_LEFTUP.0 => 1,
            Event::Mouse { flags, .. } if flags == MOUSEEVENTF_RIGHTUP.0 => 2,
            Event::Mouse { flags, .. } if flags == MOUSEEVENTF_MIDDLEUP.0 => 4,
            Event::Mouse { .. } => 0,
        }
    }

    /// The press a recorded release undoes (DeliverTracked's history).
    fn pressed(self) -> Event {
        match self {
            Event::Key { vk, scan, flags } => Event::key(vk, scan, flags & !KEY_UP),
            Event::Mouse { flags, .. } => Event::mouse(flags >> 1),
        }
    }
}

/// What one held input is keyed by: a key by its virtual key, scan code and
/// flags without KEYUP; a button by its down flag.
#[derive(PartialEq)]
enum Hold {
    Key(u16, u16, u32),
    Button(u32),
}

fn hold(held: &mut Vec<(Hold, Event)>, hold: Hold, release: Option<Event>) {
    let at = held.iter().position(|(known, _)| *known == hold);
    match (at, release) {
        (Some(at), Some(release)) => held[at].1 = release,
        (None, Some(release)) => held.push((hold, release)),
        (Some(at), None) => {
            held.remove(at);
        }
        (None, None) => {}
    }
}

/// Outstanding: the releases that undo what `events` leave pressed. Nothing
/// positive is ever replayed.
fn outstanding(events: &[Event]) -> Vec<Event> {
    let mut held = Vec::new();
    for event in events {
        match *event {
            Event::Key { vk, scan, flags } => {
                let press = (flags & KEY_UP == 0).then(|| Event::key(vk, scan, flags | KEY_UP));
                hold(&mut held, Hold::Key(vk, scan, flags & !KEY_UP), press);
            }
            Event::Mouse { flags, .. } => {
                for down in BUTTON_DOWNS {
                    if flags & (down << 1) != 0 {
                        hold(&mut held, Hold::Button(down), None);
                    } else if flags & down != 0 {
                        hold(&mut held, Hold::Button(down), Some(Event::mouse(down << 1)));
                    }
                }
            }
        }
    }
    held.into_iter().map(|(_, release)| release).collect()
}

/// Hands events to the system and answers how many it accepted (SendInput).
pub type Transmit<'a> = dyn FnMut(&[Event]) -> Result<u32, String> + 'a;
/// Whether a virtual key or mouse button is down now (GetAsyncKeyState).
pub type KeyState<'a> = dyn Fn(u16) -> bool + 'a;

/// AnyKeyHeld.
pub fn any_held(keys: &KeyState<'_>) -> bool {
    (1..256).any(|vk| keys(vk))
}

/// Waits up to two seconds for every key and button to be up; false when one
/// is still down (the held-key wait of ReadOwned and ReleaseOwned).
pub fn settle(keys: &KeyState<'_>) -> bool {
    let started = Instant::now();
    while any_held(keys) {
        if started.elapsed() >= SETTLE {
            return false;
        }
        std::thread::sleep(SETTLE_POLL);
    }
    true
}

/// Release: sends each release on its own and goes on past one that fails.
pub fn release_each(releases: &[Event], transmit: &mut Transmit<'_>) -> Result<(), String> {
    let mut failed = false;
    for release in releases {
        if transmit(std::slice::from_ref(release)) != Ok(1) {
            failed = true;
        }
    }
    if failed {
        Err(RELEASE_REJECTED.into())
    } else {
        Ok(())
    }
}

/// Deliver: hands `events` over as one batch. A partly accepted batch lets go
/// of what its accepted prefix pressed and never sends any of it again.
pub fn deliver_with(events: &[Event], transmit: &mut Transmit<'_>) -> Result<(), String> {
    let sent = transmit(events)? as usize;
    if sent == events.len() {
        return Ok(());
    }
    if sent > events.len() {
        return Err(INVALID_DELIVERY.into());
    }
    // A failed release is a cleanup failure, not a refused positive action.
    if events.iter().all(Event::is_release) {
        return Err(RELEASE_REJECTED.into());
    }
    release_each(&outstanding(&events[..sent]), transmit)?;
    Err(DELIVERY_FAILED.into())
}

/// A left or right modifier: the generic modifier it drives and the pair's
/// left key (RecordForeignKey).
fn modifier_pair(vk: u16) -> Option<(u16, u16)> {
    match vk {
        0xA0 | 0xA1 => Some((0x10, 0xA0)),
        0xA2 | 0xA3 => Some((0x11, 0xA2)),
        0xA4 | 0xA5 => Some((0x12, 0xA4)),
        _ => None,
    }
}

/// Whether a key this host holds is why `vk` reads as down: the key itself,
/// a side of a generic modifier it holds (Windows reports an injected
/// VK_SHIFT as VK_LSHIFT) or the generic of a side it holds.
fn accounts_for(owned: u16, vk: u16) -> bool {
    let generic = |key: u16| modifier_pair(key).map(|(generic, _)| generic);
    owned == vk || generic(vk) == Some(owned) || generic(owned) == Some(vk)
}

/// The receipt's cross-process lock (OwnershipLock).
pub trait Lock {
    /// Err with the busy text when another holder keeps it past the wait.
    fn acquire(&self) -> Result<(), String>;
    fn release(&self);
}

struct Locked<'a, L: Lock>(&'a L);

impl<L: Lock> Drop for Locked<'_, L> {
    fn drop(&mut self) {
        self.0.release();
    }
}

pub struct Receipt<'a, L: Lock> {
    bytes: &'a [AtomicU8; SIZE],
    lock: &'a L,
}

impl<'a, L: Lock> Receipt<'a, L> {
    pub fn new(bytes: &'a [AtomicU8; SIZE], lock: &'a L) -> Receipt<'a, L> {
        Receipt { bytes, lock }
    }

    fn locked(&self) -> Result<Locked<'a, L>, String> {
        self.lock.acquire()?;
        Ok(Locked(self.lock))
    }

    fn word(&self, at: usize, width: usize) -> u32 {
        (0..width).fold(0, |value, i| {
            value | (self.bytes[at + i].load(Ordering::Relaxed) as u32) << (8 * i)
        })
    }

    fn set_word(&self, at: usize, width: usize, value: u32) {
        for i in 0..width {
            self.bytes[at + i].store((value >> (8 * i)) as u8, Ordering::Relaxed);
        }
    }

    /// ReadOwned, under the lock.
    fn read_owned(&self, keys: &KeyState<'_>) -> Result<Vec<Event>, String> {
        if self.word(STATE, 4) != CLEAN {
            // An uncertain receipt (killed inside SendInput, or a failed
            // release) is settled by physical evidence: once nothing is down
            // there is nothing left to release.
            if !settle(keys) {
                return Err(UNCERTAIN.into());
            }
            self.write_owned(&[])?;
        }
        let count = self.word(COUNT, 4) as i32;
        if !(0..=CAPACITY as i32).contains(&count) {
            return Err(INVALID_RECEIPT.into());
        }
        (0..count as usize)
            .map(|index| {
                let at = RECORDS + index * RECORD;
                let (kind, flags) = (self.word(at, 4), self.word(at + 8, 4));
                let release = if kind == KEY {
                    Event::key(
                        self.word(at + 4, 2) as u16,
                        self.word(at + 6, 2) as u16,
                        flags,
                    )
                } else {
                    Event::mouse(flags)
                };
                if (kind == KEY || kind == MOUSE) && release.is_release() {
                    Ok(release)
                } else {
                    Err(INVALID_RELEASE.to_string())
                }
            })
            .collect()
    }

    /// WriteOwned, under the lock: the records, then the count, then a clean state.
    fn write_owned(&self, releases: &[Event]) -> Result<(), String> {
        if releases.len() > CAPACITY {
            return Err(CAPACITY_EXCEEDED.into());
        }
        let previous = (self.word(COUNT, 4) as i32).clamp(0, CAPACITY as i32) as usize;
        for index in 0..previous.max(releases.len()) {
            let at = RECORDS + index * RECORD;
            let (kind, vk, scan, flags) = match releases.get(index) {
                Some(&Event::Key { vk, scan, flags }) => (KEY, vk, scan, flags),
                Some(&Event::Mouse { flags, .. }) => (MOUSE, 0, 0, flags),
                None => (MOUSE, 0, 0, 0),
            };
            self.set_word(at, 4, kind);
            self.set_word(at + 4, 2, vk as u32);
            self.set_word(at + 6, 2, scan as u32);
            self.set_word(at + 8, 4, flags);
        }
        self.set_word(COUNT, 4, releases.len() as u32);
        self.set_word(STATE, 4, CLEAN);
        Ok(())
    }

    fn person_holds(&self, vk: u16) -> bool {
        (1..256).contains(&vk) && self.bytes[PERSON_HELD + vk as usize].load(Ordering::Relaxed) != 0
    }

    fn set_person_holds(&self, vk: u16, held: bool) {
        self.bytes[PERSON_HELD + vk as usize].store(held as u8, Ordering::Relaxed);
    }

    /// DeliverTracked: sends `events` and records what they leave held. A
    /// release of a key the person holds is refused with nothing sent.
    pub fn deliver_tracked(
        &self,
        events: &[Event],
        transmit: &mut Transmit<'_>,
        keys: &KeyState<'_>,
    ) -> Result<u32, String> {
        let _locked = self.locked()?;
        self.track(events, transmit, keys)
    }

    fn track(
        &self,
        events: &[Event],
        transmit: &mut Transmit<'_>,
        keys: &KeyState<'_>,
    ) -> Result<u32, String> {
        let previous = self.read_owned(keys)?;
        if events
            .iter()
            .any(|event| self.person_holds(event.released_key()))
        {
            return Ok(0);
        }
        // In flight before the system call: a process killed inside SendInput
        // must not leave a receipt that invents an acknowledged prefix.
        self.set_word(STATE, 4, IN_FLIGHT);
        let sent = transmit(events)?;
        if sent as usize > events.len() {
            return Err(INVALID_DELIVERY.into());
        }
        let history: Vec<Event> = previous
            .into_iter()
            .map(Event::pressed)
            .chain(events[..sent as usize].iter().copied())
            .collect();
        self.write_owned(&outstanding(&history))?;
        Ok(sent)
    }

    /// ReleaseOwned: lets go of every key and button this receipt says the
    /// host still holds, each through the tracked path.
    pub fn release_owned(
        &self,
        transmit: &mut Transmit<'_>,
        keys: &KeyState<'_>,
    ) -> Result<(), String> {
        let _locked = self.locked()?;
        let releases = self.read_owned(keys)?;
        let released = release_each(&releases, &mut |batch| {
            self.track(batch, &mut *transmit, keys)
        });
        if released.is_err() {
            // Another cleanup caller must not retry an uncertain or failed release.
            self.set_word(STATE, 4, FAILED);
        }
        released
    }

    /// RecordForeignKey: the person pressed or let go of a key or button.
    /// Takes no lock: the input hook calls it and must never wait.
    pub fn note_person(&self, vk: u32, held: bool) {
        if !(1..256).contains(&vk) {
            return;
        }
        let vk = vk as u16;
        self.set_person_holds(vk, held);
        // A left or right modifier also drives the generic one, which is held
        // while either side is.
        if let Some((generic, left)) = modifier_pair(vk) {
            let either = self.person_holds(left) || self.person_holds(left + 1);
            self.set_person_holds(generic, either);
        }
    }

    /// BeginOwnershipObservation: what is down now and not this host's is the
    /// person's.
    pub fn begin_observation(&self, keys: &KeyState<'_>) {
        // A receipt that cannot be read names nothing as this host's, so
        // whatever is down stays the person's and is never released for them.
        let owned: Vec<u16> = self
            .locked()
            .and_then(|_locked| self.read_owned(keys))
            .map(|releases| releases.iter().map(Event::released_key).collect())
            .unwrap_or_default();
        for vk in 1..256 {
            let ours = owned.iter().any(|&key| accounts_for(key, vk));
            self.set_person_holds(vk, !ours && keys(vk));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const UNICODE: u32 = 0x4;
    const EXTENDED: u32 = 0x1;

    #[derive(Default)]
    struct FakeLock {
        held: Cell<bool>,
        busy: Cell<bool>,
        acquired: Cell<u32>,
    }

    impl Lock for FakeLock {
        fn acquire(&self) -> Result<(), String> {
            if self.busy.get() {
                return Err(BUSY.into());
            }
            assert!(!self.held.get(), "the receipt lock was taken twice");
            self.held.set(true);
            self.acquired.set(self.acquired.get() + 1);
            Ok(())
        }
        fn release(&self) {
            assert!(self.held.get(), "the receipt lock was released unheld");
            self.held.set(false);
        }
    }

    struct Fixture {
        bytes: Box<[AtomicU8; SIZE]>,
        lock: FakeLock,
    }

    impl Fixture {
        fn new() -> Fixture {
            Fixture {
                bytes: Box::new(std::array::from_fn(|_| AtomicU8::new(0))),
                lock: FakeLock::default(),
            }
        }
        fn receipt(&self) -> Receipt<'_, FakeLock> {
            Receipt::new(&self.bytes, &self.lock)
        }
        /// Sends every batch whole, as an idle desktop does.
        fn press(&self, events: &[Event]) {
            let sent = self.receipt().deliver_tracked(
                events,
                &mut |batch| Ok(batch.len() as u32),
                &|_| false,
            );
            assert_eq!(sent, Ok(events.len() as u32));
        }
        fn owned(&self) -> Vec<Event> {
            self.receipt()
                .read_owned(&|_| false)
                .expect("readable receipt")
        }
    }

    fn up(vk: u16) -> Event {
        Event::key(vk, 0, KEY_UP)
    }

    fn down(vk: u16) -> Event {
        Event::key(vk, 0, 0)
    }

    fn nothing_held(_: u16) -> bool {
        false
    }

    fn all_held(_: u16) -> bool {
        true
    }

    const NOTHING_HELD: &KeyState<'static> = &nothing_held;
    const ALL_HELD: &KeyState<'static> = &all_held;

    // input-transport.test.mjs: checked delivery.
    #[test]
    fn a_partial_batch_releases_only_its_accepted_presses() {
        let batches = [
            [down(13), up(13)],
            [
                Event::key(0, 65, UNICODE),
                Event::key(0, 65, UNICODE | KEY_UP),
            ],
            [
                Event::mouse(MOUSEEVENTF_LEFTDOWN.0),
                Event::mouse(MOUSEEVENTF_LEFTUP.0),
            ],
        ];
        for batch in batches {
            for accepted in 0..=2u32 {
                let (mut calls, mut downs, mut held) = (0, 0, false);
                let outcome = deliver_with(&batch, &mut |events| {
                    calls += 1;
                    let count = if calls == 1 {
                        accepted
                    } else {
                        events.len() as u32
                    };
                    for event in &events[..count as usize] {
                        held = !event.is_release();
                        downs += held as u32;
                    }
                    Ok(count)
                });
                assert!(!held, "partial input remained held: {batch:?} {accepted}");
                assert_eq!(downs, (accepted > 0) as u32, "positive input was replayed");
                assert_eq!(calls, if accepted == 1 { 2 } else { 1 }, "unexpected retry");
                let expected = if accepted == 2 {
                    Ok(())
                } else {
                    Err(DELIVERY_FAILED.to_string())
                };
                assert_eq!(outcome, expected);
            }
        }
    }

    #[test]
    fn a_rejected_rollback_is_a_cleanup_failure() {
        let (mut calls, mut downs) = (0, 0);
        let outcome = deliver_with(&[down(13), up(13)], &mut |events| {
            calls += 1;
            if calls > 1 {
                return Ok(0);
            }
            downs += 1;
            assert!(!events[0].is_release());
            Ok(1)
        });
        assert_eq!(outcome, Err(RELEASE_REJECTED.to_string()));
        assert_eq!(
            (calls, downs),
            (2, 1),
            "failed release retried or action replayed"
        );
    }

    #[test]
    fn a_rejected_release_batch_and_an_over_count_are_cleanup_failures() {
        let outcome = deliver_with(&[up(0x10), Event::mouse(MOUSEEVENTF_LEFTUP.0)], &mut |_| {
            Ok(1)
        });
        assert_eq!(outcome, Err(RELEASE_REJECTED.to_string()));
        let outcome = deliver_with(&[down(0x41)], &mut |_| Ok(2));
        assert_eq!(outcome, Err(INVALID_DELIVERY.to_string()));
        // A mixed batch that is refused whole has nothing to roll back.
        let mut calls = 0;
        let outcome = deliver_with(&[up(0x10), down(0x41)], &mut |_| {
            calls += 1;
            Ok(0)
        });
        assert_eq!((outcome, calls), (Err(DELIVERY_FAILED.to_string()), 1));
    }

    #[test]
    fn outstanding_pairs_presses_with_their_releases() {
        let left = MOUSEEVENTF_LEFTDOWN.0;
        let right = MOUSEEVENTF_RIGHTDOWN.0;
        let events = [
            Event::mouse(left | 0x1), // a press that also moves
            Event::mouse(right),
            Event::mouse(MOUSEEVENTF_LEFTUP.0),
            Event::key(0xA3, 0, EXTENDED),
            Event::key(0xA3, 0, EXTENDED | KEY_UP),
            Event::key(0, 0x263A, UNICODE),
            down(0x41),
            down(0x41),
        ];
        assert_eq!(
            outstanding(&events),
            vec![
                Event::mouse(MOUSEEVENTF_RIGHTUP.0),
                Event::key(0, 0x263A, UNICODE | KEY_UP),
                up(0x41),
            ]
        );
        assert_eq!(
            outstanding(&[Event::mouse(MOUSEEVENTF_MIDDLEDOWN.0)]),
            vec![Event::mouse(MOUSEEVENTF_MIDDLEUP.0)]
        );
        assert!(
            outstanding(&[Event::mouse(0x800)]).is_empty(),
            "a wheel holds nothing"
        );
    }

    // input-transport.test.mjs: the tracked receipt end to end.
    #[test]
    fn the_receipt_releases_exactly_what_this_host_holds() {
        let fixture = Fixture::new();
        let receipt = fixture.receipt();
        fixture.press(&[
            down(13),
            Event::key(0xA3, 0, EXTENDED),
            Event::mouse(MOUSEEVENTF_LEFTDOWN.0),
            down(0x41),
        ]);
        receipt.note_person(0x10, true);
        receipt.note_person(0xA3, true);
        let mut conflicting = 0;
        let sent = receipt.deliver_tracked(
            &[Event::key(0xA3, 0, EXTENDED | KEY_UP)],
            &mut |_| {
                conflicting += 1;
                Ok(1)
            },
            NOTHING_HELD,
        );
        assert_eq!(
            (sent, conflicting),
            (Ok(0), 0),
            "released a key now held by the person"
        );
        // Everything this host holds reads as down when observation begins,
        // and the person holds Shift: each held input stays this host's.
        receipt.note_person(0x41, true);
        receipt.begin_observation(&|vk| matches!(vk, 13 | 0xA3 | 0x41 | 1 | 0x10));
        let mut released = 0;
        let sent = receipt.deliver_tracked(
            &[up(0x41)],
            &mut |_| {
                released += 1;
                Ok(1)
            },
            NOTHING_HELD,
        );
        assert_eq!(
            (sent, released),
            (Ok(1), 1),
            "refused the release of a key this host holds"
        );
        receipt.note_person(0xA3, true);
        receipt.note_person(0xA3, false);
        let (mut attempts, mut enter, mut right_control_extended) = (0, false, false);
        let outcome = receipt.release_owned(
            &mut |events| {
                attempts += 1;
                match events[0] {
                    Event::Key { vk, flags, .. } => {
                        assert!(flags & KEY_UP != 0, "cleanup pressed a key");
                        assert_ne!(vk, 0x10, "released the person's Shift");
                        enter |= vk == 13;
                        if vk == 0xA3 {
                            right_control_extended = flags & EXTENDED != 0;
                        }
                    }
                    Event::Mouse { flags, .. } => {
                        assert_eq!(
                            flags & !BUTTON_UPS,
                            0,
                            "cleanup moved or pressed the pointer"
                        )
                    }
                }
                Ok(if attempts == 1 { 0 } else { 1 })
            },
            NOTHING_HELD,
        );
        assert_eq!(outcome, Err(RELEASE_REJECTED.to_string()));
        assert!(
            attempts == 3 && enter && right_control_extended,
            "cleanup did not release exactly the owned inputs"
        );
        // The failed release is latched: while anything is down it is not retried.
        let outcome = receipt.release_owned(
            &mut |_| {
                attempts += 1;
                Ok(1)
            },
            ALL_HELD,
        );
        assert_eq!(outcome, Err(UNCERTAIN.to_string()));
        assert_eq!(
            attempts, 3,
            "a failed release was retried while a key is held"
        );
        // Once nothing is down the receipt resets to empty, without replaying.
        assert_eq!(
            receipt.release_owned(
                &mut |_| {
                    attempts += 1;
                    Ok(1)
                },
                NOTHING_HELD
            ),
            Ok(())
        );
        assert_eq!(
            receipt.release_owned(
                &mut |_| {
                    attempts += 1;
                    Ok(1)
                },
                ALL_HELD
            ),
            Ok(())
        );
        assert_eq!(attempts, 3, "the reset receipt replayed a release");
        // A button this host holds reads as down too; the person's other
        // button stays theirs.
        fixture.press(&[Event::mouse(MOUSEEVENTF_LEFTDOWN.0)]);
        receipt.begin_observation(&|vk| vk == 1 || vk == 2);
        let mut person_button = 0;
        let sent = receipt.deliver_tracked(
            &[Event::mouse(MOUSEEVENTF_RIGHTUP.0)],
            &mut |_| {
                person_button += 1;
                Ok(1)
            },
            NOTHING_HELD,
        );
        assert_eq!(
            (sent, person_button),
            (Ok(0), 0),
            "released a button the person holds"
        );
        let mut pointer = Vec::new();
        let outcome = receipt.release_owned(
            &mut |events| {
                pointer.extend_from_slice(events);
                Ok(1)
            },
            NOTHING_HELD,
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(pointer, vec![Event::mouse(MOUSEEVENTF_LEFTUP.0)]);
        assert!(!fixture.lock.held.get());
    }

    // input-ownership.test.mjs: a receipt outlives its writer and never
    // guesses an unacknowledged prefix.
    #[test]
    fn a_lost_delivery_receipt_is_settled_only_by_physical_evidence() {
        let fixture = Fixture::new();
        let receipt = fixture.receipt();
        fixture.press(&[down(0x11), Event::mouse(MOUSEEVENTF_LEFTDOWN.0)]);
        let mut released = Vec::new();
        let outcome = receipt.release_owned(
            &mut |events| {
                released.extend_from_slice(events);
                Ok(1)
            },
            NOTHING_HELD,
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(released, vec![up(0x11), Event::mouse(MOUSEEVENTF_LEFTUP.0)]);
        assert_eq!(
            receipt.release_owned(
                &mut |_| panic!("completed releases were repeated"),
                NOTHING_HELD
            ),
            Ok(())
        );
        // The system call never answers (the writer died inside SendInput).
        let lost = receipt.deliver_tracked(
            &[down(13)],
            &mut |_| Err("lost delivery receipt".into()),
            NOTHING_HELD,
        );
        assert!(lost.is_err());
        assert_eq!(fixture.receipt().word(STATE, 4), IN_FLIGHT);
        let outcome = receipt.release_owned(
            &mut |_| panic!("guessed an unacknowledged prefix"),
            ALL_HELD,
        );
        assert_eq!(outcome, Err(UNCERTAIN.to_string()));
        let outcome = receipt.release_owned(
            &mut |_| panic!("replayed after the receipt reset"),
            NOTHING_HELD,
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(fixture.receipt().word(STATE, 4), CLEAN);
    }

    #[test]
    fn the_receipt_holds_at_most_256_releases() {
        let fixture = Fixture::new();
        let receipt = fixture.receipt();
        let presses: Vec<Event> = (1..=256).map(|unit| Event::key(0, unit, UNICODE)).collect();
        fixture.press(&presses);
        assert_eq!(fixture.owned().len(), 256);
        let mut sent = 0;
        let outcome = receipt.deliver_tracked(
            &[Event::key(0, 257, UNICODE)],
            &mut |events| {
                sent += 1;
                Ok(events.len() as u32)
            },
            NOTHING_HELD,
        );
        assert_eq!(outcome, Err(CAPACITY_EXCEEDED.to_string()));
        assert_eq!(sent, 1);
        // The press went out unrecorded, so the receipt is uncertain until
        // nothing is down.
        assert_eq!(receipt.word(STATE, 4), IN_FLIGHT);
        assert_eq!(
            receipt.release_owned(&mut |_| panic!("released a guessed record"), NOTHING_HELD),
            Ok(())
        );
        assert!(fixture.owned().is_empty());
        let releases: Vec<Event> = (1..=256)
            .map(|unit| Event::key(0, unit, UNICODE | KEY_UP))
            .collect();
        assert_eq!(receipt.write_owned(&releases), Ok(()));
        let mut released = 0;
        let outcome = receipt.release_owned(
            &mut |events| {
                assert!(events[0].is_release());
                released += 1;
                Ok(1)
            },
            NOTHING_HELD,
        );
        assert_eq!((outcome, released), (Ok(()), 256));
        let too_many: Vec<Event> = (0..=256)
            .map(|unit| Event::key(0, unit, UNICODE | KEY_UP))
            .collect();
        assert_eq!(
            receipt.write_owned(&too_many),
            Err(CAPACITY_EXCEEDED.to_string())
        );
    }

    #[test]
    fn an_invalid_receipt_is_refused_without_input() {
        let fixture = Fixture::new();
        let receipt = fixture.receipt();
        let never = &mut |_: &[Event]| -> Result<u32, String> {
            panic!("sent input from an invalid receipt")
        };
        // A press stored as a release.
        receipt.set_word(RECORDS, 4, KEY);
        receipt.set_word(RECORDS + 4, 2, 0x41);
        receipt.set_word(COUNT, 4, 1);
        assert_eq!(
            receipt.release_owned(never, NOTHING_HELD),
            Err(INVALID_RELEASE.to_string())
        );
        // An unknown input type.
        receipt.set_word(RECORDS, 4, 2);
        receipt.set_word(RECORDS + 8, 4, KEY_UP);
        assert_eq!(
            receipt.release_owned(never, NOTHING_HELD),
            Err(INVALID_RELEASE.to_string())
        );
        for count in [257, u32::MAX] {
            receipt.set_word(COUNT, 4, count);
            assert_eq!(
                receipt.release_owned(never, NOTHING_HELD),
                Err(INVALID_RECEIPT.to_string())
            );
        }
        let mut sent = 0;
        let outcome = receipt.deliver_tracked(
            &[down(0x41)],
            &mut |_| {
                sent += 1;
                Ok(1)
            },
            NOTHING_HELD,
        );
        assert_eq!((outcome, sent), (Err(INVALID_RECEIPT.to_string()), 0));
    }

    #[test]
    fn a_busy_lock_refuses_before_any_input() {
        let fixture = Fixture::new();
        let receipt = fixture.receipt();
        fixture.press(&[down(0x41)]);
        fixture.lock.busy.set(true);
        let never =
            &mut |_: &[Event]| -> Result<u32, String> { panic!("sent input without the lock") };
        assert_eq!(
            receipt.deliver_tracked(&[up(0x41)], never, NOTHING_HELD),
            Err(BUSY.to_string())
        );
        assert_eq!(
            receipt.release_owned(never, NOTHING_HELD),
            Err(BUSY.to_string())
        );
        // The input hook records the person without the lock.
        receipt.note_person(0x41, true);
        assert!(receipt.person_holds(0x41));
        fixture.lock.busy.set(false);
        assert_eq!(fixture.owned(), vec![up(0x41)]);
    }

    #[test]
    fn left_and_right_modifiers_drive_the_generic_one() {
        let fixture = Fixture::new();
        let receipt = fixture.receipt();
        for (generic, left) in [(0x10, 0xA0), (0x11, 0xA2), (0x12, 0xA4)] {
            receipt.note_person(left as u32, true);
            receipt.note_person(left as u32 + 1, true);
            assert!(receipt.person_holds(generic));
            receipt.note_person(left as u32, false);
            assert!(receipt.person_holds(generic), "held while either side is");
            receipt.note_person(left as u32 + 1, false);
            assert!(!receipt.person_holds(generic));
            receipt.note_person(left as u32 + 1, true);
            assert!(receipt.person_holds(generic));
            receipt.note_person(left as u32 + 1, false);
        }
        receipt.note_person(0x41, true);
        assert!(
            !receipt.person_holds(0x10)
                && !receipt.person_holds(0x11)
                && !receipt.person_holds(0x12)
        );
        receipt.note_person(0, true);
        receipt.note_person(256, true);
        assert!(!receipt.person_holds(0));
    }

    #[test]
    fn a_release_of_a_key_the_person_holds_is_refused() {
        let fixture = Fixture::new();
        let receipt = fixture.receipt();
        fixture.press(&[down(0x10), down(0x41)]);
        receipt.note_person(0xA0, true);
        let mut sent = 0;
        let mut transmit = |events: &[Event]| -> Result<u32, String> {
            sent += 1;
            Ok(events.len() as u32)
        };
        let outcome = deliver_with(&[up(0x10)], &mut |batch| {
            receipt.deliver_tracked(batch, &mut transmit, NOTHING_HELD)
        });
        assert_eq!(outcome, Err(RELEASE_REJECTED.to_string()));
        assert_eq!(fixture.owned(), vec![up(0x10), up(0x41)]);
        // An abort never lets go of a modifier the person took over, and says
        // its cleanup is unconfirmed.
        let mut released = Vec::new();
        let outcome = receipt.release_owned(
            &mut |events| {
                released.extend_from_slice(events);
                Ok(1)
            },
            NOTHING_HELD,
        );
        assert_eq!(outcome, Err(RELEASE_REJECTED.to_string()));
        assert_eq!(released, vec![up(0x41)]);
        assert_eq!(
            (receipt.word(STATE, 4), receipt.word(COUNT, 4)),
            (FAILED, 1)
        );
        // Once the person lets go nothing is down, so the latched receipt
        // settles empty and the next release goes out.
        receipt.note_person(0xA0, false);
        let outcome = deliver_with(&[up(0x10)], &mut |batch| {
            receipt.deliver_tracked(batch, &mut transmit, NOTHING_HELD)
        });
        assert_eq!(outcome, Ok(()));
        assert_eq!(sent, 1);
        assert!(fixture.owned().is_empty());
    }

    #[test]
    fn observation_seeds_what_is_down_and_not_this_hosts() {
        let fixture = Fixture::new();
        let receipt = fixture.receipt();
        fixture.press(&[down(0x41), down(0x10)]);
        receipt.note_person(0x42, true);
        // This host's Shift also reads as left Shift; the person holds Ctrl
        // and the right button.
        receipt.begin_observation(&|vk| matches!(vk, 0x41 | 0x10 | 0xA0 | 0x11 | 0xA2 | 2));
        for vk in [0x41, 0x10, 0xA0, 0x42] {
            assert!(!receipt.person_holds(vk), "{vk:#x} is not the person's");
        }
        for vk in [0x11, 0xA2, 2] {
            assert!(receipt.person_holds(vk), "{vk:#x} is the person's");
        }
        // An unreadable receipt names nothing as this host's.
        fixture.lock.busy.set(true);
        receipt.begin_observation(&|vk| vk == 0x41);
        assert!(receipt.person_holds(0x41));
    }
}
