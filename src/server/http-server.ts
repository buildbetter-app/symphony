import http, { type Server } from "node:http";

import type { Orchestrator } from "../orchestrator/orchestrator.js";

interface HttpServerOptions {
  port: number;
  orchestrator: Orchestrator;
  onRefresh: () => void;
}

export async function startHttpServer(options: HttpServerOptions): Promise<{
  server: Server;
  port: number;
}> {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/") {
      const snapshot = options.orchestrator.getSnapshot();
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderDashboard(snapshot));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(options.orchestrator.getSnapshot()));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/refresh") {
      options.onRefresh();
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          queued: true,
          coalesced: false,
          requested_at: new Date().toISOString(),
          operations: ["poll", "reconcile"],
        }),
      );
      return;
    }

    if (url.pathname.startsWith("/api/v1/")) {
      if (request.method !== "GET") {
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "method_not_allowed", message: "Method not allowed" } }));
        return;
      }

      const issueIdentifier = decodeURIComponent(url.pathname.slice("/api/v1/".length));
      const details = options.orchestrator.getIssueDetails(issueIdentifier);
      if (!details) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: "issue_not_found",
              message: `Issue ${issueIdentifier} is not tracked in the current runtime state`,
            },
          }),
        );
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(details));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found", message: "Route not found" } }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine HTTP server bind address");
  }

  return {
    server,
    port: address.port,
  };
}

function renderDashboard(snapshot: ReturnType<Orchestrator["getSnapshot"]>): string {
  const runningRows = snapshot.running
    .map(
      (row) =>
        `<li><strong>${escapeHtml(row.issueIdentifier)}</strong> ${escapeHtml(row.state)} ${escapeHtml(row.sessionId ?? "")}</li>`,
    )
    .join("");
  const retryRows = snapshot.retrying
    .map(
      (row) =>
        `<li><strong>${escapeHtml(row.issueIdentifier)}</strong> retry ${row.attempt} at ${escapeHtml(row.dueAt.toISOString())}</li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Symphony</title>
  </head>
  <body>
    <h1>Symphony</h1>
    <p>Running: ${snapshot.counts.running}</p>
    <p>Retrying: ${snapshot.counts.retrying}</p>
    <h2>Running</h2>
    <ul>${runningRows || "<li>None</li>"}</ul>
    <h2>Retrying</h2>
    <ul>${retryRows || "<li>None</li>"}</ul>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
