import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function adaptWriteInterop(root) {
  for (const name of ['ccstyle.ts','ccstyle-bridge.mjs']) cpSync(new URL('./perfect-pi-adaptations/'+name,import.meta.url),join(root,'global/extensions',name));
  const path=join(root,'global/extensions/sol-pi.ts');
  let text=readFileSync(path,'utf8');
  text=text.replace("import { pathToFileURL }","import { pathToFileURL, fileURLToPath }");
  text=text.replace("export const SOL_PI_SOURCE","import { claimFusedWrite, releaseFusedWrite, executeStyledWrite } from \"./ccstyle-bridge.mjs\";\n\nexport const SOL_PI_SOURCE");
  text=text.replace("          const result = await create(ctx.cwd).execute(id, mutation, signal, update, ctx);","          const native = create(ctx.cwd);\n          const result = template.name === \"write\"\n            ? await executeStyledWrite(native.execute.bind(native), id, { ...mutation, path: queue.resolveToolPath(ctx.cwd, input.path) }, signal, update, ctx)\n            : await native.execute(id, mutation, signal, update, ctx);");
  text=text.replace("    registered = new Map();","    registered = new Map();\n    claimFusedWrite(fileURLToPath(import.meta.url));");
  text=text.replace("else if (tool.name === \"write\") pi.registerTool(createWriteToolDefinition(ctx.cwd));","else if (tool.name === \"write\") {\n        const native = createWriteToolDefinition(ctx.cwd);\n        pi.registerTool({ ...native, execute: (...args: any[]) => executeStyledWrite(native.execute.bind(native), ...args) });\n      }");
  text=text.replace("  let generation = 0;","  pi.on(\"session_shutdown\", () => releaseFusedWrite());\n  let generation = 0;");
  writeFileSync(path,text);
}
