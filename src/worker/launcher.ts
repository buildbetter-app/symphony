import { SymphonyError } from "../errors.js";
import { renderPrompt } from "../prompt/render.js";
import type { Issue, Logger } from "../types.js";
import type { WorkflowRuntime } from "../workflow/runtime.js";
import type { RuntimeTrackerAdapter } from "../tracker/runtime-tracker.js";
import type { RuntimeWorkspaceManager } from "../workspace/runtime-manager.js";
import type { WorkerHandle, WorkerLaunchParams, WorkerResult } from "../orchestrator/orchestrator.js";

import { CodexAppServerClient, type CodexSession } from "../codex/app-server-client.js";

interface WorkerLauncherFactoryOptions {
  workflowRuntime: WorkflowRuntime;
  tracker: RuntimeTrackerAdapter;
  workspaceManager: RuntimeWorkspaceManager;
  logger: Logger;
}

export function createWorkerLauncher(options: WorkerLauncherFactoryOptions) {
  return (params: WorkerLaunchParams): WorkerHandle => {
    let cancelledReason: string | null = null;
    let client: CodexAppServerClient | null = null;
    let session: CodexSession | null = null;

    const done = (async (): Promise<WorkerResult> => {
      let workspace: Awaited<ReturnType<RuntimeWorkspaceManager["ensureWorkspaceForIssue"]>> | null = null;
      try {
        const workflow = options.workflowRuntime.current;
        workspace = await options.workspaceManager.ensureWorkspaceForIssue(params.issue.identifier);
        throwIfCancelled(cancelledReason);

        await options.workspaceManager.runBeforeRun(workspace);
        throwIfCancelled(cancelledReason);

        client = new CodexAppServerClient({
          command: workflow.config.codex.command,
          cwd: workspace.path,
          readTimeoutMs: workflow.config.codex.readTimeoutMs,
          turnTimeoutMs: workflow.config.codex.turnTimeoutMs,
        });
        session = await client.startSession({
          approvalPolicy: workflow.config.codex.approvalPolicy,
          sandbox: workflow.config.codex.threadSandbox,
        });
        throwIfCancelled(cancelledReason);

        let issue = params.issue;
        for (let turnNumber = 1; turnNumber <= workflow.config.agent.maxTurns; turnNumber += 1) {
          const prompt =
            turnNumber === 1
              ? await renderPrompt(workflow.definition.promptTemplate, {
                  issue: buildTemplateIssue(issue),
                  attempt: params.attempt,
                })
              : buildContinuationPrompt(issue, params.attempt, turnNumber, workflow.config.agent.maxTurns);
          await client.runTurn(session, {
            prompt,
            title: `${issue.identifier}: ${issue.title}`,
            approvalPolicy: workflow.config.codex.approvalPolicy,
            sandboxPolicy: workflow.config.codex.turnSandboxPolicy,
            onEvent: params.onEvent,
          });
          throwIfCancelled(cancelledReason);

          const refreshedIssues = await options.tracker.fetchIssueStatesByIds([issue.id]);
          if (refreshedIssues.length > 0) {
            issue = refreshedIssues[0]!;
          }

          if (!isActiveState(issue.state, workflow.config.tracker.activeStates)) {
            break;
          }

          if (turnNumber >= workflow.config.agent.maxTurns) {
            break;
          }
        }

        return { kind: "normal" };
      } catch (error) {
        return {
          kind: "abnormal",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (session && client) {
          await client.stopSession(session).catch(() => undefined);
        }
        if (workspace) {
          await options.workspaceManager.runAfterRun(workspace).catch(() => undefined);
        }
      }
    })();

    return {
      cancel(reason: string) {
        cancelledReason = reason;
        if (session && client) {
          void client.stopSession(session);
        }
      },
      done,
    };
  };
}

function throwIfCancelled(cancelledReason: string | null): void {
  if (!cancelledReason) {
    return;
  }

  throw new SymphonyError("turn_cancelled", cancelledReason);
}

function buildContinuationPrompt(
  issue: Issue,
  attempt: number | null,
  turnNumber: number,
  maxTurns: number,
): string {
  return [
    `Continue working on ${issue.identifier}: ${issue.title}.`,
    "Do not restate the original task prompt; continue from the existing thread context.",
    `This is continuation turn ${turnNumber} of ${maxTurns}.`,
    `Retry attempt: ${attempt ?? "initial"}.`,
  ].join("\n");
}

function buildTemplateIssue(issue: Issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branchName: issue.branchName,
    branch_name: issue.branchName,
    url: issue.url,
    labels: issue.labels,
    blockedBy: issue.blockedBy,
    blocked_by: issue.blockedBy,
    createdAt: issue.createdAt?.toISOString() ?? null,
    created_at: issue.createdAt?.toISOString() ?? null,
    updatedAt: issue.updatedAt?.toISOString() ?? null,
    updated_at: issue.updatedAt?.toISOString() ?? null,
  };
}

function isActiveState(state: string, activeStates: string[]) {
  return activeStates.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
}
