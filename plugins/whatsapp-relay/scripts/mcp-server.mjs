import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { formatAccountRef, WhatsAppAccountStore } from "./account-store.mjs";
import { ControllerConfigStore } from "./controller-config.mjs";
import {
  normalizePermissionLevel,
  resolvePermissionLevel
} from "./controller-permissions.mjs";
import { enqueueControllerCommand } from "./controller-outbox.mjs";
import {
  getControllerProcessStatus,
  startControllerDaemon,
  stopControllerDaemon
} from "./controller-process.mjs";
import { defaultAccountId, getAccountPaths, normalizeAccountId } from "./paths.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";
import { normalizeTtsProvider } from "./voice-replier.mjs";

const runtimes = new Map();
const accountStore = new WhatsAppAccountStore();
const controllerConfigStore = new ControllerConfigStore();

await accountStore.load();

function getRuntime(accountId = defaultAccountId) {
  const id = normalizeAccountId(accountId);
  let runtime = runtimes.get(id);
  if (!runtime) {
    runtime = new WhatsAppRuntime({
      accountId: id,
      logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "warn"
    });
    runtimes.set(id, runtime);
  }
  return runtime;
}

async function resolveAccountId(account = null) {
  await accountStore.load();
  return accountStore.resolveAccountId(account);
}

async function getInitializedRuntime(account = null) {
  const accountId = await resolveAccountId(account);
  const runtime = getRuntime(accountId);
  await runtime.initialize();
  return runtime;
}

function chatSummary(chat) {
  const stamp = chat.lastMessageTimestamp ?? chat.timestamp;
  return [
    `- ${chat.displayName} (${chat.id})`,
    `  unread=${chat.unreadCount ?? 0}`,
    stamp ? `last=${new Date(stamp * 1000).toISOString()}` : null,
    chat.lastMessageText ? `text=${chat.lastMessageText}` : null
  ]
    .filter(Boolean)
    .join(" ");
}

function messageSummary(message) {
  const stamp = message.timestamp
    ? new Date(message.timestamp * 1000).toISOString()
    : "unknown-time";
  const author = message.fromMe ? "me" : message.pushName || message.participant || "contact";
  return `- [${stamp}] ${author}: ${message.text || `[${message.messageType}]`}`;
}

function formatTimestamp(value) {
  return value ? new Date(value * 1000).toISOString() : "unknown-time";
}

function textResult(text, { isError = false } = {}) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ],
    isError
  };
}

function formatQrBlock(qrText) {
  return ["```text", qrText.trimEnd(), "```"].join("\n");
}

async function getBridgeState() {
  const [config, processStatus] = await Promise.all([
    controllerConfigStore.load(),
    getControllerProcessStatus()
  ]);

  return {
    config,
    processStatus,
    ownsLiveSession: config.enabled && processStatus.running
  };
}

async function ensureDirectRuntimeAvailable(action, account = null) {
  const runtime = await getInitializedRuntime(account);
  const bridgeState = await getBridgeState();
  if (bridgeState.ownsLiveSession) {
    throw new Error(
      `${action} is unavailable while the WhatsApp relay manager is running because the daemon owns the live WhatsApp sessions. Stop the bridge or use cached data.`
    );
  }

  return runtime.ensureConnected();
}

