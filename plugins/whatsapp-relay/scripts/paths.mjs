import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const pluginRoot = path.resolve(scriptDir, "..");
export const repoRoot = path.resolve(pluginRoot, "..", "..");
export const dataDir = path.join(pluginRoot, "data");
export const accountsFile = path.join(dataDir, "accounts.json");
export const accountsDir = path.join(dataDir, "accounts");
export const defaultAccountId = "personal";
export const legacyAuthDir = path.join(dataDir, "auth");
export const legacyStoreFile = path.join(dataDir, "store.json");
export const legacyRuntimeFile = path.join(dataDir, "runtime.json");
export const legacyCredsFile = path.join(legacyAuthDir, "creds.json");
export const authDir = legacyAuthDir;
export const storeFile = legacyStoreFile;
export const runtimeFile = legacyRuntimeFile;
export const credsFile = legacyCredsFile;
export const controllerConfigFile = path.join(dataDir, "controller-config.json");
export const controllerStateFile = path.join(dataDir, "controller-state.json");
export const controllerLogFile = path.join(dataDir, "controller.log");
export const controllerOutboxDir = path.join(dataDir, "controller-outbox");
export const controllerOutboxFailedDir = path.join(dataDir, "controller-outbox.failed");
export const controllerDaemonScript = path.join(scriptDir, "controller-daemon.mjs");
export const globalControllerOwnerFile = path.join(
  process.env.HOME ?? repoRoot,
  ".codex",
  "plugins",
  "whatsapp-relay",
  "controller-owner.json"
);

export function normalizeAccountId(value = defaultAccountId) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || defaultAccountId;
}

export function getAccountPaths(accountId = defaultAccountId) {
  const id = normalizeAccountId(accountId);
  const accountDir = path.join(accountsDir, id);
  const accountAuthDir = path.join(accountDir, "auth");

  return {
    accountId: id,
    accountDir,
    authDir: accountAuthDir,
    storeFile: path.join(accountDir, "store.json"),
    runtimeFile: path.join(accountDir, "runtime.json"),
    credsFile: path.join(accountAuthDir, "creds.json")
  };
}

export async function ensureAccountRuntimeDirs(accountId = defaultAccountId) {
  const paths = getAccountPaths(accountId);
  await fs.mkdir(paths.authDir, { recursive: true });
  return paths;
}

export async function ensureRuntimeDirs(accountId = null) {
  if (accountId) {
    await ensureAccountRuntimeDirs(accountId);
  } else {
    await fs.mkdir(legacyAuthDir, { recursive: true });
  }
  await fs.mkdir(controllerOutboxDir, { recursive: true });
  await fs.mkdir(controllerOutboxFailedDir, { recursive: true });
}
