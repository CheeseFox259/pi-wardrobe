import { Type } from "@sinclair/typebox";

/**
 * Question extension for Pi.
 *
 * Exposes the structured single-question tool to interactively clarify user intent,
 * choices, and requirements using Pi's public extension and TUI APIs.
 */
export default function (pi: any) {
  const executeQuestion = async (_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
    if (params?.options && params.options.length > 0 && ctx?.ui?.select) {
      try {
        const choice = await ctx.ui.select(params.question, params.options);
        return {
          content: [{ type: "text", text: choice ?? params.default ?? "(no answer)" }],
        };
      } catch {
        return {
          content: [{ type: "text", text: params?.default ?? "(no answer)" }],
        };
      }
    }
    if (ctx?.ui?.input) {
      try {
        const answer = await ctx.ui.input(params.question, params.default);
        return {
          content: [{ type: "text", text: answer ?? params.default ?? "(no answer)" }],
        };
      } catch {
        return {
          content: [{ type: "text", text: params?.default ?? "(no answer)" }],
        };
      }
    }
    return {
      content: [{ type: "text", text: params?.default ?? "(no answer)" }],
    };
  };

  pi.registerTool({
    name: "question",
    label: "Question",
    description: "Ask the user a single structured question with optional choices and default answer.",
    promptSnippet: "question(question, options, default) - ask the user a single structured question",
    parameters: Type.Object({
      question: Type.String({ description: "Question prompt to display to the user" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "Optional predefined choices to select from" })),
      default: Type.Optional(Type.String({ description: "Optional default response value" })),
    }),
    execute: executeQuestion,
  });
}
