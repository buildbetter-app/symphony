import { describe, expect, it, vi } from "vitest";

import { LinearTrackerClient } from "../src/tracker/linear-client.js";

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("LinearTrackerClient", () => {
  it("fetches candidate issues with project slug filtering and pagination", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                issueNode({
                  id: "1",
                  identifier: "SYM-2",
                  title: "First page",
                  labels: ["Bug"],
                }),
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-1",
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                issueNode({
                  id: "2",
                  identifier: "SYM-3",
                  title: "Second page",
                  labels: ["Infra"],
                }),
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        }),
      );

    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "SYM",
      fetchFn: async (input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return fetchImpl(input, init);
      },
    });

    const issues = await client.fetchCandidateIssues(["Todo", "In Progress"]);

    expect(issues.map((issue) => issue.identifier)).toEqual(["SYM-2", "SYM-3"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain("slugId");
    expect(requests[0]?.variables).toMatchObject({
      projectSlug: "SYM",
      stateNames: ["Todo", "In Progress"],
      first: 50,
      after: null,
    });
    expect(requests[1]?.variables.after).toBe("cursor-1");
  });

  it("normalizes labels, blockers, and timestamps", async () => {
    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "SYM",
      fetchFn: async () =>
        jsonResponse({
          data: {
            issues: {
              nodes: [
                issueNode({
                  id: "1",
                  identifier: "SYM-1",
                  title: "Normalize me",
                  labels: ["Bug", "P0"],
                  inverseRelations: [
                    {
                      type: "blocks",
                      issue: {
                        id: "blocker-1",
                        identifier: "SYM-0",
                        state: {
                          name: "Done",
                        },
                      },
                    },
                  ],
                }),
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        }),
    });

    const [issue] = await client.fetchCandidateIssues(["Todo"]);

    expect(issue).toMatchObject({
      labels: ["bug", "p0"],
      blockedBy: [
        {
          id: "blocker-1",
          identifier: "SYM-0",
          state: "Done",
        },
      ],
      createdAt: new Date("2026-02-24T20:10:12.000Z"),
      updatedAt: new Date("2026-02-24T20:12:12.000Z"),
    });
  });

  it("returns an empty list for fetchIssuesByStates([]) without calling the API", async () => {
    const fetchFn = vi.fn();
    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "SYM",
      fetchFn,
    });

    await expect(client.fetchIssuesByStates([])).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches issue states by id using GraphQL ID typing", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "SYM",
      fetchFn: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-1",
                  identifier: "SYM-1",
                  title: "Refresh",
                  state: {
                    name: "In Progress",
                  },
                },
              ],
            },
          },
        });
      },
    });

    const issues = await client.fetchIssueStatesByIds(["issue-1"]);

    expect(issues).toEqual([
      expect.objectContaining({
        id: "issue-1",
        identifier: "SYM-1",
        state: "In Progress",
      }),
    ]);
    expect(requests[0]?.query).toContain("$ids: [ID!]");
  });

  it("maps top-level GraphQL errors to a typed tracker failure", async () => {
    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "SYM",
      fetchFn: async () =>
        jsonResponse({
          errors: [
            {
              message: "boom",
            },
          ],
        }),
    });

    await expect(client.fetchCandidateIssues(["Todo"])).rejects.toMatchObject({
      code: "linear_graphql_errors",
    });
  });
});

function issueNode(input: {
  id: string;
  identifier: string;
  title: string;
  labels: string[];
  inverseRelations?: Array<{
    type: string;
    issue: {
      id: string;
      identifier: string;
      state: {
        name: string;
      };
    };
  }>;
}) {
  return {
    id: input.id,
    identifier: input.identifier,
    title: input.title,
    description: "Description",
    priority: 2,
    branchName: `${input.identifier.toLowerCase()}-branch`,
    url: `https://linear.app/issue/${input.identifier}`,
    createdAt: "2026-02-24T20:10:12.000Z",
    updatedAt: "2026-02-24T20:12:12.000Z",
    state: {
      name: "Todo",
    },
    labels: {
      nodes: input.labels.map((name) => ({ name })),
    },
    inverseRelations: {
      nodes: input.inverseRelations ?? [],
    },
  };
}
