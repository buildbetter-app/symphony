import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadWorkflowDefinition,
  resolveWorkflowPath,
} from "../src/workflow/loader.js";
import {
  buildServiceConfig,
  validateDispatchConfig,
} from "../src/config/service-config.js";
import { renderPrompt } from "../src/prompt/render.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("workflow loading", () => {
  it("prefers the explicit workflow path when provided", async () => {
    const dir = await makeTempDir();
    const workflowPath = path.join(dir, "custom-workflow.md");

    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  project_slug: SYM",
        "",
        "codex:",
        "  command: codex app-server",
        "---",
        "Issue: {{ issue.identifier }}",
      ].join("\n"),
      "utf8",
    );

    const resolved = resolveWorkflowPath({ cwd: "/ignored", explicitPath: workflowPath });
    const workflow = await loadWorkflowDefinition(resolved);

    expect(resolved).toBe(workflowPath);
    expect(workflow.config.tracker).toEqual({
      kind: "linear",
      project_slug: "SYM",
    });
    expect(workflow.promptTemplate).toBe("Issue: {{ issue.identifier }}");
  });

  it("uses WORKFLOW.md in the cwd when no explicit path is provided", async () => {
    const dir = await makeTempDir();
    const workflowPath = path.join(dir, "WORKFLOW.md");

    await writeFile(workflowPath, "Hello {{ issue.title }}", "utf8");

    const resolved = resolveWorkflowPath({ cwd: dir });
    const workflow = await loadWorkflowDefinition(resolved);

    expect(resolved).toBe(workflowPath);
    expect(workflow.config).toEqual({});
    expect(workflow.promptTemplate).toBe("Hello {{ issue.title }}");
  });

  it("returns a typed error when front matter is not a map", async () => {
    const dir = await makeTempDir();
    const workflowPath = path.join(dir, "WORKFLOW.md");

    await writeFile(workflowPath, ["---", "- nope", "---", "Body"].join("\n"), "utf8");

    await expect(loadWorkflowDefinition(workflowPath)).rejects.toMatchObject({
      code: "workflow_front_matter_not_a_map",
    });
  });
});

describe("service config", () => {
  it("applies defaults, resolves env indirection, and normalizes per-state concurrency", async () => {
    const dir = await makeTempDir();
    const workflowPath = path.join(dir, "WORKFLOW.md");
    process.env.LINEAR_TOKEN_FOR_TEST = "linear-secret";
    process.env.SYMPHONY_WORKSPACE_ROOT_TEST = path.join(dir, "workspaces");

    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: $LINEAR_TOKEN_FOR_TEST",
        "  project_slug: SYM",
        "agent:",
        "  max_concurrent_agents: \"4\"",
        "  max_retry_backoff_ms: \"90000\"",
        "  max_concurrent_agents_by_state:",
        "    In Progress: 2",
        "    Review: 0",
        "workspace:",
        "  root: $SYMPHONY_WORKSPACE_ROOT_TEST",
        "codex:",
        "  command: codex app-server --json",
        "---",
        "Prompt",
      ].join("\n"),
      "utf8",
    );

    const workflow = await loadWorkflowDefinition(workflowPath);
    const config = buildServiceConfig(workflow, {
      cwd: dir,
      env: process.env,
    });

    expect(config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(config.tracker.apiKey).toBe("linear-secret");
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(config.workspace.root).toBe(path.join(dir, "workspaces"));
    expect(config.agent.maxConcurrentAgents).toBe(4);
    expect(config.agent.maxRetryBackoffMs).toBe(90_000);
    expect(config.agent.maxConcurrentAgentsByState).toEqual({
      "in progress": 2,
    });
    expect(config.codex.command).toBe("codex app-server --json");
  });

  it("fails dispatch validation when required dispatch fields are missing", async () => {
    const config = buildServiceConfig(
      {
        config: {
          tracker: {
            kind: "linear",
          },
        },
        promptTemplate: "Prompt",
        sourcePath: "/tmp/WORKFLOW.md",
      },
      {
        cwd: "/tmp",
        env: {},
      },
    );

    expect(validateDispatchConfig(config)).toEqual({
      code: "missing_tracker_api_key",
      message: expect.stringContaining("tracker.api_key"),
    });
  });
});

describe("prompt rendering", () => {
  it("renders issue and attempt with strict unknown-variable handling", async () => {
    const output = await renderPrompt("Issue {{ issue.identifier }} attempt {{ attempt }}", {
      issue: {
        identifier: "SYM-1",
        title: "Ship it",
      },
      attempt: 2,
    });

    expect(output).toBe("Issue SYM-1 attempt 2");
    await expect(renderPrompt("Missing {{ issue.missing }}", {
      issue: {
        identifier: "SYM-1",
      },
      attempt: null,
    })).rejects.toMatchObject({
      code: "template_render_error",
    });
  });
});
