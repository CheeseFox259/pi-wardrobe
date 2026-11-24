# Native agent recovery after tool failures

Status: implemented; native default-model acceptance pending.

## Context

Pi returns a failed tool result to the model and automatically continues a `toolUse` turn. It does not blindly replay a tool call, because the failed call may already have had side effects. Wardrobe's watchdog previously ignored `stopReason` and could mark a workflow `STALLED` after a successful read at the recovery boundary. The model's next edit and any correction then hit the closed-workflow interceptor, even though Pi's native agent loop was still actionable.

## Decision

Keep tool execution and provider retry ownership in Pi. Wardrobe does not reissue failed calls, rewrite invalid arguments or convert ordinary tool errors into provider quota errors. It records consecutive tool failures and preserves the native failure result for the next model request. At bounded no-delivery recovery, native `toolUse` turns have separate allowances for two successful investigation continuations and two error corrections; three consecutive failures exhaust correction earlier. Successful reads reset neither allowance, so alternating reads and errors remains bounded. Successful delivery, an explicit focus change, automatic focus handoff and resume reset both counters. Independent-item handoff and final verification/install sealing retain their existing behavior. If the model settles, the existing bounded `agent_before_settle` continuation and preserved pause remain the final recovery path.

## Consequences

A real Pi scripted-provider test starts a single-item maintain task, exhausts both successful investigation continuations at the watchdog boundary, emits `edit` with invalid `filePath`, then issues the corrected `path` call on the next native turn. The failure result reaches the correcting request, the candidate edit takes effect, and final verification and inactive installation complete. Separate regressions prove that changing investigation output, alternating reads and failures, and three different consecutive failures cannot extend recovery indefinitely. These are native control-path results, not evidence about real-model completion rate or cost.
