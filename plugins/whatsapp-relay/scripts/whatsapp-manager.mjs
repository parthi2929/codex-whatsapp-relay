import { WhatsAppAccountStore } from "./account-store.mjs";
import { defaultAccountId, normalizeAccountId } from "./paths.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";

export class WhatsAppRelayManager {
  constructor({
    accountStore = new WhatsAppAccountStore(),
    logLevel = process.env.WHATSAPP_LOG_LEVEL ?? "warn",
    createRuntime = (accountId) => new WhatsAppRuntime({ accountId, logLevel })
  } = {}) {
    this.accountStore = accountStore;
    this.createRuntime = createRuntime;
    this.runtimes = new Map();
    this.unsubscribers = [];
  }

  async initialize() {
    await this.accountStore.load();
  }

  getRuntime(accountId = defaultAccountId) {
    return this.runtimes.get(normalizeAccountId(accountId)) ?? null;
  }

  getOrCreateRuntime(accountId = defaultAccountId) {
    const id = normalizeAccountId(accountId);
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = this.createRuntime(id);
      this.runtimes.set(id, runtime);
      this.trackRuntime(runtime);
    }
    return runtime;
  }

  accountSummaries() {
    return Array.from(this.runtimes.values()).map((runtime) => {
      const summary = runtime.summary();
      return {
        accountId: runtime.accountId,
        status: summary.status,
        hasCreds: summary.hasCreds,
        userId: summary.user?.id ?? null,
        recentChatCount: summary.recentChatCount,
        lastDisconnect: summary.lastDisconnect ?? null
      };
    });
  }

  trackRuntime(runtime) {
    this.unsubscribers.push(
      runtime.on("connection.update", async () => {
        const summary = runtime.summary();
        await this.accountStore
          .updateAccountStatus(runtime.accountId, {
            lastStatus: summary.status,
            userId: summary.user?.id ?? null,
            ...(summary.status === "connected"
              ? { connectedAt: new Date().toISOString() }
              : {}),
            lastError: summary.lastDisconnect?.label ?? null
          })
          .catch((error) => {
            console.error(
              `failed to update WhatsApp account status for ${runtime.accountId}`,
              error
            );
          });
      })
    );
  }

  async startAccount(accountId, { requireCreds = false } = {}) {
    const runtime = this.getOrCreateRuntime(accountId);
    await runtime.initialize();

    if (!runtime.hasSavedCreds()) {
      if (requireCreds) {
        throw new Error(
          `WhatsApp account "@${runtime.accountId}" is not authenticated yet.`
        );
      }
      await this.accountStore.updateAccountStatus(runtime.accountId, {
        lastStatus: "not_authenticated"
      });
      return {
        accountId: runtime.accountId,
        status: "not_authenticated",
        runtime
      };
    }

    await runtime.start({ printQrToTerminal: false });
    return {
      accountId: runtime.accountId,
      status: runtime.summary().status,
      runtime
    };
  }

  async startAll() {
    await this.initialize();
    const results = [];
    for (const account of this.accountStore.listEnabledAccounts()) {
      results.push(await this.startAccount(account.id));
    }
    return results;
  }

  async stopAll() {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    for (const runtime of this.runtimes.values()) {
      await runtime.stop().catch(() => {});
    }
    this.runtimes.clear();
  }
}
