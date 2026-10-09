# Delegate package lifecycle to Pi

Pi already installs, updates, and removes resource packages, so Wardrobe delegates those operations to Pi rather than maintaining a second Git/npm package manager. Wardrobe owns preset composition and activation coordination; this avoids competing caches and package ownership, at the cost of accepting Pi's package identity and lifecycle limits. Review and activation remain separate responsibilities: resource filters do not suppress installation scripts, and the exact installation and recovery integration is still an open design decision.
