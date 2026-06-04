import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ControllerConfigStore } from "./controller-config.mjs";

test("ControllerConfigStore defaults to multilingual Chatterbox for new configs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");

  try {
    const store = new ControllerConfigStore(filePath);
    const config = await store.load();

    assert.equal(config.ttsProvider, "chatterbox-turbo");
    assert.equal(config.ttsChatterboxAllowNonEnglish, true);
    assert.equal(config.controllerAccount, "personal");
    assert.equal(config.defaultProject, "main");
    assert.equal(config.projects.length, 1);
    assert.equal(config.projects[0].alias, "main");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerConfigStore normalizes boolean-like non-English overrides from disk", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        enabled: true,
        ttsProvider: "chatterbox",
        ttsChatterboxAllowNonEnglish: "false",
        allowedControllers: []
      }),
      "utf8"
    );

    const store = new ControllerConfigStore(filePath);
    const config = await store.load();

    assert.equal(config.ttsProvider, "chatterbox-turbo");
    assert.equal(config.ttsChatterboxAllowNonEnglish, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerConfigStore migrates a legacy single-workspace config into projects", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");
  const alphaAppPath = path.resolve("/tmp/alpha-app");

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        enabled: true,
        workspace: "/tmp/alpha-app",
        model: "gpt-5.4",
        allowedControllers: []
      }),
      "utf8"
    );

    const store = new ControllerConfigStore(filePath);
    const config = await store.load();

    assert.equal(config.defaultProject, "main");
    assert.equal(config.workspace, alphaAppPath);
    assert.equal(config.projects.length, 1);
    assert.equal(config.projects[0].alias, "main");
    assert.equal(config.projects[0].workspace, alphaAppPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerConfigStore syncs projects from Codex desktop state while preserving workspace aliases", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");
  const desktopStateFile = path.join(tempDir, ".codex-global-state.json");
  const personalDir = path.join(tempDir, "Personal");
  const axonDir = path.join(tempDir, "New project");

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        defaultProject: "personal",
        projects: [{ alias: "personal", workspace: personalDir }],
        allowedControllers: []
      }),
      "utf8"
    );
    await fs.writeFile(
      desktopStateFile,
      JSON.stringify({
        "electron-saved-workspace-roots": [personalDir, axonDir],
        "project-order": [axonDir, personalDir],
        "electron-workspace-root-labels": {
          [axonDir]: "Axon"
        },
        "active-workspace-roots": [personalDir]
      }),
      "utf8"
    );

    const store = new ControllerConfigStore(filePath, {
      syncDesktopProjects: true,
      desktopStateFile
    });
    const config = await store.load();

    assert.equal(config.defaultProject, "personal");
    assert.deepEqual(
      config.projects.map((project) => ({
        alias: project.alias,
        label: project.label,
        workspace: project.workspace
      })),
      [
        { alias: "axon", label: "Axon", workspace: axonDir },
        { alias: "personal", label: "Personal", workspace: personalDir }
      ]
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
