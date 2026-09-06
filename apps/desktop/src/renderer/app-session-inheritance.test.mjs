import assert from "node:assert/strict";
import test from "node:test";
import { inheritSessionInPlace } from "./app-session-inheritance.ts";
import { openTabInPaneLeaf, paneLeaves } from "./pane-layout.ts";

const route = { provider: "test", model: "new-model" };
const session = (id) => ({ kind: "session", id });
const leaf = (id, ids, active = ids[0]) => ({
  type: "leaf", id, tabs: ids.map(session), activeKey: `session:${active}`,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture() {
  const original = {
    sessionId: "source",
    desktopSessionTitle: "Original",
    items: [{ kind: "user", text: "Question" }, { kind: "assistant", text: "Answer" }],
  };
  const inherited = {
    ...original, sessionId: "heir", desktopSessionTitle: "Inherited", model: route.model,
  };
  const state = {
    layout: {
      type: "split", direction: "row", ratio: 0.37,
      first: leaf("left", ["before", "source", "after"], "source"),
      second: leaf("right", ["other"]),
    },
    focused: "left",
    active: "source",
    title: "Original",
    commits: [],
    lanes: new Map([["source", original]]),
  };
  const target = {
    inherit: async (id, selectedRoute) => {
      assert.equal(id, "source");
      assert.equal(selectedRoute, route);
      return { sessionId: "heir", snapshot: inherited };
    },
    leaves: () => paneLeaves(state.layout),
    focusedLeafId: () => state.focused,
    sourceTitle: () => state.title,
    refreshSessions: async () => [],
    readSession: async () => false,
    snapshot: (id) => state.lanes.get(id) ?? null,
    prepare: (id, snapshot) => state.lanes.set(id, snapshot),
    replace: (leafId, selection, title, sourceKey, focused) => {
      // The full incoming conversation must exist at the first visible commit.
      assert.deepEqual(state.lanes.get(selection.id), inherited);
      state.layout = openTabInPaneLeaf(state.layout, leafId, selection, sourceKey);
      state.title = title;
      if (focused) state.active = selection.id;
      state.commits.push({ leafId, focused });
    },
  };
  return { state, target, original, inherited };
}

test("inheritance replaces title and full content in the same strip slot only when prepared", async () => {
  const { state, target, original, inherited } = fixture();
  const creation = deferred();
  const catalog = deferred();
  target.inherit = () => creation.promise;
  target.refreshSessions = () => catalog.promise;
  const initialLayout = state.layout;
  const work = inheritSessionInPlace("source", route, target);
  assert.equal(state.layout, initialLayout);
  creation.resolve({ sessionId: "heir", snapshot: inherited });
  await Promise.resolve();
  assert.equal(state.layout, initialLayout);
  assert.equal(state.title, "Original");
  assert.equal(state.commits.length, 0);
  catalog.resolve([]);
  await work;
  assert.deepEqual(state.layout.first.tabs.map((tab) => tab.id), ["before", "heir", "after"]);
  assert.equal(state.layout.first.activeKey, "session:heir");
  assert.equal(state.layout.second, initialLayout.second);
  assert.equal(state.layout.ratio, 0.37);
  assert.equal(state.active, "heir");
  assert.equal(state.title, "Inherited");
  assert.equal(state.commits.length, 1);
  assert.equal(state.lanes.get("source"), original);
});

test("a later tab selection or pane focus is preserved while the original slot is replaced", async () => {
  for (const moveFocus of [false, true]) {
    const { state, target, inherited } = fixture();
    const pending = deferred();
    target.inherit = () => pending.promise;
    const work = inheritSessionInPlace("source", route, target);
    if (moveFocus) {
      state.focused = "right";
      state.active = "other";
    } else {
      state.layout.first = { ...state.layout.first, activeKey: "session:after" };
      state.active = "after";
    }
    pending.resolve({ sessionId: "heir", snapshot: inherited });
    await work;
    assert.equal(state.active, moveFocus ? "other" : "after");
    assert.equal(state.focused, moveFocus ? "right" : "left");
    assert.equal(state.commits[0].focused, false);
    assert.deepEqual(state.layout.first.tabs.map((tab) => tab.id), ["before", "heir", "after"]);
  }
});

test("a moved source is replaced in its new pane; a closed source is not reopened", async () => {
  for (const moved of [true, false]) {
    const { state, target, inherited } = fixture();
    const pending = deferred();
    target.inherit = () => pending.promise;
    const work = inheritSessionInPlace("source", route, target);
    state.layout.first = leaf("left", ["before", "after"]);
    if (moved) state.layout.second = leaf("right", ["other", "source"]);
    const changedLayout = state.layout;
    pending.resolve({ sessionId: "heir", snapshot: inherited });
    await work;
    if (moved) {
      assert.deepEqual(state.layout.second.tabs.map((tab) => tab.id), ["other", "heir"]);
      assert.equal(state.layout.second.activeKey, "session:other");
    } else {
      assert.equal(state.layout, changedLayout);
      assert.equal(state.commits.length, 0);
    }
  }
});

test("failed creation or unusable results leave the original title, content and tab untouched", async () => {
  for (const result of [
    new Error("creation failed"),
    { sessionId: "", snapshot: null },
    { sessionId: "source", snapshot: null },
    { sessionId: "heir", snapshot: { sessionId: "wrong", items: [] } },
    { sessionId: "heir", snapshot: null },
  ]) {
    const { state, target, original } = fixture();
    const layout = state.layout;
    target.inherit = async () => {
      if (result instanceof Error) throw result;
      return result;
    };
    await assert.rejects(inheritSessionInPlace("source", route, target));
    assert.equal(state.layout, layout);
    assert.equal(state.title, "Original");
    assert.equal(state.lanes.get("source"), original);
    assert.equal(state.commits.length, 0);
  }
});

test("a missing response snapshot is read before replacement; catalog failure is non-fatal", async () => {
  const { state, target, inherited } = fixture();
  target.inherit = async () => ({ sessionId: "heir", snapshot: null });
  target.readSession = async (id) => {
    state.lanes.set(id, inherited);
    return true;
  };
  target.refreshSessions = async () => { throw new Error("catalog offline"); };
  await inheritSessionInPlace("source", route, target);
  assert.equal(state.title, "Inherited");
  assert.equal(state.active, "heir");
});
