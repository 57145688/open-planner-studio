import { computeSchedule } from './cpm';
import { computeEvm } from './evm';
import { computeResources } from './resources';
import type { Activity, Project, ResourceLoad, ScheduleResult } from './types';

/**
 * 阶段 4 的确定性优化内核。
 *
 * 这里的实现是纯 TypeScript 的启发式求解器，用于在没有 Python 环境时本地运行、
 * 也作为 OR-Tools 服务不可用时的回退。所有结果都是候选项目（candidate project），
 * 不直接改写调用方传入的基准数据。
 */

export type SolverKind = 'local' | 'ortools';

export interface LevelingOptions {
  /** 参与平衡的资源 id，缺省为全部非材料资源。 */
  resourceIds?: string[];
  /** 单个活动允许顺延的最大工作日，默认 30。 */
  maxShiftDays?: number;
  /** 结果来源标记，由 API 层根据实际求解器设置。 */
  solver?: SolverKind;
}

export interface LevelingSummary {
  durationDays: number;
  finishDate: string;
  overloadedResources: number;
  overCapacityDays: number;
  laborPeak: number;
  equipmentPeak: number;
}

export interface LevelingMove {
  id: string;
  code: string;
  name: string;
  baselineStartIndex: number;
  leveledStartIndex: number;
  shiftDays: number;
  totalFloat: number;
}

export interface LevelingResult {
  solver: SolverKind;
  baseline: LevelingSummary;
  leveled: LevelingSummary;
  /** 平衡后相对基准的工期增加（工作日），负值表示提前。 */
  delayDays: number;
  moves: LevelingMove[];
  notes: string[];
  /** 平衡后的候选项目，可直接走预览 → 审批 → 提交。 */
  project: Project;
}

export interface CrashOptions {
  /** 允许追加的成本上限占 BAC 的比例，默认 3%。 */
  costCapRatio?: number;
  /** 单个活动最多压缩其原始工期的比例，默认 40%。 */
  maxCutRatio?: number;
  id?: string;
  name?: string;
  description?: string;
  solver?: SolverKind;
}

export interface CrashMove {
  id: string;
  code: string;
  name: string;
  beforeDuration: number;
  afterDuration: number;
  cutDays: number;
  addedCost: number;
}

export interface CrashOption {
  id: string;
  name: string;
  description: string;
  solver: SolverKind;
  /** 计划压缩天数。 */
  targetDays: number;
  /** 实际压缩天数。 */
  achievedDays: number;
  durationDays: number;
  finishDate: string;
  addedCost: number;
  costCap: number;
  costCapRatio: number;
  maxCutRatio: number;
  eac: number;
  moves: CrashMove[];
  riskNote: string;
  project: Project;
}

export interface CrashResult {
  solver: SolverKind;
  baseline: {
    durationDays: number;
    finishDate: string;
    eac: number;
    bac: number;
  };
  options: CrashOption[];
  notes: string[];
}

function cloneProject(project: Project): Project {
  return structuredClone(project);
}

function overCapacityDays(loads: ResourceLoad[]): number {
  let days = 0;
  for (const load of loads) {
    if (load.type === 'material' || load.capacityPerDay <= 0) continue;
    days += load.daily.filter((value) => value > load.capacityPerDay + 1e-9).length;
  }
  return days;
}

function summarize(
  schedule: ScheduleResult,
  loads: ResourceLoad[],
  laborPeak: number,
  equipmentPeak: number,
): LevelingSummary {
  return {
    durationDays: schedule.projectDurationDays,
    finishDate: schedule.projectFinish,
    overloadedResources: loads.filter(
      (load) => load.type !== 'material' && load.overloaded,
    ).length,
    overCapacityDays: overCapacityDays(loads),
    laborPeak,
    equipmentPeak,
  };
}

/**
 * 资源平衡：按最早开始顺序执行串行调度生成（SSGS），在资源容量约束下寻找
 * 最早可行开始日，并把结果写成 `notEarlierThan` 约束，便于重算与审批。
 */
