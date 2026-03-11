import { Liquid } from "liquidjs";

import { SymphonyError } from "../errors.js";

const engine = new Liquid({
  strictFilters: true,
  strictVariables: true,
});

export async function renderPrompt(
  template: string,
  context: { issue: Record<string, unknown>; attempt: number | null },
): Promise<string> {
  const effectiveTemplate = template.trim() || "You are working on an issue from Linear.";

  try {
    return await engine.parseAndRender(effectiveTemplate, context);
  } catch (error) {
    throw new SymphonyError(
      "template_render_error",
      `Failed to render workflow prompt: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }
}
