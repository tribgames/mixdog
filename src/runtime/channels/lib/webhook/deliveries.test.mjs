import assert from "node:assert/strict";
import test from "node:test";

import { buildHeadersSummary, contentDeliveryId } from "./deliveries.mjs";

test("webhook claim identity is stable for signed content and ignores mutable headers", () => {
  const body = Buffer.from('{"event":"same"}');
  const first = contentDeliveryId(body);
  const replay = contentDeliveryId(Buffer.from(body));

  assert.equal(first, replay);
  assert.match(first, /^body-sha256-[a-f0-9]{64}$/);
  assert.notEqual(first, contentDeliveryId(Buffer.from('{"event":"different"}')));
  assert.equal(
    buildHeadersSummary({ "x-request-id": "attacker-selected" }).delivery_id,
    "attacker-selected",
  );
});
