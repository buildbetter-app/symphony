import { readFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { SymphonyError, isRecord } from "../errors.js";
import type { WorkflowDefinition } from "../types.js";

export function resolveWorkflowPath(options: { cwd: string; explicitPath?: string }): string {
  return options.explicitPath ?? path.join(options.cwd, "WORKFLOW.md");
}

export async function loadWorkflowDefinition(sourcePath: string): Promise<WorkflowDefinition> {
  let raw: string;

  try {
    raw = await readFile(sourcePath, "utf8");
  } catch (error) {
    throw new SymphonyError(
      "missing_workflow_file",
      `Unable to read workflow file at ${sourcePath}`,
      { cause: error },
    );
  }

  if (!raw.startsWith("---")) {
    return {
      config: {},
      promptTemplate: raw.trim(),
      sourcePath,
    };
  }

  const closingFenceIndex = raw.indexOf("\n---", 3);
  if (closingFenceIndex === -1) {
    throw new SymphonyError(
      "workflow_parse_error",
      `Workflow front matter fence is not terminated in ${sourcePath}`,
    );
  }

  const yamlSource = raw.slice(4, closingFenceIndex);
  const body = raw.slice(closingFenceIndex + 4).trim();

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlSource);
  } catch (error) {
    throw new SymphonyError(
      "workflow_parse_error",
      `Failed to parse workflow front matter in ${sourcePath}`,
      { cause: error },
    );
  }

  if (parsed == null) {
    parsed = {};
  }

  if (!isRecord(parsed)) {
    throw new SymphonyError(
      "workflow_front_matter_not_a_map",
      `Workflow front matter must decode to an object in ${sourcePath}`,
    );
  }

  return {
    config: parsed,
    promptTemplate: body,
    sourcePath,
  };
}
