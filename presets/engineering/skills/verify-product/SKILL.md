---
name: verify-product
description: Verify end-to-end product behavior and user journeys against requirements and acceptance criteria.
---

# Verify Product

Perform full end-to-end verification of user flows and deliverable behavior in the shape the end-user receives it.

## Prerequisites

- Built deliverable and runnable application binaries.
- If UI, web browser automation, or external network inspection is required but browser/web tools are absent in this preset:
  - Report browser/web automation as **UNAVAILABLE**.
  - Never silently install browser binaries, headless engines, or unapproved drivers.
  - Never claim browser verification occurred when only unit/headless tests ran.
  - Fall back to headless CLI, API, or integration test commands and report that boundary explicitly.

## Process

1. **Verify Deliverable Artifacts**:
   Run the project's standard build and start commands against the shipped deliverables.
2. **Exercise Real Scenarios**:
   Execute realistic input flows, validating stdout/stderr, return codes, and persistent data changes.
3. **Capture Observable Evidence**:
   Report concrete verification logs, commands run, and exact output evidence.