export function levelResources(
  project: Project,
  options: LevelingOptions = {},
): LevelingResult {
  const solver = options.solver ?? 'local';
  const maxShiftDays = options.maxShiftDays ?? 30;
  const baselineSchedule = computeSchedule(project);
  const baselineResources = computeResources(project, baselineSchedule);

  const constrained = new Set(
    options.resourceIds ??
      project.resources
        .filter((resource) => resource.type !== 'material' && resource.capacityPerDay > 0)
        .map((resource) => resource.id),
  );
  const capacities = new Map<string, number>();
  for (const resource of project.resources) {
    if (constrained.has(resource.id)) capacities.set(resource.id, resource.capacityPerDay);
  }

  const horizon =
    baselineSchedule.projectDurationDays + maxShiftDays + 60;
  const loads = new Map<string, number[]>();
  for (const id of capacities.keys()) loads.set(id, new Array(horizon).fill(0));

  const activityById = new Map(project.activities.map((activity) => [activity.id, activity]));
  const order = [...baselineSchedule.activities].sort(
    (a, b) =>
      a.startIndex - b.startIndex ||
      a.totalFloat - b.totalFloat ||
      a.code.localeCompare(b.code),
  );

  const planned = new Map<string, { start: number; finish: number }>();
  const moves: LevelingMove[] = [];
  const notes: string[] = [];

  const fits = (activity: Activity, start: number, duration: number): boolean => {
    if (start + duration > horizon) return false;
    for (let day = start; day < start + duration; day += 1) {
      for (const assignment of activity.resources) {
        const capacity = capacities.get(assignment.resourceId);
        const daily = loads.get(assignment.resourceId);
        if (capacity === undefined || !daily) continue;
        if (daily[day] + assignment.unitsPerDay > capacity + 1e-9) return false;
      }
    }
    return true;
  };

  for (const item of order) {
    const activity = activityById.get(item.id);
    if (!activity) continue;
    const duration = item.durationDays;
    let earliest = 0;
    for (const rel of activity.predecessors) {
      const pred = planned.get(rel.activityId);
      if (!pred) continue;
      let candidate: number;
      switch (rel.type) {
        case 'FS':
          candidate = pred.finish + 1 + rel.lagDays;
          break;
        case 'SS':
          candidate = pred.start + rel.lagDays;
          break;
        case 'FF':
          candidate = pred.finish + rel.lagDays - duration + 1;
          break;
        case 'SF':
          candidate = pred.start + rel.lagDays - duration + 1;
          break;
      }
      earliest = Math.max(earliest, candidate);
    }
    earliest = Math.max(0, earliest);

    let start = earliest;
    if (duration > 0) {
      const limit = earliest + maxShiftDays;
      while (start <= limit && !fits(activity, start, duration)) start += 1;
      if (start > limit) {
        notes.push(
          `${item.code} 在顺延 ${maxShiftDays} 个工作日内仍无法满足资源容量，保持最早开始，需考虑增配资源。`,
        );
        start = earliest;
      }
    }

    const finish = duration === 0 ? start : start + duration - 1;
    planned.set(item.id, { start, finish });

    if (duration > 0) {
      for (let day = start; day <= finish; day += 1) {
        for (const assignment of activity.resources) {
          const daily = loads.get(assignment.resourceId);
          if (daily) daily[day] += assignment.unitsPerDay;
        }
      }
    }

    const shift = start - item.startIndex;
    if (shift > 0) {
      moves.push({
        id: item.id,
        code: item.code,
        name: item.name,
        baselineStartIndex: item.startIndex,
        leveledStartIndex: start,
        shiftDays: shift,
        totalFloat: item.totalFloat,
      });
    }
  }

  const candidate = cloneProject(project);
  for (const activity of candidate.activities) {
    const target = planned.get(activity.id);
    if (target && target.start > 0) activity.notEarlierThan = target.start;
  }

  const leveledSchedule = computeSchedule(candidate);
  const leveledResources = computeResources(candidate, leveledSchedule);

  const baseline = summarize(
    baselineSchedule,
    baselineResources.loads,
    baselineResources.laborPeak,
    baselineResources.equipmentPeak,
  );
  const leveled = summarize(
    leveledSchedule,
    leveledResources.loads,
    leveledResources.laborPeak,
    leveledResources.equipmentPeak,
  );

  if (baseline.overloadedResources === 0) {
    notes.push('基准计划未出现资源超配，无需顺延。');
  } else if (moves.length === 0) {
    notes.push('当前容量下无法通过顺延消除超配，建议增加资源容量或调整施工段划分。');
  } else if (leveled.overloadedResources === 0) {
    notes.push(`已消除全部 ${baseline.overloadedResources} 项资源超配。`);
  } else {
    notes.push(
      `超配资源从 ${baseline.overloadedResources} 项降至 ${leveled.overloadedResources} 项，剩余超配需增配资源。`,
    );
  }

  return {
    solver,
    baseline,
    leveled,
    delayDays: leveled.durationDays - baseline.durationDays,
    moves,
    notes,
    project: candidate,
  };
}

