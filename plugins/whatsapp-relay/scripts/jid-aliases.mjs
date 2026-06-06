import fs from "node:fs/promises";
import path from "node:path";

function digitsOnly(value) {
  return String(value ?? "").replace(/\D+/g, "");
}

function addIfPresent(values, value) {
  const normalized = String(value ?? "").trim();
  if (normalized) {
    values.add(normalized);
  }
}

function collectStrings(value, strings = []) {
  if (typeof value === "string" || typeof value === "number") {
    strings.push(String(value));
    return strings;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, strings);
    }
    return strings;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item, strings);
    }
  }

  return strings;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function listFiles(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

function addJidsFromText(values, text) {
  const normalized = String(text ?? "").trim();
  const jidMatches = normalized.matchAll(/\b\d+(?::\d+)?@(?:s\.whatsapp\.net|lid|hosted|hosted\.lid)\b/gi);
  for (const match of jidMatches) {
    addIfPresent(values, match[0]);
  }
}

function addPhoneAliases(values, phoneKey) {
  if (phoneKey) {
    values.add(`${phoneKey}@s.whatsapp.net`);
  }
}

function addLidAliases(values, lidKey) {
  if (lidKey) {
    values.add(`${lidKey}@lid`);
  }
}

function phoneKeyFromInput(value) {
  const raw = String(value ?? "").trim();
  const jidMatch = raw.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/i);
  if (jidMatch) {
    return jidMatch[1];
  }

  if (raw.includes("@")) {
    return null;
  }

  return digitsOnly(raw);
}

function lidKeyFromInput(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/i);
  return match?.[1] ?? null;
}

async function findLidsForPhoneKey(phoneKey, authDir) {
  if (!phoneKey || !authDir) {
    return [];
  }

  const lids = new Set();
  const files = await listFiles(authDir);
  for (const file of files) {
    const reverseMatch = file.match(/^lid-mapping-(.+)_reverse\.json$/);
    if (!reverseMatch) {
      continue;
    }

    const mapped = await readJson(path.join(authDir, file));
    if (digitsOnly(collectStrings(mapped).join(" ")) === phoneKey) {
      lids.add(reverseMatch[1]);
    }
  }

  const forward = await readJson(path.join(authDir, `lid-mapping-${phoneKey}.json`));
  for (const value of collectStrings(forward)) {
    const lidMatch = value.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/i);
    if (lidMatch) {
      lids.add(lidMatch[1]);
      continue;
    }

    const numeric = digitsOnly(value);
    if (numeric && numeric !== phoneKey) {
      lids.add(numeric);
    }
  }

  return [...lids];
}

async function findPhoneKeyForLid(lidKey, authDir) {
  if (!lidKey || !authDir) {
    return null;
  }

  const reverse = await readJson(path.join(authDir, `lid-mapping-${lidKey}_reverse.json`));
  const phoneKey = digitsOnly(collectStrings(reverse).join(" "));
  return phoneKey || null;
}

function addStoreMatches(values, store, phoneKey) {
  if (!phoneKey || !store?.data) {
    return;
  }

  const keys = new Set([
    ...Object.keys(store.data.chats ?? {}),
    ...Object.keys(store.data.contacts ?? {}),
    ...Object.keys(store.data.messages ?? {})
  ]);

  for (const key of keys) {
    if (key.startsWith(`${phoneKey}@`) || key.startsWith(`${phoneKey}:`)) {
      values.add(key);
    }
  }
}

export async function resolveJidAliases(input, { authDir = null, store = null } = {}) {
  const raw = String(input ?? "").trim();
  const aliases = new Set();

  addIfPresent(aliases, raw.includes("@") ? raw : null);
  addJidsFromText(aliases, raw);

  let phoneKey = phoneKeyFromInput(raw);
  const lidKey = lidKeyFromInput(raw);

  if (lidKey) {
    const mappedPhoneKey = await findPhoneKeyForLid(lidKey, authDir);
    phoneKey = mappedPhoneKey ?? phoneKey;
    addLidAliases(aliases, lidKey);
  }

  addPhoneAliases(aliases, phoneKey);

  for (const lid of await findLidsForPhoneKey(phoneKey, authDir)) {
    addLidAliases(aliases, lid);
  }

  addStoreMatches(aliases, store, phoneKey);

  return {
    input: raw,
    phoneKey,
    aliases: [...aliases]
  };
}
