import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerClient } from "../src/codex/app-server-client.js";

describe("CodexAppServerClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T16:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("launches the app-server, performs the handshake, and emits session metadata", async () => {
    const child = new FakeChildProcess();
    const spawns: Array<{ command: string; args: string[]; cwd?: string | URL }> = [];
    const events: string[] = [];
    const client = new CodexAppServerClient({
      command: "codex app-server",
      cwd: "/tmp/workspaces/SYM-1",
      readTimeoutMs: 5_000,
      turnTimeoutMs: 10_000,
      spawnFn(command, args, options) {
        spawns.push({ command, args, cwd: options.cwd });
        return child;
      },
    });

    const sessionPromise = client.startSession({
      approvalPolicy: "auto",
      sandbox: "workspace-write",
    });

    await child.waitForWriteCount(1);
    child.sendResponse({ id: 1, result: { ok: true } });
    await child.waitForWriteCount(3);
    child.sendResponse({ id: 2, result: { thread: { id: "thread-1" } } });
    const session = await sessionPromise;

    const turnPromise = client.runTurn(session, {
      prompt: "Fix the bug",
      title: "SYM-1: Fix the bug",
      approvalPolicy: "auto",
      sandboxPolicy: { type: "workspace-write" },
      onEvent(event) {
        events.push(event.event);
      },
    });

    await child.waitForWriteCount(4);
    child.sendResponse({ id: 3, result: { turn: { id: "turn-1" } } });
    child.sendNotification({ method: "turn/completed", params: {} });
    const result = await turnPromise;

    expect(spawns).toEqual([
      {
        command: "bash",
        args: ["-lc", "codex app-server"],
        cwd: "/tmp/workspaces/SYM-1",
      },
    ]);
    expect(child.jsonWrites[0]).toMatchObject({ method: "initialize" });
    expect(child.jsonWrites[1]).toMatchObject({ method: "initialized" });
    expect(child.jsonWrites[2]).toMatchObject({ method: "thread/start" });
    expect(child.jsonWrites[3]).toMatchObject({ method: "turn/start" });
    expect(result).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      sessionId: "thread-1-turn-1",
    });
    expect(events).toEqual(["session_started", "turn_completed"]);

    await client.stopSession(session);
  });

  it("buffers partial stdout lines and ignores stderr protocol-looking data", async () => {
    const child = new FakeChildProcess();
    const client = new CodexAppServerClient({
      command: "codex app-server",
      cwd: "/tmp/workspaces/SYM-1",
      readTimeoutMs: 5_000,
      turnTimeoutMs: 10_000,
      spawnFn() {
        return child;
      },
    });

    const sessionPromise = client.startSession({
      approvalPolicy: "auto",
      sandbox: "workspace-write",
    });
    await child.waitForWriteCount(1);
    child.sendStdoutChunk('{"id":1,"result":{"ok":true}}\n');
    await child.waitForWriteCount(3);
    child.sendStdoutChunk('{"id":2,"result":{"thread":{"id":"thread-1"}}');
    child.sendStderrLine('{"id":999,"result":"ignore me"}');
    child.sendStdoutChunk("}\n");
    const session = await sessionPromise;

    const turnPromise = client.runTurn(session, {
      prompt: "Continue",
      title: "SYM-1: Continue",
      approvalPolicy: "auto",
      sandboxPolicy: { type: "workspace-write" },
      onEvent() {},
    });

    await child.waitForWriteCount(4);
    child.sendStdoutChunk('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    child.sendStdoutChunk('{"method":"turn/completed","params":{}}\n');
    await expect(turnPromise).resolves.toMatchObject({
      sessionId: "thread-1-turn-1",
    });
  });

  it("fails the turn when user input is requested", async () => {
    const child = new FakeChildProcess();
    const client = new CodexAppServerClient({
      command: "codex app-server",
      cwd: "/tmp/workspaces/SYM-1",
      readTimeoutMs: 5_000,
      turnTimeoutMs: 10_000,
      spawnFn() {
        return child;
      },
    });

    const sessionPromise = client.startSession({
      approvalPolicy: "auto",
      sandbox: "workspace-write",
    });
    await child.waitForWriteCount(1);
    child.sendResponse({ id: 1, result: { ok: true } });
    await child.waitForWriteCount(3);
    child.sendResponse({ id: 2, result: { thread: { id: "thread-1" } } });
    const session = await sessionPromise;

    const turnPromise = client.runTurn(session, {
      prompt: "Need input",
      title: "SYM-1: Need input",
      approvalPolicy: "auto",
      sandboxPolicy: { type: "workspace-write" },
      onEvent() {},
    });

    await child.waitForWriteCount(4);
    child.sendResponse({ id: 3, result: { turn: { id: "turn-1" } } });
    child.sendNotification({ method: "turn/input_required", params: {} });

    await expect(turnPromise).rejects.toMatchObject({
      code: "turn_input_required",
    });
  });

  it("returns unsupported tool failures to the session and continues streaming", async () => {
    const child = new FakeChildProcess();
    const client = new CodexAppServerClient({
      command: "codex app-server",
      cwd: "/tmp/workspaces/SYM-1",
      readTimeoutMs: 5_000,
      turnTimeoutMs: 10_000,
      spawnFn() {
        return child;
      },
    });

    const sessionPromise = client.startSession({
      approvalPolicy: "auto",
      sandbox: "workspace-write",
    });
    await child.waitForWriteCount(1);
    child.sendResponse({ id: 1, result: { ok: true } });
    await child.waitForWriteCount(3);
    child.sendResponse({ id: 2, result: { thread: { id: "thread-1" } } });
    const session = await sessionPromise;

    const turnPromise = client.runTurn(session, {
      prompt: "Use a tool",
      title: "SYM-1: Use a tool",
      approvalPolicy: "auto",
      sandboxPolicy: { type: "workspace-write" },
      onEvent() {},
    });

    await child.waitForWriteCount(4);
    child.sendResponse({ id: 3, result: { turn: { id: "turn-1" } } });
    child.sendNotification({
      method: "item/tool/call",
      params: {
        id: "tool-1",
        name: "unknown_tool",
        arguments: {},
      },
    });
    await child.waitForWriteCount(5);
    child.sendNotification({ method: "turn/completed", params: {} });

    await expect(turnPromise).resolves.toMatchObject({
      sessionId: "thread-1-turn-1",
    });
    expect(child.jsonWrites[4]).toEqual({
      id: "tool-1",
      result: {
        success: false,
        error: "unsupported_tool_call",
      },
    });
  });

  it("enforces read timeouts during startup requests", async () => {
    const child = new FakeChildProcess();
    const client = new CodexAppServerClient({
      command: "codex app-server",
      cwd: "/tmp/workspaces/SYM-1",
      readTimeoutMs: 500,
      turnTimeoutMs: 10_000,
      spawnFn() {
        return child;
      },
    });

    const sessionPromise = client.startSession({
      approvalPolicy: "auto",
      sandbox: "workspace-write",
    });
    const rejection = expect(sessionPromise).rejects.toMatchObject({
      code: "response_timeout",
    });

    await vi.advanceTimersByTimeAsync(500);

    await rejection;
  });
});

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly jsonWrites: unknown[] = [];
  readonly pid = 4242;

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          this.jsonWrites.push(JSON.parse(line));
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
  }

  kill() {
    this.emit("exit", 0, null);
    return true;
  }

  async waitForWriteCount(expectedCount: number) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.jsonWrites.length >= expectedCount) {
        return;
      }
      await Promise.resolve();
    }
    throw new Error(`Timed out waiting for ${expectedCount} writes`);
  }

  sendResponse(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendNotification(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendStdoutChunk(chunk: string) {
    this.stdout.write(chunk);
  }

  sendStderrLine(line: string) {
    this.stderr.write(`${line}\n`);
  }
}
