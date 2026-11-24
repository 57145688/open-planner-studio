import { computeSchedule } from './cpm';
import { computeEvm } from './evm';
import { computeResources } from './resources';
import type { Activity, Project, ScenarioDef, ScenarioResult } from './types';

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'SC-A',
    name: '情景 A · 关键路径赶工',
    description: '对剩余关键路径活动压缩 25% 工期，人工与机械投入上浮 6%。',
    durationFactor: 0.75,
    costFactor: 1.06,
    resourceFactor: 1.25,
    applyTo: 'critical',
  },
  {
    id: 'SC-B',
    name: '情景 B · 增加班组',
    description: '关键活动增派班组，工期压缩 15%，资源投入上浮 4%。',
    durationFactor: 0.85,
    costFactor: 1.04,
    resourceFactor: 1.3,
    applyTo: 'critical',
  },
  {
    id: 'SC-C',
    name: '情景 C · 工序穿插',
    description: '对全部未完成活动优化工序搭接，缩短 10% 工期，几乎不增加成本。',
    durationFactor: 0.9,
    costFactor: 1.0,
    resourceFactor: 1.0,
    applyTo: 'all',
  },
];

function cloneProject(project: Project): Project {
  return structuredClone(project);
}

export function simulateScenario(
  project: Project,
  scenarioId: string,
): ScenarioResult {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    throw new Error(`未知情景: ${scenarioId}`);
  }

  const baselineSchedule = computeSchedule(project);
  const baselineEvm = computeEvm(project, baselineSchedule).snapshot;
  const baselineResources = computeResources(project, baselineSchedule);
  const criticalIds = new Set(
    baselineSchedule.activities.filter((a) => a.critical).map((a) => a.id),
  );

  const next = cloneProject(project);
  const activities = next.activities as Activity[];
  for (const activity of activities) {
    if (activity.status === 'done') continue;
    const targeted =
      scenario.applyTo === 'all' || criticalIds.has(activity.id);
    if (!targeted) continue;
    if (!activity.isMilestone) {
      activity.durationDays = Math.max(
        1,
        Math.round(activity.durationDays * scenario.durationFactor),
      );
    }
    activity.budgetCost = Math.round(activity.budgetCost * scenario.costFactor);
    activity.resources = activity.resources.map((r) => ({
      ...r,
      unitsPerDay: Number((r.unitsPerDay * scenario.resourceFactor).toFixed(2)),
    }));
    activity.predecessors = activity.predecessors.map((rel) => ({
      ...rel,
      lagDays: Math.round(rel.lagDays * scenario.durationFactor),
    }));
  }

  const schedule = computeSchedule(next);
  const evm = computeEvm(next, schedule).snapshot;
  const resourceResult = computeResources(next, schedule);

  const overloaded = resourceResult.loads.filter((l) => l.overloaded);
  let riskNote = '资源投入处于可控范围。';
  if (overloaded.length > 0) {
    riskNote = `存在资源超配：${overloaded.map((l) => l.name).join('、')}，需复核作业面。`;
  }

  return {
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    durationDays: schedule.projectDurationDays,
    finishDate: schedule.projectFinish,
    bac: evm.bac,
    eac: evm.eac,
    peakLabor: resourceResult.laborPeak,
    peakEquipment: resourceResult.equipmentPeak,
    durationDelta: schedule.projectDurationDays - baselineSchedule.projectDurationDays,
    costDelta: Math.round(evm.eac - baselineEvm.eac),
    riskNote,
  };
}

export function simulateAllScenarios(project: Project): ScenarioResult[] {
  return SCENARIOS.map((s) => simulateScenario(project, s.id));
}
