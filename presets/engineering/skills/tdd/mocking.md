# Mocking Guidelines

1. **Avoid Mocking What You Do Not Own**: Prefer loopback in-process transports or ephemeral real fixtures over extensive API mocks.
2. **State Over Interactions**: Assert resulting state and responses rather than counting internal method call invocations.
3. **Seams Over Swaps**: If mocking is essential, introduce an explicit injectable interface seam.
