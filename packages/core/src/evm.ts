import { workingIndexFor } from './calendar';
import type {
  EvmSnapshot,
  Project,
  ScheduleResult,
  SeriesPoint,
} from './types';

interface EvmResult {
  snapshot: EvmSnapshot;
  series: SeriesPoint[];
}

/**
 * Earned Value Management.
 *
 * PV/EV/AC are spread across each activity's scheduled window so the S-curve
 * is time-phased. Because this MVP has a single data date, the earned and
 * actual curves stop at that date; the planned curve continues to completion.
 */
export function computeEvm(project: Project, schedule: ScheduleResult): EvmResult {
  const days = schedule.projectDurationDays;
  const workingDays = schedule.workingDays;
  const dataIdxRaw = workingIndexFor(workingDays, project.dataDate);
  const dataIdx = Math.max(0, Math.min(dataIdxRaw, days - 1));

  const plannedCum = new Array<number>(days).fill(0);
  const earnedCum = new Array<number>(days).fill(0);
  const actualCum = new Array<number>(days).fill(0);

  const activityById = new Map(project.activities.map((a) => [a.id, a]));

  for (const scheduled of schedule.activities) {
    const activity = activityById.get(scheduled.id);
    if (!activity) continue;

    const duration = Math.max(1, scheduled.durationDays);
    const from = Math.max(0, scheduled.startIndex);
    const to = Math.min(days - 1, scheduled.finishIndex);

    // Planned value: spread the full budget evenly across the scheduled window
    const perDayPlanned = activity.budgetCost / duration;
    for (let i = from; i <= to; i += 1) {
      plannedCum[i] += perDayPlanned;
    }

    // Earned value: spread the earned amount across elapsed work up to data date
    const earnedEnd = Math.min(to, dataIdx);
    if (earnedEnd >= from && activity.percentComplete > 0) {
      const span = earnedEnd - from + 1;
      const perDayEarned = (activity.budgetCost * activity.percentComplete) / span;
      for (let i = from; i <= earnedEnd; i += 1) {
        earnedCum[i] += perDayEarned;
      }
    }

    // Actual cost: spread actual cost across elapsed work up to data date
    const actualEnd = Math.min(to, dataIdx);
    if (actualEnd >= from && activity.actualCost > 0) {
      const span = actualEnd - from + 1;
      const perDayActual = activity.actualCost / span;
      for (let i = from; i <= actualEnd; i += 1) {
        actualCum[i] += perDayActual;
      }
    }
  }

  // Running cumulative totals
  let pvRun = 0;
  let evRun = 0;
  let acRun = 0;
  for (let i = 0; i < days; i += 1) {
    pvRun += plannedCum[i];
    plannedCum[i] = pvRun;
    evRun += earnedCum[i];
    earnedCum[i] = evRun;
    acRun += actualCum[i];
    actualCum[i] = acRun;
  }

  const bac = project.activities.reduce((sum, a) => sum + a.budgetCost, 0);
  const pv = plannedCum[dataIdx] ?? 0;
  const ev = earnedCum[dataIdx] ?? 0;
  const ac = actualCum[dataIdx] ?? 0;

  const spi = pv > 0 ? ev / pv : 0;
  const cpi = ac > 0 ? ev / ac : 0;
  const eac = cpi > 0 ? ac + (bac - ev) / cpi : bac;
  const etc = Math.max(0, eac - ac);
  const vac = bac - eac;

  const snapshot: EvmSnapshot = {
    bac,
    pv,
    ev,
    ac,
    sv: ev - pv,
    cv: ev - ac,
    spi,
    cpi,
    eac,
    etc,
    vac,
    percentComplete: bac > 0 ? ev / bac : 0,
    plannedPercent: bac > 0 ? pv / bac : 0,
  };

  // Sample the curve roughly weekly (every 5 working days) plus key dates
  const series: SeriesPoint[] = [];
  const step = 5;
  for (let i = 0; i < days; i += step) {
    series.push({
      index: i,
      date: workingDays[i],
      pv: Math.round(plannedCum[i]),
      ev: Math.round(earnedCum[i]),
      ac: Math.round(actualCum[i]),
    });
  }
  const last = days - 1;
  if (series.length === 0 || series[series.length - 1].index !== last) {
    series.push({
      index: last,
      date: workingDays[last],
      pv: Math.round(plannedCum[last]),
      ev: Math.round(earnedCum[last]),
      ac: Math.round(actualCum[last]),
    });
  }

  return { snapshot, series };
}

export function computeEvmSnapshotOnly(
  project: Project,
  schedule: ScheduleResult,
): EvmSnapshot {
  return computeEvm(project, schedule).snapshot;
}
