import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserSurfaceRequestShouldReveal,
  browserSurfaceRevealPlan,
  surfaceOwnerChain,
  surfaceRevealTarget,
  surfaceSessionName,
} from './session-browser-policy.ts';
import { agentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberSessionId, roomSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';

test('a child, task or room-member session reveals in the owner conversation on screen, never a guessed pane', () => {
  const home = agentHomeSessionId('watcher');
  const member = roomMemberSessionId('abc123', 'watcher');
  const room = roomSessionId('abc123');
  assert.ok(home && member && room);
  const sources = {
    sessions: [{ id: 'task-1', taskAgent: 'watcher', taskFrom: 'home', title: 'Report' }],
    pool: [
      { sessionId: 'sub-2', parentSessionId: 'sub-1', ownerSessionId: 'lead', title: '', tag: 'w2' },
      { sessionId: 'sub-1', parentSessionId: 'lead', ownerSessionId: 'lead', title: '시장 조사', tag: 'w1' },
      { sessionId: 'task-sub', parentSessionId: 'task-1', ownerSessionId: 'task-1', title: '', tag: 'reviewer' },
      { sessionId: 'room-sub', parentSessionId: member, ownerSessionId: member, title: '', tag: 'helper' },
    ],
  };
  assert.deepEqual(surfaceOwnerChain('sub-2', sources), ['sub-2', 'sub-1', 'lead']);
  assert.deepEqual(surfaceOwnerChain('task-sub', sources), ['task-sub', 'task-1', home]);
  assert.deepEqual(surfaceOwnerChain('task-1', sources), ['task-1', home]);
  assert.deepEqual(surfaceOwnerChain(member, sources), [member, room]);
  assert.deepEqual(surfaceOwnerChain('room-sub', sources), ['room-sub', member, room]);
  assert.deepEqual(surfaceOwnerChain('lead', sources), ['lead']);

  const chain = surfaceOwnerChain('sub-2', sources);
  assert.deepEqual(surfaceRevealTarget([{ leafId: 'pane-a', sessionId: 'lead' }], chain, 'pane-a'), {
    leafId: 'pane-a',
    sessionId: 'lead',
  });
  // The nearest shown conversation of the chain wins.
  assert.deepEqual(
    surfaceRevealTarget(
      [
        { leafId: 'pane-a', sessionId: 'lead' },
        { leafId: 'pane-b', sessionId: 'sub-1' },
      ],
      chain,
      'pane-a'
    ),
    { leafId: 'pane-b', sessionId: 'sub-1' }
  );
  assert.deepEqual(
    surfaceRevealTarget([{ leafId: 'pane-r', sessionId: room }], surfaceOwnerChain('room-sub', sources), 'x'),
    { leafId: 'pane-r', sessionId: room }
  );
  assert.deepEqual(surfaceRevealTarget([{ leafId: 'pane-x', sessionId: 'other' }], chain, 'pane-x'), {
    leafId: null,
    sessionId: 'sub-2',
  });
  assert.equal(surfaceSessionName('sub-1', sources), '시장 조사');
  assert.equal(surfaceSessionName('sub-2', sources), 'w2');
  assert.equal(surfaceSessionName('task-1', sources), 'Report');
});

test('the owner chain climbs any depth and stops at a cycle', () => {
  const depth = 40;
  const pool = Array.from({ length: depth }, (_, index) => ({
    sessionId: `s${index}`,
    parentSessionId: index + 1 < depth ? `s${index + 1}` : 'lead',
    ownerSessionId: 'lead',
    title: '',
    tag: '',
  }));
  const chain = surfaceOwnerChain('s0', { sessions: [], pool });
  assert.equal(chain.length, depth + 1);
  assert.equal(chain.at(-1), 'lead');

  const loop = [
    { sessionId: 'a', parentSessionId: 'b', ownerSessionId: 'lead', title: '', tag: '' },
    { sessionId: 'b', parentSessionId: 'a', ownerSessionId: 'lead', title: '', tag: '' },
  ];
  assert.deepEqual(surfaceOwnerChain('a', { sessions: [], pool: loop }), ['a', 'b', 'lead']);
});

const owners = [
  { leafId: 'pane-a', sessionId: 'alpha' },
  { leafId: 'pane-b', sessionId: 'beta' },
  { leafId: 'pane-c', sessionId: 'alpha' },
];

test('Browser Use reveals beside a visible owner without reactivating it', () => {
  assert.deepEqual(browserSurfaceRevealPlan(owners, 'beta', 'pane-a'), {
    leafId: 'pane-b',
  });
});

test('a hidden Browser Use owner stays parked until the user returns', () => {
  assert.deepEqual(browserSurfaceRevealPlan(owners, 'missing', 'pane-a'), {
    leafId: null,
  });
});

test('duplicate visible session views prefer the focused pane', () => {
  assert.deepEqual(browserSurfaceRevealPlan(owners, 'alpha', 'pane-c'), {
    leafId: 'pane-c',
  });
  assert.deepEqual(browserSurfaceRevealPlan(owners, 'alpha', 'pane-b'), {
    leafId: 'pane-a',
  });
});

test('foreground requests reveal while parked remote requests do not', () => {
  assert.equal(browserSurfaceRequestShouldReveal({ sessionId: 'alpha' }), true);
  assert.equal(browserSurfaceRequestShouldReveal({ sessionId: 'alpha', reveal: true }), true);
  assert.equal(browserSurfaceRequestShouldReveal({ sessionId: 'alpha', reveal: false }), false);
});