function controllerSummaryLines(config, processStatus) {
  const lines = [
    `enabled: ${config.enabled ? "yes" : "no"}`,
    `running: ${processStatus.running ? "yes" : "no"}`,
    "codex_transport: app-server",
    `controller_account: @${config.controllerAccount}`,
    `default_project: ${config.defaultProject}`,
    `workspace: ${config.workspace}`,
    `codex_bin: ${config.codexBin}`,
    `default_permission_level: ${config.permissionLevel}`,
    `capture_all_direct_messages: ${config.captureAllDirectMessages ? "yes" : "no"}`,
    `tts_provider: ${config.ttsProvider}`,
    `tts_chatterbox_allow_non_english: ${config.ttsChatterboxAllowNonEnglish ? "yes" : "no"}`,
    `allowed_controller_count: ${config.allowedControllers.length}`,
    `project_count: ${config.projects.length}`
  ];

  if (config.profile) {
    lines.push(`profile: ${config.profile}`);
  }

  if (config.model) {
    lines.push(`model: ${config.model}`);
  }

  if (processStatus.pid) {
    lines.push(`pid: ${processStatus.pid}`);
  }

  if (processStatus.process.startedAt) {
    lines.push(`started_at: ${processStatus.process.startedAt}`);
  }

  if (processStatus.process.heartbeatAt) {
    lines.push(`heartbeat_at: ${processStatus.process.heartbeatAt}`);
  }

  if (processStatus.process.whatsappAccounts?.length) {
    lines.push("");
    lines.push("whatsapp_accounts:");
    for (const account of processStatus.process.whatsappAccounts) {
      lines.push(
        `- @${account.accountId} status=${account.status} credentials=${
          account.hasCreds ? "present" : "missing"
        } chats=${account.recentChatCount ?? 0}${
          account.userId ? ` user=${account.userId}` : ""
        }`
      );
    }
  }

  if (config.allowedControllers.length) {
    lines.push("");
    lines.push("allowed_controllers:");
    for (const controller of config.allowedControllers) {
      lines.push(
        `- ${controller.label ? `${controller.label} ` : ""}${controller.number}`
      );
    }
  }

  if (config.projects.length) {
    lines.push("");
    lines.push("projects:");
    for (const project of config.projects) {
      lines.push(
        `- ${project.alias}${project.alias === config.defaultProject ? " (default)" : ""} workspace=${project.workspace}`
      );
    }
  }

  if (processStatus.sessions.length) {
    lines.push("");
    lines.push("sessions:");
    for (const session of processStatus.sessions) {
      lines.push(
        `- ${session.label ? `${session.label} ` : ""}${session.phoneKey} active_project=${
          session.activeProject ?? config.defaultProject
        } thread=${
          session.threadId ? session.threadId.slice(0, 8) : "none"
        } permissions=${session.permissionLevel ?? config.permissionLevel}`
      );
    }
  }

  return lines;
}

function resolveChatOrError(runtime, { chatId, chatName }) {
  const resolved = runtime.store.resolveChat({ chatId, chatName });
  if (resolved.match) {
    return resolved.match;
  }

  if (resolved.candidates.length > 1) {
    throw new Error(
      `Multiple chats matched "${chatName}". Candidates:\n${resolved.candidates
        .slice(0, 10)
        .map(chatSummary)
        .join("\n")}`
    );
  }

  throw new Error(
    chatId
      ? `Chat "${chatId}" was not found in the local WhatsApp cache.`
      : `Chat "${chatName}" was not found in the local WhatsApp cache.`
  );
}

const server = new McpServer({
  name: "whatsapp-relay",
  version: "0.2.0"
});

