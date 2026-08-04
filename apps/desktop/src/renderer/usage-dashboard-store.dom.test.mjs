import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";

import { cleanupDom, installDom, root } from "./renderer-dom-test-harness.mjs";

const { ActivityRail } = await import("./ActivityRail.tsx");
const { SidebarUsage } = await import("./SidebarUsage.tsx");
const {
  getUsageDashboardSnapshot,
  holdUsageDashboardCadence,
  publishUsageDashboard,
  refreshUsageDashboard,
  resetUsageDashboardStore,
  sanitizeUsageDashboard,
  USAGE_DASHBOARD_CACHE_KEY,
} = await import("./usage-dashboard-store.ts");

const CODEX_RESET_ATTEMPT_KEY = "mixdog.desktop.codex-reset-attempt.v1";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  // Timers/subscribers are dropped while the window is still live, then the
  // DOM is retired — a store left holding a closed window would leak into the
  // next test exactly like the popup-owned timers this store replaced.
  resetUsageDashboardStore();
  await cleanupDom();
});

function dashboard(usedPct) {
  const checkedAt = Date.now();
  return {
    checkedAt,
    rows: [{
      id: "openai-oauth",
      label: "OpenAI OAuth",
      group: "oauth",
      authenticated: true,
      windows: [{ label: "WEEK", usedPct, resetAt: checkedAt + 86_400_000 }],
    }],
  };
}

function railProps(extra = {}) {
  return {
    activeSurface: null,
    sidebarOpen: false,
    onToggleSessions() {},
    onOpenProjects() {},
    onOpenWorkflows() {},
    onOpenSchedules() {},
    onOpenWebhooks() {},
    onCloseActiveSurface() {},
    onOpenSettings() {},
    onOpenUpdate() {},
    ...extra,
  };
}

function usageText() {
  return document.querySelector(".rail-usage-popup")?.textContent || "";
}

async function toggleUsage() {
  await act(async () => {
    document.querySelector(".sidebar-usage-toggle").click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Collapses the post-boot idle schedule so a real prewarm can be observed
 *  without waiting out its production quiet window. */
function accelerateIdleTimers() {
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(
    callback,
    typeof delay === "number" && delay > 0 && delay <= 5_000 ? 0 : delay,
    ...args,
  );
  return async () => {
    for (let tick = 0; tick < 4; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => nativeSetTimeout(resolve, 0));
      });
    }
  };
}

test("first Usage open paints the cached snapshot instead of Loading", async () => {
  installDom();
  window.localStorage.setItem(USAGE_DASHBOARD_CACHE_KEY, JSON.stringify(dashboard(31)));
  const usageApi = { invokeCapability: () => new Promise(() => {}) };

  await act(async () => root.render(React.createElement(ActivityRail, railProps({ usageApi }))));
  await toggleUsage();

  assert.match(usageText(), /W.*31%/s, "the stale seed must paint on the very first open");
  assert.doesNotMatch(usageText(), /Loading/,
    "a revalidation in flight must never replace valid rows with Loading");
});

test("the always mounted rail prewarms usage before the popup is ever opened", async () => {
  installDom();
  const advance = accelerateIdleTimers();
  const calls = [];
  const usageApi = {
    invokeCapability: async (request) => {
      calls.push(request);
      return { value: dashboard(44) };
    },
  };

  await act(async () => root.render(React.createElement(ActivityRail, railProps({ usageApi }))));
  await advance();

  assert.equal(document.querySelector(".rail-usage-popup"), null,
    "the prewarm must run with the flyout closed");
  assert.deepEqual(calls, [{
    capability: "getUsageDashboard",
    args: [{ refresh: true, refreshSetup: false }],
  }]);
  assert.equal(getUsageDashboardSnapshot().dashboard.rows.length, 1);

  await toggleUsage();
  assert.match(usageText(), /W.*44%/s, "the first click paints prewarmed rows");
  assert.equal(calls.length, 1, "fresh prewarmed data satisfies the open without a second request");
});

