// The remote capability deny-list is maintained BY HAND, so it needs a test
// that fails the moment a secret- or OAuth-bearing capability is added to the
// desktop surface without being denied over the relay.
import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_CAPABILITIES } from "../shared/contract.ts";
import {
  assertRemoteCapability,
  REMOTE_BLOCKED_CAPABILITIES,
} from "./remote-methods.ts";

// Driven from the CAPABILITY SURFACE, not from the deny-list: a new
// secret-bearing or OAuth capability added to DESKTOP_CAPABILITIES fails here
// until it is denied, which is exactly the mistake a hand-maintained list
// invites. `forgetProviderAuth` deliberately does not match — deleting stored
// auth carries no secret and stays available to a paired phone.
const SECRET_CAPABILITY_PATTERN = /(apikey|secret|password|credential|sessionkey|usageauth)/i;
const OAUTH_CAPABILITY_PATTERN = /(oauth|authenticateprovider|login)/i;

const sensitiveCapabilities = DESKTOP_CAPABILITIES.filter((capability) =>
  SECRET_CAPABILITY_PATTERN.test(capability)
  || OAUTH_CAPABILITY_PATTERN.test(capability));

test("every secret- or OAuth-bearing capability on the desktop surface is denied remotely", () => {
  // Guards the guard: a pattern that stops matching anything would pass
  // vacuously.
  assert.ok(sensitiveCapabilities.length >= 10, "capability scan found nothing to check");
  for (const capability of sensitiveCapabilities) {
    assert.equal(
      REMOTE_BLOCKED_CAPABILITIES.has(capability),
      true,
      `${capability} carries a secret or an OAuth flow and must be desktop-local`,
    );
    assert.throws(
      () => assertRemoteCapability(capability),
      /is not available over remote access/,
      `${capability} must be refused over remote access`,
    );
  }
});

test("the media resolver stays desktop-local for its own documented reason", () => {
  // Not secret-bearing: a phone reaches media through the media HTTP route and
  // never needs host filesystem paths.
  assert.equal(REMOTE_BLOCKED_CAPABILITIES.has("resolveMediaFile"), true);
  assert.throws(() => assertRemoteCapability("resolveMediaFile"),
    /is not available over remote access/);
});

test("every deny-list entry still names a real capability", () => {
  const known = new Set(DESKTOP_CAPABILITIES);
  for (const capability of REMOTE_BLOCKED_CAPABILITIES) {
    assert.equal(known.has(capability), true,
      `${capability} is denied but no longer exists — a rename would open the lane`);
  }
});

test("ordinary capabilities are not blocked by the deny-list", () => {
  for (const capability of ["setModel", "setWorkflow", "listSessions", "getSnapshot"]) {
    assert.equal(REMOTE_BLOCKED_CAPABILITIES.has(capability), false);
    assert.doesNotThrow(() => assertRemoteCapability(capability));
  }
});
