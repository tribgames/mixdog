import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAccessibilitySnapshot } from './accessibility.ts';

const property = (name, value) => ({ name, value: { value } });

test('accessibility snapshot keeps actionable refs, cross-frame text, hierarchy, and degradation warnings', () => {
  const result = buildAccessibilitySnapshot({
    snapshotId: 'p1-s1',
    pageInfo: {
      url: 'https://example.test/',
      title: 'Example',
      scrollY: 0,
      scrollHeight: 800,
      viewportHeight: 600,
      viewportWidth: 800,
      text: 'Top page text',
    },
    targets: [
      {
        nodes: [
          {
            nodeId: 'root',
            role: { value: 'RootWebArea' },
            name: { value: 'Example' },
            backendDOMNodeId: 1,
            properties: [property('focusable', true)],
          },
          {
            nodeId: 'button',
            parentId: 'root',
            role: { value: 'button' },
            name: { value: 'Continue' },
            backendDOMNodeId: 2,
          },
        ],
        bounds: new Map([[2, [10, 10, 100, 30]]]),
      },
      {
        sessionId: 'frame-session',
        nodes: [
          {
            nodeId: 'frame-text',
            role: { value: 'StaticText' },
            name: { value: 'Cross-frame evidence' },
            backendDOMNodeId: 10,
          },
          {
            nodeId: 'frame-link',
            parentId: 'frame-text',
            role: { value: 'link' },
            name: { value: 'Frame link' },
            backendDOMNodeId: 11,
          },
        ],
        bounds: new Map([[11, [20, 20, 90, 20]]]),
        layoutError: 'layout unavailable',
      },
    ],
    maxElements: 20,
    textChars: 500,
  });

  assert.deepEqual(result.payload.elements.map((entry) => entry.role), ['button', 'link']);
  assert.equal(result.payload.elements[0].depth, 1);
  assert.match(result.payload.text, /Top page text Cross-frame evidence/);
  assert.equal(result.payload.viewportWidth, 800);
  assert.deepEqual(result.payload.warnings, ['Layout metadata unavailable: layout unavailable']);
  assert.equal(result.refs.length, 2);
  assert.equal(result.refs[1].sessionId, 'frame-session');
});

test('semantic snapshot queries rank accessible names and ignore matches found only in URL query tokens', () => {
  const result = buildAccessibilitySnapshot({
    snapshotId: 'p2-s1',
    pageInfo: {
      url: 'https://example.test/issues?q=download',
      title: 'Issues',
      scrollY: 0,
      scrollHeight: 800,
      viewportHeight: 600,
      viewportWidth: 800,
      text: 'Issue search',
    },
    targets: [{
      nodes: [
        {
          nodeId: 'sign-in',
          role: { value: 'link' },
          name: { value: 'Sign in' },
          backendDOMNodeId: 1,
          properties: [property('url', 'https://example.test/login?return_to=%2Fissues%3Fq%3Ddownload')],
        },
        {
          nodeId: 'named',
          role: { value: 'button' },
          name: { value: 'Download report' },
          backendDOMNodeId: 2,
        },
        {
          nodeId: 'path',
          role: { value: 'link' },
          name: { value: 'Release asset' },
          backendDOMNodeId: 3,
          properties: [property('url', 'https://example.test/downloads/latest?token=tracking')],
        },
        {
          nodeId: 'search-value',
          role: { value: 'searchbox' },
          name: { value: 'Issue search' },
          value: { value: 'download' },
          backendDOMNodeId: 4,
        },
        {
          nodeId: 'focusable-wrapper',
          role: { value: 'listitem' },
          name: { value: 'Download report' },
          backendDOMNodeId: 5,
          properties: [property('focusable', true)],
        },
        {
          nodeId: 'named-link',
          role: { value: 'link' },
          name: { value: 'Download report' },
          backendDOMNodeId: 6,
          properties: [property('url', 'https://example.test/downloads/report')],
        },
      ],
      bounds: new Map([
        [1, [10, 10, 100, 20]],
        [2, [10, 40, 100, 20]],
        [3, [10, 70, 100, 20]],
        [4, [10, 100, 100, 20]],
        [5, [10, 130, 100, 20]],
        [6, [10, 160, 100, 20]],
      ]),
    }],
    query: 'download',
    maxElements: 20,
    textChars: 500,
  });

  assert.deepEqual(
    result.payload.elements.map((entry) => [entry.name, entry.matchField]),
    [
      ['Download report', 'name'],
      ['Download report', 'name'],
      ['Download report', 'name'],
      ['Release asset', 'href'],
      ['Issue search', 'value'],
    ],
  );
  assert.equal(result.payload.elements[0].role, 'link');
  assert.equal(result.payload.elements[1].role, 'button');
  assert.equal(result.payload.elements[2].role, 'listitem');
  assert.ok(
    result.payload.elements.findIndex((entry) => entry.name === 'Release asset')
      < result.payload.elements.findIndex((entry) => entry.name === 'Issue search'),
  );
  assert.equal(result.payload.elements.some((entry) => entry.name === 'Sign in'), false);
});
