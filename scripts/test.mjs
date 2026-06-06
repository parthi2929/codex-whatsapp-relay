import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

async function listTestFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

const files = [
  ...(await listTestFiles(path.join("plugins", "whatsapp-relay", "scripts"))),
  ...(await listTestFiles("scripts"))
];

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