export interface AppliedLevelingOptions {
  maxShiftDays?: number;
  solver?: SolverKind;
  notes?: string[];
}

/**
 * 把外部求解器（OR-Tools）返回的开始日索引写回候选项目，并重算摘要。
 * 开始日会被裁剪到基准工期 + 顺延窗口以内。
 */
export function applyLevelingSolution(
  project: Project,
  starts: Record<string, number>,
  options: AppliedLevelingOptions = {},
): LevelingResult {
  const solver = options.solver ?? 'ortools';
  const maxShiftDays = options.maxShiftDays ?? 30;
  const baselineSchedule = computeSchedule(project);
  const baselineResources = computeResources(project, baselineSchedule);
  const limit = baselineSchedule.projectDurationDays + maxShiftDays;

  const candidate = cloneProject(project);
  const moves: LevelingMove[] = [];
  for (const activity of candidate.activities) {
    const target = starts[activity.id];
    const base = baselineSchedule.byId[activity.id];
    if (target === undefined || !base) continue;
    if (!Number.isFinite(target)) continue;
    const start = Math.max(0, Math.min(Math.round(target), limit));
    if (start > 0) activity.notEarlierThan = start;
    if (start > base.startIndex) {
      moves.push({
        id: base.id,
        code: base.code,
        name: base.name,
        baselineStartIndex: base.startIndex,
        leveledStartIndex: start,
        shiftDays: start - base.startIndex,
        totalFloat: base.totalFloat,
      });
    }
  }

  const schedule = computeSchedule(candidate);
  const levels = computeResources(candidate, schedule);
  const baseline = summarize(
    baselineSchedule,
    baselineResources.loads,
    baselineResources.laborPeak,
    baselineResources.equipmentPeak,
  );
  const leveled = summarize(
    schedule,
    levels.loads,
    levels.laborPeak,
    levels.equipmentPeak,
  );

  const notes = [...(options.notes ?? [])];
  notes.push(
    leveled.overloadedResources === 0
      ? 'OR-Tools 求解结果已消除全部资源超配。'
      : `OR-Tools 求解后仍有 ${leveled.overloadedResources} 项资源超配，受顺延窗口或容量约束。`,
  );

  return {
    solver,
    baseline,
    leveled,
    delayDays: leveled.durationDays - baseline.durationDays,
    moves,
    notes,
    project: candidate,
  };
}

export interface AppliedCrashOptions {
  id: string;
  name: string;
  description: string;
  targetDays: number;
  costCap: number;
  costCapRatio?: number;
  maxCutRatio?: number;
  solver?: SolverKind;
  notes?: string[];
}

/**
 * 把外部求解器（OR-Tools）返回的压缩天数写回候选项目，并重算工期与 EAC。
 */
