import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceManager, assertWorkspacePathInRoot, sanitizeWorkspaceKey } from "../src/workspace/manager.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-workspace-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createLogger() {
  const lines: string[] = [];
  return {
    lines,
    info(message: string) {
      lines.push(`info:${message}`);
    },
    warn(message: string) {
      lines.push(`warn:${message}`);
    },
    error(message: string) {
      lines.push(`error:${message}`);
    },
  };
}

describe("workspace manager", () => {
  it("creates deterministic sanitized workspaces and only runs after_create once", async () => {
    const root = await makeTempDir();
    const logger = createLogger();
    const manager = new WorkspaceManager({
      root,
      hooks: {
        afterCreate:
          "count=$(cat hook-count 2>/dev/null || echo 0); echo $((count + 1)) > hook-count",
      },
      hookTimeoutMs: 5_000,
      logger,
    });

    const first = await manager.ensureWorkspaceForIssue("MT/1?");
    const second = await manager.ensureWorkspaceForIssue("MT/1?");
    const hookCount = await readFile(path.join(first.path, "hook-count"), "utf8");

    expect(first.workspaceKey).toBe("MT_1_");
    expect(first.createdNow).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.createdNow).toBe(false);
    expect(hookCount.trim()).toBe("1");
    expect(await stat(first.path)).toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("fails safely when the workspace path already exists as a file", async () => {
    const root = await makeTempDir();
    const logger = createLogger();
    const workspacePath = path.join(root, "MT-2");
    await writeFile(workspacePath, "not a directory", "utf8");
    const manager = new WorkspaceManager({
      root,
      hooks: {},
      hookTimeoutMs: 5_000,
      logger,
    });

    await expect(manager.ensureWorkspaceForIssue("MT-2")).rejects.toMatchObject({
      code: "invalid_workspace_path",
    });
  });

  it("treats before_run failures as fatal for the current attempt", async () => {
    const root = await makeTempDir();
    const logger = createLogger();
    const manager = new WorkspaceManager({
      root,
      hooks: {
        beforeRun: "exit 7",
      },
      hookTimeoutMs: 5_000,
      logger,
    });
    const workspace = await manager.ensureWorkspaceForIssue("MT-3");

    await expect(manager.runBeforeRun(workspace)).rejects.toMatchObject({
      code: "workspace_hook_failed",
    });
  });

  it("logs and ignores after_run failures", async () => {
    const root = await makeTempDir();
    const logger = createLogger();
    const manager = new WorkspaceManager({
      root,
      hooks: {
        afterRun: "echo post-run >&2; exit 5",
      },
      hookTimeoutMs: 5_000,
      logger,
    });
    const workspace = await manager.ensureWorkspaceForIssue("MT-4");

    await expect(manager.runAfterRun(workspace)).resolves.toBeUndefined();
    expect(logger.lines.some((line) => line.includes("warn:hook=after_run"))).toBe(true);
  });

  it("runs before_remove, ignores failures, and still deletes the workspace", async () => {
    const root = await makeTempDir();
    const logger = createLogger();
    const markerPath = path.join(root, "remove.log");
    const manager = new WorkspaceManager({
      root,
      hooks: {
        beforeRemove: `echo removing >> "${markerPath}"; exit 3`,
      },
      hookTimeoutMs: 5_000,
      logger,
    });
    const workspace = await manager.ensureWorkspaceForIssue("MT-5");

    await manager.removeWorkspace(workspace.workspaceKey);

    await expect(access(workspace.path)).rejects.toBeDefined();
    expect((await readFile(markerPath, "utf8")).trim()).toBe("removing");
    expect(logger.lines.some((line) => line.includes("warn:hook=before_remove"))).toBe(true);
  });
});

describe("workspace safety", () => {
  it("sanitizes workspace keys to the allowed character set", () => {
    expect(sanitizeWorkspaceKey("AB C/123?%")).toBe("AB_C_123__");
  });

  it("rejects workspace paths outside the configured root", () => {
    expect(() =>
      assertWorkspacePathInRoot("/tmp/symphony-root", "/tmp/other/MT-1"),
    ).toThrowError(/outside the configured workspace root/i);

    expect(() =>
      assertWorkspacePathInRoot("/tmp/symphony-root", "/tmp/symphony-root/MT-1"),
    ).not.toThrow();
  });
});
