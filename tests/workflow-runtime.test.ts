import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowRuntime } from "../src/workflow/runtime.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-runtime-test-"));
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

describe("workflow runtime", () => {
  it("reloads workflow changes without restart", async () => {
    const cwd = await makeTempDir();
    const workflowPath = path.join(cwd, "WORKFLOW.md");
    const logger = createLogger();
    const updates: number[] = [];

    await writeFile(
      workflowPath,
      ["---", "tracker:", "  kind: linear", "  api_key: token", "  project_slug: SYM", "---", "Prompt"].join(
        "\n",
      ),
      "utf8",
    );

    const runtime = new WorkflowRuntime({
      cwd,
      env: process.env,
      logger,
      onReload(workflow) {
        updates.push(workflow.config.polling.intervalMs);
      },
    });

    await runtime.initialize();
    runtime.startWatching();

    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: token",
        "  project_slug: SYM",
        "polling:",
        "  interval_ms: 1234",
        "---",
        "Updated",
      ].join("\n"),
      "utf8",
    );

    await waitFor(() => updates.includes(1234));
    expect(runtime.current.config.polling.intervalMs).toBe(1234);

    runtime.close();
  });

  it("keeps the last known good config when reload becomes invalid", async () => {
    const cwd = await makeTempDir();
    const workflowPath = path.join(cwd, "WORKFLOW.md");
    const logger = createLogger();
    let reloadErrors = 0;

    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: token",
        "  project_slug: SYM",
        "polling:",
        "  interval_ms: 2000",
        "---",
        "Prompt",
      ].join("\n"),
      "utf8",
    );

    const runtime = new WorkflowRuntime({
      cwd,
      env: process.env,
      logger,
      onReloadError() {
        reloadErrors += 1;
      },
    });

    await runtime.initialize();
    runtime.startWatching();

    await writeFile(workflowPath, ["---", "- invalid", "---", "Broken"].join("\n"), "utf8");

    await waitFor(() => reloadErrors > 0);
    expect(runtime.current.config.polling.intervalMs).toBe(2000);
    expect(logger.lines.some((line) => line.includes("workflow_reload_failed"))).toBe(true);

    runtime.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}
