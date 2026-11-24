import type { Activity, Project } from '../src/index';

/** 构造最小活动，仅覆盖测试关心的字段。 */
export function makeActivity(
  overrides: Partial<Activity> & { id: string; durationDays: number },
): Activity {
  return {
    code: overrides.id,
    name: overrides.id,
    wbsId: 'W1',
    predecessors: [],
    resources: [],
    budgetCost: 100,
    percentComplete: 0,
    actualCost: 0,
    status: 'planned',
    ifcGuids: [],
    isMilestone: false,
    ...overrides,
  };
}

/** 构造最小项目，默认 5 天工作周，开工日期为周一。 */
export function makeProject(
  activities: Activity[],
  overrides: Partial<Project> = {},
): Project {
  return {
    id: 'TEST-001',
    name: '测试项目',
    description: '单元测试用最小项目',
    currency: 'CNY',
    startDate: '2026-03-02',
    dataDate: '2026-03-02',
    baselineVersion: 'B1',
    workweek: [1, 2, 3, 4, 5],
    activities,
    resources: [],
    boq: [],
    wbs: [{ id: 'W1', code: '1', name: '测试工程', parentId: null }],
    risks: [],
    ...overrides,
  };
}