test("popup remounts share one in-flight usage request", async () => {
  installDom();
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const calls = [];
  const usageApi = {
    invokeCapability: async (request) => {
      calls.push(request);
      await gate;
      return { value: dashboard(57) };
    },
  };

  await act(async () => root.render(React.createElement(ActivityRail, railProps({ usageApi }))));
  await toggleUsage();
  await toggleUsage();
  await toggleUsage();
  assert.equal(calls.length, 1, "each remount adopts the in-flight request");

  await act(async () => {
    finish();
    await gate;
    await Promise.resolve();
  });
  assert.match(usageText(), /W.*57%/s);
});

test("Usage revalidates only after the refresh TTL expires", async () => {
  installDom();
  const calls = [];
  let usedPct = 12;
  const usageApi = {
    invokeCapability: async (request) => {
      calls.push(request);
      return { value: dashboard(usedPct) };
    },
  };

  await act(async () => root.render(React.createElement(ActivityRail, railProps({ usageApi }))));
  await toggleUsage();
  assert.equal(calls.length, 1);
  await toggleUsage();
  await toggleUsage();
  assert.equal(calls.length, 1, "a snapshot inside the TTL is reused across opens");

  const nativeNow = Date.now;
  Date.now = () => nativeNow() + 6 * 60_000;
  try {
    usedPct = 68;
    await toggleUsage();
    await toggleUsage();
    assert.equal(calls.length, 2, "an expired snapshot revalidates on open");
    assert.match(usageText(), /W.*68%/s);
  } finally {
    Date.now = nativeNow;
  }
});

