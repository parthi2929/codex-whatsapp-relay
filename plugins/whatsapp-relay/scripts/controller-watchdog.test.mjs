import test from "node:test";
import assert from "node:assert/strict";

import { ensureControllerRunningOnce } from "./controller-watchdog.mjs";

test("ensureControllerRunningOnce leaves disabled controllers stopped", async () => {
  let starts = 0;
  const result = await ensureControllerRunningOnce({
    configStore: {
      async load() {
        return { enabled: false };
      }
    },
    async getProcessStatus() {
      return { running: false };
    },
    async startDaemon() {
      starts += 1;
    }
  });

  assert.equal(result.status, "disabled");
  assert.equal(starts, 0);
});

test("ensureControllerRunningOnce leaves healthy controllers alone", async () => {
  let starts = 0;
  const result = await ensureControllerRunningOnce({
    configStore: {
      async load() {
        return { enabled: true };
      }
    },
    async getProcessStatus() {
      return { running: true, pid: 42 };
    },
    async startDaemon() {
      starts += 1;
    }
  });

  assert.equal(result.status, "already_running");
  assert.equal(result.processStatus.pid, 42);
  assert.equal(starts, 0);
});

test("ensureControllerRunningOnce restarts an enabled stopped controller", async () => {
  let starts = 0;
  const statuses = [{ running: false }, { running: true, pid: 99 }];
  const result = await ensureControllerRunningOnce({
    configStore: {
      async load() {
        return { enabled: true };
      }
    },
    async getProcessStatus() {
      return statuses.shift();
    },
    async startDaemon() {
      starts += 1;
    }
  });

  assert.equal(result.status, "started");
  assert.equal(result.processStatus.pid, 99);
  assert.equal(starts, 1);
});
