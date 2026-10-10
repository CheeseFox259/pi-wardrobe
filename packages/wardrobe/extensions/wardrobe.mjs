// /wardrobe — the Wardrobe manager entry point.
//
// This extension registers one command and nothing else. It declares no
// packages, no MCP servers, no browser tooling and no install scripts, so
// installing the manager never pulls in a reference preset or an engineering
// dependency.

import { runCommand, withText } from "../src/commands.mjs";

export const RESULT_TYPE = "wardrobe.result";

export default function (pi) {
  pi.registerCommand("wardrobe", {
    description: "Inspect Wardrobe presets: list, show, explain",
    handler: async (args, ctx) => {
      const entry = withText(await runCommand(args));
      ctx.ui.notify(entry.text, entry.ok ? "info" : "error");
      // A structured record keeps the result machine-readable for scripting and
      // for checks that do not scrape terminal output.
      pi.appendEntry(RESULT_TYPE, { ...entry.result, text: entry.text });
    },
  });
}
