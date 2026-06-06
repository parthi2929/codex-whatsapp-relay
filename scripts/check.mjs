import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

async function listMjsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

const files = [
  ...(await listMjsFiles(path.join("plugins", "whatsapp-relay", "scripts"))),
  ...(await listMjsFiles("scripts"))
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
