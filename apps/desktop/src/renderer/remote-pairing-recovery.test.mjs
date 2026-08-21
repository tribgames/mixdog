import assert from "node:assert/strict";
import test from "node:test";

import { canReuseStoredRemoteClientRegistration } from "./remote-pairing-recovery.ts";

const credential = "a".repeat(64);

test("a previously verified PWA dials its stored browser credential directly", () => {
  assert.equal(canReuseStoredRemoteClientRegistration({
    everPaired: true,
    token: credential,
    hasE2eePairing: true,
  }), true);
});

test("a first QR bootstrap still performs browser registration", () => {
  assert.equal(canReuseStoredRemoteClientRegistration({
    everPaired: false,
    token: credential,
    hasE2eePairing: true,
  }), false);
});

test("incomplete or malformed stored pairing material is never reused", () => {
  assert.equal(canReuseStoredRemoteClientRegistration({
    everPaired: true,
    token: "not-a-client-token",
    hasE2eePairing: true,
  }), false);
  assert.equal(canReuseStoredRemoteClientRegistration({
    everPaired: true,
    token: credential,
    hasE2eePairing: false,
  }), false);
});