test("a failed refresh keeps stale rows and schedules one bounded retry", async () => {
  installDom();
  window.localStorage.setItem(USAGE_DASHBOARD_CACHE_KEY, JSON.stringify(dashboard(31)));
  const nativeSetTimeout = window.setTimeout.bind(window);
  const retries = [];
  window.setTimeout = (callback, delay, ...args) => {
    if (delay === 15_000) {
      retries.push(() => callback(...args));
      return 15_000;
    }
    return nativeSetTimeout(callback, delay, ...args);
  };
  let attempt = 0;
  const usageApi = {
    invokeCapability: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary engine startup race");
      return { value: dashboard(63) };
    },
  };

  await act(async () => {
    root.render(React.createElement(SidebarUsage, { api: usageApi }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.body.textContent || "", /W.*31%/s,
    "the failure must leave the stale snapshot in place");
  assert.equal(retries.length, 1, "exactly one bounded retry per failure streak");

  await act(async () => {
    retries.pop()();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.body.textContent || "", /W.*63%/s);
  assert.equal(retries.length, 0, "a successful retry clears the bounded retry state");
});

test("consuming a reset credit updates the shared snapshot and its cache", async () => {
  installDom();
  const offerRevision = `v1:${"a".repeat(64)}`;
  const initial = {
    checkedAt: Date.now(),
    rows: [{
      id: "openai-oauth",
      label: "OpenAI OAuth",
      group: "oauth",
      authenticated: true,
      windows: [{ label: "5H", usedPct: 100 }],
      resetCredits: {
        availableCount: 1,
        availableCredits: [{ expiresAt: Date.now() + 2 * 86_400_000 }],
        offerRevision,
      },
    }],
  };
  const refreshed = {
    checkedAt: Date.now() + 1,
    rows: [{ ...initial.rows[0], windows: [{ label: "5H", usedPct: 0 }], resetCredits: {} }],
  };
  window.localStorage.setItem(USAGE_DASHBOARD_CACHE_KEY, JSON.stringify(initial));
  const consumeCalls = [];
  const usageApi = {
    invokeCapability: async (request) => {
      if (request.capability === "consumeCodexRateLimitResetCredit") {
        consumeCalls.push(request);
        return { value: { outcome: "reset", dashboard: refreshed } };
      }
      return { value: initial };
    },
  };

  await act(async () => {
    root.render(React.createElement(SidebarUsage, { api: usageApi }));
    await Promise.resolve();
  });
  await act(async () => document.querySelector('[aria-label="Use Codex reset credit 1"]').click());
  await act(async () => {
    document.querySelector('[aria-label="Confirm using Codex reset credit 1"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(consumeCalls.length, 1);
  assert.equal(consumeCalls[0].args[0].expectedOfferRevision, offerRevision);
  assert.equal(getUsageDashboardSnapshot().dashboard.rows[0].windows[0].usedPct, 0,
    "the mutation result becomes the shared snapshot, not popup-local state");
  assert.equal(
    JSON.parse(window.localStorage.getItem(USAGE_DASHBOARD_CACHE_KEY)).rows[0].windows[0].usedPct,
    0,
    "the existing usage cache is the only persisted copy and it is updated in place",
  );
  assert.ok(getUsageDashboardSnapshot().refreshedAt > 0,
    "a reset counts as a live response for the refresh TTL");
});

test("a confirmed reset without a rebuilt dashboard revalidates instead of claiming failure", async () => {
  installDom();
  const offerRevision = `v1:${"e".repeat(64)}`;
  const initial = {
    checkedAt: Date.now(),
    rows: [{
      id: "openai-oauth",
      label: "OpenAI OAuth",
      group: "oauth",
      authenticated: true,
      windows: [{ label: "5H", usedPct: 100 }],
      resetCredits: {
        availableCount: 1,
        availableCredits: [{ expiresAt: Date.now() + 2 * 86_400_000 }],
        offerRevision,
      },
    }],
  };
  const refreshed = {
    checkedAt: Date.now() + 1,
    rows: [{ ...initial.rows[0], windows: [{ label: "5H", usedPct: 0 }], resetCredits: {} }],
  };
  window.localStorage.setItem(USAGE_DASHBOARD_CACHE_KEY, JSON.stringify(initial));
  let consumed = false;
  const usageApi = {
    invokeCapability: async (request) => {
      if (request.capability === "consumeCodexRateLimitResetCredit") {
        consumed = true;
        // The runtime's courtesy refresh ran out of budget: the OUTCOME is
        // still the server's answer and the credit is spent.
        return { value: { outcome: "reset" } };
      }
      return { value: consumed ? refreshed : initial };
    },
  };

  await act(async () => {
    root.render(React.createElement(SidebarUsage, { api: usageApi }));
    await Promise.resolve();
  });
  await act(async () => document.querySelector('[aria-label="Use Codex reset credit 1"]').click());
  await act(async () => {
    document.querySelector('[aria-label="Confirm using Codex reset credit 1"]').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.match(document.querySelector('[role="status"]')?.textContent || "", /Rate limits reset/);
  assert.equal(window.localStorage.getItem(CODEX_RESET_ATTEMPT_KEY), null,
    "a confirmed outcome clears the durable attempt even without a rebuilt dashboard");
  assert.equal(getUsageDashboardSnapshot().dashboard.rows[0].windows[0].usedPct, 0,
    "the store revalidates so the surface stops showing pre-reset meters");
});

test("an account with no reset credits still states the reset-credit count", async () => {
  installDom();
  const initial = {
    checkedAt: Date.now(),
    rows: [{
      id: "openai-oauth",
      label: "OpenAI OAuth",
      group: "oauth",
      authenticated: true,
      windows: [{ label: "7D", usedPct: 90 }],
      resetCredits: {
        availableCount: 0,
        availableCredits: [],
        offerRevision: `v1:${"f".repeat(64)}`,
      },
    }],
  };
  window.localStorage.setItem(USAGE_DASHBOARD_CACHE_KEY, JSON.stringify(initial));
  const usageApi = { invokeCapability: async () => ({ value: initial }) };

  await act(async () => {
    root.render(React.createElement(SidebarUsage, { api: usageApi }));
    await Promise.resolve();
  });

  const section = document.querySelector(".sidebar-usage-reset-credit");
  assert.ok(section, "a known offer must state its count instead of hiding the feature");
  assert.equal(document.querySelectorAll(".sidebar-usage-reset-row").length, 0,
    "there is nothing to redeem, so no credit row may offer it");
});

test("reset confirmation follows the credit identity when a refresh inserts an earlier row", async () => {
  installDom();
  const checkedAt = Date.now();
  const offerRevision = `v1:${"d".repeat(64)}`;
  const credit = (days) => ({ expiresAt: checkedAt + days * 86_400_000 });
  const initial = {
    checkedAt,
    rows: [{
      id: "openai-oauth",
      label: "OpenAI OAuth",
      group: "oauth",
      authenticated: true,
      windows: [{ label: "5H", usedPct: 100 }],
      resetCredits: {
        availableCount: 2,
        availableCredits: [credit(2), credit(5)],
        offerRevision,
      },
    }],
  };
  window.localStorage.setItem(USAGE_DASHBOARD_CACHE_KEY, JSON.stringify(initial));
  const usageApi = { invokeCapability: async () => ({ value: initial }) };

  await act(async () => {
    root.render(React.createElement(SidebarUsage, { api: usageApi }));
    await Promise.resolve();
  });
  const selectedRow = document.querySelectorAll(".sidebar-usage-reset-row")[1];
  await act(async () => document.querySelector('[aria-label="Use Codex reset credit 2"]').click());
  assert.match(selectedRow.textContent || "", /uses one available credit/i);

  const refreshed = {
    ...initial,
    checkedAt: checkedAt + 1,
    rows: [{
      ...initial.rows[0],
      resetCredits: {
        availableCount: 3,
        availableCredits: [credit(1), credit(2), credit(5)],
        offerRevision,
      },
    }],
  };
  await act(async () => {
    assert.equal(publishUsageDashboard(refreshed), true);
    await Promise.resolve();
  });

  const rows = document.querySelectorAll(".sidebar-usage-reset-row");
  assert.equal(rows[2], selectedRow,
    "inserting an earlier credit must move, not remount, the selected credit row");
  assert.match(rows[2].textContent || "", /Reset credit 3.*uses one available credit/is,
    "confirmation stays with the selected credit rather than its former array index");
  assert.doesNotMatch(rows[1].textContent || "", /uses one available credit/i);
});

test("a reset response that predates the mutation can never overwrite it", async () => {
  installDom();
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const usageApi = {
    invokeCapability: async () => {
      await gate;
      return { value: dashboard(99) };
    },
  };
  const release = holdUsageDashboardCadence(usageApi);
  const inFlight = refreshUsageDashboard(usageApi);

  assert.equal(publishUsageDashboard(dashboard(3)), true,
    "a valid mutation dashboard is accepted");
  await act(async () => {
    finish();
    await inFlight;
    await Promise.resolve();
  });

  assert.equal(getUsageDashboardSnapshot().dashboard.rows[0].windows[0].usedPct, 3,
    "the older in-flight response must be dropped, not published");
  assert.equal(
    JSON.parse(window.localStorage.getItem(USAGE_DASHBOARD_CACHE_KEY)).rows[0].windows[0].usedPct,
    3,
    "a retired generation must not persist either",
  );
  release();
});

test("a malformed dashboard keeps stale rows and never reaches the cache", async () => {
  installDom();
  const seed = dashboard(31);
  window.localStorage.setItem(USAGE_DASHBOARD_CACHE_KEY, JSON.stringify(seed));
  const usageApi = {
    invokeCapability: async () => ({
      value: { rows: "not-an-array", nested: { poison: "x".repeat(4_000) } },
    }),
  };
  const release = holdUsageDashboardCadence(usageApi);

  await act(async () => { await refreshUsageDashboard(usageApi); });

  assert.equal(getUsageDashboardSnapshot().dashboard.rows[0].windows[0].usedPct, 31,
    "a fulfilled but malformed response must retain the valid stale snapshot");
  assert.equal(getUsageDashboardSnapshot().refreshedAt, 0,
    "nothing malformed may count as a live result for the TTL");
  assert.equal(window.localStorage.getItem(USAGE_DASHBOARD_CACHE_KEY), JSON.stringify(seed),
    "the persisted cache must be untouched by a refused payload");
  release();
});

test("the sanitizer keeps provider quota fields and drops unbounded junk", () => {
  installDom();
  const sanitized = sanitizeUsageDashboard({
    checkedAt: 1_700_000_000_000,
    rows: [{
      id: "openai-oauth",
      label: "OpenAI OAuth",
      group: "oauth",
      authenticated: true,
      windows: [{ label: "5H", usedPct: 17, resetAt: 1_700_000_100_000 }],
      resetCredits: {
        availableCount: 1,
        offerRevision: `v1:${"a".repeat(64)}`,
        availableCredits: [{ expiresAt: 1_700_100_000_000 }],
      },
      injected: { deep: { deeper: [1, 2, 3] } },
    }],
  });

  assert.deepEqual(sanitized.rows[0].windows[0], { label: "5H", usedPct: 17, resetAt: 1_700_000_100_000 },
    "quota windows survive intact");
  assert.equal(sanitized.rows[0].resetCredits.availableCredits[0].expiresAt, 1_700_100_000_000);
  assert.equal(sanitized.rows[0].authenticated, true);
  assert.equal("injected" in sanitized.rows[0], false, "unknown nested payloads are dropped");
  assert.equal(sanitizeUsageDashboard({ rows: {} }), null);
  assert.equal(sanitizeUsageDashboard("dashboard"), null);
});

test("no retry runs once the last cadence holder is released", async () => {
  installDom();
  const nativeSetTimeout = window.setTimeout.bind(window);
  const retries = [];
  window.setTimeout = (callback, delay, ...args) => {
    if (delay === 15_000) {
      retries.push(() => callback(...args));
      return 15_000;
    }
    return nativeSetTimeout(callback, delay, ...args);
  };
  const calls = [];
  const usageApi = {
    invokeCapability: async () => {
      calls.push("getUsageDashboard");
      throw new Error("engine unavailable");
    },
  };

  await act(async () => root.render(React.createElement(SidebarUsage, { api: usageApi })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  assert.equal(calls.length, 1);
  assert.equal(retries.length, 1);

  // Unmounting the only holder retires the store lifecycle: the captured retry
  // must not resurrect a request against a released API.
  await act(async () => root.render(React.createElement("div", null)));
  await act(async () => { await Promise.resolve(); });
  await act(async () => {
    retries.pop()();
    await Promise.resolve();
  });
  assert.equal(calls.length, 1, "a released cadence must not retry");
});

test("a seedless first open announces loading instead of Not connected", async () => {
  installDom();
  const usageApi = { invokeCapability: () => new Promise(() => {}) };

  await act(async () => root.render(React.createElement(ActivityRail, railProps({ usageApi }))));
  await toggleUsage();

  assert.match(usageText(), /Loading/,
    "the first paint without any cached row must announce loading");
  assert.doesNotMatch(usageText(), /Not connected/,
    "a transient Not connected claims an answer the first request has not returned");
});

test("an unrecognized reset outcome preserves the durable idempotency attempt", async () => {
  installDom();
  const offerRevision = `v1:${"b".repeat(64)}`;
  const initial = {
    checkedAt: Date.now(),
    rows: [{
      id: "openai-oauth",
      label: "OpenAI OAuth",
      group: "oauth",
      authenticated: true,
      windows: [{ label: "5H", usedPct: 100 }],
      resetCredits: {
        availableCount: 1,
        availableCredits: [{ expiresAt: Date.now() + 2 * 86_400_000 }],
        offerRevision,
      },
    }],
  };
  window.localStorage.setItem(USAGE_DASHBOARD_CACHE_KEY, JSON.stringify(initial));
  const usageApi = {
    invokeCapability: async (request) => (
      request.capability === "consumeCodexRateLimitResetCredit"
        // Unknown vocabulary AND no dashboard: nothing here is authoritative.
        ? { value: { outcome: "somethingElse" } }
        : { value: initial }
    ),
  };

  await act(async () => {
    root.render(React.createElement(SidebarUsage, { api: usageApi }));
    await Promise.resolve();
  });
  await act(async () => document.querySelector('[aria-label="Use Codex reset credit 1"]').click());
  await act(async () => {
    document.querySelector('[aria-label="Confirm using Codex reset credit 1"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.match(document.querySelector('[role="status"]')?.textContent || "",
    /could not be confirmed.*Retrying is safe/i);
  const attempt = JSON.parse(window.localStorage.getItem(CODEX_RESET_ATTEMPT_KEY) || "null");
  assert.equal(attempt?.offerRevision, offerRevision,
    "an unconfirmed reset keeps its idempotency key so a retry cannot spend a second credit");
  assert.equal(getUsageDashboardSnapshot().dashboard.rows[0].windows[0].usedPct, 100,
    "an unusable mutation payload must not replace the known dashboard");
});
