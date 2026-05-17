import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { ControllerConfigStore } from "./controller-config.mjs";
import {
  getControllerProcessStatus,
  startControllerDaemon
} from "./controller-process.mjs";

export async function ensureControllerRunningOnce({
  configStore = new ControllerConfigStore(),
  getProcessStatus = getControllerProcessStatus,
  startDaemon = startControllerDaemon
} = {}) {
  const config = await configStore.load();
  if (!config.enabled) {
    return {
      status: "disabled",
      processStatus: await getProcessStatus()
    };
  }

  const current = await getProcessStatus();
  if (current.running) {
    return {
      status: "already_running",
      processStatus: current
    };
  }

  await startDaemon();
  const next = await getProcessStatus();
  return {
    status: next.running ? "started" : "start_requested",
    processStatus: next
  };
}

export async function runControllerWatchdog({
  intervalMs = 60_000,
  ensureRunning = ensureControllerRunningOnce,
  onEvent = () => {},
  onError = (error) => console.error(error)
} = {}) {
  for (;;) {
    try {
      const result = await ensureRunning();
      onEvent(result);
    } catch (error) {
      onError(error);
    }

    await delay(intervalMs);
  }
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  const intervalMs = Number.parseInt(
    process.env.WHATSAPP_RELAY_WATCHDOG_INTERVAL_MS ?? "",
    10
  );

  await runControllerWatchdog({
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60_000,
    onEvent(result) {
      if (result.status === "started") {
        process.stdout.write("WhatsApp controller bridge restarted by watchdog.\n");
      }
    },
    onError(error) {
      console.error(`WhatsApp controller watchdog error: ${error.message}`);
    }
  });
}
