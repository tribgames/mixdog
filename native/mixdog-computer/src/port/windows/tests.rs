//! Forced-order tests of the Windows port over a fake system: the fake's log is what reached Windows, in order.

use super::fake::FakeWin;
use super::*;
use crate::port::fake::Pause;
use crate::port::{Cleanup, Scope, REVOKED};
use std::sync::{Arc, Mutex};

const A_DOWN: Event = Event::Key { vk: 0x41, scan: 0, flags: 0 };
const A_UP: Event = Event::Key { vk: 0x41, scan: 0, flags: KEY_UP };
const B_DOWN: Event = Event::Key { vk: 0x42, scan: 0, flags: 0 };
const B_UP: Event = Event::Key { vk: 0x42, scan: 0, flags: KEY_UP };
const LEFT_DOWN: Event = Event::Mouse { flags: 0x2, dx: 0, dy: 0, data: 0 };
const LEFT_UP: Event = Event::Mouse { flags: 0x4, dx: 0, dy: 0, data: 0 };
const RIGHT_DOWN: Event = Event::Mouse { flags: 0x8, dx: 0, dy: 0, data: 0 };
const RIGHT_UP: Event = Event::Mouse { flags: 0x10, dx: 0, dy: 0, data: 0 };
const MOVE: Event = Event::Mouse { flags: 0x8001, dx: 10, dy: 10, data: 0 };

/// Held right before its admission, a `SendInput` that resumes after Off was acknowledged reaches nothing.
#[test]
fn a_send_paused_before_admission_resumes_after_the_acknowledgement_and_sends_nothing() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    let pause = fake.pause_before("input");
    std::thread::scope(|threads| {
        let sending = threads.spawn(|| port.input(&[A_DOWN, A_UP]));
        pause.reached.wait();
        scope.revoke();
        pause.resume.wait();
        assert_eq!(sending.join().unwrap(), Err(REVOKED.to_string()));
    });
    assert!(fake.log().is_empty());
    assert!(port.holds().is_empty());
}

/// Admitted first, the send wins: the acknowledgement comes only once the system took it, and nothing follows it.
#[test]
fn a_send_already_admitted_lands_before_the_acknowledgement() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    let pause = Pause::new();
    *fake.inside.lock().unwrap() = Some(pause.clone());
    let acknowledged = std::sync::atomic::AtomicBool::new(false);
    std::thread::scope(|threads| {
        let sending = threads.spawn(|| port.input(&[A_DOWN]));
        pause.reached.wait();
        let revoker = threads.spawn(|| {
            scope.revoke();
            acknowledged.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        while !scope.is_revoked() {
            std::thread::yield_now();
        }
        assert!(!acknowledged.load(std::sync::atomic::Ordering::SeqCst));
        pause.resume.wait();
        assert_eq!(sending.join().unwrap(), Ok(()));
        revoker.join().unwrap();
    });
    assert_eq!(port.input(&[B_DOWN]), Err(REVOKED.to_string()));
    // The press that won is owned: its release is the only thing left to go out.
    assert!(scope.release_held());
    assert_eq!(fake.log(), ["input key 0x41 down", "input key 0x41 up"]);
}

/// After Off a release goes out once per receipt, whether the operation or the cleanup sends it; one without a receipt, a
/// second one, and the motion part of a batch are refused, while the batch's owned release still goes out alone.
#[test]
fn after_off_only_owned_releases_go_out_and_each_once() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    port.input(&[A_DOWN]).unwrap();
    port.input(&[LEFT_DOWN]).unwrap();
    port.input(&[B_DOWN]).unwrap();
    scope.revoke();
    // The drag's next motion and a new press are refused; the owned up goes out.
    assert_eq!(port.input(&[MOVE]), Err(REVOKED.to_string()));
    assert_eq!(port.input(&[LEFT_UP]), Ok(()));
    assert_eq!(port.input(&[LEFT_UP]), Err(REVOKED.to_string()), "a double release");
    assert_eq!(port.input(&[Event::Key { vk: 0x43, scan: 0, flags: KEY_UP }]), Err(REVOKED.to_string()), "no receipt");
    assert_eq!(port.input(&[A_UP, MOVE]), Err(REVOKED.to_string()), "the motion is refused; the owned up went out");
    assert_eq!(port.input(&[A_UP]), Err(REVOKED.to_string()), "consumed by the batch before");
    // The cleanup lets go of what is left; the operation's own release after it sends nothing again.
    assert!(scope.release_held());
    assert_eq!(port.input(&[B_UP]), Ok(()));
    assert_eq!(
        fake.log(),
        [
            "input key 0x41 down",
            "input mouse 0x2 0 0 0",
            "input key 0x42 down",
            "input mouse 0x4 0 0 0",
            "input key 0x41 up",
            "input key 0x42 up",
        ]
    );
    assert!(port.holds().is_empty());
}

