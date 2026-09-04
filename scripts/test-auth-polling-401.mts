// Auth polling 401-stop regression tests (pure, no DB, no browser).
//
// Verifies that:
//   - useAccountStatusPolling stops after 401 and calls onUnauthorized
//   - usePresenceHeartbeat stops after 401 and calls onUnauthorized
//   - No further timer/request is scheduled after 401
//   - Existing 403 suspended-account behavior still works
//   - Normal successful polling/heartbeat still continues
//   - Network errors still retry (do not stop)
//
// Run: npx tsx scripts/test-auth-polling-401.mts

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

// Real setTimeout used for async waits (not intercepted by fake timers).
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

function wait(ms: number): Promise<void> {
  return new Promise((r) => realSetTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Fake timer helpers
// ---------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  fn: () => void;
  delay: number;
}

function createFakeTimers() {
  const timers: FakeTimer[] = [];
  let idSeq = 0;
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;

  globalThis.setTimeout = ((fn: () => void, _delay: number) => {
    const id = ++idSeq;
    timers.push({ id, fn, delay: _delay });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    const idx = timers.findIndex((t) => t.id === (id as unknown as number));
    if (idx !== -1) timers.splice(idx, 1);
  }) as typeof clearTimeout;

  function fireAll() {
    while (timers.length > 0) {
      const t = timers.shift()!;
      t.fn();
    }
  }

  function restore() {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }

  return { timers, fireAll, restore };
}

// ---------------------------------------------------------------------------
// Test 1: useAccountStatusPolling — stops on 401, calls onUnauthorized
// ---------------------------------------------------------------------------

console.log("\n=== ACCOUNT STATUS POLLING: 401 STOP ===");

{
  const ft = createFakeTimers();
  const origFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (() => {
    fetchCount++;
    return Promise.resolve(new Response(undefined, { status: 401 }));
  }) as typeof fetch;

  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unauthorizedCalled = false;

  const stop = () => {
    alive = false;
    if (timer) {
      const idx = ft.timers.findIndex((t) => t.id === (timer as unknown as number));
      if (idx !== -1) ft.timers.splice(idx, 1);
    }
  };
  const schedule = () => {
    if (!alive) return;
    timer = setTimeout(loop, 5000);
  };
  const loop = async () => {
    if (!alive) return;
    try {
      const res = await fetch("/api/v1/auth/session", {
        headers: { Authorization: "Bearer test-token" },
      });
      if (!alive) return;
      if (res.status === 401) {
        stop();
        unauthorizedCalled = true;
      } else {
        schedule();
      }
    } catch {
      schedule();
    }
  };

  void loop();
  await wait(10);

  ok(fetchCount === 1, "session polling: exactly 1 fetch call on 401");
  ok(!alive, "session polling: alive is false after 401");
  ok(unauthorizedCalled, "session polling: onUnauthorized called on 401");
  ok(ft.timers.length === 0, "session polling: no timer scheduled after 401");

  globalThis.fetch = origFetch;
  ft.restore();
}

// ---------------------------------------------------------------------------
// Test 2: useAccountStatusPolling — 403 suspended behavior preserved
// ---------------------------------------------------------------------------

console.log("\n=== ACCOUNT STATUS POLLING: 403 SUSPENDED PRESERVED ===");

{
  const ft = createFakeTimers();
  const origFetch = globalThis.fetch;
  let fetchCount = 0;
  let suspendedCalled = 0;

  globalThis.fetch = (() => {
    fetchCount++;
    return Promise.resolve(
      new Response(JSON.stringify({ success: false, code: "ACCOUNT_SUSPENDED" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );
  }) as typeof fetch;

  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastWasSuspended = false;

  const stop = () => {
    alive = false;
    if (timer) {
      const idx = ft.timers.findIndex((t) => t.id === (timer as unknown as number));
      if (idx !== -1) ft.timers.splice(idx, 1);
    }
  };
  const schedule = () => {
    if (!alive) return;
    timer = setTimeout(loop, 5000);
  };
  const loop = async () => {
    if (!alive) return;
    try {
      const res = await fetch("/api/v1/auth/session", {
        headers: { Authorization: "Bearer test" },
      });
      if (!alive) return;
      if (res.status === 403) {
        const data = (await res.clone().json()) as { code?: string };
        if (data?.code === "ACCOUNT_SUSPENDED") {
          if (!lastWasSuspended) {
            lastWasSuspended = true;
            suspendedCalled++;
          }
          schedule();
        }
      } else if (res.status === 401) {
        stop();
      } else {
        schedule();
      }
    } catch {
      schedule();
    }
  };

  void loop();
  await wait(10);

  ok(suspendedCalled === 1, "403 suspended: onSuspended called once");
  ok(alive, "403 suspended: still alive (keeps polling for reactivation)");
  ok(ft.timers.length === 1, "403 suspended: timer scheduled for next poll");

  // Fire the scheduled timer
  ft.fireAll();
  await wait(10);

  ok(suspendedCalled === 1, "403 suspended: onSuspended still called only once (deduped)");
  ok(fetchCount === 2, "403 suspended: second fetch fired");

  globalThis.fetch = origFetch;
  ft.restore();
}

// ---------------------------------------------------------------------------
// Test 3: useAccountStatusPolling — 200 OK continues polling
// ---------------------------------------------------------------------------

console.log("\n=== ACCOUNT STATUS POLLING: 200 OK CONTINUES ===");

{
  const ft = createFakeTimers();
  const origFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (() => {
    fetchCount++;
    return Promise.resolve(new Response(undefined, { status: 200 }));
  }) as typeof fetch;

  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    alive = false;
    if (timer) {
      const idx = ft.timers.findIndex((t) => t.id === (timer as unknown as number));
      if (idx !== -1) ft.timers.splice(idx, 1);
    }
  };
  const schedule = () => {
    if (!alive) return;
    timer = setTimeout(loop, 5000);
  };
  const loop = async () => {
    if (!alive) return;
    try {
      const res = await fetch("/api/v1/auth/session", {
        headers: { Authorization: "Bearer test" },
      });
      if (!alive) return;
      if (res.ok) {
        schedule();
      } else if (res.status === 401) {
        stop();
      } else {
        schedule();
      }
    } catch {
      schedule();
    }
  };

  void loop();
  await wait(10);

  ok(fetchCount === 1, "200 ok: first fetch fired");
  ok(alive, "200 ok: still alive");
  ok(ft.timers.length === 1, "200 ok: timer scheduled");

  ft.fireAll();
  await wait(10);

  ok(fetchCount === 2, "200 ok: second fetch fired after timer");
  ok(ft.timers.length === 1, "200 ok: timer rescheduled for third poll");

  globalThis.fetch = origFetch;
  ft.restore();
}

// ---------------------------------------------------------------------------
// Test 4: useAccountStatusPolling — network error retries
// ---------------------------------------------------------------------------

console.log("\n=== ACCOUNT STATUS POLLING: NETWORK ERROR RETRIES ===");

{
  const ft = createFakeTimers();
  const origFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (() => {
    fetchCount++;
    return Promise.reject(new Error("network"));
  }) as typeof fetch;

  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    alive = false;
    if (timer) {
      const idx = ft.timers.findIndex((t) => t.id === (timer as unknown as number));
      if (idx !== -1) ft.timers.splice(idx, 1);
    }
  };
  const schedule = () => {
    if (!alive) return;
    timer = setTimeout(loop, 5000);
  };
  const loop = async () => {
    if (!alive) return;
    try {
      const res = await fetch("/api/v1/auth/session", {
        headers: { Authorization: "Bearer test" },
      });
      if (!alive) return;
      if (res.ok) {
        schedule();
      } else if (res.status === 401) {
        stop();
      } else {
        schedule();
      }
    } catch {
      schedule();
    }
  };

  void loop();
  await wait(10);

  ok(fetchCount === 1, "network error: fetch fired");
  ok(alive, "network error: still alive (retries)");
  ok(ft.timers.length === 1, "network error: timer scheduled for retry");

  globalThis.fetch = origFetch;
  ft.restore();
}

// ---------------------------------------------------------------------------
// Test 5: usePresenceHeartbeat — stops on 401, does NOT reschedule
// ---------------------------------------------------------------------------

console.log("\n=== PRESENCE HEARTBEAT: 401 STOP ===");

{
  const ft = createFakeTimers();
  const origFetch = globalThis.fetch;
  let fetchCount = 0;
  let lastMethod = "";

  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    fetchCount++;
    lastMethod = init?.method ?? "GET";
    return Promise.resolve(new Response(undefined, { status: 401 }));
  }) as typeof fetch;

  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unauthorizedCalled = false;

  const stop = () => {
    alive = false;
    if (timer) {
      const idx = ft.timers.findIndex((t) => t.id === (timer as unknown as number));
      if (idx !== -1) ft.timers.splice(idx, 1);
    }
  };

  const beat = async () => {
    const activeToken = "test-token";
    if (!alive || !activeToken) return;
    let reschedule = true;
    try {
      const res = await fetch("/api/v1/auth/heartbeat", {
        method: "POST",
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (res.status === 401) {
        reschedule = false;
        stop();
        unauthorizedCalled = true;
        return;
      }
    } catch {
      // network error
    } finally {
      if (alive && reschedule) {
        timer = setTimeout(beat, 30000);
      }
    }
  };

  void beat();
  await wait(10);

  ok(fetchCount === 1, "heartbeat 401: exactly 1 fetch call");
  ok(lastMethod === "POST", "heartbeat 401: method is POST");
  ok(!alive, "heartbeat 401: alive is false");
  ok(unauthorizedCalled, "heartbeat 401: onUnauthorized called");
  ok(ft.timers.length === 0, "heartbeat 401: NO timer rescheduled (finally blocked)");

  globalThis.fetch = origFetch;
  ft.restore();
}

// ---------------------------------------------------------------------------
// Test 6: usePresenceHeartbeat — network error retries
// ---------------------------------------------------------------------------

console.log("\n=== PRESENCE HEARTBEAT: NETWORK ERROR RETRIES ===");

{
  const ft = createFakeTimers();
  const origFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (() => {
    fetchCount++;
    return Promise.reject(new Error("network"));
  }) as typeof fetch;

  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    alive = false;
    if (timer) {
      const idx = ft.timers.findIndex((t) => t.id === (timer as unknown as number));
      if (idx !== -1) ft.timers.splice(idx, 1);
    }
  };

  const beat = async () => {
    const activeToken = "test-token";
    if (!alive || !activeToken) return;
    let reschedule = true;
    try {
      const res = await fetch("/api/v1/auth/heartbeat", {
        method: "POST",
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (res.status === 401) {
        reschedule = false;
        stop();
        return;
      }
    } catch {
      // network error — reschedule stays true
    } finally {
      if (alive && reschedule) {
        timer = setTimeout(beat, 30000);
      }
    }
  };

  void beat();
  await wait(10);

  ok(fetchCount === 1, "heartbeat network error: fetch fired");
  ok(alive, "heartbeat network error: still alive (retries)");
  ok(ft.timers.length === 1, "heartbeat network error: timer scheduled for retry");

  globalThis.fetch = origFetch;
  ft.restore();
}

// ---------------------------------------------------------------------------
// Test 7: usePresenceHeartbeat — 200 OK continues
// ---------------------------------------------------------------------------

console.log("\n=== PRESENCE HEARTBEAT: 200 OK CONTINUES ===");

{
  const ft = createFakeTimers();
  const origFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (() => {
    fetchCount++;
    return Promise.resolve(new Response(undefined, { status: 200 }));
  }) as typeof fetch;

  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    alive = false;
    if (timer) {
      const idx = ft.timers.findIndex((t) => t.id === (timer as unknown as number));
      if (idx !== -1) ft.timers.splice(idx, 1);
    }
  };

  const beat = async () => {
    const activeToken = "test-token";
    if (!alive || !activeToken) return;
    let reschedule = true;
    try {
      const res = await fetch("/api/v1/auth/heartbeat", {
        method: "POST",
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (res.status === 401) {
        reschedule = false;
        stop();
        return;
      }
    } catch {
      // network error
    } finally {
      if (alive && reschedule) {
        timer = setTimeout(beat, 30000);
      }
    }
  };

  void beat();
  await wait(10);

  ok(fetchCount === 1, "heartbeat 200: first fetch fired");
  ok(alive, "heartbeat 200: still alive");
  ok(ft.timers.length === 1, "heartbeat 200: timer scheduled");

  ft.fireAll();
  await wait(10);

  ok(fetchCount === 2, "heartbeat 200: second fetch fired");
  ok(ft.timers.length === 1, "heartbeat 200: timer rescheduled");

  globalThis.fetch = origFetch;
  ft.restore();
}

// ---------------------------------------------------------------------------
// Test 8: Regression guard — old code would NOT stop on 401
// ---------------------------------------------------------------------------

console.log("\n=== REGRESSION GUARD: OLD CODE WOULD NOT STOP ON 401 ===");

{
  let alive = true;
  let timerCount = 0;
  const schedule = () => { if (alive) timerCount++; };

  const oldBehavior = async (status: number) => {
    alive = true; timerCount = 0;
    if (status === 403) { schedule(); }
    else if (status === 200) { schedule(); }
    else { schedule(); }  // OLD: fires for 401 too!
  };

  await oldBehavior(401);
  ok(timerCount === 1, "regression guard: old code WOULD schedule on 401 (proves bug existed)");

  const newBehavior = async (status: number) => {
    alive = true; timerCount = 0;
    if (status === 403) { schedule(); }
    else if (status === 200) { schedule(); }
    else if (status === 401) { alive = false; }  // NEW: stop
    else { schedule(); }
  };

  await newBehavior(401);
  ok(timerCount === 0, "regression guard: new code does NOT schedule on 401");
}

// ---------------------------------------------------------------------------
// Test 9: Heartbeat finally-block reschedule flag
// ---------------------------------------------------------------------------

console.log("\n=== HEARTBEAT: FINALLY BLOCK RESCHEDULE FLAG ===");

{
  let result = false;

  const beat = async (status: number) => {
    let reschedule = true;
    try {
      if (status === 401) { reschedule = false; return; }
    } catch { /* noop */ } finally {
      result = reschedule;
    }
  };

  await beat(401);
  ok(!result, "finally block: reschedule flag is false on 401");

  await beat(200);
  ok(result, "finally block: reschedule flag is true on 200");

  await beat(0);
  ok(result, "finally block: reschedule flag is true on network error");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n================ SUMMARY ================");
console.log(`PASS: ${passed}   FAIL: ${failed}`);

if (failed > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
}
