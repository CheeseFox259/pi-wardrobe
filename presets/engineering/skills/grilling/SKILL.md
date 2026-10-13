---
name: grilling
description: Interrogate requirements, decisions, and assumptions relentlessly until a shared design tree is settled.
---

# Grilling

Relentlessly interview the user to clarify requirements and map assumptions into a settled design tree before implementation begins.

## Prerequisites

- **Interactive Question Tools**: Requires `question` or `questionnaire` tool in the runtime.
- If neither tool is available, report the interactive grilling workflow as **UNAVAILABLE** before attempting interactive questioning. Never claim absent tools exist or silently install question handlers.

## Process

1. **Map the Frontier**:
   Identify open decision branches whose prerequisites are already settled. Collect these decisions into rounds.
2. **Execute Interactive Rounds**:
   Use the `question` or `questionnaire` tool to prompt the user with clear options and recommendations.
3. **Handle Answers**:
   Incorporate the user's answers, update the decision frontier, and proceed until all architectural ambiguities are resolved.
