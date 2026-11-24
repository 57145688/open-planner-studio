import { buildBimModel } from './bim';
import { computeCostBreakdown } from './cost';
import { computeSchedule } from './cpm';
import { computeEvm } from './evm';
import { buildInsights } from './insights';
import { computeResources } from './resources';
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
  };
}
