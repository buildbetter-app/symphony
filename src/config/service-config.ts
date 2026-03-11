import os from "node:os";
import path from "node:path";

import { isRecord } from "../errors.js";
import type {
  JsonObject,
  ServiceConfig,
  ServiceConfigContext,
  ValidationError,
  WorkflowDefinition,
} from "../types.js";

const DEFAULT_TRACKER_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
const DEFAULT_WORKSPACE_ROOT = path.join(os.tmpdir(), "symphony_workspaces");
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const DEFAULT_STALL_TIMEOUT_MS = 300_000;

export function buildServiceConfig(
  workflow: WorkflowDefinition,
  context: ServiceConfigContext,
): ServiceConfig {
  const config = workflow.config;
  const tracker = asObject(config.tracker);
  const polling = asObject(config.polling);
  const workspace = asObject(config.workspace);
  const hooks = asObject(config.hooks);
  const agent = asObject(config.agent);
  const codex = asObject(config.codex);

  return {
    workflowPath: workflow.sourcePath,
    tracker: {
      kind: asString(tracker.kind),
      endpoint: asString(tracker.endpoint) ?? DEFAULT_TRACKER_ENDPOINT,
      apiKey: resolveSecret(asString(tracker.api_key), context.env),
      projectSlug: asString(tracker.project_slug),
      activeStates: asStringArray(tracker.active_states) ?? DEFAULT_ACTIVE_STATES,
      terminalStates: asStringArray(tracker.terminal_states) ?? DEFAULT_TERMINAL_STATES,
    },
    polling: {
      intervalMs: asInteger(polling.interval_ms) ?? DEFAULT_POLL_INTERVAL_MS,
    },
    workspace: {
      root: resolveWorkspaceRoot(workflow, workspace.root, context),
    },
    hooks: {
      afterCreate: asString(hooks.after_create),
      beforeRun: asString(hooks.before_run),
      afterRun: asString(hooks.after_run),
      beforeRemove: asString(hooks.before_remove),
      timeoutMs: normalizePositiveInteger(
        asInteger(hooks.timeout_ms),
        DEFAULT_HOOK_TIMEOUT_MS,
      ),
    },
    agent: {
      maxConcurrentAgents: asInteger(agent.max_concurrent_agents) ?? DEFAULT_MAX_CONCURRENT_AGENTS,
      maxConcurrentAgentsByState: normalizeStateConcurrency(agent.max_concurrent_agents_by_state),
      maxRetryBackoffMs:
        asInteger(agent.max_retry_backoff_ms) ?? DEFAULT_MAX_RETRY_BACKOFF_MS,
      maxTurns: asInteger(agent.max_turns) ?? DEFAULT_MAX_TURNS,
    },
    codex: {
      command: asString(codex.command)?.trim() || "codex app-server",
      approvalPolicy: codex.approval_policy,
      threadSandbox: codex.thread_sandbox,
      turnSandboxPolicy: codex.turn_sandbox_policy,
      turnTimeoutMs: asInteger(codex.turn_timeout_ms) ?? DEFAULT_TURN_TIMEOUT_MS,
      readTimeoutMs: asInteger(codex.read_timeout_ms) ?? DEFAULT_READ_TIMEOUT_MS,
      stallTimeoutMs: asInteger(codex.stall_timeout_ms) ?? DEFAULT_STALL_TIMEOUT_MS,
    },
  };
}

export function validateDispatchConfig(config: ServiceConfig): ValidationError | null {
  if (!config.tracker.kind || config.tracker.kind !== "linear") {
    return {
      code: "unsupported_tracker_kind",
      message: "tracker.kind must be set to linear",
    };
  }

  if (!config.tracker.apiKey) {
    return {
      code: "missing_tracker_api_key",
      message: "tracker.api_key must be configured before dispatch can start",
    };
  }

  if (!config.tracker.projectSlug) {
    return {
      code: "missing_tracker_project_slug",
      message: "tracker.project_slug must be configured for Linear dispatch",
    };
  }

  if (!config.codex.command.trim()) {
    return {
      code: "missing_codex_command",
      message: "codex.command must be configured before dispatch can start",
    };
  }

  return null;
}

function asObject(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length === value.length ? strings : null;
}

function asInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

function normalizePositiveInteger(value: number | null, fallback: number): number {
  if (value == null || value <= 0) {
    return fallback;
  }

  return value;
}

function resolveSecret(value: string | null, env: NodeJS.ProcessEnv): string | null {
  if (!value) {
    return env.LINEAR_API_KEY?.trim() || null;
  }

  if (!value.startsWith("$")) {
    return value;
  }

  const resolved = env[value.slice(1)]?.trim() ?? "";
  return resolved.length > 0 ? resolved : null;
}

function resolveWorkspaceRoot(
  workflow: WorkflowDefinition,
  value: unknown,
  context: ServiceConfigContext,
): string {
  const configured = asString(value);
  if (!configured) {
    return DEFAULT_WORKSPACE_ROOT;
  }

  let resolved = configured;
  if (configured.startsWith("$")) {
    resolved = context.env[configured.slice(1)] ?? "";
  }

  if (resolved.startsWith("~")) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }

  if (resolved.includes(path.sep) || resolved.includes("/")) {
    return path.resolve(path.dirname(workflow.sourcePath), resolved);
  }

  return resolved;
}

function normalizeStateConcurrency(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, number> = {};
  for (const [state, rawLimit] of Object.entries(value)) {
    const limit = asInteger(rawLimit);
    if (limit != null && limit > 0) {
      normalized[state.toLowerCase()] = limit;
    }
  }

  return normalized;
}
