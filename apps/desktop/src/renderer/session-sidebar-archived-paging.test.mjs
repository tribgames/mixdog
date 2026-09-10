import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

for (const withObserver of [true, false]) {
  test(`archived sessions page without narrowing bulk actions (${withObserver ? "observer" : "scroll"})`, async () => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" });
    const values = {
      window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
      CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(Object.keys(values).map((key) =>
      [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const observers = [];
    if (withObserver) {
      dom.window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe(target) { this.target = target; }
        takeRecords() { return []; }
        disconnect() { this.disconnected = true; }
      };
    }
    const { SessionSidebar } = await import("./session-sidebar.tsx");
    const root = createRoot(document.getElementById("root"));
    const sessions = Array.from({ length: 120 }, (_, i) => ({
      id: `archived-${i}`, title: `Archived ${i}`, preview: "", updatedAt: 120 - i,
      activityAt: 120 - i, messageCount: 1, cwd: "", classification: "task",
      projectPath: null, working: false, archived: true,
    }));
    const restored = [];
    const deleted = [];
    const props = {
      open: true, sessions, sessionsReady: true, selection: { kind: "new" },
      onNewTask() {}, onResumeSession() {}, async onRenameSession() {},
      async onArchiveSession(id, archived) { restored.push([id, archived]); },
      async onDeleteSession(id) { deleted.push(id); },
    };
    const render = async (extra = {}) => act(async () =>
      root.render(React.createElement(SessionSidebar, { ...props, ...extra })));
    const click = async (selector) => act(async () => {
      const target = document.querySelector(selector);
      assert.ok(target, selector);
      target.click();
    });
    const rows = () => document.querySelectorAll(".archived-session-list .session-row").length;
    const page = async () => act(async () => {
      if (withObserver) observers.at(-1).callback([{ isIntersecting: true }]);
      else document.querySelector(".sidebar-archived").closest(".session-sidebar-scroll")
        .dispatchEvent(new dom.window.Event("scroll"));
    });
    try {
      await render();
      assert.equal(rows(), 0);
      await click(".sidebar-archived-toggle");
      const initial = rows();
      assert.ok(initial > 0 && initial < sessions.length);
      await page();
      assert.ok(rows() > initial && rows() < sessions.length);
      const staleObserver = observers.at(-1);
      await click(".sidebar-archived-toggle");
      if (withObserver) {
        assert.equal(staleObserver.disconnected, true);
        await act(async () => staleObserver.callback([{ isIntersecting: true }]));
      }
      assert.equal(rows(), 0);
      await click(".sidebar-archived-toggle");
      assert.equal(rows(), initial, "reopening does not remount the accumulated pages");

      await click(".sidebar-archived .row-overflow-trigger");
      await click('[data-action-id="restore-all"]');
      assert.deepEqual(new Set(restored.map(([id]) => id)), new Set(sessions.map(({ id }) => id)));
      assert.ok(restored.every(([, archived]) => archived === false));
      await click(".sidebar-archived .row-overflow-trigger");
      await click('[data-action-id="delete-all-archived"]');
      assert.equal(deleted.length, 0);
      await click('[data-action-id="confirm-delete-all-archived"]');
      assert.deepEqual(new Set(deleted), new Set(sessions.map(({ id }) => id)));

      for (let attempts = 0; rows() < sessions.length && attempts < 10; attempts++) await page();
      assert.equal(rows(), sessions.length);
      assert.equal(document.querySelector(".archived-session-list .session-list-sentinel"), null);

      await click(".sidebar-archived-toggle");
      await render({ selection: { kind: "session", id: sessions.at(-1).id } });
      await click(".sidebar-archived-toggle");
      assert.ok(document.querySelector(`[data-session-id="${sessions.at(-1).id}"]`),
        "an active archived session beyond the first page remains reachable");
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
}
