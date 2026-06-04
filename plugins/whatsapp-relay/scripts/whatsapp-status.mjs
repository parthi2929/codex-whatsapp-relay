import { ControllerConfigStore } from "./controller-config.mjs";
import { getControllerProcessStatus } from "./controller-process.mjs";
import { normalizeAccountId } from "./paths.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";

function parseAccountArg(argv = process.argv.slice(2)) {
  const accountFlag = argv.find((arg) => arg.startsWith("--account="));
  const tagFlag = argv.find((arg) => arg.startsWith("--tag="));
  const index = argv.findIndex((arg) => arg === "--account" || arg === "--tag");
  const raw =
    accountFlag?.split("=").slice(1).join("=") ??
    tagFlag?.split("=").slice(1).join("=") ??
    (index >= 0 ? argv[index + 1] : null);
  return normalizeAccountId(raw);
}

const accountId = parseAccountArg();
const runtime = new WhatsAppRuntime({
  accountId,
  logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "error"
});
const controllerConfigStore = new ControllerConfigStore();

if (!runtime.hasSavedCreds()) {
  process.stdout.write(`account: @${accountId}\n`);
  process.stdout.write("status: not_authenticated\n");
  process.stdout.write(
    `next: use \`whatsapp_start_auth\` in Codex with account=${accountId} or run \`npm run whatsapp:auth -- --account ${accountId}\`\n`
  );
  process.exit(0);
}

const [controllerConfig, controllerProcessStatus] = await Promise.all([
  controllerConfigStore.load(),
  getControllerProcessStatus()
]);

if (controllerConfig.enabled && controllerProcessStatus.running) {
  process.stdout.write(`account: @${accountId}\n`);
  process.stdout.write(
    `status: ${
      controllerProcessStatus.process.whatsappStatus ?? "connected_via_bridge"
    }\n`
  );
  process.stdout.write("live_session_owner: controller_bridge\n");
  if (controllerProcessStatus.process.whatsappUserId) {
    process.stdout.write(`user: ${controllerProcessStatus.process.whatsappUserId}\n`);
  }
  if (controllerProcessStatus.process.whatsappLastDisconnect?.label) {
    process.stdout.write(
      `last_disconnect: ${controllerProcessStatus.process.whatsappLastDisconnect.label}\n`
    );
  }
  process.exit(0);
}

await runtime.start({ printQrToTerminal: false });

try {
  const socket = await runtime.waitForConnection(20_000);
  process.stdout.write(`account: @${accountId}\n`);
  process.stdout.write("status: connected\n");
  process.stdout.write(`user: ${socket.user?.id ?? "unknown"}\n`);
  process.exit(0);
} catch (error) {
  const summary = runtime.summary();
  process.stdout.write(`account: @${accountId}\n`);
  process.stdout.write(`status: ${summary.status}\n`);
  if (summary.lastDisconnect?.label) {
    process.stdout.write(`last_disconnect: ${summary.lastDisconnect.label}\n`);
  }
  process.stdout.write(
    "next: use `whatsapp_start_auth` in Codex or rerun `npm run whatsapp:auth` if the session was logged out\n"
  );
  process.exit(1);
}
