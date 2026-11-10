// The transport oracle on the phone: the same script and world the Node recorder used (benchmarks/rust-core/recorders/lib/transport-oracle.mjs),
// through `createRelayConnector` alone -- the connector and its transport peer, with no client, view or app. Prints the trace on a marker line.
import { createPhoneWorld } from '../../../../benchmarks/rust-core/recorders/lib/phone-world.mjs';
import { ORACLE_SCENARIOS, oracleDialect, playOracle } from '../../../../benchmarks/rust-core/recorders/lib/transport-oracle.mjs';

async function main() {
  const name = process.argv[2];
  const repo = new URL('../../../../', import.meta.url);
  const world = await createPhoneWorld({ tree: decodeURIComponent(repo.pathname.slice(1)), dialect: oracleDialect, mxt: true, installed: false });
  const { createRelayConnector } = await import('../../../mobile/src/relay-connector.ts');
  const driver = {
    writer: null,
    boot: async () => {
      const visible = () => globalThis.document.visibilityState !== 'hidden';
      const connector = createRelayConnector({
        pairing: () => world.material,
        socketUrl: () => 'wss://relay.test/ws',
        createSocket: (url) => new globalThis.WebSocket(url),
        ready: () => world.log({ ev: 'ready' }),
        visible,
        webrtc: { createPeer: (configuration) => new globalThis.RTCPeerConnection(configuration), visible, log: () => {} },
      });
      // The page lifecycle the oracle's script drives: hidden stops the transport's timers, visible again wakes it (phone-boot.ts maps these two).
      globalThis.document.addEventListener('visibilitychange', () => (visible() ? connector.wake() : connector.hidden()));
      void connector
        .open({ id: 'pc' }, { frame: (text) => world.log({ ev: 'deliver', frame: JSON.parse(text) }), closed: () => {} })
        .then((writer) => (driver.writer = writer));
    },
    send: (payload) => driver.writer.send(JSON.stringify(payload)),
    // The frame's own claim: it settles when the frame has left (the connector's per-call transmission signal).
    sendTracked: (payload, done) => driver.writer.send(JSON.stringify(payload), (sent) => void sent.then(done)),
  };
  const trace = await playOracle(world, driver, ORACLE_SCENARIOS[name]);
  process.stdout.write(`\n@@TRACE@@${JSON.stringify(trace)}\n`);
}
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);