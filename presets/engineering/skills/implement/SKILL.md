---
name: implement
description: Implement work from a spec or tickets using test-driven development and truthful LSP feedback.
---

# Implement

Execute the planned implementation ticket by ticket, keeping changes focused, verified at seams, and observable.

## Prerequisites

- **LSP Diagnostics & Fixes**: `lsp_diagnostics` and `lsp_fix` tools.
- **Language Server Availability**: An external language server binary must be installed on the host for LSP features to function.
- If the language server binary or LSP tools are absent, report LSP-assisted editing as **UNAVAILABLE** before attempting diagnostics. Never attempt to silently download or install language servers. Fall back to standard compiler checks without claiming LSP capabilities.

## Process

1. **Verify Seams**:
   Review the agreed testing seam from the specification or ticket.
2. **Execute Red-Green Cycle**:
   Use `/tdd` to write failing tests first, then write minimal code to make them pass.
3. **Diagnostics & Fixes**:
   If LSP tools and servers are available, check `lsp_diagnostics` and apply `lsp_fix` where appropriate. If unavailable, rely on local build/test commands.
4. **Final Suite Run**:
   Run the full project test suite before reporting completion.
