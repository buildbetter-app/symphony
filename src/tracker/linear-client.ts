import { SymphonyError, isRecord } from "../errors.js";
import type { Issue } from "../types.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 30_000;

type FetchFn = typeof fetch;

interface LinearTrackerClientOptions {
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  fetchFn?: FetchFn;
}

export class LinearTrackerClient {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #projectSlug: string;
  readonly #fetchFn: FetchFn;

  constructor(options: LinearTrackerClientOptions) {
    this.#endpoint = options.endpoint;
    this.#apiKey = options.apiKey;
    this.#projectSlug = options.projectSlug;
    this.#fetchFn = options.fetchFn ?? fetch;
  }

  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    const issues: Issue[] = [];
    let after: string | null = null;

    while (true) {
      const payload: GraphqlEnvelope<{
        issues?: {
          nodes?: unknown[];
          pageInfo?: {
            hasNextPage?: boolean;
            endCursor?: string | null;
          };
        };
      }> = await this.#requestGraphql({
        query: CANDIDATE_ISSUES_QUERY,
        variables: {
          projectSlug: this.#projectSlug,
          stateNames: activeStates,
          first: DEFAULT_PAGE_SIZE,
          after,
        },
      });

      const connection = payload.data?.issues;
      if (!connection || !Array.isArray(connection.nodes) || !isRecord(connection.pageInfo)) {
        throw new SymphonyError(
          "linear_unknown_payload",
          "Linear candidate issue response was missing issues connection data",
        );
      }

      issues.push(...connection.nodes.map((node: unknown) => normalizeIssue(node)));

      const hasNextPage = connection.pageInfo.hasNextPage === true;
      if (!hasNextPage) {
        return issues;
      }

      if (typeof connection.pageInfo.endCursor !== "string" || connection.pageInfo.endCursor.length === 0) {
        throw new SymphonyError(
          "linear_missing_end_cursor",
          "Linear pagination indicated more pages but did not include endCursor",
        );
      }

      after = connection.pageInfo.endCursor;
    }
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) {
      return [];
    }

    const payload: GraphqlEnvelope<{
      issues?: {
        nodes?: unknown[];
      };
    }> = await this.#requestGraphql({
      query: ISSUES_BY_STATE_QUERY,
      variables: {
        projectSlug: this.#projectSlug,
        stateNames,
      },
    });

    const nodes = payload.data?.issues?.nodes;
    if (!Array.isArray(nodes)) {
      throw new SymphonyError(
        "linear_unknown_payload",
        "Linear issues-by-state response was missing nodes",
      );
    }

    return nodes.map((node) => normalizeIssue(node));
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const payload: GraphqlEnvelope<{
      issues?: {
        nodes?: unknown[];
      };
    }> = await this.#requestGraphql({
      query: ISSUE_STATES_BY_IDS_QUERY,
      variables: {
        ids: issueIds,
      },
    });

    const nodes = payload.data?.issues?.nodes;
    if (!Array.isArray(nodes)) {
      throw new SymphonyError(
        "linear_unknown_payload",
        "Linear issue-state response was missing nodes",
      );
    }

    return nodes.map((node) => normalizeIssue(node));
  }

  async executeRawGraphql(query: string, variables?: Record<string, unknown>) {
    return this.#requestGraphql({
      query,
      variables,
    });
  }

  async #requestGraphql<T>(body: {
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<GraphqlEnvelope<T>> {
    let response: Response;
    try {
      response = await this.#fetchFn(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.#apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SymphonyError(
        "linear_api_request",
        `Linear request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new SymphonyError(
        "linear_api_status",
        `Linear request failed with status ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new SymphonyError(
        "linear_unknown_payload",
        "Linear response body was not valid JSON",
        { cause: error },
      );
    }

    if (!isRecord(payload)) {
      throw new SymphonyError(
        "linear_unknown_payload",
        "Linear response payload must be an object",
      );
    }

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new SymphonyError(
        "linear_graphql_errors",
        "Linear returned top-level GraphQL errors",
        { cause: payload.errors },
      );
    }

    return payload as GraphqlEnvelope<T>;
  }
}

export interface GraphqlEnvelope<T> {
  data?: T;
  errors?: unknown[];
}

function normalizeIssue(input: unknown): Issue {
  if (!isRecord(input)) {
    throw new SymphonyError("linear_unknown_payload", "Linear issue node must be an object");
  }

  const state = isRecord(input.state) ? input.state.name : null;
  const labelsConnection = isRecord(input.labels) ? input.labels.nodes : [];
  const inverseRelationsConnection = isRecord(input.inverseRelations)
    ? input.inverseRelations.nodes
    : [];

  return {
    id: asRequiredString(input.id, "id"),
    identifier: asRequiredString(input.identifier, "identifier"),
    title: asRequiredString(input.title, "title"),
    description: asOptionalString(input.description),
    priority:
      typeof input.priority === "number" && Number.isInteger(input.priority) ? input.priority : null,
    state: typeof state === "string" ? state : "Unknown",
    branchName: asOptionalString(input.branchName),
    url: asOptionalString(input.url),
    labels: Array.isArray(labelsConnection)
      ? labelsConnection
          .map((label) => (isRecord(label) && typeof label.name === "string" ? label.name.toLowerCase() : null))
          .filter((label): label is string => label !== null)
      : [],
    blockedBy: Array.isArray(inverseRelationsConnection)
      ? inverseRelationsConnection
          .map((relation) => normalizeBlocker(relation))
          .filter((relation): relation is NonNullable<typeof relation> => relation !== null)
      : [],
    createdAt: parseIsoDate(input.createdAt),
    updatedAt: parseIsoDate(input.updatedAt),
  };
}

function normalizeBlocker(input: unknown) {
  if (!isRecord(input) || input.type !== "blocks" || !isRecord(input.issue)) {
    return null;
  }

  return {
    id: asOptionalString(input.issue.id),
    identifier: asOptionalString(input.issue.identifier),
    state: isRecord(input.issue.state) && typeof input.issue.state.name === "string"
      ? input.issue.state.name
      : null,
  };
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asRequiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new SymphonyError(
    "linear_unknown_payload",
    `Linear issue node is missing required string field ${field}`,
  );
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const CANDIDATE_ISSUES_QUERY = `
  query CandidateIssues($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $stateNames } }
      }
      first: $first
      after: $after
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        branchName
        url
        createdAt
        updatedAt
        state { name }
        labels { nodes { name } }
        inverseRelations {
          nodes {
            type
            issue {
              id
              identifier
              state { name }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ISSUES_BY_STATE_QUERY = `
  query IssuesByStates($projectSlug: String!, $stateNames: [String!]!) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $stateNames } }
      }
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        branchName
        url
        createdAt
        updatedAt
        state { name }
        labels { nodes { name } }
        inverseRelations {
          nodes {
            type
            issue {
              id
              identifier
              state { name }
            }
          }
        }
      }
    }
  }
`;

const ISSUE_STATES_BY_IDS_QUERY = `
  query IssueStatesByIds($ids: [ID!]) {
    issues(filter: { id: { in: $ids } }) {
      nodes {
        id
        identifier
        title
        description
        priority
        branchName
        url
        createdAt
        updatedAt
        state { name }
        labels { nodes { name } }
        inverseRelations {
          nodes {
            type
            issue {
              id
              identifier
              state { name }
            }
          }
        }
      }
    }
  }
`;
