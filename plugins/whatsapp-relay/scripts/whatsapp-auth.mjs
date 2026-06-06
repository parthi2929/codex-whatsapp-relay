import { WhatsAppAccountStore } from "./account-store.mjs";
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
const accountStore = new WhatsAppAccountStore();
await accountStore.load();
await accountStore.addAccount({
  tag: accountId,
  label: accountId === "personal" ? "Personal WhatsApp" : accountId
});

const runtime = new WhatsAppRuntime({
  accountId,
  logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "error"
});

process.stdout.write(`Starting WhatsApp terminal QR authentication for @${accountId}...\n`);
process.stdout.write(
  "Open WhatsApp on your phone, then go to Settings -> Linked Devices -> Link a Device.\n"
);

await runtime.start({ printQrToTerminal: true, force: true });

try {
  const socket = await runtime.waitForConnection(5 * 60_000);
  const user = socket.user?.id ?? "unknown";
  await accountStore.updateAccountStatus(accountId, {
    userId: user,
    lastStatus: "connected",
    connectedAt: new Date().toISOString()
  });
  process.stdout.write(`\nAuthenticated @${accountId} successfully as ${user}.\n`);
  process.exit(0);
} catch (error) {
  process.stderr.write(`\nAuthentication failed: ${error.message}\n`);
  process.exit(1);
}
