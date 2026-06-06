import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { normalizeProjectAlias } from "./controller-projects.mjs";

export const codexGlobalStateFile = path.join(
  process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  ".codex-global-state.json"
);

function nonEmptyStrings(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim())
    : [];
}

function uniqueWorkspaceRoots(values) {
  const seen = new Set();
  const roots = [];

  for (const value of values) {
    const workspace = path.resolve(String(value));
    const key = process.platform === "win32" ? workspace.toLowerCase() : workspace;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    roots.push(workspace);
  }

  return roots;
}

function readStateValue(raw = {}, key) {
  return raw[key] ?? raw["electron-persisted-atom-state"]?.[key];
}

function orderedWorkspaceRoots(raw = {}) {
  const savedRoots = uniqueWorkspaceRoots(
    nonEmptyStrings(readStateValue(raw, "electron-saved-workspace-roots"))
  );
  const savedRootSet = new Set(
    savedRoots.map((workspace) =>
      process.platform === "win32" ? workspace.toLowerCase() : workspace
    )
  );
  const preferredOrder = uniqueWorkspaceRoots(nonEmptyStrings(readStateValue(raw, "project-order"))).filter(
    (workspace) =>
      savedRootSet.has(process.platform === "win32" ? workspace.toLowerCase() : workspace)
  );
  const orderedSet = new Set(
    preferredOrder.map((workspace) =>
      process.platform === "win32" ? workspace.toLowerCase() : workspace
    )
  );

  return [
    ...preferredOrder,
    ...savedRoots.filter(
      (workspace) =>
        !orderedSet.has(process.platform === "win32" ? workspace.toLowerCase() : workspace)
    )
  ];
}

function labelForWorkspace(raw = {}, workspace) {
  const labels = readStateValue(raw, "electron-workspace-root-labels") ?? {};
  return labels[workspace] ?? path.basename(workspace) ?? workspace;
}

export async function loadCodexDesktopProjectState(filePath = codexGlobalStateFile) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    const workspaceRoots = orderedWorkspaceRoots(raw);
    const activeWorkspaceRoots = uniqueWorkspaceRoots(
      nonEmptyStrings(readStateValue(raw, "active-workspace-roots"))
    );

    return {
      projects: workspaceRoots.map((workspace) => ({
        workspace,
        label: labelForWorkspace(raw, workspace)
      })),
      activeWorkspaceRoots
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

function workspaceKey(workspace) {
  const resolved = path.resolve(String(workspace));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function projectByWorkspace(projects = []) {
  return new Map(projects.map((project) => [workspaceKey(project.workspace), project]));
}

function chooseDefaultProject(config, projects, activeWorkspaceRoots) {
  const previousProjects = projectByWorkspace(config.projects);
  const previousDefault = config.projects.find(
    (project) => project.alias === config.defaultProject
  );
  const previousDefaultMatch = previousDefault
    ? projects.find((project) => workspaceKey(project.workspace) === workspaceKey(previousDefault.workspace))
    : null;
  if (previousDefaultMatch) {
    return previousDefaultMatch.alias;
  }

  const activeMatch = activeWorkspaceRoots
    .map((workspace) => previousProjects.get(workspaceKey(workspace)) ?? workspace)
    .map((candidate) =>
      typeof candidate === "string"
        ? projects.find((project) => workspaceKey(project.workspace) === workspaceKey(candidate))
        : projects.find((project) => workspaceKey(project.workspace) === workspaceKey(candidate.workspace))
    )
    .find(Boolean);
  if (activeMatch) {
    return activeMatch.alias;
  }

  return projects[0]?.alias ?? config.defaultProject;
}

export function syncProjectsFromCodexDesktop(config = {}, desktopState = null) {
  if (!desktopState?.projects?.length) {
    return config;
  }

  const existingByWorkspace = projectByWorkspace(config.projects);
  const projects = desktopState.projects.map(({ workspace, label }) => {
    const existing = existingByWorkspace.get(workspaceKey(workspace));
    return {
      alias: existing?.alias ?? normalizeProjectAlias(label ?? path.basename(workspace)),
      label: label ?? path.basename(workspace) ?? workspace,
      workspace,
      model: existing?.model ?? null,
      profile: existing?.profile ?? null,
      permissionLevel: existing?.permissionLevel ?? null,
      search: existing?.search ?? null
    };
  });

  const defaultProject = chooseDefaultProject(
    config,
    projects,
    desktopState.activeWorkspaceRoots ?? []
  );

  return {
    ...config,
    defaultProject,
    projects
  };
}
