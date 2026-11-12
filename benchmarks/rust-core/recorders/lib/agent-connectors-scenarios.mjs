// The cases of apps/desktop/src/main/agent-connectors-remote.test.mjs (b6f10295a), as functions of the modules they drive (the recorder
// passes the Node tree's, the desktop's replay the product's). Each returns what the test asserted on.
const READS = {
  getAgentConnectors: ['github-watcher'],
  getAgentConnectorTools: ['github-watcher'],
  listConnectors: [],
  listConnectorTools: ['github'],
  getProjectConnectors: ['C:\\work\\app'],
};
const WRITES = {
  setAgentConnectors: ['github-watcher', { off: ['notion'], tools: { github: { create_issue: 'disabled' } } }],
  setAgentConnectorEnabled: ['github-watcher', 'notion', false],
  setAgentConnectorToolPermission: ['github-watcher', 'github', 'create_issue', 'needs_approval'],
  setProjectConnectorEnabled: ['C:\\work\\app', 'notion', false],
};
const refusal = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.name;
  }
};

export function agentConnectorScenarios(m) {
  const { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES, requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest, assertRemoteCapability, createRemoteMethods, SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS } = m;
  return {
    'every connector method is a desktop capability, a remote capability and a session action': async () => ({
      reads: Object.keys(READS).map((capability) => ({ capability, desktopRead: DESKTOP_READ_CAPABILITIES.includes(capability), sessionRead: SESSION_READ_ACTIONS.includes(capability) })),
      all: [...Object.keys(READS), ...Object.keys(WRITES)].map((capability) => ({ capability, desktop: DESKTOP_CAPABILITIES.includes(capability), remoteRefusal: refusal(() => assertRemoteCapability(capability)) })),
      writes: Object.keys(WRITES).map((capability) => ({ capability, sessionConfigure: SESSION_CONFIGURE_ACTIONS.includes(capability), desktopRead: DESKTOP_READ_CAPABILITIES.includes(capability) })),
    }),
    'the phone and the desktop send the same validated call to the host': async () => {
      const hostCalls = [];
      const host = {
        invokeCapability: async (capability, args, sessionId) => {
          hostCalls.push([capability, args, sessionId]);
          return { value: null };
        },
        readCapabilities: async (requests) => {
          // The remote host's own pre-write comparison reads (remote-authority.ts) are not the call under test.
          for (const request of requests) {
            if (request.capability === 'getAgentConnectorPolicy' || request.capability === 'getAgentPermissions') continue;
            hostCalls.push([request.capability, request.args, undefined]);
          }
          return requests.map(() => ({ ok: true, value: null }));
        },
      };
      const remote = createRemoteMethods({ host });
      const writes = [];
      for (const [capability, args] of Object.entries(WRITES)) {
        const desktop = requiredDesktopCapabilityRequest({ capability, args });
        await host.invokeCapability(desktop.capability, desktop.args, desktop.sessionId);
        await remote.invokeCapability([{ capability, args }]);
        const [sent, sentArgs, sentSession] = hostCalls.at(-1);
        // The phone's call is the desktop's plus the host's no-widen mark on the authority setters.
        const marked = sentArgs.at(-1)?.noWiden === true;
        writes.push({ capability, desktopCall: hostCalls.at(-2), phoneCall: [sent, marked ? sentArgs.slice(0, -1) : sentArgs, sentSession], noWidenMark: marked });
      }
      const reads = [];
      for (const [capability, args] of Object.entries(READS)) {
        const desktop = requiredDesktopCapabilityReadRequests([{ capability, args }]);
        await host.readCapabilities(desktop);
        await remote.readCapabilities([[{ capability, args }]]);
        reads.push({ capability, desktopCall: hostCalls.at(-2), phoneCall: hostCalls.at(-1) });
      }
      return { writes, reads };
    },
    'a wrong argument count is refused before the host is reached': async () => ({
      setAgentConnectorsOneArg: refusal(() => requiredDesktopCapabilityRequest({ capability: 'setAgentConnectors', args: ['a'] })),
      setAgentConnectorToolPermissionTwoArgs: refusal(() => requiredDesktopCapabilityRequest({ capability: 'setAgentConnectorToolPermission', args: ['a', 'b'] })),
      listConnectorsOneArg: refusal(() => requiredDesktopCapabilityRequest({ capability: 'listConnectors', args: ['x'] })),
    }),
  };
}
