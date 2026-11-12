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
          // Every read is recorded, the remote host's own pre-write policy and permission reads (remote-authority.ts) included.
          for (const request of requests) hostCalls.push([request.capability, request.args, undefined]);
          return requests.map(() => ({ ok: true, value: null }));
        },
      };
      const remote = createRemoteMethods({ host });
      const writes = [];
      for (const [capability, args] of Object.entries(WRITES)) {
        const desktop = requiredDesktopCapabilityRequest({ capability, args });
        const start = hostCalls.length;
        await host.invokeCapability(desktop.capability, desktop.args, desktop.sessionId);
        const phoneStart = hostCalls.length;
        await remote.invokeCapability([{ capability, args }]);
        // Whole, in order: the desktop's call, then everything the phone's reached the host with (the pre-write reads and the call, with
        // the host's no-widen mark on the authority setters).
        writes.push({ capability, desktopCalls: hostCalls.slice(start, phoneStart), phoneCalls: hostCalls.slice(phoneStart) });
      }
      const reads = [];
      for (const [capability, args] of Object.entries(READS)) {
        const desktop = requiredDesktopCapabilityReadRequests([{ capability, args }]);
        const start = hostCalls.length;
        await host.readCapabilities(desktop);
        const phoneStart = hostCalls.length;
        await remote.readCapabilities([[{ capability, args }]]);
        reads.push({ capability, desktopCalls: hostCalls.slice(start, phoneStart), phoneCalls: hostCalls.slice(phoneStart) });
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
