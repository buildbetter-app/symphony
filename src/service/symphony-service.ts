import type { Server } from "node:http";

import { Orchestrator } from "../orchestrator/orchestrator.js";
import type { Logger, ServiceConfig } from "../types.js";
import { RuntimeTrackerAdapter } from "../tracker/runtime-tracker.js";
import { startHttpServer } from "../server/http-server.js";
import { WorkflowRuntime } from "../workflow/runtime.js";
import { RuntimeWorkspaceManager } from "../workspace/runtime-manager.js";
import { createWorkerLauncher } from "../worker/launcher.js";

interface SymphonyServiceOptions {
  cwd: string;
  workflowPath?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
}

export class SymphonyService {
  readonly #cwd: string;
  readonly #workflowPath?: string;
  readonly #port?: number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #logger: Logger;

  #workflowRuntime: WorkflowRuntime | null = null;
  #orchestrator: Orchestrator | null = null;
  #server: Server | null = null;
  #boundPort: number | null = null;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #tickInFlight = false;
  #refreshQueued = false;
  #stopped = false;

  constructor(options: SymphonyServiceOptions) {
    this.#cwd = options.cwd;
    this.#workflowPath = options.workflowPath;
    this.#port = options.port;
    this.#env = options.env ?? process.env;
    this.#logger = options.logger;
  }

  get orchestrator(): Orchestrator {
    if (!this.#orchestrator) {
      throw new Error("Symphony service has not been started");
    }
    return this.#orchestrator;
  }

  get port(): number | null {
    return this.#boundPort;
  }

  async start(): Promise<void> {
    const workflowRuntime = new WorkflowRuntime({
      cwd: this.#cwd,
      explicitPath: this.#workflowPath,
      env: this.#env,
      logger: this.#logger,
      onReload: ({ config }) => {
        if (liveConfig) {
          replaceConfig(liveConfig, config);
        }
      },
    });
    const initialWorkflow = await workflowRuntime.initialize();
    const liveConfig = cloneConfig(initialWorkflow.config);
    this.#workflowRuntime = workflowRuntime;
    workflowRuntime.startWatching();

    const tracker = new RuntimeTrackerAdapter(workflowRuntime);
    const workspaceManager = new RuntimeWorkspaceManager(workflowRuntime, this.#logger);
    const workerLauncher = createWorkerLauncher({
      workflowRuntime,
      tracker,
      workspaceManager,
      logger: this.#logger,
    });
    this.#orchestrator = new Orchestrator({
      config: liveConfig,
      tracker,
      workerLauncher,
      workspaceManager,
      logger: this.#logger,
    });

    await this.#orchestrator.startupCleanup();

    const effectivePort = this.#port ?? readServerPort(initialWorkflow.definition.config);
    if (effectivePort != null) {
      const httpServer = await startHttpServer({
        port: effectivePort,
        orchestrator: this.#orchestrator,
        onRefresh: () => this.requestRefresh(),
      });
      this.#server = httpServer.server;
      this.#boundPort = httpServer.port;
      this.#logger.info(`http_server_started port=${this.#boundPort}`);
    }

    this.#scheduleNextTick(0);
  }

  requestRefresh(): void {
    if (this.#tickInFlight) {
      this.#refreshQueued = true;
      return;
    }

    this.#scheduleNextTick(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#workflowRuntime?.close();
    if (this.#server) {
      await new Promise<void>((resolve, reject) => {
        this.#server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.#server = null;
    }
  }

  #scheduleNextTick(delayMs: number): void {
    if (this.#stopped) {
      return;
    }
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
    }
    this.#pollTimer = setTimeout(() => {
      void this.#runTick();
    }, delayMs);
  }

  async #runTick(): Promise<void> {
    if (this.#stopped || !this.#orchestrator || !this.#workflowRuntime) {
      return;
    }
    if (this.#tickInFlight) {
      this.#refreshQueued = true;
      return;
    }

    this.#tickInFlight = true;
    try {
      await this.#orchestrator.tick();
    } finally {
      this.#tickInFlight = false;
      if (this.#refreshQueued) {
        this.#refreshQueued = false;
        this.#scheduleNextTick(0);
        return;
      }
      this.#scheduleNextTick(this.#workflowRuntime.current.config.polling.intervalMs);
    }
  }
}

function cloneConfig(config: ServiceConfig): ServiceConfig {
  return structuredClone(config);
}

function replaceConfig(target: ServiceConfig, source: ServiceConfig): void {
  target.workflowPath = source.workflowPath;
  target.tracker = source.tracker;
  target.polling = source.polling;
  target.workspace = source.workspace;
  target.hooks = source.hooks;
  target.agent = source.agent;
  target.codex = source.codex;
}

function readServerPort(config: Record<string, unknown>): number | undefined {
  const server = config.server;
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return undefined;
  }
  const port = (server as { port?: unknown }).port;
  return typeof port === "number" && Number.isInteger(port) ? port : undefined;
}
