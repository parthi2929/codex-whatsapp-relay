import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveJidAliases } from "./jid-aliases.mjs";
import { WhatsAppStore } from "./store.mjs";

test("resolveJidAliases maps a phone JID to the active LID chat", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jid-aliases-test-"));
  const authDir = path.join(tempDir, "auth");
  const phoneJid = "917389908818@s.whatsapp.net";
  const lidJid = "20594401787943@lid";
  const store = new WhatsAppStore(path.join(tempDir, "store.json"));

  try {
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(
      path.join(authDir, "lid-mapping-20594401787943_reverse.json"),
      JSON.stringify("917389908818"),
      "utf8"
    );

    store.ingestMessage({
      key: {
        remoteJid: phoneJid,
        id: "phone-message",
        fromMe: true
      },
      messageTimestamp: 100,
      message: {
        conversation: "sent on phone jid"
      }
    });
    store.ingestMessage({
      key: {
        remoteJid: lidJid,
        id: "lid-message",
        fromMe: false
      },
      pushName: "Contact",
      messageTimestamp: 200,
      message: {
        conversation: "reply on lid jid"
      }
    });

    const aliasInfo = await resolveJidAliases(phoneJid, { authDir, store });
    assert.deepEqual(new Set(aliasInfo.aliases), new Set([phoneJid, lidJid]));

    const resolved = store.resolveChat({
      chatId: phoneJid,
      aliases: aliasInfo.aliases
    });
    assert.equal(resolved.match.id, lidJid);

    const bareNumberAliases = await resolveJidAliases("+91 73899 08818", {
      authDir,
      store
    });
    const resolvedFromName = store.resolveChat({
      chatName: "+91 73899 08818",
      aliases: bareNumberAliases.aliases
    });
    assert.equal(resolvedFromName.match.id, lidJid);

    const messages = store.getMessagesForChats(
      resolved.candidates.map((candidate) => candidate.id),
      10
    );
    assert.deepEqual(
      messages.map((message) => message.text),
      ["sent on phone jid", "reply on lid jid"]
    );
  } finally {
    if (store.pendingSave) {
      clearTimeout(store.pendingSave);
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
