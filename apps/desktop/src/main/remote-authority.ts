// A paired client may narrow what a bot may run without asking, never widen it.
// The judgement is made where the state is written, in the same synchronous
// stretch (or file lock) as the write itself, so a restriction the owner adds
// meanwhile is never overwritten: the host only marks the call. The mark is
// added here, after the client's arguments were validated (which fix their
// number), so a client can neither send nor omit it.

/** Capabilities that can give a bot more authority (see the `noWiden` option of
 *  their writers in the session runtime): `allow` modes, connector tools,
 *  connector switches (agent and project) and connector policies. */
const NO_WIDEN = new Set([
  'setAgentPermission',
  'setAgentConnectorToolPermission',
  'setAgentConnectorEnabled',
  'setProjectConnectorEnabled',
  'setAgentConnectors',
  'saveAgentDefinition',
]);

/** The arguments a remote client's capability call is forwarded with. */
export function remoteCapabilityArgs(capability: string, args: readonly unknown[] = []): unknown[] {
  return NO_WIDEN.has(capability) ? [...args, { noWiden: true }] : [...args];
}
