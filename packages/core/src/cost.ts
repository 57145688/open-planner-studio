import { workingIndexFor } from './calendar';
import type {
  BoqItem,
  EvmSnapshot,
  Project,
  ScheduleResult,
  WbsNode,
} from './types';

/**
 * 5D 成本执行：BOQ → WBS → 活动 → 实际成本 的联动视图，以及基于 EVM 的完工预测。
 */

export interface CostActivityLink {
  activityId: string;
  code: string;
  name: string;
  amount: number;
}

export interface BoqLine {
  id: string;
  code: string;
  description: string;
  unit: string;
  quantity: number;
  unitRate: number;
  amount: number;
  wbsId: string;
  wbsName: string;
  allocatedBudget: number;
  allocations: CostActivityLink[];
}

export interface WbsCostLine {
  wbsId: string;
  code: string;
  name: string;
  activityCount: number;
  budget: number;
  earned: number;
  actual: number;
  variance: number;
  percent: number;
  boqValue: number;
  boqDelta: number;
}

export interface CostForecast {
  method: 'cpi' | 'composite' | 'plan';
  name: string;
  eac: number;
  etc: number;
  vac: number;
  note: string;
}

export interface CostBreakdown {
  currency: string;
  bac: number;
  ev: number;
  ac: number;
  cv: number;
  cpi: number;
  boqTotal: number;
  budgetGap: number;
  lines: WbsCostLine[];
  boq: BoqLine[];
  forecasts: CostForecast[];
  finish: {
    dataDate: string;
    plannedFinish: string;
    forecastFinish: string;
    delayDays: number;
    spi: number;
  };
}

function amountOf(item: BoqItem): number {
  return item.quantity * item.unitRate;
}

function descendants(nodes: WbsNode[], rootId: string): string[] {
  const ids = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const node of nodes) {
      if (node.parentId === current) {
        ids.push(node.id);
        queue.push(node.id);
      }
    }
  }
  return ids;
}

export function computeCostBreakdown(
  project: Project,
  schedule: ScheduleResult,
  snapshot: EvmSnapshot,
): CostBreakdown {
  const roots = project.wbs.filter((node) => node.parentId === null);
  const lines: WbsCostLine[] = [];
  const scheduledById = new Map(schedule.activities.map((row) => [row.id, row]));
  const dataIdx = Math.max(
    0,
    Math.min(workingIndexFor(schedule.workingDays, project.dataDate), schedule.projectDurationDays - 1),
  );
  /** 与 EVM 一致：活动在数据日期已开工才计入已完价值与实际成本。 */
  const started = (activityId: string): boolean => {
    const row = scheduledById.get(activityId);
    return !row || Math.max(0, row.startIndex) <= dataIdx;
  };

  for (const root of roots) {
    const ids = descendants(project.wbs, root.id);
    const idSet = new Set(ids);
    const activities = project.activities.filter((activity) => idSet.has(activity.wbsId));
    const items = project.boq.filter((item) => idSet.has(item.wbsId));
    const budget = activities.reduce((sum, activity) => sum + activity.budgetCost, 0);
    const earned = activities
      .filter((activity) => started(activity.id))
      .reduce((sum, activity) => sum + activity.budgetCost * activity.percentComplete, 0);
    const actual = activities
      .filter((activity) => started(activity.id))
      .reduce((sum, activity) => sum + activity.actualCost, 0);
    const boqValue = items.reduce((sum, item) => sum + amountOf(item), 0);
    lines.push({
      wbsId: root.id,
      code: root.code,
      name: root.name,
      activityCount: activities.length,
      budget,
      earned,
      actual,
      variance: earned - actual,
      percent: budget > 0 ? earned / budget : 0,
      boqValue,
      boqDelta: budget - boqValue,
    });
  }

  const boq: BoqLine[] = project.boq.map((item) => {
    const wbs = project.wbs.find((node) => node.id === item.wbsId);
    const activities = project.activities.filter(
      (activity) => activity.wbsId === item.wbsId,
    );
    const { budgetSum, boqSum } = amountsForWbs(project, item.wbsId);
    const amount = amountOf(item);
    const allocations: CostActivityLink[] = activities
      .map((activity) => ({
        activityId: activity.id,
        code: activity.code,
        name: activity.name,
        amount:
          budgetSum > 0 ? Math.round((amount * activity.budgetCost) / budgetSum) : 0,
      }))
      .sort((a, b) => b.amount - a.amount);
    const allocatedBudget = boqSum > 0 ? Math.round((budgetSum * amount) / boqSum) : 0;
    return {
      id: item.id,
      code: item.code,
      description: item.description,
      unit: item.unit,
      quantity: item.quantity,
      unitRate: item.unitRate,
      amount,
      wbsId: item.wbsId,
      wbsName: wbs?.name ?? item.wbsId,
      allocatedBudget,
      allocations,
    };
  });

  const bac = snapshot.bac;
  const ev = snapshot.ev;
  const ac = snapshot.ac;
  const cpi = snapshot.cpi > 0 ? snapshot.cpi : 1;
  const spi = snapshot.spi > 0 ? snapshot.spi : 1;
  const remaining = Math.max(0, bac - ev);

  const eacCpi = bac / cpi;
  const eacComposite = ac + remaining / Math.max(0.05, cpi * spi);
  const eacPlan = ac + remaining;

  const forecasts: CostForecast[] = [
    {
      method: 'cpi',
      name: 'CPI 趋势外推',
      eac: eacCpi,
      etc: Math.max(0, eacCpi - ac),
      vac: bac - eacCpi,
      note: '假设剩余工作按当前成本效率（CPI）继续执行。',
    },
    {
      method: 'composite',
      name: '成本 × 进度综合',
      eac: eacComposite,
      etc: Math.max(0, eacComposite - ac),
      vac: bac - eacComposite,
      note: '同时考虑成本与进度偏差，适用于当前趋势延续。',
    },
    {
      method: 'plan',
      name: '剩余按计划单价',
      eac: eacPlan,
      etc: Math.max(0, eacPlan - ac),
      vac: bac - eacPlan,
      note: '假设剩余工作完全按预算单价完成，仅反映已发生超支。',
    },
  ];

  const total = schedule.projectDurationDays;
  const remainingDays = Math.max(0, total - 1 - dataIdx);
  const projectedIndex = Math.min(
    schedule.workingDays.length - 1,
    Math.round(dataIdx + remainingDays / Math.max(0.2, spi)),
  );

  const boqTotal = boq.reduce((sum, line) => sum + line.amount, 0);

  return {
    currency: project.currency,
    bac,
    ev,
    ac,
    cv: ev - ac,
    cpi,
    boqTotal,
    budgetGap: bac - boqTotal,
    lines,
    boq,
    forecasts,
    finish: {
      dataDate: project.dataDate,
      plannedFinish: schedule.projectFinish,
      forecastFinish: schedule.workingDays[projectedIndex] ?? schedule.projectFinish,
      delayDays: projectedIndex - (total - 1),
      spi,
    },
  };
}

/** WBS 内活动预算与 BOQ 金额汇总，供分摊计算使用。 */
function amountsForWbs(
  project: Project,
  wbsId: string,
): { budgetSum: number; boqSum: number } {
  const budgetSum = project.activities
    .filter((activity) => activity.wbsId === wbsId)
    .reduce((sum, activity) => sum + activity.budgetCost, 0);
  const boqSum = project.boq
    .filter((item) => item.wbsId === wbsId)
    .reduce((sum, item) => sum + amountOf(item), 0);
  return { budgetSum, boqSum };
}