/// A release event whose flags also carry motion, a wheel or absolute coordinates: after Off only the bare release the receipt
/// names goes out (no coordinates, no wheel data), and two releases of one hold in one batch consume its receipt once.
#[test]
fn a_combined_release_is_split_and_a_double_release_in_one_batch_consumes_once() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    port.input(&[LEFT_DOWN]).unwrap();
    port.input(&[RIGHT_DOWN]).unwrap();
    scope.revoke();
    let up_and_move = Event::Mouse { flags: 0x4 | 0x1 | 0x8000, dx: 300, dy: 400, data: 0 };
    let up_and_wheel = Event::Mouse { flags: 0x10 | 0x0800, dx: 0, dy: 0, data: 120 };
    assert_eq!(port.input(&[up_and_move]), Err(REVOKED.to_string()), "its motion is refused");
    assert_eq!(port.input(&[up_and_wheel, RIGHT_UP]), Err(REVOKED.to_string()), "its wheel and the second up are refused");
    assert!(scope.release_held());
    assert_eq!(
        fake.log(),
        ["input mouse 0x2 0 0 0", "input mouse 0x8 0 0 0", "input mouse 0x4 0 0 0", "input mouse 0x10 0 0 0"]
    );
    assert!(port.holds().is_empty());
}

/// While open, a combined event is sent as its parts: the ordinary part and the release the receipt names.
#[test]
fn while_open_a_combined_release_goes_out_as_its_parts() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    port.input(&[LEFT_DOWN]).unwrap();
    port.input(&[Event::Mouse { flags: 0x4 | 0x1, dx: 3, dy: 4, data: 0 }]).unwrap();
    assert_eq!(fake.log(), ["input mouse 0x2 0 0 0", "input mouse 0x1 3 4 0", "input mouse 0x4 0 0 0"]);
    assert!(port.holds().is_empty());
}

/// The receipt's cross-process lock is waited for before admission: Off is acknowledged while a send waits for it, and the
/// send then reaches nothing.
#[test]
fn a_send_waiting_for_the_receipt_lock_does_not_hold_off() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    let pause = Pause::new();
    *fake.receipt_lock.lock().unwrap() = Some(pause.clone());
    std::thread::scope(|threads| {
        let sending = threads.spawn(|| port.input(&[A_DOWN]));
        pause.reached.wait();
        assert_eq!(scope.revoke().unfinished, 0, "acknowledged with the lock still held elsewhere");
        pause.resume.wait();
        assert_eq!(sending.join().unwrap(), Err(REVOKED.to_string()));
    });
    assert!(fake.log().is_empty());
    assert!(port.holds().is_empty());
}

/// Holds the named primitive inside its call, revokes, and lets it go: answers the operation's outcome and the closure count.
fn revoke_inside<T: Send>(
    scope: &Scope,
    fake: &FakeWin,
    primitive: &'static str,
    operation: impl FnOnce() -> T + Send,
) -> (T, usize) {
    let pause = fake.pause_inside(primitive);
    std::thread::scope(|threads| {
        let running = threads.spawn(operation);
        pause.reached.wait();
        let unfinished = scope.revoke().unfinished;
        pause.resume.wait();
        (running.join().unwrap(), unfinished)
    })
}

/// Clipboard: `EmptyClipboard` held, Off, released: it completes, and `SetClipboardData` is refused (the clipboard stays
/// cleared); the continuation's input is refused too.
#[test]
fn a_clipboard_clear_held_across_off_is_not_followed_by_its_write() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    let ((written, next), unfinished) =
        revoke_inside(&scope, &fake, "clipboard_empty", || (port.clipboard_write("x"), port.input(&[A_DOWN])));
    assert_eq!(unfinished, 1, "the held call is counted, not waited for");
    assert_eq!((written, next), (Err(REVOKED.to_string()), Err(REVOKED.to_string())));
    assert_eq!(fake.log(), ["clipboard_empty"]);
}

/// The activation broker: `CoCreateInstance` held across Off, then `ActivateApplication` is refused.
#[test]
fn a_broker_creation_held_across_off_is_not_followed_by_the_activation() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    let (launched, unfinished) = revoke_inside(&scope, &fake, "create_broker", || port.launch(Launch::AppId("app")).map(|_| ()));
    assert_eq!((launched, unfinished), (Err(REVOKED.to_string()), 1));
    assert_eq!(fake.log(), ["create_broker"]);
}

