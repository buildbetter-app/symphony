import type { Logger, Workspace } from "../types.js";
import type { WorkflowRuntime } from "../workflow/runtime.js";

import { WorkspaceManager } from "./manager.js";

export class RuntimeWorkspaceManager {
  readonly #workflowRuntime: WorkflowRuntime;
  readonly #logger: Logger;

  constructor(workflowRuntime: WorkflowRuntime, logger: Logger) {
    this.#workflowRuntime = workflowRuntime;
    this.#logger = logger;
  }

  ensureWorkspaceForIssue(issueIdentifier: string): Promise<Workspace> {
    return this.#manager().ensureWorkspaceForIssue(issueIdentifier);
  }

  runBeforeRun(workspace: Workspace): Promise<void> {
    return this.#manager().runBeforeRun(workspace);
  }

  runAfterRun(workspace: Workspace): Promise<void> {
    return this.#manager().runAfterRun(workspace);
  }

  removeWorkspace(issueIdentifier: string): Promise<void> {
    return this.#manager().removeWorkspace(issueIdentifier);
  }

  root(): string {
    return this.#workflowRuntime.current.config.workspace.root;
  }

  #manager(): WorkspaceManager {
    const config = this.#workflowRuntime.current.config;
    return new WorkspaceManager({
      root: config.workspace.root,
      hooks: {
        afterCreate: config.hooks.afterCreate,
        beforeRun: config.hooks.beforeRun,
        afterRun: config.hooks.afterRun,
        beforeRemove: config.hooks.beforeRemove,
      },
      hookTimeoutMs: config.hooks.timeoutMs,
      logger: this.#logger,
    });
  }
}
