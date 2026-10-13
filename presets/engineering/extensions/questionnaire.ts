import { Type } from "@sinclair/typebox";

/**
 * Questionnaire extension for Pi.
 *
 * Exposes the structured questionnaire tool to prompt the user through a sequence
 * of questions using Pi's public extension and TUI APIs.
 */
export default function (pi: any) {
  const executeQuestionnaire = async (_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
    const answers: Record<string, string> = {};
    const questions = params?.questions ?? [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const key = q.id ?? `q${i + 1}`;
      let answer: string | undefined;
      if (q.options && q.options.length > 0 && ctx?.ui?.select) {
        try {
          answer = await ctx.ui.select(q.question, q.options);
        } catch {
          answer = q.default;
        }
      } else if (ctx?.ui?.input) {
        try {
          answer = await ctx.ui.input(q.question, q.default);
        } catch {
          answer = q.default;
        }
      }
      answers[key] = answer ?? q.default ?? "(no answer)";
    }
    return {
      content: [{ type: "text", text: JSON.stringify(answers, null, 2) }],
    };
  };

  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description: "Ask the user a sequence of structured questions to gather requirements or decisions.",
    promptSnippet: "questionnaire(questions) - ask the user a sequence of structured questions",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.Optional(Type.String({ description: "Question identifier" })),
          question: Type.String({ description: "Question prompt text" }),
          options: Type.Optional(Type.Array(Type.String(), { description: "Optional choices" })),
          default: Type.Optional(Type.String({ description: "Optional default response" })),
        }),
        { description: "List of questions to ask the user" }
      ),
    }),
    execute: executeQuestionnaire,
  });
}