/// An activation try: `ShowWindowAsync` held across Off, then no raise, foreground, activation or focus follows; the input
/// queues it attached are detached through their receipts.
#[test]
fn a_restore_held_across_off_ends_the_activation_and_detaches() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    fake.iconic.lock().unwrap().push(7);
    *fake.foreground.lock().unwrap() = 3;
    let (landed, unfinished) = revoke_inside(&scope, &fake, "show", || port.focus_try(7));
    assert_eq!((landed, unfinished), (false, 1));
    assert_eq!(fake.log(), ["attach 99 1", "show 7 Restore", "detach 99 1"]);
    assert!(port.holds().is_empty());
}

/// While open the activation is the whole sequence, each primitive on its own.
#[test]
fn an_activation_is_a_sequence_of_primitives() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    *fake.focus_lands.lock().unwrap() = true;
    assert!(port.focus_try(7));
    assert_eq!(fake.log(), ["attach 99 1", "bring_to_top 7", "foreground 7", "active 7", "focus 7", "detach 99 1"]);
}

/// A no-activate change paused before it applied, Off and the cleanup run meanwhile, then it completes: its stored
/// compensation follows, the cleanup report goes from pending to complete, and no caller release consumes it twice.
#[test]
fn a_pending_no_activate_is_compensated_after_it_completes() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    let reports = Arc::new(Mutex::new(Vec::new()));
    let seen = reports.clone();
    scope.on_report(move |report| seen.lock().unwrap().push(report.cleanup));
    let pause = fake.pause_inside("no_activate");
    std::thread::scope(|threads| {
        let holding = threads.spawn(|| port.hold_no_activate(7));
        pause.reached.wait();
        assert_eq!(scope.revoke().unfinished, 1);
        assert!(scope.release_held());
        assert!(port.release_no_activate(7), "a caller's release marks it; it consumes nothing");
        assert_eq!(scope.report().cleanup, Cleanup::Pending);
        pause.resume.wait();
        assert_eq!(holding.join().unwrap(), Err(REVOKED.to_string()));
    });
    assert!(port.release_no_activate(7));
    assert!(scope.release_held());
    assert_eq!(fake.log(), ["no_activate 7 true", "no_activate 7 false"]);
    assert_eq!(scope.report().cleanup, Cleanup::Complete);
    assert!(reports.lock().unwrap().contains(&Cleanup::Complete));
}

/// The shield the same way: applied after Off and the cleanup, it is enabled again once.
#[test]
fn a_pending_shield_is_compensated_after_it_completes() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    let pause = fake.pause_inside("shield");
    std::thread::scope(|threads| {
        let shielding = threads.spawn(|| port.shield(4));
        pause.reached.wait();
        scope.revoke();
        assert!(scope.release_held());
        pause.resume.wait();
        assert_eq!(shielding.join().unwrap(), Err(REVOKED.to_string()));
    });
    port.unshield(4);
    assert_eq!(fake.log(), ["enabled 4 false", "enabled 4 true"]);
}

/// A compensation in progress stays accounted: the shield applied after Off and the cleanup, its `EnableWindow(true)` held
/// while a report is taken: the cleanup is pending, never complete, until the compensation returned.
#[test]
fn a_compensation_held_while_a_report_is_taken_keeps_the_cleanup_pending() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    let applying = fake.pause_inside("shield");
    std::thread::scope(|threads| {
        let shielding = threads.spawn(|| port.shield(4));
        applying.reached.wait();
        scope.revoke();
        assert!(scope.release_held());
        let compensating = fake.pause_inside("shield");
        applying.resume.wait();
        compensating.reached.wait();
        assert_eq!(scope.report().cleanup, Cleanup::Pending, "the compensation has not returned");
        compensating.resume.wait();
        assert_eq!(shielding.join().unwrap(), Err(REVOKED.to_string()));
    });
    assert_eq!(scope.report().cleanup, Cleanup::Complete);
    assert_eq!(fake.log(), ["enabled 4 false", "enabled 4 true"]);
}

/// A partly accepted batch: the accepted prefix is owned and let go of at once, and the rest is never sent.
#[test]
fn a_partly_accepted_batch_lets_go_of_its_accepted_prefix() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    *fake.accept.lock().unwrap() = Some(1);
    assert!(port.input(&[A_DOWN, B_DOWN, A_UP]).is_err());
    assert_eq!(fake.log(), ["input key 0x41 down", "input key 0x41 up"]);
    assert!(port.holds().is_empty());
}

