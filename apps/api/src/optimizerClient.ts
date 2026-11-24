import { computeSchedule, crashRateOf, type Project } from '@apcc/core';

/**
 * OR-Tools 求解服务客户端。服务不可用时返回 null，由路由回退到本地 TS 求解器。
 */

const DEFAULT_URL = 'http://127.0.0.1:8010';

function optimizerUrl(): string {
  return (process.env.APCC_OPTIMIZER_URL?.trim() || DEFAULT_URL).replace(/\/$/, '');
}

function enabled(): boolean {
  return process.env.APCC_OPTIMIZER_DISABLED !== '1';
}

export interface RemoteLeveling {
  status: string;
  starts: Record<string, number>;
  makespan: number;
  solveSeconds: number;
}

export interface RemoteCrash {
  status: string;
  cuts: Record<string, number>;
  addedCost: number;
  makespan: number;
  solveSeconds: number;
}

async function request<T>(path: string, body: unknown, timeoutMs = 4500): Promise<T | null> {
  try {
    const response = await fetch(`${optimizerUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** 探测服务是否在线（1 秒超时）。 */
export async function optimizerAvailable(): Promise<boolean> {
  if (!enabled()) return false;
  try {
    const response = await fetch(`${optimizerUrl()}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function capacitiesOf(project: Project): Record<string, number> {
  const capacities: Record<string, number> = {};
  for (const resource of project.resources) {
    if (resource.type === 'material' || resource.capacityPerDay <= 0) continue;
    capacities[resource.id] = resource.capacityPerDay;
  }
  return capacities;
}

function activitiesOf(project: Project, mode: 'leveling' | 'crash', maxCutRatio = 0.4) {
  const schedule = computeSchedule(project);
  return project.activities.map((activity) => ({
    id: activity.id,
    duration: activity.isMilestone ? 0 : activity.durationDays,
    earliestStart: schedule.byId[activity.id]?.startIndex ?? 0,
    resources: activity.resources.map((assignment) => ({
      resourceId: assignment.resourceId,
      units: assignment.unitsPerDay,
    })),
    predecessors: activity.predecessors.map((relation) => ({
      activityId: relation.activityId,
      type: relation.type,
      lag: relation.lagDays,
    })),
    rate: crashRateOf(activity),
    maxCut:
      mode === 'crash' && !activity.isMilestone && activity.status !== 'done'
        ? Math.max(0, Math.floor(activity.durationDays * maxCutRatio))
        : 0,
  }));
}

/** 请求 OR-Tools 做资源平衡；失败返回 null。 */
export async function requestLeveling(
  project: Project,
  maxShiftDays: number,
): Promise<RemoteLeveling | null> {
  if (!enabled()) return null;
  const schedule = computeSchedule(project);
  const result = await request<RemoteLeveling>('/v1/leveling', {
    activities: activitiesOf(project, 'leveling'),
    capacities: capacitiesOf(project),
    maxShiftDays,
    horizon: schedule.projectDurationDays + maxShiftDays + 120,
    timeLimitSeconds: 4,
  });
  if (!result || (result.status !== 'OPTIMAL' && result.status !== 'FEASIBLE')) return null;
  return result;
}

/** 请求 OR-Tools 做工期-成本权衡；失败返回 null。 */
export async function requestCrash(
  project: Project,
  targetDays: number,
  costCapRatio: number,
  maxCutRatio: number,
): Promise<RemoteCrash | null> {
  if (!enabled()) return null;
  const schedule = computeSchedule(project);
  const bac = project.activities.reduce((sum, activity) => sum + activity.budgetCost, 0);
  const result = await request<RemoteCrash>('/v1/crash', {
    activities: activitiesOf(project, 'crash', maxCutRatio),
    capacities: capacitiesOf(project),
    targetDays,
    costCap: Math.round(bac * costCapRatio),
    horizon: schedule.projectDurationDays + 60,
    timeLimitSeconds: 4,
  });
  if (!result || (result.status !== 'OPTIMAL' && result.status !== 'FEASIBLE')) return null;
  return result;
}
