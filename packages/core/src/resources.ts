import type { Project, ResourceResult, ScheduleResult } from './types';
import type { ResourceLoad } from './types';

export function computeResources(
  project: Project,
  schedule: ScheduleResult,
): ResourceResult {
  const days = schedule.projectDurationDays;
  const resourceById = new Map(project.resources.map((r) => [r.id, r]));
  const dailyByResource = new Map<string, number[]>();

  for (const resource of project.resources) {
    dailyByResource.set(resource.id, new Array(days).fill(0));
  }

  for (const scheduled of schedule.activities) {
    const activity = project.activities.find((a) => a.id === scheduled.id);
    if (!activity) continue;
    for (const assignment of activity.resources) {
      const daily = dailyByResource.get(assignment.resourceId);
      if (!daily) continue;
      const from = Math.max(0, scheduled.startIndex);
      const to = Math.min(days - 1, scheduled.finishIndex);
      for (let i = from; i <= to; i += 1) {
        daily[i] += assignment.unitsPerDay;
      }
    }
  }

  const loads: ResourceLoad[] = [];
  const laborDaily = new Array(days).fill(0);
  const equipmentDaily = new Array(days).fill(0);

  for (const [resourceId, daily] of dailyByResource) {
    const resource = resourceById.get(resourceId);
    if (!resource) continue;
    const peak = daily.reduce((m, v) => Math.max(m, v), 0);
    const total = daily.reduce((s, v) => s + v, 0);
    const average = days > 0 ? total / days : 0;
    loads.push({
      resourceId,
      name: resource.name,
      type: resource.type,
      unit: resource.unit,
      capacityPerDay: resource.capacityPerDay,
      peak,
      average,
      utilizationPeak: resource.capacityPerDay > 0 ? peak / resource.capacityPerDay : 0,
      daily,
      overloaded: peak > resource.capacityPerDay,
    });
    if (resource.type === 'labor') {
      for (let i = 0; i < days; i += 1) laborDaily[i] += daily[i];
    } else if (resource.type === 'equipment') {
      for (let i = 0; i < days; i += 1) equipmentDaily[i] += daily[i];
    }
  }

  const laborPeak = laborDaily.reduce((m, v) => Math.max(m, v), 0);
  const equipmentPeak = equipmentDaily.reduce((m, v) => Math.max(m, v), 0);

  return { loads, laborDaily, equipmentDaily, laborPeak, equipmentPeak };
}
