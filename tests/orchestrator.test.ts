import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { Issue, Logger, ServiceConfig } from "../src/types.js";

describe("Orchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T15:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches eligible issues by priority and age, skipping blocked Todo issues", async () => {
    const tracker = createTracker({
      candidates: [
        issue({
          id: "3",
          identifier: "SYM-3",
          title: "Blocked todo",
          state: "Todo",
          priority: 1,
          blockedBy: [{ id: "b1", identifier: "SYM-0", state: "In Progress" }],
        }),
        issue({
          id: "2",
          identifier: "SYM-2",
          title: "Older medium priority",
          state: "In Progress",
          priority: 2,
          createdAt: new Date("2026-03-09T10:00:00.000Z"),
        }),
        issue({
          id: "1",
          identifier: "SYM-1",
          title: "Highest priority",
          state: "In Progress",
          priority: 1,
          createdAt: new Date("2026-03-09T12:00:00.000Z"),
        }),
      ],
    });
    const workers = createWorkerHarness();
    const workspaceManager = createWorkspaceManager();
    const orchestrator = new Orchestrator({
      config: createConfig({ maxConcurrentAgents: 2 }),
      tracker,
      workerLauncher: workers.launcher,
      workspaceManager,
      logger: createLogger(),
    });

    await orchestrator.tick();

    expect(workers.launches.map((launch) => launch.issue.identifier)).toEqual(["SYM-1", "SYM-2"]);
  });

  it("schedules a continuation retry one second after a normal worker exit", async () => {
    const tracker = createTracker({
      candidates: [issue({ id: "1", identifier: "SYM-1", title: "Retry me" })],
    });
    const workers = createWorkerHarness();
    const orchestrator = new Orchestrator({
      config: createConfig(),
      tracker,
      workerLauncher: workers.launcher,
      workspaceManager: createWorkspaceManager(),
      logger: createLogger(),
    });

    await orchestrator.tick();
    workers.launches[0]?.finish({ kind: "normal" });
    await flushMicrotasks();

    let snapshot = orchestrator.getSnapshot();
    expect(snapshot.retrying).toEqual([
      expect.objectContaining({
        issueIdentifier: "SYM-1",
        attempt: 1,
        error: null,
      }),
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    snapshot = orchestrator.getSnapshot();
    expect(workers.launches).toHaveLength(2);
    expect(workers.launches[1]?.attempt).toBe(1);
    expect(snapshot.retrying).toHaveLength(0);
  });

  it("uses exponential retry backoff with the configured cap after abnormal exits", async () => {
    const tracker = createTracker({
      candidates: [issue({ id: "1", identifier: "SYM-1", title: "Retry me" })],
    });
    const workers = createWorkerHarness();
    const orchestrator = new Orchestrator({
      config: createConfig({ maxRetryBackoffMs: 15_000 }),
      tracker,
      workerLauncher: workers.launcher,
      workspaceManager: createWorkspaceManager(),
      logger: createLogger(),
    });

    await orchestrator.tick();
    workers.launches[0]?.finish({ kind: "abnormal", error: "boom-1" });
    await flushMicrotasks();

    let snapshot = orchestrator.getSnapshot();
    expect(snapshot.retrying[0]).toMatchObject({
      attempt: 1,
      error: "boom-1",
    });
    expect(snapshot.retrying[0]!.dueAt.getTime() - Date.now()).toBe(10_000);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    workers.launches[1]?.finish({ kind: "abnormal", error: "boom-2" });
    await flushMicrotasks();

    snapshot = orchestrator.getSnapshot();
    expect(snapshot.retrying[0]).toMatchObject({
      attempt: 2,
      error: "boom-2",
    });
    expect(snapshot.retrying[0]!.dueAt.getTime() - Date.now()).toBe(15_000);
  });

  it("reconciliation stops terminal issues with cleanup and non-active issues without cleanup", async () => {
    const tracker = createTracker({
      candidates: [
        issue({ id: "1", identifier: "SYM-1", title: "Terminal soon" }),
        issue({ id: "2", identifier: "SYM-2", title: "Paused soon" }),
      ],
      refreshedStates: [
        issue({ id: "1", identifier: "SYM-1", title: "Terminal soon", state: "Done" }),
        issue({ id: "2", identifier: "SYM-2", title: "Paused soon", state: "Backlog" }),
      ],
    });
    const workers = createWorkerHarness();
    const workspaceManager = createWorkspaceManager();
    const orchestrator = new Orchestrator({
      config: createConfig({ maxConcurrentAgents: 2 }),
      tracker,
      workerLauncher: workers.launcher,
      workspaceManager,
      logger: createLogger(),
    });

    await orchestrator.tick();
    await orchestrator.tick();
    await flushMicrotasks();

    expect(workers.launches[0]?.cancelReasons).toContain("terminal state Done");
    expect(workers.launches[1]?.cancelReasons).toContain("inactive state Backlog");
    expect(workspaceManager.removed).toEqual(["SYM-1"]);
  });

  it("startup cleanup removes terminal-state workspaces and continues on tracker errors", async () => {
    const workspaceManager = createWorkspaceManager();
    const tracker = createTracker({
      terminalIssues: [
        issue({ id: "1", identifier: "SYM-1", title: "Done", state: "Done" }),
        issue({ id: "2", identifier: "SYM-2", title: "Canceled", state: "Canceled" }),
      ],
    });
    const orchestrator = new Orchestrator({
      config: createConfig(),
      tracker,
      workerLauncher: createWorkerHarness().launcher,
      workspaceManager,
      logger: createLogger(),
    });

    await orchestrator.startupCleanup();

    expect(workspaceManager.removed).toEqual(["SYM-1", "SYM-2"]);

    tracker.fetchIssuesByStates.mockRejectedValueOnce(new Error("down"));
    await expect(orchestrator.startupCleanup()).resolves.toBeUndefined();
  });

  it("exposes a runtime snapshot with running sessions, retry rows, and token totals", async () => {
    const tracker = createTracker({
      candidates: [
        issue({ id: "1", identifier: "SYM-1", title: "Running" }),
        issue({ id: "2", identifier: "SYM-2", title: "Retrying" }),
      ],
    });
    const workers = createWorkerHarness();
    const orchestrator = new Orchestrator({
      config: createConfig({ maxConcurrentAgents: 2 }),
      tracker,
      workerLauncher: workers.launcher,
      workspaceManager: createWorkspaceManager(),
      logger: createLogger(),
    });

    await orchestrator.tick();
    workers.launches[0]?.emit({
      event: "session_started",
      timestamp: new Date(),
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });
    workers.launches[1]?.finish({ kind: "abnormal", error: "boom" });
    await flushMicrotasks();

    const snapshot = orchestrator.getSnapshot();

    expect(snapshot.running).toEqual([
      expect.objectContaining({
        issueIdentifier: "SYM-1",
        sessionId: "thread-1-turn-1",
        tokens: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      }),
    ]);
    expect(snapshot.retrying).toEqual([
      expect.objectContaining({
        issueIdentifier: "SYM-2",
        error: "boom",
      }),
    ]);
    expect(snapshot.codexTotals).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      secondsRunning: expect.any(Number),
    });
  });
});

