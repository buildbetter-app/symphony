import { spawn } from "node:child_process";

import { SymphonyError, isRecord } from "../errors.js";

interface WritableStreamLike {
  write(chunk: string): boolean;
}

interface ReadableStreamLike {
  setEncoding(encoding: BufferEncoding): void;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

interface SpawnedProcess {
  stdin: WritableStreamLike;
  stdout: ReadableStreamLike;
  stderr: ReadableStreamLike;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  pid?: number;
}

type SpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd?: string | URL;
    stdio?: "pipe";
  },
) => SpawnedProcess;

type ToolHandler = (arguments_: unknown) => Promise<unknown>;

interface CodexAppServerClientOptions {
  command: string;
  cwd: string;
  readTimeoutMs: number;
  turnTimeoutMs: number;
  spawnFn?: SpawnFn;
  dynamicTools?: Record<string, ToolHandler>;
}

interface SessionStartOptions {
  approvalPolicy: unknown;
  sandbox: unknown;
}

interface TurnStartOptions {
  prompt: string;
  title: string;
  approvalPolicy: unknown;
  sandboxPolicy: unknown;
  onEvent: (event: CodexClientEvent) => void;
}

export interface CodexClientEvent {
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

export interface CodexSession {
  threadId: string;
  cwd: string;
  process: SpawnedProcess;
  connection: ProtocolConnection;
}

export interface TurnResult {
  threadId: string;
  turnId: string;
  sessionId: string;
}

export class CodexAppServerClient {
  readonly #command: string;
  readonly #cwd: string;
  readonly #readTimeoutMs: number;
  readonly #turnTimeoutMs: number;
  readonly #spawnFn: SpawnFn;
  readonly #dynamicTools: Record<string, ToolHandler>;
  #nextRequestId = 1;

  constructor(options: CodexAppServerClientOptions) {
    this.#command = options.command;
    this.#cwd = options.cwd;
    this.#readTimeoutMs = options.readTimeoutMs;
    this.#turnTimeoutMs = options.turnTimeoutMs;
    this.#spawnFn = options.spawnFn ?? spawn;
    this.#dynamicTools = options.dynamicTools ?? {};
  }

  async startSession(options: SessionStartOptions): Promise<CodexSession> {
    const process = this.#spawnFn("bash", ["-lc", this.#command], {
      cwd: this.#cwd,
      stdio: "pipe",
    });
    const connection = new ProtocolConnection(process);

