import fs from "node:fs/promises";
import path from "node:path";

import {
  accountsFile,
  dataDir,
  defaultAccountId,
  getAccountPaths,
  legacyAuthDir,
  legacyCredsFile,
  legacyRuntimeFile,
  legacyStoreFile,
  normalizeAccountId
} from "./paths.mjs";

function defaultAccounts() {
  return {
    defaultAccount: defaultAccountId,
    controllerAccount: defaultAccountId,
    accounts: []
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfMissing(source, target, missingTarget = target) {
  if (!(await exists(source)) || (await exists(missingTarget))) {
    return false;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: false
  });
  return true;
}

function normalizeAccount(value = {}, fallbackId = defaultAccountId) {
  const id = normalizeAccountId(value.id ?? value.tag ?? fallbackId);
  return {
    id,
    tag: normalizeAccountId(value.tag ?? id),
    label: value.label ?? (id === defaultAccountId ? "Personal WhatsApp" : id),
    number: value.number ?? null,
    enabled: value.enabled !== false,
    addedAt: value.addedAt ?? new Date().toISOString(),
    connectedAt: value.connectedAt ?? null,
    userId: value.userId ?? null,
    lastStatus: value.lastStatus ?? null,
    lastStatusAt: value.lastStatusAt ?? null,
    lastError: value.lastError ?? null
  };
}

function normalizeAccountsData(value = {}) {
  const merged = {
    ...defaultAccounts(),
    ...value
  };
  const seen = new Set();
  const accounts = [];

  for (const account of merged.accounts ?? []) {
    const normalized = normalizeAccount(account);
    if (seen.has(normalized.id)) {
      continue;
    }
    seen.add(normalized.id);
    accounts.push(normalized);
  }

  const defaultAccount = normalizeAccountId(merged.defaultAccount);
  const controllerAccount = normalizeAccountId(merged.controllerAccount ?? defaultAccount);

  if (!accounts.some((account) => account.id === defaultAccount)) {
    accounts.unshift(normalizeAccount({ id: defaultAccount }));
  }

  if (!accounts.some((account) => account.id === controllerAccount)) {
    accounts.unshift(normalizeAccount({ id: controllerAccount }));
  }

  return {
    defaultAccount,
    controllerAccount,
    accounts
  };
}

export class WhatsAppAccountStore {
  constructor(filePath = accountsFile) {
    this.filePath = filePath;
    this.data = defaultAccounts();
    this.queue = Promise.resolve();
  }

  async load() {
    let diskData = null;
    try {
      diskData = normalizeAccountsData(
        JSON.parse(await fs.readFile(this.filePath, "utf8"))
      );
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
      diskData = normalizeAccountsData(defaultAccounts());
    }

    this.data = diskData;
    const migrated = await this.migrateLegacySingleAccount();

    if (
      migrated ||
      JSON.stringify(this.data) !== JSON.stringify(diskData) ||
      !(await exists(this.filePath))
    ) {
      await this.save();
    }

    return this.data;
  }

  async save() {
    this.data = normalizeAccountsData(this.data);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempFile = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    await fs.writeFile(tempFile, JSON.stringify(this.data, null, 2));
    await fs.rename(tempFile, this.filePath);
    return this.data;
  }

  async mutate(mutator) {
    const run = this.queue.then(async () => {
      await this.load();
      await mutator(this.data);
      return this.save();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async migrateLegacySingleAccount() {
    if (!(await exists(legacyCredsFile))) {
      return false;
    }

    const accountId = this.data.controllerAccount ?? this.data.defaultAccount;
    const accountPaths = getAccountPaths(accountId);
    let copied = false;
    copied =
      (await copyIfMissing(
        legacyAuthDir,
        accountPaths.authDir,
        accountPaths.credsFile
      )) || copied;
    copied = (await copyIfMissing(legacyStoreFile, accountPaths.storeFile)) || copied;
    copied = (await copyIfMissing(legacyRuntimeFile, accountPaths.runtimeFile)) || copied;

    const existingIndex = this.data.accounts.findIndex((account) => account.id === accountId);
    const account = normalizeAccount({
      ...(existingIndex >= 0 ? this.data.accounts[existingIndex] : {}),
      id: accountId,
      tag: accountId,
      label:
        existingIndex >= 0
          ? this.data.accounts[existingIndex].label
          : "Personal WhatsApp",
      enabled: true
    });

    if (existingIndex >= 0) {
      this.data.accounts[existingIndex] = account;
    } else {
      this.data.accounts.unshift(account);
    }

    return copied;
  }

  resolveAccountId(value = null) {
    const requested = normalizeAccountId(value ?? this.data.defaultAccount);
    const match =
      this.data.accounts.find(
        (account) => account.id === requested || account.tag === requested
      ) ?? null;
    if (!match) {
      throw new Error(`Unknown WhatsApp account "@${requested}".`);
    }
    return match.id;
  }

  listEnabledAccounts() {
    return this.data.accounts.filter((account) => account.enabled !== false);
  }

  async addAccount({ tag, label = null, number = null, enabled = true } = {}) {
    const id = normalizeAccountId(tag);
    return this.mutate((data) => {
      const existingIndex = data.accounts.findIndex(
        (account) => account.id === id || account.tag === id
      );
      const nextAccount = normalizeAccount({
        ...(existingIndex >= 0 ? data.accounts[existingIndex] : {}),
        id,
        tag: id,
        label: label ?? (existingIndex >= 0 ? data.accounts[existingIndex].label : id),
        number,
        enabled
      });

      if (existingIndex >= 0) {
        data.accounts[existingIndex] = nextAccount;
      } else {
        data.accounts.push(nextAccount);
      }
    }).then(() => this.data.accounts.find((account) => account.id === id));
  }

  async updateAccountStatus(accountId, partial = {}) {
    const id = normalizeAccountId(accountId);
    return this.mutate((data) => {
      const existingIndex = data.accounts.findIndex((account) => account.id === id);
      const current =
        existingIndex >= 0 ? data.accounts[existingIndex] : normalizeAccount({ id });
      const next = normalizeAccount({
        ...current,
        ...partial,
        id,
        tag: current.tag ?? id,
        lastStatusAt: new Date().toISOString()
      });
      if (existingIndex >= 0) {
        data.accounts[existingIndex] = next;
      } else {
        data.accounts.push(next);
      }
    });
  }
}

export function formatAccountRef(account = {}) {
  return `@${account.tag ?? account.id ?? defaultAccountId}`;
}