function createConfig(overrides: { maxConcurrentAgents?: number; maxRetryBackoffMs?: number } = {}): ServiceConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "SYM",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Canceled", "Cancelled", "Duplicate", "Closed"],
    },
    polling: {
      intervalMs: 30_000,
    },
    workspace: {
      root: "/tmp/symphony",
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: overrides.maxConcurrentAgents ?? 10,
      maxConcurrentAgentsByState: {},
      maxRetryBackoffMs: overrides.maxRetryBackoffMs ?? 300_000,
      maxTurns: 20,
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: null,
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 3_600_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 300_000,
    },
  };
}

function createTracker(options: {
  candidates?: Issue[];
  refreshedStates?: Issue[];
  terminalIssues?: Issue[];
} = {}) {
  return {
    fetchCandidateIssues: vi.fn(async () => options.candidates ?? []),
    fetchIssuesByStates: vi.fn(async () => options.terminalIssues ?? []),
    fetchIssueStatesByIds: vi.fn(async () => options.refreshedStates ?? []),
  };
}

function createWorkspaceManager() {
  return {
    removed: [] as string[],
    async removeWorkspace(identifier: string) {
      this.removed.push(identifier);
    },
  };
}

function createLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function createWorkerHarness() {
  const launches: Array<ReturnType<typeof createWorkerLaunch>> = [];

  return {
    launches,
    launcher(params: Parameters<typeof createWorkerLaunch>[0]) {
      const launch = createWorkerLaunch(params);
      launches.push(launch);
      return launch.handle;
    },
  };
}

function createWorkerLaunch(params: {
  issue: Issue;
  attempt: number | null;
  onEvent: (event: {
    event: string;
    timestamp: Date;
    sessionId?: string;
    threadId?: string;
    turnId?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  }) => void;
}) {
  let resolve: ((value: { kind: "normal" | "abnormal"; error?: string }) => void) | undefined;
  const cancelReasons: string[] = [];
  const done = new Promise<{ kind: "normal" | "abnormal"; error?: string }>((res) => {
    resolve = res;
  });

  return {
    issue: params.issue,
    attempt: params.attempt,
    cancelReasons,
    emit: params.onEvent,
    finish(result: { kind: "normal" | "abnormal"; error?: string }) {
      resolve?.(result);
    },
    handle: {
      cancel(reason: string) {
        cancelReasons.push(reason);
        resolve?.({ kind: "abnormal", error: reason });
      },
      done,
    },
  };
}

function issue(overrides: Partial<Issue> & Pick<Issue, "id" | "identifier" | "title">): Issue {
  return {
    id: overrides.id,
    identifier: overrides.identifier,
    title: overrides.title,
    description: overrides.description ?? null,
    priority: overrides.priority ?? 2,
    state: overrides.state ?? "In Progress",
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? new Date("2026-03-10T10:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-03-10T10:00:00.000Z"),
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
