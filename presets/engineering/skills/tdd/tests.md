# Testing Guidelines

1. **Test Real Behavior**: Assert externally observable outcomes, not private implementation details.
2. **Deterministic & Isolated**: Each test must run independently and clean up transient resources.
3. **High Seams**: Prefer testing through top-level public interfaces over deep internal units.