    try {
      await connection.request({
        id: this.#allocateRequestId(),
        method: "initialize",
        params: {
          clientInfo: {
            name: "symphony",
            version: "1.0",
          },
          capabilities: {},
        },
        timeoutMs: this.#readTimeoutMs,
      });
      connection.notify({
        method: "initialized",
        params: {},
      });
      const threadResult = await connection.request({
        id: this.#allocateRequestId(),
        method: "thread/start",
        params: {
          approvalPolicy: options.approvalPolicy,
          sandbox: options.sandbox,
          cwd: this.#cwd,
        },
        timeoutMs: this.#readTimeoutMs,
      });
      const threadId = extractThreadId(threadResult);
      return {
        threadId,
        cwd: this.#cwd,
        process,
        connection,
      };
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async runTurn(session: CodexSession, options: TurnStartOptions): Promise<TurnResult> {
    const turnStartResult = await session.connection.request({
      id: this.#allocateRequestId(),
      method: "turn/start",
      params: {
        threadId: session.threadId,
        input: [
          {
            type: "text",
            text: options.prompt,
          },
        ],
        cwd: session.cwd,
        title: options.title,
        approvalPolicy: options.approvalPolicy,
        sandboxPolicy: options.sandboxPolicy,
      },
      timeoutMs: this.#readTimeoutMs,
    });

    const turnId = extractTurnId(turnStartResult);
    const sessionId = `${session.threadId}-${turnId}`;
    options.onEvent({
      event: "session_started",
      timestamp: new Date(),
      sessionId,
      threadId: session.threadId,
      turnId,
      codexAppServerPid: session.process.pid ? String(session.process.pid) : undefined,
    });

    const deadline = Date.now() + this.#turnTimeoutMs;
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new SymphonyError(
          "turn_timeout",
          `Turn exceeded timeout of ${this.#turnTimeoutMs}ms`,
        );
      }

      const message = await session.connection.nextMessage(remainingMs);
      const timestamp = new Date();
      if (message.kind === "malformed") {
        options.onEvent({
          event: "malformed",
          timestamp,
          message: message.raw,
        });
        continue;
      }

      const method = typeof message.method === "string" ? message.method : "";
      const usage = extractUsage(message.params);
      const rateLimits = extractRateLimits(message.params);

      if (method === "item/tool/call") {
        await this.#handleToolCall(session, message.params);
        continue;
      }

      if (method === "turn/input_required" || method === "item/tool/requestUserInput") {
        options.onEvent({
          event: "turn_input_required",
          timestamp,
          sessionId,
          threadId: session.threadId,
          turnId,
          usage,
          rateLimits,
        });
        throw new SymphonyError("turn_input_required", "Turn requested user input");
      }

      if (method === "turn/completed") {
        options.onEvent({
          event: "turn_completed",
          timestamp,
          sessionId,
          threadId: session.threadId,
          turnId,
          usage,
          rateLimits,
        });
        return {
          threadId: session.threadId,
          turnId,
          sessionId,
        };
      }

      if (method === "turn/failed") {
        options.onEvent({
          event: "turn_failed",
          timestamp,
          sessionId,
          threadId: session.threadId,
          turnId,
          usage,
          rateLimits,
        });
        throw new SymphonyError("turn_failed", "Turn failed");
      }

      if (method === "turn/cancelled") {
        options.onEvent({
          event: "turn_cancelled",
          timestamp,
          sessionId,
          threadId: session.threadId,
          turnId,
          usage,
          rateLimits,
        });
        throw new SymphonyError("turn_cancelled", "Turn cancelled");
      }

      options.onEvent({
        event: "notification",
        timestamp,
        sessionId,
        threadId: session.threadId,
        turnId,
        usage,
        rateLimits,
      });
    }
  }

  async stopSession(session: CodexSession): Promise<void> {
    session.connection.close();
  }

  async #handleToolCall(session: CodexSession, params: unknown): Promise<void> {
    if (!isRecord(params) || (typeof params.id !== "string" && typeof params.id !== "number")) {
      return;
    }

    const toolId = params.id;
    const toolName = typeof params.name === "string" ? params.name : "";
    const toolArgs = params.arguments;
    const handler = this.#dynamicTools[toolName];

    if (!handler) {
      session.connection.respond({
        id: toolId,
        result: {
          success: false,
          error: "unsupported_tool_call",
        },
      });
      return;
    }

    try {
      const result = await handler(toolArgs);
      session.connection.respond({
        id: toolId,
        result,
      });
    } catch (error) {
      session.connection.respond({
        id: toolId,
        result: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  #allocateRequestId(): number {
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return requestId;
  }
}

class ProtocolConnection {
  readonly #process: SpawnedProcess;
  readonly #pendingRequests = new Map<
    string | number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #queuedMessages: Array<ProtocolMessage> = [];
  readonly #messageWaiters: Array<{
    resolve: (message: ProtocolMessage) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  #stdoutBuffer = "";
  #closed = false;

  constructor(process: SpawnedProcess) {
    this.#process = process;
    this.#process.stdout.setEncoding("utf8");
    this.#process.stderr.setEncoding("utf8");
    this.#process.stdout.on("data", (chunk) => this.#onStdoutData(String(chunk)));
    this.#process.stderr.on("data", () => {
      // stderr is diagnostics only; it is intentionally excluded from protocol parsing
    });
    this.#process.once("exit", () => {
      this.#handleClose(new SymphonyError("port_exit", "Codex app-server exited"));
    });
  }

  request(options: {
    id: string | number;
    method: string;
    params: unknown;
    timeoutMs: number;
  }): Promise<unknown> {
    this.#write({
      id: options.id,
      method: options.method,
      params: options.params,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(options.id);
        reject(
          new SymphonyError(
            "response_timeout",
            `Timed out waiting for ${options.method} response after ${options.timeoutMs}ms`,
          ),
        );
      }, options.timeoutMs);

      this.#pendingRequests.set(options.id, {
        resolve,
        reject,
        timer,
      });
    });
  }

  notify(message: { method: string; params: unknown }): void {
    this.#write(message);
  }

  respond(message: { id: string | number; result: unknown }): void {
    this.#write(message);
  }

  nextMessage(timeoutMs: number): Promise<ProtocolMessage> {
    const queued = this.#queuedMessages.shift();
    if (queued) {
      return Promise.resolve(queued);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new SymphonyError(
            "turn_timeout",
            `Timed out waiting for turn stream data after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.#messageWaiters.push({
        resolve,
        reject,
        timer,
      });
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#process.kill();
  }

  #write(message: unknown): void {
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onStdoutData(chunk: string): void {
    this.#stdoutBuffer += chunk;
    let newlineIndex = this.#stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#stdoutBuffer.slice(0, newlineIndex).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.#dispatchParsedLine(line);
      }
      newlineIndex = this.#stdoutBuffer.indexOf("\n");
    }
  }

  #dispatchParsedLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#enqueueMessage({
        kind: "malformed",
        raw: line,
      });
      return;
    }

    const parsedId =
      isRecord(parsed) && (typeof parsed.id === "string" || typeof parsed.id === "number")
        ? parsed.id
        : null;
    if (parsedId != null && this.#pendingRequests.has(parsedId)) {
      const pending = this.#pendingRequests.get(parsedId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.#pendingRequests.delete(parsedId);
      if (isRecord(parsed) && parsed.error) {
        pending.reject(new SymphonyError("response_error", "Codex app-server returned an error"));
        return;
      }
      pending.resolve(isRecord(parsed) ? parsed.result : undefined);
      return;
    }

    if (isRecord(parsed)) {
      this.#enqueueMessage({
        kind: "message",
        method: typeof parsed.method === "string" ? parsed.method : null,
        params: parsed.params,
      });
    }
  }

  #enqueueMessage(message: ProtocolMessage): void {
    const waiter = this.#messageWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }

    this.#queuedMessages.push(message);
  }

  #handleClose(error: SymphonyError): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    for (const [id, pending] of this.#pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pendingRequests.delete(id);
    }

    while (this.#messageWaiters.length > 0) {
      const waiter = this.#messageWaiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

type ProtocolMessage =
  | {
      kind: "message";
      method: string | null;
      params: unknown;
    }
  | {
      kind: "malformed";
      raw: string;
    };

function extractThreadId(result: unknown): string {
  if (isRecord(result) && isRecord(result.thread) && typeof result.thread.id === "string") {
    return result.thread.id;
  }

  throw new SymphonyError("response_error", "thread/start response did not include result.thread.id");
}

function extractTurnId(result: unknown): string {
  if (isRecord(result) && isRecord(result.turn) && typeof result.turn.id === "string") {
    return result.turn.id;
  }

  throw new SymphonyError("response_error", "turn/start response did not include result.turn.id");
}

function extractUsage(params: unknown) {
  if (!isRecord(params)) {
    return undefined;
  }

  const usage = isRecord(params.usage)
    ? params.usage
    : isRecord(params.total_token_usage)
      ? params.total_token_usage
      : null;
  if (!usage) {
    return undefined;
  }

  const inputTokens = asNumber(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = asNumber(usage.outputTokens ?? usage.output_tokens);
  const totalTokens = asNumber(usage.totalTokens ?? usage.total_tokens);
  if (inputTokens == null && outputTokens == null && totalTokens == null) {
    return undefined;
  }

  return {
    inputTokens: inputTokens ?? undefined,
    outputTokens: outputTokens ?? undefined,
    totalTokens: totalTokens ?? undefined,
  };
}

function extractRateLimits(params: unknown) {
  if (!isRecord(params)) {
    return undefined;
  }

  return params.rate_limits;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
