import { validateDispatchConfig } from "../config/service-config.js";
import type { Issue, Logger, ServiceConfig } from "../types.js";

export interface AgentRuntimeEvent {
  event: string;
  timestamp: Date;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  codexAppServerPid?: string;
  message?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  rateLimits?: unknown;
}

export interface WorkerResult {
  kind: "normal" | "abnormal";
  error?: string;
}

export interface WorkerHandle {
  cancel(reason: string): void;
  done: Promise<WorkerResult>;
}

export interface WorkerLaunchParams {
  issue: Issue;
  attempt: number | null;
  onEvent: (event: AgentRuntimeEvent) => void;
}

interface TrackerAdapter {
  fetchCandidateIssues(activeStates: string[]): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}

interface WorkspaceManagerLike {
  removeWorkspace(identifier: string): Promise<void>;
}

interface OrchestratorOptions {
  config: ServiceConfig;
  tracker: TrackerAdapter;
  workerLauncher: (params: WorkerLaunchParams) => WorkerHandle;
  workspaceManager: WorkspaceManagerLike;
  logger: Logger;
}

interface RetryEntry {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  dueAt: Date;
  error: string | null;
  timer: ReturnType<typeof setTimeout>;
}

interface RunningEntry {
  issue: Issue;
  attempt: number | null;
  handle: WorkerHandle;
  startedAt: Date;
  threadId: string | null;
  turnId: string | null;
  sessionId: string | null;
  turnCount: number;
  lastEvent: string | null;
  lastMessage: string | null;
  lastEventAt: Date | null;
  codexAppServerPid: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  releaseClaimOnExit: boolean;
  cleanupWorkspaceOnExit: boolean;
}

export class Orchestrator {
  readonly #config: ServiceConfig;
  readonly #tracker: TrackerAdapter;
  readonly #workerLauncher: (params: WorkerLaunchParams) => WorkerHandle;
  readonly #workspaceManager: WorkspaceManagerLike;
  readonly #logger: Logger;

  readonly #running = new Map<string, RunningEntry>();
  readonly #claimed = new Set<string>();
  readonly #retryAttempts = new Map<string, RetryEntry>();
  readonly #completed = new Set<string>();

  #endedRuntimeSeconds = 0;
  #aggregateInputTokens = 0;
  #aggregateOutputTokens = 0;
  #aggregateTotalTokens = 0;
  #latestRateLimits: unknown = null;

  constructor(options: OrchestratorOptions) {
    this.#config = options.config;
    this.#tracker = options.tracker;
    this.#workerLauncher = options.workerLauncher;
    this.#workspaceManager = options.workspaceManager;
    this.#logger = options.logger;
  }