/// A key pressed in a window's queue, then Off before its character: the character is refused, and only the release the
/// press's receipt names goes out (the caller's release payload is not what is sent). No Escape, motion or text follows.
#[test]
fn a_revocation_between_a_queued_press_and_its_character_lets_out_only_the_owned_release() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    port.message(1, 2, Message::KeyDown { vk: 0x1B, lparam: 1 }).unwrap();
    scope.revoke();
    assert_eq!(port.message(1, 2, Message::Char { unit: 0x1B, lparam: 1 }).err(), Some(Refusal::Revoked));
    assert_eq!(port.message(1, 2, Message::MouseMove { flags: 0, point: 5 }).err(), Some(Refusal::Revoked));
    assert_eq!(port.message(1, 3, Message::KeyUp { vk: 0x1B, lparam: 0 }).err(), Some(Refusal::Revoked), "wrong target");
    assert_eq!(port.message(1, 2, Message::KeyUp { vk: 0x41, lparam: 0 }).err(), Some(Refusal::Revoked), "no receipt");
    let released = port.message(1, 2, Message::KeyUp { vk: 0x1B, lparam: 777 }).unwrap();
    // Not acknowledged yet: a second release answers the same reply and sends nothing.
    let again = port.message(1, 2, Message::KeyUp { vk: 0x1B, lparam: 0 }).unwrap();
    assert_eq!((released.get(), again.get()), (Some(1), Some(1)));
    assert!(scope.release_held());
    assert_eq!(
        fake.log(),
        ["queue 2 KeyDown { vk: 27, lparam: 1 }", "queue 2 KeyUp { vk: 27, lparam: -1073741823 }"]
    );
}

/// A button press whose reply was lost is still owned: the cleanup lets go of it at the point of the last accepted motion,
/// with no motion of its own.
#[test]
fn a_press_with_a_lost_reply_is_owned_and_released_by_the_cleanup() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    *fake.silent.lock().unwrap() = true;
    let press = port.message(1, 2, Message::ButtonDown { button: MouseButton::Left, flags: 0, point: 1 }).unwrap();
    assert_eq!(port.wait(&press, Duration::ZERO), None);
    port.message(1, 2, Message::MouseMove { flags: 0, point: 9 }).unwrap();
    scope.revoke();
    assert_eq!(port.message(1, 2, Message::MouseMove { flags: 0, point: 12 }).err(), Some(Refusal::Revoked));
    assert!(scope.release_held());
    assert_eq!(
        fake.log(),
        [
            "queue 2 ButtonDown { button: Left, flags: 0, point: 1 }",
            "queue 2 MouseMove { flags: 1, point: 9 }",
            "queue 2 ButtonUp { button: Left, flags: 0, point: 9 }",
        ]
    );
}

/// A refused delivery at each boundary leaves nothing queued and nothing owned; a hung target is refused before admission.
#[test]
fn a_refused_or_hung_delivery_queues_nothing_and_owns_nothing() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    fake.hung.lock().unwrap().push(2);
    assert_eq!(port.message(1, 2, Message::KeyDown { vk: 0x41, lparam: 1 }).err(), Some(Refusal::Hung));
    *fake.refuse.lock().unwrap() = Some(Refusal::Isolated);
    assert_eq!(port.message(1, 3, Message::KeyDown { vk: 0x41, lparam: 1 }).err(), Some(Refusal::Isolated));
    assert!(fake.log().is_empty());
    assert!(port.holds().is_empty());
}

/// A window reused by another owner since the press holds nothing of this executor's: its receipt is consumed and nothing
/// is sent to the stranger.
#[test]
fn a_release_to_a_reused_window_sends_nothing() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    port.message(1, 2, Message::KeyDown { vk: 0x41, lparam: 1 }).unwrap();
    fake.reused.lock().unwrap().push(2);
    assert_eq!(port.release_pressed(1, 2, Pressed::Key(0x41)).map(|sent| sent.err()), Some(Some(Refusal::Gone)));
    assert!(port.holds().is_empty());
    assert_eq!(fake.log(), ["queue 2 KeyDown { vk: 65, lparam: 1 }"]);
}

