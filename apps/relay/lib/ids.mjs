// Routing identifiers handed out to phone legs and stored as device ids.
// One predicate so every decoder, store row, and HTTP handler agrees on the
// same shape: a misattributed id fails the wrong call.
const ROUTING_ID = /^[0-9a-f-]{8,64}$/;

export function isRoutingId(value) {
  return ROUTING_ID.test(value);
}