export function applyCrashCuts(
  project: Project,
  cuts: Record<string, number>,
  options: AppliedCrashOptions,
): CrashOption {
  const solver = options.solver ?? 'ortools';
  const baselineSchedule = computeSchedule(project);
  const candidate = cloneProject(project);
  const moves: CrashMove[] = [];
  let addedCost = 0;

  for (const [id, rawCut] of Object.entries(cuts)) {
    const activity = candidate.activities.find((item) => item.id === id);
    if (!activity || activity.isMilestone || activity.status === 'done') continue;
    const cut = Math.max(0, Math.min(Math.round(rawCut), activity.durationDays - 1));
    if (cut <= 0) continue;
    const rate = crashRateOf(activity);
    const before = activity.durationDays;
    activity.durationDays = before - cut;
    const cost = Math.round(rate * cut);
    activity.budgetCost += cost;
    addedCost += cost;
    moves.push({
      id,
      code: activity.code,
      name: activity.name,
      beforeDuration: before,
      afterDuration: activity.durationDays,
      cutDays: cut,
      addedCost: cost,
    });
  }
  moves.sort((a, b) => b.cutDays - a.cutDays || a.code.localeCompare(b.code));

  const schedule = computeSchedule(candidate);
  const evm = computeEvm(candidate, schedule).snapshot;
  const achieved = Math.max(0, baselineSchedule.projectDurationDays - schedule.projectDurationDays);
  const target = Math.max(0, Math.round(options.targetDays));

  let riskNote = `OR-Tools 已在 ${options.costCap.toLocaleString('zh-CN')} 元成本上限内压缩 ${achieved} 个工作日。`;
  if (achieved === 0) {
    riskNote = 'OR-Tools 未找到可在成本上限内压缩的关键活动，需调整施工方案或增加预算。';
  } else if (achieved < target) {
    riskNote = `计划压缩 ${target} 天，实际完成 ${achieved} 天，受成本上限与关键路径变化约束。`;
  }

  return {
    id: options.id,
    name: options.name,
    description: options.description,
    solver,
    targetDays: target,
    achievedDays: achieved,
    durationDays: schedule.projectDurationDays,
    finishDate: schedule.projectFinish,
    addedCost,
    costCap: options.costCap,
    costCapRatio: options.costCapRatio ?? 0.03,
    maxCutRatio: options.maxCutRatio ?? 0.4,
    eac: evm.eac,
    moves,
    riskNote,
    project: candidate,
  };
}

/** 默认赶工单价：按日均预算的 50% 估算，最低 500 元/天。 */
export function crashRateOf(activity: Activity): number {
  if (activity.crashCostPerDay && activity.crashCostPerDay > 0) {
    return activity.crashCostPerDay;
  }
  const daily = activity.budgetCost / Math.max(1, activity.durationDays);
  return Math.max(500, Math.round(daily * 0.5));
}

/**
 * 工期-成本权衡：在成本上限内逐日压缩关键路径活动，采用「单位赶工成本最低」的
 * 贪心策略。每次压缩后重算关键路径，避免在已失去关键的链上继续投入。
 */
export function crashProject(
  project: Project,
  targetDays: number,
  options: CrashOptions = {},
): CrashOption {
  const solver = options.solver ?? 'local';
  const baselineSchedule = computeSchedule(project);
  const baselineEvm = computeEvm(project, baselineSchedule).snapshot;
  const bac = baselineEvm.bac;
  const costCap = Math.max(0, Math.round(bac * (options.costCapRatio ?? 0.03)));
  const maxCutRatio = options.maxCutRatio ?? 0.4;
  const target = Math.max(0, Math.round(targetDays));

  const candidate = cloneProject(project);
  const originalDuration = new Map(
    project.activities.map((activity) => [activity.id, activity.durationDays] as const),
  );
  const cuts = new Map<string, number>();
  const addedCost = new Map<string, number>();
  const exhausted = new Set<string>();

  let schedule = baselineSchedule;
  let totalCost = 0;
  let achieved = 0;
  let attempts = 0;
  const maxAttempts = Math.max(4, target * 4);

  while (achieved < target && attempts < maxAttempts) {
    attempts += 1;
    const critical = candidate.activities
      .filter((activity) => {
        const sched = schedule.byId[activity.id];
        if (!sched?.critical) return false;
        if (activity.status === 'done' || activity.isMilestone) return false;
        if (activity.durationDays <= 1) return false;
        if (exhausted.has(activity.id)) return false;
        const cut = cuts.get(activity.id) ?? 0;
        return cut < Math.max(1, Math.floor((originalDuration.get(activity.id) ?? 1) * maxCutRatio));
      })
      .sort(
        (a, b) =>
          crashRateOf(a) - crashRateOf(b) ||
          b.durationDays - a.durationDays ||
          a.code.localeCompare(b.code),
      );

    const chosen = critical.find(
      (activity) => totalCost + crashRateOf(activity) <= costCap,
    );
    if (!chosen) break;

    const rate = crashRateOf(chosen);
    chosen.durationDays -= 1;
    chosen.budgetCost += rate;

    const next = computeSchedule(candidate);
    if (next.projectDurationDays >= schedule.projectDurationDays) {
      // 压缩没有缩短总工期（已成为非关键或受其他路径约束），回滚并跳过。
      chosen.durationDays += 1;
      chosen.budgetCost -= rate;
      exhausted.add(chosen.id);
      continue;
    }

    totalCost += rate;
    cuts.set(chosen.id, (cuts.get(chosen.id) ?? 0) + 1);
    addedCost.set(chosen.id, (addedCost.get(chosen.id) ?? 0) + rate);
    schedule = next;
    achieved += 1;
  }

  const finalEvm = computeEvm(candidate, schedule).snapshot;
  const moves: CrashMove[] = [];
  for (const [id, cutDays] of cuts) {
    if (cutDays <= 0) continue;
    const activity = candidate.activities.find((item) => item.id === id);
    const scheduled = schedule.byId[id];
    if (!activity || !scheduled) continue;
    moves.push({
      id,
      code: scheduled.code,
      name: scheduled.name,
      beforeDuration: originalDuration.get(id) ?? activity.durationDays,
      afterDuration: activity.durationDays,
      cutDays,
      addedCost: addedCost.get(id) ?? 0,
    });
  }
  moves.sort((a, b) => b.cutDays - a.cutDays || a.code.localeCompare(b.code));

  let riskNote = `已在 ${costCap.toLocaleString('zh-CN')} 元成本上限内压缩 ${achieved} 个工作日。`;
  if (achieved === 0) {
    riskNote = '未找到可在成本上限内压缩的关键活动，需调整施工方案或增加预算。';
  } else if (achieved < target) {
    riskNote = `计划压缩 ${target} 天，实际完成 ${achieved} 天，受成本上限与关键路径变化约束。`;
  }

  return {
    id: options.id ?? 'crash-custom',
    name: options.name ?? '自定义赶工',
    description:
      options.description ??
      `对关键路径活动逐日压缩，追加成本上限为 BAC 的 ${((options.costCapRatio ?? 0.03) * 100).toFixed(0)}%。`,
    solver,
    targetDays: target,
    achievedDays: achieved,
    durationDays: schedule.projectDurationDays,
    finishDate: schedule.projectFinish,
    addedCost: totalCost,
    costCap,
    costCapRatio: options.costCapRatio ?? 0.03,
    maxCutRatio: options.maxCutRatio ?? 0.4,
    eac: finalEvm.eac,
    moves,
    riskNote,
    project: candidate,
  };
}