server.tool(
  "whatsapp_list_accounts",
  "List configured WhatsApp account tags.",
  {},
  async () => {
    try {
      const data = await accountStore.load();
      return textResult(
        [
          `default_account: @${data.defaultAccount}`,
          `controller_account: @${data.controllerAccount}`,
          "",
          ...data.accounts.map((account) => {
            const flags = [];
            if (account.id === data.defaultAccount) {
              flags.push("default");
            }
            if (account.id === data.controllerAccount) {
              flags.push("controller");
            }
            if (account.enabled === false) {
              flags.push("disabled");
            }
            return [
              `- ${formatAccountRef(account)}${flags.length ? ` (${flags.join(", ")})` : ""}`,
              account.label ? `  label=${account.label}` : null,
              account.number ? `  number=${account.number}` : null,
              account.userId ? `  user=${account.userId}` : null,
              account.lastStatus ? `  status=${account.lastStatus}` : null
            ]
              .filter(Boolean)
              .join(" ");
          })
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_add_account",
  "Add or update a tagged WhatsApp account before running its QR auth flow.",
  {
    tag: z.string().min(1),
    label: z.string().min(1).optional(),
    number: z.string().min(5).optional()
  },
  async ({ tag, label, number }) => {
    try {
      const account = await accountStore.addAccount({ tag, label, number });
      return textResult(
        [
          `Added WhatsApp account ${formatAccountRef(account)}.`,
          account.label ? `label: ${account.label}` : null,
          "Next step: call `whatsapp_start_auth` with this account tag and scan the QR code."
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_start_auth",
  "Start the local WhatsApp auth flow and return the current terminal-style QR code.",
  {
    account: z.string().min(1).optional()
  },
  async ({ account }) => {
    try {
      if (account) {
        await accountStore.addAccount({
          tag: account,
          label: normalizeAccountId(account)
        });
      }
      const runtime = await getInitializedRuntime(account);
      const result = await runtime.startAuthFlow();
      if (result.status === "connected") {
        await accountStore.updateAccountStatus(runtime.accountId, {
          userId: result.user?.id ?? null,
          lastStatus: "connected",
          connectedAt: new Date().toISOString()
        });
        return textResult(
          `WhatsApp account @${runtime.accountId} is already connected as ${result.user?.id ?? "unknown"}.`
        );
      }

      return textResult(
        [
          `Scan this QR code for WhatsApp account @${runtime.accountId} directly from the terminal or Codex output.`,
          "",
          formatQrBlock(result.qrText),
          "",
          "WhatsApp -> Settings -> Linked Devices -> Link a Device",
          "After scanning, call `whatsapp_auth_status` to confirm the session is connected.",
          "If terminal rendering is degraded, use the CLI fallback: `npm run whatsapp:auth`."
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_auth_status",
  "Show whether the local WhatsApp account is authenticated and connected.",
  {
    account: z.string().min(1).optional()
  },
  async ({ account }) => {
    const runtime = await getInitializedRuntime(account);
    const summary = runtime.summary();
    const bridgeState = await getBridgeState();
    const paths = getAccountPaths(runtime.accountId);
    const status =
      bridgeState.ownsLiveSession && summary.status === "idle"
        ? bridgeState.processStatus.process.whatsappStatus ?? "connected_via_bridge"
        : summary.status;
    const lines = [
      `account: @${runtime.accountId}`,
      `status: ${status}`,
      `credentials: ${summary.hasCreds ? "present" : "missing"}`,
      `auth_file: ${paths.credsFile}`,
      `cache_file: ${paths.storeFile}`,
      `recent_chat_count: ${summary.recentChatCount}`
    ];

    if (summary.user?.id) {
      lines.push(`user: ${summary.user.id}`);
    }

    if (bridgeState.ownsLiveSession) {
      lines.push("live_session_owner: controller_bridge");
      if (bridgeState.processStatus.process.whatsappUserId) {
        lines.push(`user: ${bridgeState.processStatus.process.whatsappUserId}`);
      }
    }

    if (summary.lastQrAt) {
      lines.push(`last_qr_at: ${summary.lastQrAt}`);
    }

    if (summary.currentQrText) {
      lines.push("qr_ready: yes");
      lines.push("");
      lines.push("current_qr:");
      lines.push(formatQrBlock(summary.currentQrText));
    }

    if (summary.lastDisconnect?.label) {
      lines.push(`last_disconnect: ${summary.lastDisconnect.label}`);
    } else if (bridgeState.processStatus.process.whatsappLastDisconnect?.label) {
      lines.push(
        `last_disconnect: ${bridgeState.processStatus.process.whatsappLastDisconnect.label}`
      );
    }

    if (!summary.hasCreds) {
      lines.push("next_step: call `whatsapp_start_auth` to get a QR code");
    }

    return textResult(lines.join("\n"));
  }
);

server.tool(
  "whatsapp_allow_controller",
  "Allow a WhatsApp number to control Codex through the controller bridge.",
  {
    number: z.string().min(5),
    label: z.string().min(1).optional()
  },
  async ({ number, label }) => {
    try {
      const controller = await controllerConfigStore.allowController({ number, label });
      return textResult(
        [
          `Allowed controller: ${controller.label ? `${controller.label} ` : ""}${
            controller.number
          }`,
          "Next step: call `whatsapp_start_controller_bridge` to enable phone control."
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_revoke_controller",
  "Remove a WhatsApp number from the controller allowlist.",
  {
    number: z.string().min(5)
  },
  async ({ number }) => {
    try {
      const removed = await controllerConfigStore.revokeController(number);
      return textResult(
        removed
          ? `Removed ${number} from the WhatsApp controller allowlist.`
          : `${number} was not in the WhatsApp controller allowlist.`
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_controller_status",
  "Show whether the WhatsApp-to-Codex controller bridge is configured and running.",
  {},
  async () => {
    try {
      const config = await controllerConfigStore.load();
      const processStatus = await getControllerProcessStatus();
      return textResult(controllerSummaryLines(config, processStatus).join("\n"));
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_start_controller_bridge",
  "Start the background WhatsApp-to-Codex controller bridge for allowed numbers.",
  {
    workspace: z.string().min(1).optional(),
    defaultProject: z.string().min(1).optional(),
    projects: z
      .array(
        z.object({
          alias: z.string().min(1).optional(),
          workspace: z.string().min(1),
          model: z.string().min(1).optional(),
          profile: z.string().min(1).optional(),
          permissionLevel: z.string().min(1).optional(),
          search: z.boolean().optional()
        })
      )
      .min(1)
      .optional(),
    model: z.string().min(1).optional(),
    profile: z.string().min(1).optional(),
    permissionLevel: z.string().min(1).optional(),
    search: z.boolean().optional(),
    captureAllDirectMessages: z.boolean().optional(),
    ttsProvider: z.string().min(1).optional(),
    ttsChatterboxAllowNonEnglish: z.boolean().optional()
  },
  async ({
    workspace,
    defaultProject,
    projects,
    model,
    profile,
    permissionLevel,
    search,
    captureAllDirectMessages,
    ttsProvider,
    ttsChatterboxAllowNonEnglish
  }) => {
    try {
      const existingConfig = await controllerConfigStore.load();
      const controllerRuntime = await getInitializedRuntime(
        existingConfig.controllerAccount
      );
      if (!controllerRuntime.hasSavedCreds()) {
        throw new Error(
          "WhatsApp is not authenticated yet. Run `whatsapp_start_auth` before starting the controller bridge."
        );
      }

      if (permissionLevel && !normalizePermissionLevel(permissionLevel)) {
        throw new Error(
          "Unknown permissionLevel. Use read-only, workspace-write, or danger-full-access."
        );
      }

      if (ttsProvider && normalizeTtsProvider(ttsProvider, null) === null) {
        throw new Error("Unknown ttsProvider. Use system or chatterbox-turbo.");
      }

      const config = await controllerConfigStore.update({
        enabled: true,
        ...(workspace ? { workspace } : {}),
        ...(defaultProject ? { defaultProject } : {}),
        ...(projects ? { projects } : {}),
        ...(model ? { model } : {}),
        ...(profile ? { profile } : {}),
        ...(permissionLevel
          ? { permissionLevel: resolvePermissionLevel(permissionLevel) }
          : {}),
        ...(typeof search === "boolean" ? { search } : {}),
        ...(typeof captureAllDirectMessages === "boolean"
          ? { captureAllDirectMessages }
          : {}),
        ...(ttsProvider ? { ttsProvider: normalizeTtsProvider(ttsProvider, "system") } : {}),
        ...(typeof ttsChatterboxAllowNonEnglish === "boolean"
          ? { ttsChatterboxAllowNonEnglish }
          : {})
      });

      if (!config.allowedControllers.length) {
        throw new Error(
          "No allowed controller numbers are configured yet. Call `whatsapp_allow_controller` first."
        );
      }

      const processStatus = await startControllerDaemon();
      return textResult(
        [
          "WhatsApp controller bridge is running.",
          ...controllerSummaryLines(config, processStatus),
          "",
          "Allowed direct chats can now send plain text to continue their Codex session.",
          "Bridge commands: /projects, /project <n|alias|hint>, /in, /btw, /n, /st, /ls, /1 or /session, /p, /a, /d, /q, /x, /h"
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_stop_controller_bridge",
  "Stop the background WhatsApp-to-Codex controller bridge.",
  {},
  async () => {
    try {
      const config = await controllerConfigStore.update({
        enabled: false
      });
      const processStatus = await stopControllerDaemon();
      return textResult(
        [
          "WhatsApp controller bridge stopped.",
          ...controllerSummaryLines(config, processStatus)
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_list_chats",
  "List recent WhatsApp chats from the local cache.",
  {
    account: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    query: z.string().min(1).optional(),
    unreadOnly: z.boolean().optional()
  },
  async ({ account, limit = 20, query, unreadOnly = false }) => {
    try {
      const runtime = await getInitializedRuntime(account);
      const chats = runtime.store.listChats({ limit, query, unreadOnly });
      if (!chats.length) {
        return textResult("No chats matched the requested filter.");
      }

      return textResult([`account: @${runtime.accountId}`, ...chats.map(chatSummary)].join("\n"));
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_read_messages",
  "Read recent messages from one WhatsApp chat, identified by chat id or name.",
  {
    account: z.string().min(1).optional(),
    chatId: z.string().min(1).optional(),
    chatName: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional()
  },
  async ({ account, chatId, chatName, limit = 20 }) => {
    try {
      const runtime = await getInitializedRuntime(account);
      const chat = resolveChatOrError(runtime, { chatId, chatName });
      const messages = runtime.store.getMessages(chat.id, limit);

      if (!messages.length) {
        return textResult(`No cached messages found for ${chat.displayName}.`);
      }

      return textResult(
        [
          `account: @${runtime.accountId}`,
          `chat: ${chat.displayName} (${chat.id})`,
          ...messages.map(messageSummary)
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_sync_history",
  "Request older messages for a WhatsApp chat and store them in the local cache.",
  {
    account: z.string().min(1).optional(),
    chatId: z.string().min(1).optional(),
    chatName: z.string().min(1).optional(),
    count: z.number().int().min(1).max(50).optional()
  },
  async ({ account, chatId, chatName, count = 50 }) => {
    try {
      await ensureDirectRuntimeAvailable("History sync", account);
      const runtime = await getInitializedRuntime(account);
      const chat = resolveChatOrError(runtime, { chatId, chatName });
      const result = await runtime.syncChatHistory({
        chatId: chat.id,
        count
      });

      return textResult(
        [
          `account: @${runtime.accountId}`,
          `chat: ${chat.displayName} (${chat.id})`,
          `requested: ${count}`,
          `history_events: ${result.events}`,
          `messages_received: ${result.messages}`,
          `cache_before: ${result.beforeCount}`,
          `cache_after: ${result.afterCount}`,
          `oldest_before: ${formatTimestamp(result.oldestTimestampBefore)}`,
          `oldest_after: ${formatTimestamp(result.oldestTimestampAfter)}`,
          `retention_limit: ${result.retentionLimit}`,
          `session_id: ${result.sessionId}`,
          result.timedOut ? "status: partial_sync_timeout" : "status: ok"
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_send_message",
  "Send a text message to a WhatsApp chat identified by id or name.",
  {
    account: z.string().min(1).optional(),
    chatId: z.string().min(1).optional(),
    chatName: z.string().min(1).optional(),
    text: z.string().min(1).max(4000)
  },
  async ({ account, chatId, chatName, text }) => {
    try {
      const runtime = await getInitializedRuntime(account);
      const chat = resolveChatOrError(runtime, { chatId, chatName });
      const bridgeState = await getBridgeState();

      if (bridgeState.ownsLiveSession) {
        await enqueueControllerCommand({
          type: "send_message",
          payload: {
            accountId: runtime.accountId,
            chatId: chat.id,
            text
          }
        });
        return textResult(
          `Queued message to ${chat.displayName} (${chat.id}) through WhatsApp account @${runtime.accountId}.`
        );
      }

      const socket = await runtime.ensureConnected();
      await socket.sendMessage(chat.id, { text });
      return textResult(`Sent message to ${chat.displayName} (${chat.id}).`);
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
