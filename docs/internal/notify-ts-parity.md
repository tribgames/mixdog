# The TypeScript turn notifier: what replaced each of its tests

Deleted by t1-notify-fix: `desktop-turn-notifier.ts`, `final-answer-watcher.ts`, `push-turn-events.ts`, `session-final-answer.ts`,
`notification-preview.ts` (each with its test), their recorded data (`shared/test-recorded/desktop-turn-notifier.test.0.recorded.*`,
`session-final-answer.restore.node.json`, `record/record-session-final-answer.mjs`) and `scripts/probes/native-notification.ts`.
The decider is now the core's: `mixdog-app-server-daemon` `domain_seams/notify_producer.rs` (this PC's sessions) and
`mixdog-connections` `notifier.rs` (a server's sessions) over ONE final-answer watcher (`AnswerWatch`, `TurnTracker` in `notifier.rs`);
the toast is `apps/desktop/src/main/host/notification.ts`.

Rust test names are the functions; PROD = `notify_producer_tests.rs`, WATCH = `mixdog-connections/src/notifier_watch_tests.rs`,
HOST = `apps/desktop/src/main/host/notification.test.mjs`, CLICK = `apps/desktop/src/main/notification-click-routing.test.mjs`.

## desktop-turn-notifier.test.mjs

| Old test | Now |
| --- | --- |
| attachment-only title in this PC's language / in English | PROD `an_attachment_only_title_is_its_kind_in_this_pcs_language_and_english_for_a_phone` |
| bot home chat under the bot's name, a rename, a room under its name, Mixy | PROD `a_bots_home_chat_is_told_under_the_bots_name_and_a_room_under_its_name` |
| restored background completion: one native notification, plain text, opens its session | PROD `a_finished_turn_is_one_toast_with_plain_text_for_its_session`; HOST `a click on a local toast brings the window forward on the session it names...`; CLICK |
| each mode is an explicit suppression, not a claimed delivery | PROD `a_suppressed_toast_says_why_in_the_log` (the core's reason), HOST `a toast the OS cannot show is reported as suppressed...`, HOST pet overlay |
| preferences decide at delivery (bots only, muted bot, quiet hours); "always" conversation | PROD `this_pcs_preferences_decide_when_the_toast_is_made`; `mixdog-core-domains` `decision.rs` and `decision_parity_tests.rs` |
| a failed turn notifies only with errors on, in this PC's words | PROD `a_failed_turn_notifies_only_with_errors_on_in_this_pcs_words` |
| focused window showing A does not suppress B; every split pane stays suppressed; focused but minimized/hidden shows nothing; schedule/webhook run still notifies on screen; on-screen rechecked at delivery | PROD `what_the_window_shows_is_checked_when_the_toast_is_made`, `an_automatic_run_still_notifies_on_screen` |
| a construct / show failure is reported, no unhandled exception, no duplicate retry | HOST `a toast whose show fails is reported and plays no sound...` and `...cannot be built as failed` |
| a late answer is retried, its pending diagnostic is not spammed | WATCH `a_pending_answer_is_polled_and_its_wait_is_reported_once` |
| disposal cancels pending completions and closes retained native notifications | PROD `nothing_is_told_once_the_host_is_closing` (pending ones), HOST `closing a banner reports it and opens nothing; quitting closes the toasts still held` (the returned closer; the lead binds it, see the .wire) |
| Markdown removed without damaging paths, links, Unicode | `mixdog-core-domains` `preview.rs` `paths_links_unicode_and_unpaired_hangul_strong_read_as_plain_text` (new; the same assertions) and `strips_markup_and_skips_code_and_tables` |
| click restores/focuses the hidden/minimized/visible window before sending the exact session | CLICK (same three modes, through `openDesktopNotificationSession`) |
| closing a banner does not open or focus a session | CLICK `closing a banner does not open or focus a session`, HOST `closing a banner reports it...` |
| missing or destroyed windows reject navigation | CLICK `missing or destroyed windows reject notification navigation` |
| custom sound plays once on native show, never on suppression or a failed show; no sound for foreground/disabled/show failure | HOST pet overlay (no toast, no sound), HOST `a toast whose show fails ... plays no sound`, HOST `the steps of a toast ...` (sound once); the core decides disabled/foreground before any toast is requested (PROD preference tests) |
| a sound failure leaves the banner and click intact | HOST `a toast whose show fails ...; a failing sound leaves the click intact` |
| an unfocused session's approval and question notify in this PC's words and a click opens that session | PROD `an_approval_and_a_question_are_told_in_this_pcs_words_for_their_session`; CLICK (wait row) |
| without words of its own a wait notification speaks English | `compose_connections_language.rs` / `CatalogProducerTexts::waiting` (the catalog answers the English key when no language is set) |
| a wait is not notified when muted / quiet hours / on screen / off | PROD `a_wait_is_not_told_when_muted_in_quiet_hours_on_screen_or_switched_off` |
| an approval docked in every chat a hand-off reaches is one notification | PROD `an_approval_docked_in_every_chat_a_hand_off_reaches_is_one_notification`; the phone's one push per session: PROD `a_phone_is_told_a_wait_once_per_session_that_shows_it` |
| a sub-agent's approval is told as, and opens, the chat it shows in | PROD `a_sub_agents_approval_is_told_as_the_chat_it_shows_in`; CLICK |
| a replayed wait is not a new one | PROD `a_replayed_wait_is_not_a_new_one` |
| an unreadable approval settled before preferences recover is forgotten | PROD `an_approval_answered_before_it_is_shown_is_forgotten_not_told_later` |
| preferences that cannot be read are reported, held, notified once on recovery (5 tests) | Moot: this PC's preferences are held in memory by the core (`Audience::pc`) and cannot fail to read. `ServerNotifier` keeps the held-and-offered-again path for the server link (`notifier_tests.rs`). |

## final-answer-watcher.test.mjs

| Old test | Now |
| --- | --- |
| Lead that finished is announced at once with the completed turn answer | PROD `a_finished_turn_is_one_toast_with_plain_text_for_its_session` |
| mid-turn flicker keeps polling, quiet when the turn resumes; answer arriving after idle is awaited | PROD `a_pending_answer_is_polled_until_it_lands`, `a_session_that_resumes_before_the_answer_is_read_tells_nothing`; WATCH `a_pending_answer_is_polled_and_its_wait_is_reported_once` |
| reaction alone / routine "nothing new" / cancelled are silent and stop polling; failed is an error | PROD `a_cancelled_turn_a_reaction_and_a_quiet_reply_tell_nothing` (now with the shared `ROUTINE_QUIET` constant), `a_failed_turn_notifies_only_...`; WATCH `the_steps_of_a_turn_are_reported_with_their_reasons` |
| a turn that resumes within the quiet period is not delivered | PROD `a_session_that_resumes_before_the_answer_is_read_tells_nothing` |
| schedule final answer keeps its origin, delivered once; schedules respect disabled notifications and disabling in the quiet period | PROD `an_automatic_run_still_notifies_on_screen`, `this_pcs_preferences_decide...`, `nothing_is_told_once_the_host_is_closing` |
| a running background shell job never holds the Lead final answer | PROD `a_lead_waiting_on_its_agents_has_not_answered`; WATCH `a_lead_waiting_on_its_agents_is_still_working_until_they_settle` |
| a late read from a previous turn cannot notify after another turn starts and finishes | WATCH `a_read_of_an_earlier_turn_cannot_tell_after_another_turn_ran` |
| a deleted session never substitutes an older answer | WATCH `a_forgotten_session_is_neither_read_nor_told`; PROD `archived_and_sub_agent_sessions_are_silent_and_a_deleted_one_is_forgotten` |
| a read failure is reported and the exact answer can arrive later; transient failures back off and are abandoned | PROD `read_failures_back_off_and_end` (the log line is now `turn-notification-read-failed`), WATCH steps |
| a session whose record is gone is cancelled after one read / reported missing by code | PROD `a_missing_session_is_not_read_again`; `notify_sources.rs` `a_session_whose_record_is_gone_is_missing_and_any_other_failure_is_not` |
| the read gets an abort signal that fires at its deadline; a hung read is a transient failure and frees the slot; only one read in flight | WATCH `a_hung_read_fails_at_its_deadline_and_frees_the_slot_for_the_next` (the read future is dropped by the deadline: that is the abort); PROD `answers_are_read_one_at_a_time` |

## push-turn-events.test.mjs

All in WATCH (`TurnTracker`): `a_session_is_announced_once_when_it_stops_working_and_never_before_it_worked` (baseline, never-worked, repeated idle roster, start recorded),
`every_real_finish_is_announced_with_its_own_start`, `a_lead_waiting_on_its_agents_is_still_working_until_they_settle` (child-agent work, pending work from running agents only is
PROD `a_lead_waiting_on_its_agents_has_not_answered`), `an_archived_or_sub_agent_session_stays_silent_and_its_lead_is_announced`,
`a_roster_is_the_whole_list_and_each_session_in_it_finishes_on_its_own` (several at once, a deleted session re-baselines, idleness for the recheck).
"A completion carries kind, origin, bot and room" is PROD `a_bots_home_chat_...` and `an_automatic_run_still_notifies_on_screen`.

## session-final-answer.test.mjs

`mixdog-core-session` `reads.rs` `the_final_answer_equals_nodes` over the 20+ recorded snapshots of `fixtures/session-reads/golden.json` (restored identity, final assistant not user text /
progress / tools, late / streaming / missing / older stay pending, same wording is a new answer for another turn, reaction-only, stopped turn), and
`notify_sources.rs` for the missing-session tag. `fixtures/session-final-answer-cases/golden.json` is the recording of the same cases.

## notification-click-routing.test.mjs

Kept and rewritten over the real host presenter (`registerNotificationHost`) instead of the deleted notifier: every kind of toast, three window modes, rebuild-then-deliver once,
plain activation never drops a waiting session, a toast stays referenced until clicked/closed/failed, a session named before the renderer subscribes is held for the first listener.

## Not deleted

`notification-center.ts` and `notification-preferences.ts` (and the tests of `createNotificationCenter` / the preferences store) have no production caller, but their
parity (the store's migration and per-device merge against `notification-state.ts` and the core's `config/notifications`) is not shown by a test yet: they are listed in
the result as not done. `readSessionFinalAnswer` stays in the desktop service route (`thread/finalAnswer/read`); it has no caller left in the main process.
