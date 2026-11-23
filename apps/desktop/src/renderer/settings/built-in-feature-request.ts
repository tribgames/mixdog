// The built-in feature whose dialog Extensions opens on: set by a caller elsewhere in the app (the /model picker's
// row menu of an agent's model), taken once by the built-in list, which also hears of a request made while it is up.
import type { BuiltInFeatureId } from './built-in-feature-registry';

const REQUESTED_EVENT = 'mixdog:open-built-in-feature';
let requested: BuiltInFeatureId | null = null;

export function requestBuiltInFeature(id: BuiltInFeatureId): void {
  requested = id;
  window.dispatchEvent(new window.Event(REQUESTED_EVENT));
}

export function takeRequestedBuiltInFeature(): BuiltInFeatureId | null {
  const id = requested;
  requested = null;
  return id;
}

export function subscribeBuiltInFeatureRequest(listener: () => void): () => void {
  window.addEventListener(REQUESTED_EVENT, listener);
  return () => window.removeEventListener(REQUESTED_EVENT, listener);
}