/// Focus, placement, posts, the shield and new holds are refused after Off; the no-activate hold taken before is let go of.
#[test]
fn after_off_focus_placement_and_new_holds_are_refused_and_owned_holds_let_go() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    *fake.focus_lands.lock().unwrap() = true;
    assert_eq!(port.hold_no_activate(5), Ok(true));
    scope.revoke();
    assert!(!port.focus_try(5));
    assert_eq!(port.set_foreground(5), Err(REVOKED.to_string()));
    assert_eq!(port.move_window(5, 0, 0, 1, 1), Err(REVOKED.to_string()));
    assert_eq!(port.post(5, Posted::Close).err(), Some(Refusal::Revoked));
    assert_eq!(port.hold_no_activate(6), Err(REVOKED.to_string()));
    assert!(port.shield(6).is_err());
    assert_eq!(port.clipboard_write("x"), Err(REVOKED.to_string()));
    assert!(port.launch(Launch::Shell("x")).is_err());
    assert!(port.release_no_activate(5));
    assert!(scope.release_held());
    assert_eq!(fake.log(), ["no_activate 5 true", "no_activate 5 false"]);
}

/// Work queued under an old scope stays refused once a new scope (On again) began; the new one's port is its own.
#[test]
fn work_of_a_revoked_epoch_stays_refused_under_the_next_one() {
    let old = Scope::open(1);
    let (queued, old_log) = FakeWin::port(&old);
    old.revoke();
    let new = Scope::open(2);
    let (current, new_log) = FakeWin::port(&new);
    assert_eq!(queued.input(&[A_DOWN]), Err(REVOKED.to_string()));
    assert_eq!(current.input(&[A_DOWN]), Ok(()));
    // The new scope's receipt is not the old port's to release.
    assert_eq!(queued.input(&[A_UP]), Err(REVOKED.to_string()));
    assert!(old_log.log().is_empty());
    assert_eq!(new_log.log(), ["input key 0x41 down"]);
}

/// A revoked scope inside a live one: its port refuses alone, and the live scope's port goes on.
#[test]
fn a_revoked_scope_nested_in_a_live_one_refuses_alone() {
    let live = Scope::open(1);
    let (outer, outer_log) = FakeWin::port(&live);
    let nested = Scope::open(2);
    let (inner, inner_log) = FakeWin::port(&nested);
    outer.input(&[A_DOWN]).unwrap();
    nested.revoke();
    assert_eq!(inner.input(&[B_DOWN]), Err(REVOKED.to_string()));
    assert_eq!(outer.input(&[A_UP]), Ok(()));
    assert!(inner_log.log().is_empty());
    assert_eq!(outer_log.log(), ["input key 0x41 down", "input key 0x41 up"]);
}

/// An elevated child's pending scope: a submission waits before its first input for the grant, and a revocation that comes
/// first (a worker that finished launching after Off) refuses it without anything reaching the system.
#[test]
fn a_pending_executor_sends_nothing_before_its_grant_and_nothing_once_revoked() {
    let scope = Scope::pending(1);
    let (port, fake) = FakeWin::port(&scope);
    std::thread::scope(|threads| {
        let waiting = threads.spawn(|| port.input(&[A_DOWN]));
        scope.revoke();
        assert_eq!(waiting.join().unwrap(), Err(REVOKED.to_string()));
    });
    assert!(!scope.grant());
    assert!(fake.log().is_empty());
    let granted = Scope::pending(1);
    let (port, fake) = FakeWin::port(&granted);
    assert!(granted.grant());
    port.input(&[A_DOWN]).unwrap();
    granted.revoke();
    assert_eq!(port.input(&[B_DOWN]), Err(REVOKED.to_string()), "between events");
    assert!(granted.release_held());
    assert_eq!(fake.log(), ["input key 0x41 down", "input key 0x41 up"]);
}

/// An ordinary release under way at Off (its receipt releasing, so the cleanup leaves it): the report stays pending, and its
/// later success is published by the ledger as an updated report, complete, with no further call.
#[test]
fn a_release_under_way_at_off_publishes_its_later_success() {
    let scope = Scope::open(1);
    let (port, fake) = FakeWin::port(&scope);
    assert_eq!(port.hold_no_activate(7), Ok(true));
    let reports = Arc::new(Mutex::new(Vec::new()));
    let seen = reports.clone();
    scope.on_report(move |report| seen.lock().unwrap().push(report.cleanup));
    let clearing = fake.pause_inside("no_activate");
    std::thread::scope(|threads| {
        let releasing = threads.spawn(|| port.release_no_activate(7));
        clearing.reached.wait();
        scope.revoke();
        assert!(scope.release_held(), "nothing held for the cleanup: the receipt is being released");
        assert_eq!(scope.report().cleanup, Cleanup::Pending);
        clearing.resume.wait();
        assert!(releasing.join().unwrap());
    });
    assert_eq!(reports.lock().unwrap().last(), Some(&Cleanup::Complete), "the release's success was published");
    assert_eq!(fake.log(), ["no_activate 7 true", "no_activate 7 false"]);
}
