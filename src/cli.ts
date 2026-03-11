#!/usr/bin/env node
import { createConsoleLogger } from "./logging/console-logger.js";
import { SymphonyService } from "./service/symphony-service.js";

async function main() {
  const { workflowPath, port } = parseArgs(process.argv.slice(2));
  const logger = createConsoleLogger();
  const service = new SymphonyService({
    cwd: process.cwd(),
    workflowPath,
    port,
    logger,
  });

  await service.start();
  logger.info("symphony_started");

  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

function parseArgs(argv: string[]) {
  let workflowPath: string | undefined;
  let port: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value || !/^\d+$/.test(value)) {
        throw new Error("--port requires an integer value");
      }
      port = Number.parseInt(value, 10);
      index += 1;
      continue;
    }

    if (!workflowPath) {
      workflowPath = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return {
    workflowPath,
    port,
  };
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`symphony_startup_failed error=${JSON.stringify(message)}`);
  process.exit(1);
});
