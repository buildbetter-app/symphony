import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { SymphonyError } from "../errors.js";
import type { Logger, Workspace } from "../types.js";

export function sanitizeWorkspaceKey(issueIdentifier: string): string {
  return issueIdentifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function assertWorkspacePathInRoot(workspaceRoot: string, workspacePath: string): void {
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedPath = path.resolve(workspacePath);
  const relativePath = path.relative(normalizedRoot, normalizedPath);

  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  ) {
    return;
  }

  throw new SymphonyError(
    "invalid_workspace_cwd",
    `Workspace path ${normalizedPath} is outside the configured workspace root ${normalizedRoot}`,
  );
}

interface WorkspaceManagerOptions {
  root: string;
  hooks: {
    afterCreate?: string | null;
    beforeRun?: string | null;
    afterRun?: string | null;
    beforeRemove?: string | null;
  };
  hookTimeoutMs: number;
  logger: Logger;
}

export class WorkspaceManager {
  readonly #root: string;
  readonly #hooks: WorkspaceManagerOptions["hooks"];
  readonly #hookTimeoutMs: number;
  readonly #logger: Logger;

  constructor(options: WorkspaceManagerOptions) {
    this.#root = options.root;
    this.#hooks = options.hooks;
    this.#hookTimeoutMs = options.hookTimeoutMs;
    this.#logger = options.logger;
  }

  async ensureWorkspaceForIssue(issueIdentifier: string): Promise<Workspace> {
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    const workspacePath = path.resolve(this.#root, workspaceKey);
    assertWorkspacePathInRoot(this.#root, workspacePath);

    await mkdir(this.#root, { recursive: true });

    let createdNow = false;
    try {
      const existing = await stat(workspacePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      });

      if (existing?.isDirectory()) {
        return {
          path: workspacePath,
          workspaceKey,
          createdNow,
        };
      }

      if (existing) {
        throw new SymphonyError(
          "invalid_workspace_path",
          `Workspace path ${workspacePath} already exists and is not a directory`,
        );
      }

      await mkdir(workspacePath, { recursive: false });
      createdNow = true;

      if (this.#hooks.afterCreate) {
        await this.#runHook("after_create", this.#hooks.afterCreate, workspacePath, {
          fatal: true,
        });
      }

      return {
        path: workspacePath,
        workspaceKey,
        createdNow,
      };
    } catch (error) {
      if (createdNow) {
        await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  async runBeforeRun(workspace: Workspace): Promise<void> {
    if (!this.#hooks.beforeRun) {
      return;
    }

    await this.#runHook("before_run", this.#hooks.beforeRun, workspace.path, { fatal: true });
  }

  async runAfterRun(workspace: Workspace): Promise<void> {
    if (!this.#hooks.afterRun) {
      return;
    }

    await this.#runHook("after_run", this.#hooks.afterRun, workspace.path, { fatal: false });
  }

  async removeWorkspace(issueIdentifierOrKey: string): Promise<void> {
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifierOrKey);
    const workspacePath = path.resolve(this.#root, workspaceKey);
    assertWorkspacePathInRoot(this.#root, workspacePath);

    const existing = await stat(workspacePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!existing) {
      return;
    }

    if (this.#hooks.beforeRemove) {
      await this.#runHook("before_remove", this.#hooks.beforeRemove, workspacePath, {
        fatal: false,
      });
    }

    await rm(workspacePath, { recursive: true, force: true });
  }

  async listWorkspaceKeys(): Promise<string[]> {
    await mkdir(this.#root, { recursive: true });
    return readdir(this.#root);
  }

  get root(): string {
    return this.#root;
  }

  async #runHook(
    hookName: "after_create" | "before_run" | "after_run" | "before_remove",
    script: string,
    cwd: string,
    options: { fatal: boolean },
  ): Promise<void> {
    this.#logger.info(`hook=${hookName} status=starting cwd=${cwd}`);

    try {
      await runShellScript({
        script,
        cwd,
        timeoutMs: this.#hookTimeoutMs,
      });
      this.#logger.info(`hook=${hookName} status=completed cwd=${cwd}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      const logLine = `hook=${hookName} status=failed cwd=${cwd} reason=${JSON.stringify(reason)}`;
      if (options.fatal) {
        this.#logger.error(logLine);
        throw error;
      }

      this.#logger.warn(logLine);
    }
  }
}

async function runShellScript(options: {
  script: string;
  cwd: string;
  timeoutMs: number;
}): Promise<void> {
  await mkdir(options.cwd, { recursive: true });

  const child = spawn("sh", ["-lc", options.script], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
  }, options.timeoutMs);

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", (error) => {
        reject(
          new SymphonyError("workspace_hook_failed", `Failed to launch hook: ${error.message}`, {
            cause: error,
          }),
        );
      });

      child.once("exit", (code, signal) => {
        if (signal === "SIGKILL") {
          reject(
            new SymphonyError(
              "workspace_hook_timeout",
              `Hook timed out after ${options.timeoutMs}ms`,
            ),
          );
          return;
        }

        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new SymphonyError(
            "workspace_hook_failed",
            `Hook exited with code ${code}. stderr=${truncate(stderr)} stdout=${truncate(stdout)}`,
          ),
        );
      });
    });
  } finally {
    clearTimeout(timeout);
  }
}

function truncate(value: string): string {
  return value.trim().slice(0, 512);
}
