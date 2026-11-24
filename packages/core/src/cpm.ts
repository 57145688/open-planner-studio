import { buildWorkingCalendar } from './calendar';
import type {
  Activity,
  Project,
  Relation,
  ScheduleResult,
  ScheduledActivity,
} from './types';

interface Edge extends Relation {
  /** successor activity id */
  activityId: string;
}

function durationOf(activity: Activity): number {
  return activity.isMilestone ? 0 : Math.max(0, activity.durationDays);
}

/**
 * Critical Path Method with FS / SS / FF / SF relations and lag.
 * Uses a simplified working-day calendar (no holidays) and 7-day or 5-day workweek.
 */
export function computeSchedule(project: Project): ScheduleResult {
  const activities = project.activities;
  const byId = new Map(activities.map((a) => [a.id, a]));
  const successors = new Map<string, Edge[]>();
  const indegree = new Map<string, number>();

  for (const a of activities) {
    successors.set(a.id, []);
    indegree.set(a.id, 0);
  }

  for (const a of activities) {
    for (const rel of a.predecessors) {
      if (!byId.has(rel.activityId)) continue;
      successors.get(rel.activityId)!.push({
        activityId: a.id,
        type: rel.type,
        lagDays: rel.lagDays,
      });
      indegree.set(a.id, (indegree.get(a.id) ?? 0) + 1);
    }
  }

  // Kahn topological sort
  const queue: string[] = [];
  for (const a of activities) {
    if ((indegree.get(a.id) ?? 0) === 0) queue.push(a.id);
  }
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const edge of successors.get(id) ?? []) {
      const remaining = (indegree.get(edge.activityId) ?? 0) - 1;
      indegree.set(edge.activityId, remaining);
      if (remaining === 0) queue.push(edge.activityId);
    }
  }

  const warnings: string[] = [];
  if (order.length !== activities.length) {
    warnings.push('检测到循环逻辑关系，部分活动无法参与排程计算。');
  }

  const es = new Map<string, number>();
  const ef = new Map<string, number>();

  for (const id of order) {
    const activity = byId.get(id)!;
    const duration = durationOf(activity);
    let start = Math.max(0, activity.notEarlierThan ?? 0);
    for (const rel of activity.predecessors) {
      const pEs = es.get(rel.activityId);
      const pEf = ef.get(rel.activityId);
      if (pEs === undefined || pEf === undefined) continue;
      let candidate = 0;
      switch (rel.type) {
        case 'FS':
          candidate = pEf + 1 + rel.lagDays;
          break;
        case 'SS':
          candidate = pEs + rel.lagDays;
          break;
        case 'FF':
          candidate = pEf + rel.lagDays - duration + 1;
          break;
        case 'SF':
          candidate = pEs + rel.lagDays - duration + 1;
          break;
      }
      start = Math.max(start, candidate);
    }
    start = Math.max(0, start);
    es.set(id, start);
    ef.set(id, duration === 0 ? start : start + duration - 1);
  }

  const finish = Math.max(0, ...Array.from(ef.values()));

  const ls = new Map<string, number>();
  const lf = new Map<string, number>();

  for (const id of [...order].reverse()) {
    const activity = byId.get(id)!;
    const duration = durationOf(activity);
    const edges = successors.get(id) ?? [];
    let lateFinish: number;
    if (edges.length === 0) {
      lateFinish = finish;
    } else {
      lateFinish = Number.POSITIVE_INFINITY;
      for (const edge of edges) {
        const sLs = ls.get(edge.activityId);
        const sLf = lf.get(edge.activityId);
        if (sLs === undefined || sLf === undefined) continue;
        let candidate: number;
        switch (edge.type) {
          case 'FS':
            candidate = sLs - 1 - edge.lagDays;
            break;
          case 'SS':
            candidate = sLs - edge.lagDays + duration - 1;
            break;
          case 'FF':
            candidate = sLf - edge.lagDays;
            break;
          case 'SF':
            candidate = sLf - edge.lagDays + duration - 1;
            break;
        }
        lateFinish = Math.min(lateFinish, candidate);
      }
      if (!Number.isFinite(lateFinish)) lateFinish = finish;
    }
    lf.set(id, lateFinish);
    ls.set(id, duration === 0 ? lateFinish : lateFinish - duration + 1);
  }

  const calendarLength = Math.max(
    finish + 2,
    activities.reduce((sum, a) => sum + durationOf(a), 0) + 14,
  );
  const workingDays = buildWorkingCalendar(
    project.startDate,
    project.workweek,
    calendarLength,
  );

  const scheduled: ScheduledActivity[] = activities.map((activity) => {
    const start = es.get(activity.id) ?? 0;
    const end = ef.get(activity.id) ?? start;
    const lateStart = ls.get(activity.id) ?? start;
    const totalFloat = lateStart - start;

    let freeFloat = finish - end;
    for (const edge of successors.get(activity.id) ?? []) {
      const sEs = es.get(edge.activityId);
      const sEf = ef.get(edge.activityId);
      if (sEs === undefined || sEf === undefined) continue;
      let value: number;
      switch (edge.type) {
        case 'FS':
          value = sEs - (end + 1 + edge.lagDays);
          break;
        case 'SS':
          value = sEs - (start + edge.lagDays);
          break;
        case 'FF':
          value = sEf - (end + edge.lagDays);
          break;
        case 'SF':
          value = sEf - (start + edge.lagDays);
          break;
      }
      freeFloat = Math.min(freeFloat, value);
    }

    const critical = totalFloat <= 0;
    return {
      id: activity.id,
      code: activity.code,
      name: activity.name,
      wbsId: activity.wbsId,
      startIndex: start,
      finishIndex: end,
      startDate: workingDays[Math.min(start, workingDays.length - 1)],
      finishDate: workingDays[Math.min(end, workingDays.length - 1)],
      durationDays: durationOf(activity),
      totalFloat,
      freeFloat: Math.max(0, freeFloat),
      critical,
      nearCritical: !critical && totalFloat <= 2,
      percentComplete: activity.percentComplete,
      budgetCost: activity.budgetCost,
    };
  });

  const byIdResult: Record<string, ScheduledActivity> = {};
  for (const item of scheduled) byIdResult[item.id] = item;

  const criticalPath = scheduled
    .filter((a) => a.critical)
    .sort((a, b) => a.startIndex - b.startIndex || b.durationDays - a.durationDays)
    .map((a) => a.code);

  return {
    activities: scheduled,
    byId: byIdResult,
    workingDays,
    projectStart: workingDays[0],
    projectFinish: workingDays[Math.min(finish, workingDays.length - 1)],
    projectDurationDays: finish + 1,
    criticalPath,
    warnings,
  };
}
