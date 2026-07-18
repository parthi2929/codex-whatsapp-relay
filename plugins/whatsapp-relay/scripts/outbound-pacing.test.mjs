import test from "node:test";
import assert from "node:assert/strict";

import {
  OUTBOUND_PACING,
  chooseOutboundDelayHundredths,
  installOutboundMessagePacing
} from "./outbound-pacing.mjs";

test("outbound pacing stays within 4.00-14.00 seconds at two-decimal precision", () => {
  let previous = null;
  for (let index = 0; index < 1_000; index += 1) {
    const current = chooseOutboundDelayHundredths(previous);
    assert.ok(current >= OUTBOUND_PACING.minDelayHundredths);
    assert.ok(current <= OUTBOUND_PACING.maxDelayHundredths);
    assert.match((current / 100).toFixed(2), /^\d{1,2}\.\d{2}$/);
    if (previous !== null) {
      assert.ok(
        Math.abs(current - previous) >= OUTBOUND_PACING.minSeparationHundredths
      );
    }
    previous = current;
  }
});

test("outbound pacing spaces concurrent sends and keeps consecutive delays far apart", async () => {
  let currentTime = 1_000;
  const dispatchTimes = [];
  const pacingEvents = [];
  const randomOffsets = [0, 600];
  const socket = {
    sendMessage: async () => {
      dispatchTimes.push(currentTime);
      return { key: { id: `message-${dispatchTimes.length}` } };
    }
  };

  installOutboundMessagePacing(socket, {
    accountId: `test-${Date.now()}-${Math.random()}`,
    now: () => currentTime,
    sleep: async (milliseconds) => {
      currentTime += milliseconds;
    },
    randomInteger: (minimum, maximum) => {
      const offset = randomOffsets.shift() ?? 0;
      assert.ok(minimum + offset < maximum);
      return minimum + offset;
    },
    onPacing: (event) => pacingEvents.push(event)
  });

  await Promise.all([
    socket.sendMessage("one", { text: "one" }),
    socket.sendMessage("two", { text: "two" }),
    socket.sendMessage("three", { text: "three" })
  ]);

  assert.deepEqual(dispatchTimes, [1_000, 5_000, 19_000]);
  assert.deepEqual(
    pacingEvents.map((event) => event.delaySeconds),
    [null, "4.00", "14.00"]
  );
  assert.equal(
    Number(pacingEvents[2].delaySeconds) - Number(pacingEvents[1].delaySeconds),
    10
  );
});

test("installOutboundMessagePacing wraps each socket only once", async () => {
  const socket = {
    sendMessage: async () => ({ key: { id: "message-1" } })
  };
  const accountId = `test-once-${Date.now()}-${Math.random()}`;

  const first = installOutboundMessagePacing(socket, { accountId });
  const second = installOutboundMessagePacing(socket, { accountId });

  assert.equal(first, second);
});
