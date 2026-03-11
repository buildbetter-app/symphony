import { LinearTrackerClient } from "./linear-client.js";

import type { Issue } from "../types.js";
import type { WorkflowRuntime } from "../workflow/runtime.js";

export class RuntimeTrackerAdapter {
  readonly #workflowRuntime: WorkflowRuntime;

  constructor(workflowRuntime: WorkflowRuntime) {
    this.#workflowRuntime = workflowRuntime;
  }

  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    return this.#client().fetchCandidateIssues(activeStates);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    return this.#client().fetchIssuesByStates(stateNames);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    return this.#client().fetchIssueStatesByIds(issueIds);
  }

  async executeRawGraphql(query: string, variables?: Record<string, unknown>) {
    return this.#client().executeRawGraphql(query, variables);
  }

  #client(): LinearTrackerClient {
    const config = this.#workflowRuntime.current.config;
    return new LinearTrackerClient({
      endpoint: config.tracker.endpoint,
      apiKey: config.tracker.apiKey ?? "",
      projectSlug: config.tracker.projectSlug ?? "",
    });
  }
}
