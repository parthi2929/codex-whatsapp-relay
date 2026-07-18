import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const OUTBOUND_PACING = Object.freeze({
  minDelayHundredths: 400,
  maxDelayHundredths: 1400,
  minSeparationHundredths: 400
});

const PACING_MARKER = Symbol.for("codex.whatsapp-relay.outbound-pacing");
const accountStates = new Map();

function rangeSize([start, end]) {
  return end >= start ? end - start + 1 : 0;
}

export function chooseOutboundDelayHundredths(
  previousDelayHundredths = null,
  {
    minDelayHundredths = OUTBOUND_PACING.minDelayHundredths,
    maxDelayHundredths = OUTBOUND_PACING.maxDelayHundredths,
    minSeparationHundredths = OUTBOUND_PACING.minSeparationHundredths,
    randomInteger = randomInt
  } = {}
) {
  if (!Number.isInteger(minDelayHundredths) || !Number.isInteger(maxDelayHundredths)) {
    throw new TypeError("Outbound pacing bounds must use integer hundredths of a second.");
  }
  if (minDelayHundredths > maxDelayHundredths) {
    throw new RangeError("Outbound pacing minimum exceeds its maximum.");
  }

  const ranges = [];
  if (Number.isInteger(previousDelayHundredths)) {
    const lowerEnd = Math.min(
      maxDelayHundredths,
      previousDelayHundredths - minSeparationHundredths
    );
    const upperStart = Math.max(
      minDelayHundredths,
      previousDelayHundredths + minSeparationHundredths
    );

    if (lowerEnd >= minDelayHundredths) {
      ranges.push([minDelayHundredths, lowerEnd]);
    }
    if (upperStart <= maxDelayHundredths) {
      ranges.push([upperStart, maxDelayHundredths]);
    }
  } else {
    ranges.push([minDelayHundredths, maxDelayHundredths]);
  }

  const availableValues = ranges.reduce((total, current) => total + rangeSize(current), 0);
  if (availableValues <= 0) {
    throw new RangeError("Outbound pacing has no value that satisfies the separation rule.");
  }

  let offset = randomInteger(0, availableValues);
  for (const [start, end] of ranges) {
    const size = rangeSize([start, end]);
    if (offset < size) {
      return start + offset;
    }
    offset -= size;
  }

  throw new Error("Outbound pacing random selection exceeded the available ranges.");
}

function stateFor(accountId) {
  const key = String(accountId || "default");
  let state = accountStates.get(key);
  if (!state) {
    state = {
      dispatchCount: 0,
      lastDispatchAt: null,
      previousDelayHundredths: null,
      queue: Promise.resolve()
    };
    accountStates.set(key, state);
  }
  return state;
}

export function installOutboundMessagePacing(
  socket,
  {
    accountId = "default",
    now = Date.now,
    sleep = delay,
    randomInteger = randomInt,
    onPacing = null
  } = {}
) {
  if (!socket || typeof socket.sendMessage !== "function") {
    throw new TypeError("WhatsApp socket sendMessage is unavailable for outbound pacing.");
  }

  if (socket[PACING_MARKER]) {
    return socket[PACING_MARKER];
  }

  const state = stateFor(accountId);
  const originalSendMessage = socket.sendMessage.bind(socket);

  socket.sendMessage = (...args) => {
    const operation = state.queue.then(async () => {
      let delayHundredths = null;
      let waitMs = 0;

      if (state.dispatchCount > 0) {
        delayHundredths = chooseOutboundDelayHundredths(
          state.previousDelayHundredths,
          { randomInteger }
        );
        const targetDispatchAt = state.lastDispatchAt + delayHundredths * 10;
        waitMs = Math.max(0, targetDispatchAt - now());
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }

      state.lastDispatchAt = now();
      state.dispatchCount += 1;
      if (delayHundredths !== null) {
        state.previousDelayHundredths = delayHundredths;
      }

      const pacing = {
        accountId: String(accountId || "default"),
        dispatchCount: state.dispatchCount,
        delaySeconds:
          delayHundredths === null ? null : (delayHundredths / 100).toFixed(2),
        waitMs
      };
      if (typeof onPacing === "function") {
        onPacing(pacing);
      }

      return originalSendMessage(...args);
    });

    state.queue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  };

  const controller = Object.freeze({
    accountId: String(accountId || "default"),
    snapshot: () => ({
      dispatchCount: state.dispatchCount,
      lastDispatchAt: state.lastDispatchAt,
      previousDelaySeconds:
        state.previousDelayHundredths === null
          ? null
          : (state.previousDelayHundredths / 100).toFixed(2)
    })
  });
  Object.defineProperty(socket, PACING_MARKER, {
    configurable: false,
    enumerable: false,
    value: controller,
    writable: false
  });
  return controller;
}
