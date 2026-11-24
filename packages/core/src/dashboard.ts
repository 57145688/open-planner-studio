import { buildBimModel } from './bim';
import { computeCostBreakdown } from './cost';
import { computeSchedule } from './cpm';
import { computeEvm } from './evm';
import { buildInsights } from './insights';
import { computeResources } from './resources';
import { summarizeReality } from './reality';
import { simulateAllScenarios } from './scenarios';
import type { DashboardPayload, FloorStatus, Project } from './types';

function computeFloors(project: Project): FloorStatus[] {
  const floors: FloorStatus[] = [];
  for (let level = 1; level <= 6; level += 1) {
    const prefix = `3.${level}.`;
    const items = project.activities.filter((a) => a.code.startsWith(prefix));
    const total = items.reduce((sum, a) => sum + a.budgetCost, 0);
    const earned = items.reduce((sum, a) => sum + a.budgetCost * a.percentComplete, 0);
    const percent = total > 0 ? earned / total : 0;
    floors.push({
      level,
      label: `${level}F`,
      percent,
      status: percent >= 0.999 ? 'done' : percent > 0 ? 'active' : 'planned',
    });
  }
  return floors;
}

export function computeDashboard(project: Project): DashboardPayload {
  const schedule = computeSchedule(project);
  const { snapshot, series } = computeEvm(project, schedule);
  const resources = computeResources(project, schedule);
  const insights = buildInsights(project, schedule, snapshot, resources);
  const bim = buildBimModel(project);
  const cost = computeCostBreakdown(project, schedule, snapshot);
  const reality = summarizeReality(bim, project.activities);
  if (reality.missingElements > 0 || reality.overThreshold > 0) {
    insights.unshift({
      id: 'reality-check',
      level: 'warning',
      title: `实景核验：发现 ${reality.missingElements} 个构件缺失`,
      detail: `模拟点云覆盖 ${(reality.coverage * 100).toFixed(1)}%，平均偏差 ${(reality.meanDeviation * 1000).toFixed(0)} mm，最大 ${(reality.maxDeviation * 1000).toFixed(0)} mm，${reality.overThreshold} 个点超出 ${(reality.tolerance * 1000).toFixed(0)} mm 容差。`,
      action: '在「模拟实景核验」面板查看缺失与偏移构件，确认后生成整改任务。',
    });
  }
  const activities = project.activities.map((activity) => ({
    ...activity,
    ifcGuids: bim.activityGuids[activity.id] ?? activity.ifcGuids,
  }));

  return {
    generatedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      currency: project.currency,
      startDate: project.startDate,
      dataDate: project.dataDate,
      baselineVersion: project.baselineVersion,
    },
    schedule,
    evm: snapshot,
    series,
    resources,
    risks: project.risks,
    floors: computeFloors(project),
    insights,
    scenarios: simulateAllScenarios(project),
    wbs: project.wbs,
    activities,
    bim,
    cost,
    reality,
  };
}
