import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WhatsAppAccountStore } from "./account-store.mjs";

test("WhatsAppAccountStore creates a default personal account", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "account-store-test-"));
  const filePath = path.join(tempDir, "accounts.json");

  try {
    const store = new WhatsAppAccountStore(filePath);
    const data = await store.load();

    assert.equal(data.defaultAccount, "personal");
    assert.equal(data.controllerAccount, "personal");
    assert.deepEqual(
      data.accounts.map((account) => account.id),
      ["personal"]
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("WhatsAppAccountStore normalizes account tags and resolves aliases", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "account-store-test-"));
  const filePath = path.join(tempDir, "accounts.json");

  try {
    const store = new WhatsAppAccountStore(filePath);
    await store.load();
    const account = await store.addAccount({
      tag: "@Sales WhatsApp",
      label: "Sales"
    });

    assert.equal(account.id, "sales-whatsapp");
    assert.equal(account.tag, "sales-whatsapp");
    assert.equal(account.label, "Sales");
    assert.equal(store.resolveAccountId("@sales-whatsapp"), "sales-whatsapp");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
