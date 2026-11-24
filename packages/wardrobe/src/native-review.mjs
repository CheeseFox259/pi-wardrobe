export function nativeReviewSummary(plan, { previous = null, packageAlias = null } = {}) {
  const selectors = plan.resourceSelectors.filter(entry => !packageAlias || entry.package === packageAlias);
  const counts = {};
  for (const entry of selectors) counts[entry.kind] = (counts[entry.kind] || 0) + entry.loaded.length;
  const lines = [previous ? `${previous.declaration.name} ${previous.declaration.version} → ${plan.declaration.version}` : `${plan.declaration.name} ${plan.declaration.version}`,
    `Pi ${plan.declaration.compatibility.pi}`,
    '资源：' + Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join(' · ')];
  lines.push('依赖包：' + plan.installationSurfaces.length);
  for (const surface of plan.installationSurfaces.filter(entry => !packageAlias || entry.alias === packageAlias)) {
    if (surface.scripts?.length) lines.push('安装脚本：' + surface.scripts.join(', '));
  }
  if (previous) {
    const before = new Set(previous.resourceSelectors.flatMap(entry => entry.loaded.map(path => entry.package + '/' + path)));
    const after = new Set(selectors.flatMap(entry => entry.loaded.map(path => entry.package + '/' + path)));
    lines.push(`资源路径变化：新增 ${[...after].filter(path => !before.has(path)).length} · 移除 ${[...before].filter(path => !after.has(path)).length}`);
  }
  if (plan.agent?.files?.length) lines.push('辅助文件：' + plan.agent.files.length);
  if (plan.agent?.deviceBindings?.length) lines.push('设备需求：' + plan.agent.deviceBindings.map(item => item.name + (item.required ? '（必需）' : '（可选）')).join(' · '));
  return lines.join('\n');
}
