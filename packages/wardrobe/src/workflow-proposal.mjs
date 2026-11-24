const recommendations = new Map([
  ['adopt', '采用 / Adopt'],
  ['adapt', '适配 / Adapt'],
  ['defer', '暂缓 / Defer'],
  ['preserve', '保留 / Preserve'],
]);

export const updateReviewTitle = 'Wardrobe · 更新方案';

export function renderCapabilityReport(proposal) {
  const line = (value, label, max) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
      throw Object.assign(new Error(label + ' must be a single line of 1–' + max + ' characters'), {code:'WORKFLOW_PROPOSAL_INVALID'});
    }
    return value.trim();
  };
  const summary = proposal?.summary === undefined ? null : line(proposal.summary, 'summary', 160);
  if (!Array.isArray(proposal.changes) || proposal.changes.length < 1 || proposal.changes.length > 6) {
    throw Object.assign(new Error('Group the material changes into 1–6 component rows'), {code:'WORKFLOW_PROPOSAL_INVALID'});
  }
  const rows = proposal.changes.map(change => {
    const component = line(change?.component, 'component', 48);
    const effect = line(change.effect, 'effect', 110);
    const reason = change.reason === undefined ? null : line(change.reason, 'reason', 110);
    const recommendation = recommendations.get(change.recommendation);
    if (!recommendation) throw Object.assign(new Error('Use adopt, adapt, defer or preserve for each recommendation'), {code:'WORKFLOW_PROPOSAL_INVALID'});
    return `• ${component} (${recommendation}) — ${effect}${reason ? ' ' + reason : ''}`;
  });
  const validation = line(proposal.validation, 'validation', 220);
  const question = proposal.question === undefined ? null : line(proposal.question, 'question', 180);
  return [...(summary ? [summary] : []), ...rows, '', '验收 / Validation — ' + validation, ...(question ? ['取舍 / Trade-off — ' + question] : [])].join('\n');
}

export const proposeUpdateNext = 'Use the request and focused change summary already in this handoff. Read the affected component contract only if it could change the recommendation, then call propose. For one outcome, submit one change row and one validation sentence. Omit a repeated summary and any reason already clear from the request.';

export const implementUpdateNext = 'Implement the approved outcome in workspace.source. Open only the files needed for the first edit. For a new resource, write the file, then register it with submission.resources (action: add, package: context.localPackageAlias, kind, path). Wardrobe compiles both resource lists. Follow nextCall and submit the decision and work with ready:true after the edit. Use verify to run native loading and your affected behavior checks; a small text change can use a Node assertion in work.checks. Install the verified revision with existing authorization.';

export function requireApprovedPlan(record) {
  if (record.planReview && record.planReview.phase !== 'approved') {
    throw Object.assign(new Error('Present the capability report and obtain user confirmation before implementation.'), {code:'WORKFLOW_PLAN_APPROVAL_REQUIRED'});
  }
}
