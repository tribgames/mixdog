// Error code for a provider init that has no enabled provider to register.
// The registry refuses such an init to protect its live instances; readers
// that legitimately run before any provider exists (the model catalog on a
// fresh install) treat it as "nothing to load" instead of a failure.
export const NO_ENABLED_PROVIDERS = 'PROVIDERS_NONE_ENABLED';

export function noEnabledProvidersError(message) {
  return Object.assign(new Error(message), { code: NO_ENABLED_PROVIDERS });
}