  async startupCleanup(): Promise<void> {
    try {
      const issues = await this.#tracker.fetchIssuesByStates(this.#config.tracker.terminalStates);
      await Promise.all(issues.map((issue) => this.#workspaceManager.removeWorkspace(issue.identifier)));
    } catch (error) {
      this.#logger.warn(
        `startup_cleanup_failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  async tick(): Promise<void> {
    await this.#reconcileRunningIssues();

    const validation = validateDispatchConfig(this.#config);
    if (validation) {
      this.#logger.error(
        `dispatch_validation_failed code=${validation.code} message=${JSON.stringify(validation.message)}`,
      );
      return;
    }

    let issues: Issue[];
    try {
      issues = await this.#tracker.fetchCandidateIssues(this.#config.tracker.activeStates);
    } catch (error) {
      this.#logger.error(
        `candidate_fetch_failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
      );
      return;
    }

    for (const issue of sortIssuesForDispatch(issues)) {
      if (this.#availableGlobalSlots() === 0) {
        break;
      }

      if (this.#shouldDispatch(issue)) {
        this.#dispatchIssue(issue, null);
      }
    }
  }

  getSnapshot() {
    const now = Date.now();
    return {
      generatedAt: new Date(now),
      counts: {
        running: this.#running.size,
        retrying: this.#retryAttempts.size,
      },
      running: Array.from(this.#running.values()).map((entry) => ({
        issueId: entry.issue.id,
        issueIdentifier: entry.issue.identifier,
        state: entry.issue.state,
        sessionId: entry.sessionId,
        turnCount: entry.turnCount,
        lastEvent: entry.lastEvent,
        lastMessage: entry.lastMessage,
        startedAt: entry.startedAt,
        lastEventAt: entry.lastEventAt,
        tokens: {
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          totalTokens: entry.totalTokens,
        },
      })),
      retrying: Array.from(this.#retryAttempts.values())
        .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())
        .map((entry) => ({
          issueId: entry.issueId,
          issueIdentifier: entry.issueIdentifier,
          attempt: entry.attempt,
          dueAt: entry.dueAt,
          error: entry.error,
        })),
      codexTotals: {
        inputTokens: this.#aggregateInputTokens,
        outputTokens: this.#aggregateOutputTokens,
        totalTokens: this.#aggregateTotalTokens,
        secondsRunning:
          this.#endedRuntimeSeconds +
          Array.from(this.#running.values()).reduce(
            (sum, entry) => sum + (now - entry.startedAt.getTime()) / 1_000,
            0,
          ),
      },
      rateLimits: this.#latestRateLimits,
    };
  }

  getIssueDetails(issueIdentifier: string) {
    const runningEntry = Array.from(this.#running.values()).find(
      (entry) => entry.issue.identifier === issueIdentifier,
    );
    const retryEntry = Array.from(this.#retryAttempts.values()).find(
      (entry) => entry.issueIdentifier === issueIdentifier,
    );

    if (!runningEntry && !retryEntry) {
      return null;
    }

    return {
      issueIdentifier,
      issueId: runningEntry?.issue.id ?? retryEntry?.issueId ?? null,
      status: runningEntry ? "running" : "retrying",
      workspace: {
        path: `${this.#config.workspace.root}/${issueIdentifier}`,
      },
      attempts: {
        restartCount: runningEntry?.attempt ?? retryEntry?.attempt ?? 0,
        currentRetryAttempt: retryEntry?.attempt ?? null,
      },
      running: runningEntry
        ? {
            sessionId: runningEntry.sessionId,
            turnCount: runningEntry.turnCount,
            state: runningEntry.issue.state,
            startedAt: runningEntry.startedAt,
            lastEvent: runningEntry.lastEvent,
            lastMessage: runningEntry.lastMessage,
            lastEventAt: runningEntry.lastEventAt,
            tokens: {
              inputTokens: runningEntry.inputTokens,
              outputTokens: runningEntry.outputTokens,
              totalTokens: runningEntry.totalTokens,
            },
          }
        : null,
      retry: retryEntry
        ? {
            attempt: retryEntry.attempt,
            dueAt: retryEntry.dueAt,
            error: retryEntry.error,
          }
        : null,
    };
  }

  async #reconcileRunningIssues(): Promise<void> {
    await this.#reconcileStalledRuns();

    const runningIds = Array.from(this.#running.keys());
    if (runningIds.length === 0) {
      return;
    }

    let refreshedIssues: Issue[];
    try {
      refreshedIssues = await this.#tracker.fetchIssueStatesByIds(runningIds);
    } catch (error) {
      this.#logger.warn(
        `state_refresh_failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
      );
      return;
    }

    for (const issue of refreshedIssues) {
      const runningEntry = this.#running.get(issue.id);
      if (!runningEntry) {
        continue;
      }

      if (this.#isTerminalState(issue.state)) {
        await this.#terminateRunningIssue(issue.id, {
          cleanupWorkspace: true,
          reason: `terminal state ${issue.state}`,
        });
        continue;
      }

      if (this.#isActiveState(issue.state)) {
        runningEntry.issue = issue;
        continue;
      }

      await this.#terminateRunningIssue(issue.id, {
        cleanupWorkspace: false,
        reason: `inactive state ${issue.state}`,
      });
    }
  }

  async #reconcileStalledRuns(): Promise<void> {
    const stallTimeoutMs = this.#config.codex.stallTimeoutMs;
    if (stallTimeoutMs <= 0) {
      return;
    }

    const now = Date.now();
    for (const [issueId, entry] of this.#running.entries()) {
      const lastEventAt = entry.lastEventAt?.getTime() ?? entry.startedAt.getTime();
      if (now - lastEventAt > stallTimeoutMs) {
        entry.handle.cancel(`stalled for ${now - lastEventAt}ms`);
        this.#logger.warn(
          `issue_id=${issueId} issue_identifier=${entry.issue.identifier} status=stalled`,
        );
      }
    }
  }

  async #terminateRunningIssue(
    issueId: string,
    options: { cleanupWorkspace: boolean; reason: string },
  ): Promise<void> {
    const entry = this.#running.get(issueId);
    if (!entry) {
      return;
    }

    entry.releaseClaimOnExit = true;
    entry.cleanupWorkspaceOnExit = options.cleanupWorkspace;
    entry.handle.cancel(options.reason);
  }

  #dispatchIssue(issue: Issue, attempt: number | null): void {
    this.#claimed.add(issue.id);
    this.#clearRetry(issue.id);

    try {
      const handle = this.#workerLauncher({
        issue,
        attempt,
        onEvent: (event) => this.#handleWorkerEvent(issue.id, event),
      });

      const entry: RunningEntry = {
        issue,
        attempt,
        handle,
        startedAt: new Date(),
        threadId: null,
        turnId: null,
        sessionId: null,
        turnCount: 1,
        lastEvent: null,
        lastMessage: null,
        lastEventAt: null,
        codexAppServerPid: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        lastReportedInputTokens: 0,
        lastReportedOutputTokens: 0,
        lastReportedTotalTokens: 0,
        releaseClaimOnExit: false,
        cleanupWorkspaceOnExit: false,
      };

      this.#running.set(issue.id, entry);
      void handle.done.then((result) => this.#onWorkerExit(issue.id, result));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "failed to spawn agent";
      this.#scheduleRetry(issue, nextAttempt(attempt), reason, false);
    }
  }

  async #onWorkerExit(issueId: string, result: WorkerResult): Promise<void> {
    const entry = this.#running.get(issueId);
    if (!entry) {
      return;
    }

    this.#running.delete(issueId);
    this.#endedRuntimeSeconds += (Date.now() - entry.startedAt.getTime()) / 1_000;

    if (entry.releaseClaimOnExit) {
      this.#claimed.delete(issueId);
      this.#clearRetry(issueId);
      if (entry.cleanupWorkspaceOnExit) {
        await this.#workspaceManager.removeWorkspace(entry.issue.identifier);
      }
      return;
    }

    if (result.kind === "normal") {
      this.#completed.add(issueId);
      this.#scheduleRetry(entry.issue, 1, null, true);
      return;
    }

    this.#scheduleRetry(entry.issue, nextAttempt(entry.attempt), result.error ?? "worker exited abnormally", false);
  }

  #handleWorkerEvent(issueId: string, event: AgentRuntimeEvent): void {
    const entry = this.#running.get(issueId);
    if (!entry) {
      return;
    }

    entry.lastEvent = event.event;
    entry.lastEventAt = event.timestamp;
    entry.lastMessage = event.message ?? entry.lastMessage;
    entry.codexAppServerPid = event.codexAppServerPid ?? entry.codexAppServerPid;

    if (event.sessionId) {
      entry.sessionId = event.sessionId;
    }
    if (event.threadId) {
      entry.threadId = event.threadId;
    }
    if (event.turnId) {
      entry.turnId = event.turnId;
    }
    if (event.rateLimits !== undefined) {
      this.#latestRateLimits = event.rateLimits;
    }

    if (!event.usage) {
      return;
    }

    const absoluteInput = normalizeUsageNumber(event.usage.inputTokens);
    const absoluteOutput = normalizeUsageNumber(event.usage.outputTokens);
    const absoluteTotal = normalizeUsageNumber(event.usage.totalTokens);

    if (absoluteInput != null) {
      this.#aggregateInputTokens += Math.max(absoluteInput - entry.lastReportedInputTokens, 0);
      entry.inputTokens = absoluteInput;
      entry.lastReportedInputTokens = absoluteInput;
    }
    if (absoluteOutput != null) {
      this.#aggregateOutputTokens += Math.max(absoluteOutput - entry.lastReportedOutputTokens, 0);
      entry.outputTokens = absoluteOutput;
      entry.lastReportedOutputTokens = absoluteOutput;
    }
    if (absoluteTotal != null) {
      this.#aggregateTotalTokens += Math.max(absoluteTotal - entry.lastReportedTotalTokens, 0);
      entry.totalTokens = absoluteTotal;
      entry.lastReportedTotalTokens = absoluteTotal;
    }
  }

  #scheduleRetry(
    issue: Issue,
    attempt: number,
    error: string | null,
    continuation: boolean,
  ): void {
    this.#clearRetry(issue.id);
    this.#claimed.add(issue.id);

    const delayMs = continuation
      ? 1_000
      : Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), this.#config.agent.maxRetryBackoffMs);
    const dueAt = new Date(Date.now() + delayMs);
    const timer = setTimeout(() => {
      void this.#onRetryTimer(issue.id);
    }, delayMs);

    this.#retryAttempts.set(issue.id, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt,
      dueAt,
      error,
      timer,
    });
  }

  async #onRetryTimer(issueId: string): Promise<void> {
    const retry = this.#retryAttempts.get(issueId);
    if (!retry) {
      return;
    }

    this.#retryAttempts.delete(issueId);

    let candidates: Issue[];
    try {
      candidates = await this.#tracker.fetchCandidateIssues(this.#config.tracker.activeStates);
    } catch {
      this.#scheduleRetry(
        {
          id: issueId,
          identifier: retry.issueIdentifier,
          title: retry.issueIdentifier,
          description: null,
          priority: null,
          state: this.#config.tracker.activeStates[0] ?? "Todo",
          branchName: null,
          url: null,
          labels: [],
          blockedBy: [],
          createdAt: null,
          updatedAt: null,
        },
        retry.attempt + 1,
        "retry poll failed",
        false,
      );
      return;
    }

    const issue = candidates.find((candidate) => candidate.id === issueId);
    if (!issue) {
      this.#claimed.delete(issueId);
      return;
    }

    if (this.#availableGlobalSlots() === 0 || !this.#hasAvailableStateSlot(issue.state, issue.id)) {
      this.#scheduleRetry(issue, retry.attempt + 1, "no available orchestrator slots", false);
      return;
    }

    if (!this.#shouldDispatch(issue, { ignoreClaimedIssueId: issueId })) {
      this.#claimed.delete(issueId);
      return;
    }

    this.#dispatchIssue(issue, retry.attempt);
  }

  #clearRetry(issueId: string): void {
    const existing = this.#retryAttempts.get(issueId);
    if (!existing) {
      return;
    }

    clearTimeout(existing.timer);
    this.#retryAttempts.delete(issueId);
  }

  #shouldDispatch(issue: Issue, options: { ignoreClaimedIssueId?: string } = {}): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
      return false;
    }

    if (!this.#isActiveState(issue.state) || this.#isTerminalState(issue.state)) {
      return false;
    }

    if (this.#running.has(issue.id)) {
      return false;
    }

    if (this.#claimed.has(issue.id) && options.ignoreClaimedIssueId !== issue.id) {
      return false;
    }

    if (this.#availableGlobalSlots() === 0) {
      return false;
    }

    if (!this.#hasAvailableStateSlot(issue.state)) {
      return false;
    }

    if (
      normalizeState(issue.state) === "todo" &&
      issue.blockedBy.some((blocker) => blocker.state != null && !this.#isTerminalState(blocker.state))
    ) {
      return false;
    }

    return true;
  }

  #availableGlobalSlots(): number {
    return Math.max(this.#config.agent.maxConcurrentAgents - this.#running.size, 0);
  }

  #hasAvailableStateSlot(state: string, currentIssueId?: string): boolean {
    const limit =
      this.#config.agent.maxConcurrentAgentsByState[normalizeState(state)] ??
      this.#config.agent.maxConcurrentAgents;
    const runningCount = Array.from(this.#running.entries()).filter(([issueId, entry]) => {
      if (issueId === currentIssueId) {
        return false;
      }
      return normalizeState(entry.issue.state) === normalizeState(state);
    }).length;

    return runningCount < limit;
  }

  #isActiveState(state: string): boolean {
    return this.#config.tracker.activeStates.some(
      (candidate) => normalizeState(candidate) === normalizeState(state),
    );
  }

  #isTerminalState(state: string): boolean {
    return this.#config.tracker.terminalStates.some(
      (candidate) => normalizeState(candidate) === normalizeState(state),
    );
  }
}

function normalizeState(state: string): string {
  return state.toLowerCase();
}

function normalizeUsageNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nextAttempt(attempt: number | null): number {
  if (attempt == null) {
    return 1;
  }

  return attempt + 1;
}

function sortIssuesForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((left, right) => {
    const leftPriority = left.priority ?? Number.POSITIVE_INFINITY;
    const rightPriority = right.priority ?? Number.POSITIVE_INFINITY;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftCreatedAt = left.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const rightCreatedAt = right.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    return left.identifier.localeCompare(right.identifier);
  });
}
