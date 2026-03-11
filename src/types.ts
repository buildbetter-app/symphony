export type JsonObject = Record<string, unknown>;

export interface WorkflowDefinition {
  config: JsonObject;
  promptTemplate: string;
  sourcePath: string;
}

export interface ServiceConfigContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ServiceConfig {
  workflowPath: string;
  tracker: {
    kind: string | null;
    endpoint: string;
    apiKey: string | null;
    projectSlug: string | null;
    activeStates: string[];
    terminalStates: string[];
  };
  polling: {
    intervalMs: number;
  };
  workspace: {
    root: string;
  };
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxConcurrentAgentsByState: Record<string, number>;
    maxRetryBackoffMs: number;
    maxTurns: number;
  };
  codex: {
    command: string;
    approvalPolicy: unknown;
    threadSandbox: unknown;
    turnSandboxPolicy: unknown;
    turnTimeoutMs: number;
    readTimeoutMs: number;
    stallTimeoutMs: number;
  };
}

export interface ValidationError {
  code: string;
  message: string;
}

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: Date | null;
  updatedAt: Date | null;
}