/**
 * 生成三档工期-成本方案：最省成本、平衡、最大压缩。
 */
export function optimizeTimeCost(
  project: Project,
  options: { solver?: SolverKind } = {},
): CrashResult {
  const solver = options.solver ?? 'local';
  const baselineSchedule = computeSchedule(project);
  const baselineEvm = computeEvm(project, baselineSchedule).snapshot;
  const duration = baselineSchedule.projectDurationDays;

  const profiles: Array<{
    id: string;
    name: string;
    ratio: number;
    costCapRatio: number;
    maxCutRatio: number;
    description: string;
  }> = [
    {
      id: 'crash-min-cost',
      name: '最省成本',
      ratio: 0.05,
      costCapRatio: 0.01,
      maxCutRatio: 0.2,
      description: '只在单位赶工成本最低的关键活动上投入，追加成本不超过 BAC 的 1%。',
    },
    {
      id: 'crash-balanced',
      name: '平衡方案',
      ratio: 0.1,
      costCapRatio: 0.03,
      maxCutRatio: 0.3,
      description: '压缩约 10% 工期，追加成本不超过 BAC 的 3%，兼顾时间与成本。',
    },
    {
      id: 'crash-max-time',
      name: '最大压缩',
      ratio: 0.2,
      costCapRatio: 0.06,
      maxCutRatio: 0.5,
      description: '以 BAC 的 6% 为上限尽可能压缩工期，用于应对里程碑违约风险。',
    },
  ];

  const optionsResults = profiles.map((profile) =>
    crashProject(project, Math.max(1, Math.ceil(duration * profile.ratio)), {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      costCapRatio: profile.costCapRatio,
      maxCutRatio: profile.maxCutRatio,
      solver,
    }),
  );

  const notes = [
    '赶工单价缺省按活动日均预算的 50% 估算，可在活动数据中通过 crashCostPerDay 覆盖。',
    '压缩按关键路径逐日推进并重算，方案为候选数据，需经审批后写入新版本。',
  ];

  return {
    solver,
    baseline: {
      durationDays: duration,
      finishDate: baselineSchedule.projectFinish,
      eac: baselineEvm.eac,
      bac: baselineEvm.bac,
    },
    options: optionsResults,
    notes,
  };
}
