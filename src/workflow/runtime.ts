import { watchFile, unwatchFile } from "node:fs";

import type { Logger, ServiceConfig, WorkflowDefinition } from "../types.js";
import { buildServiceConfig } from "../config/service-config.js";

import { loadWorkflowDefinition, resolveWorkflowPath } from "./loader.js";

export interface EffectiveWorkflow {
  definition: WorkflowDefinition;
  config: ServiceConfig;
}

interface WorkflowRuntimeOptions {
  cwd: string;
  explicitPath?: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  onReload?: (workflow: EffectiveWorkflow) => void;
  onReloadError?: (error: unknown) => void;
}

export class WorkflowRuntime {
  readonly #cwd: string;
  readonly #explicitPath?: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #logger: Logger;
  readonly #onReload?: (workflow: EffectiveWorkflow) => void;
  readonly #onReloadError?: (error: unknown) => void;
  readonly #workflowPath: string;

  #watching = false;
  #reloadInFlight: Promise<void> | null = null;
  #pendingReload = false;
  #current: EffectiveWorkflow | null = null;

  constructor(options: WorkflowRuntimeOptions) {
    this.#cwd = options.cwd;
    this.#explicitPath = options.explicitPath;
    this.#env = options.env;
    this.#logger = options.logger;
    this.#onReload = options.onReload;
    this.#onReloadError = options.onReloadError;
    this.#workflowPath = resolveWorkflowPath({
      cwd: options.cwd,
      explicitPath: options.explicitPath,
    });
  }

  get current(): EffectiveWorkflow {
    if (!this.#current) {
      throw new Error("Workflow runtime has not been initialized");
    }
    return this.#current;
  }

  get workflowPath(): string {
    return this.#workflowPath;
  }

  async initialize(): Promise<EffectiveWorkflow> {
    const workflow = await this.#loadEffectiveWorkflow();
    this.#current = workflow;
    return workflow;
  }

  startWatching(): void {
    if (this.#watching) {
      return;
    }

    watchFile(this.#workflowPath, { interval: 100 }, () => {
      void this.reloadFromDisk();
    });
    this.#watching = true;
  }

  close(): void {
    if (!this.#watching) {
      return;
    }

    unwatchFile(this.#workflowPath);
    this.#watching = false;
  }

  async reloadFromDisk(): Promise<void> {
    if (this.#reloadInFlight) {
      this.#pendingReload = true;
      await this.#reloadInFlight;
      return;
    }

    this.#reloadInFlight = this.#performReload();
    try {
      await this.#reloadInFlight;
    } finally {
      this.#reloadInFlight = null;
      if (this.#pendingReload) {
        this.#pendingReload = false;
        await this.reloadFromDisk();
      }
    }
  }

  async #performReload(): Promise<void> {
    try {
      const workflow = await this.#loadEffectiveWorkflow();
      this.#current = workflow;
      this.#logger.info(`workflow_reloaded path=${this.#workflowPath}`);
      this.#onReload?.(workflow);
    } catch (error) {
      this.#logger.error(
        `workflow_reload_failed path=${this.#workflowPath} error=${JSON.stringify(stringifyError(error))}`,
      );
      this.#onReloadError?.(error);
    }
  }

  async #loadEffectiveWorkflow(): Promise<EffectiveWorkflow> {
    const definition = await loadWorkflowDefinition(this.#workflowPath);
    const config = buildServiceConfig(definition, {
      cwd: this.#cwd,
      env: this.#env,
    });

    return {
      definition,
      config,
    };
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
