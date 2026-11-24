import type { Activity, BoqItem, Project, Relation, Resource, Risk, WbsNode } from './types';

const wbs: WbsNode[] = [
  { id: 'W1', code: '1', name: '前期与土方', parentId: null },
  { id: 'W2', code: '2', name: '基础工程', parentId: null },
  { id: 'W3', code: '3', name: '主体结构', parentId: null },
  { id: 'W4', code: '4', name: '砌体与屋面', parentId: null },
  { id: 'W5', code: '5', name: '机电安装', parentId: null },
  { id: 'W6', code: '6', name: '装饰装修', parentId: null },
  { id: 'W7', code: '7', name: '室外与收尾', parentId: null },
];

const resources: Resource[] = [
  { id: 'R-PU', name: '普工', type: 'labor', unit: '人', capacityPerDay: 60, unitCost: 220 },
  { id: 'R-GJ', name: '钢筋工', type: 'labor', unit: '人', capacityPerDay: 30, unitCost: 380 },
  { id: 'R-MG', name: '木工', type: 'labor', unit: '人', capacityPerDay: 28, unitCost: 400 },
  { id: 'R-HN', name: '混凝土工', type: 'labor', unit: '人', capacityPerDay: 24, unitCost: 380 },
  { id: 'R-QZ', name: '砌筑工', type: 'labor', unit: '人', capacityPerDay: 20, unitCost: 360 },
  { id: 'R-JD', name: '机电安装工', type: 'labor', unit: '人', capacityPerDay: 24, unitCost: 450 },
  { id: 'R-ZX', name: '装修工', type: 'labor', unit: '人', capacityPerDay: 30, unitCost: 400 },
  { id: 'R-WJ', name: '挖掘机', type: 'equipment', unit: '台', capacityPerDay: 3, unitCost: 1800 },
  { id: 'R-TD', name: '塔吊', type: 'equipment', unit: '台', capacityPerDay: 1, unitCost: 2200 },
  { id: 'R-BC', name: '混凝土泵车', type: 'equipment', unit: '台', capacityPerDay: 1, unitCost: 2600 },
  { id: 'R-HNT', name: '商品混凝土', type: 'material', unit: 'm³', capacityPerDay: 200, unitCost: 480 },
];

interface ActivitySeed {
  id: string;
  code: string;
  name: string;
  wbsId: string;
  durationDays: number;
  predecessors: Relation[];
  resources: { resourceId: string; unitsPerDay: number }[];
  budgetCost: number;
  progress: number;
  actualFactor: number;
  ifcGuids?: string[];
  isMilestone?: boolean;
}

function guid(seed: number): string {
  const base = `2O2Fr$t4X7Zf8NOew3FL${seed.toString(36).toUpperCase().padStart(4, '0')}`;
  return base.slice(0, 22);
}

function toActivity(seed: ActivitySeed): Activity {
  const percentComplete = Math.max(0, Math.min(1, seed.progress));
  const status = percentComplete >= 1 ? 'done' : percentComplete > 0 ? 'inProgress' : 'planned';
  return {
    id: seed.id,
    code: seed.code,
    name: seed.name,
    wbsId: seed.wbsId,
    durationDays: seed.durationDays,
    predecessors: seed.predecessors,
    resources: seed.resources,
    budgetCost: seed.budgetCost,
    percentComplete,
    actualCost: Math.round(seed.budgetCost * percentComplete * seed.actualFactor),
    status,
    ifcGuids: seed.ifcGuids ?? [guid(seed.code.length + seed.durationDays)],
    isMilestone: seed.isMilestone ?? false,
  };
}

function buildSeeds(): ActivitySeed[] {
  const seeds: ActivitySeed[] = [
    {
      id: 'A01', code: '1.1', name: '施工准备与场地平整', wbsId: 'W1',
      durationDays: 4, predecessors: [],
      resources: [{ resourceId: 'R-PU', unitsPerDay: 10 }],
      budgetCost: 20000, progress: 1, actualFactor: 1.0,
    },
    {
      id: 'A02', code: '1.2', name: '土方开挖', wbsId: 'W1',
      durationDays: 7, predecessors: [{ activityId: 'A01', type: 'FS', lagDays: 0 }],
      resources: [{ resourceId: 'R-PU', unitsPerDay: 8 }, { resourceId: 'R-WJ', unitsPerDay: 2 }],
      budgetCost: 90000, progress: 1, actualFactor: 1.03,
    },
    {
      id: 'A03', code: '1.3', name: '垫层与基础防水', wbsId: 'W2',
      durationDays: 5, predecessors: [{ activityId: 'A02', type: 'FS', lagDays: 0 }],
      resources: [
        { resourceId: 'R-PU', unitsPerDay: 12 },
        { resourceId: 'R-HN', unitsPerDay: 6 },
        { resourceId: 'R-HNT', unitsPerDay: 25 },
      ],
      budgetCost: 70000, progress: 1, actualFactor: 1.02,
    },
    {
      id: 'A04', code: '2.1', name: '基础钢筋绑扎', wbsId: 'W2',
      durationDays: 7, predecessors: [{ activityId: 'A03', type: 'FS', lagDays: 0 }],
      resources: [{ resourceId: 'R-GJ', unitsPerDay: 24 }],
      budgetCost: 160000, progress: 1, actualFactor: 1.05,
    },
    {
      id: 'A05', code: '2.2', name: '基础模板安装', wbsId: 'W2',
      durationDays: 5, predecessors: [{ activityId: 'A04', type: 'FS', lagDays: 0 }],
      resources: [{ resourceId: 'R-MG', unitsPerDay: 20 }],
      budgetCost: 90000, progress: 1, actualFactor: 1.04,
    },
    {
      id: 'A06', code: '2.3', name: '基础混凝土浇筑', wbsId: 'W2',
      durationDays: 3, predecessors: [{ activityId: 'A05', type: 'FS', lagDays: 0 }],
      resources: [
        { resourceId: 'R-HN', unitsPerDay: 18 },
        { resourceId: 'R-BC', unitsPerDay: 1 },
        { resourceId: 'R-HNT', unitsPerDay: 60 },
      ],
      budgetCost: 150000, progress: 1, actualFactor: 1.06,
    },
    {
      id: 'A07', code: '2.4', name: '基础回填', wbsId: 'W2',
      durationDays: 4, predecessors: [{ activityId: 'A06', type: 'FS', lagDays: 0 }],
      resources: [{ resourceId: 'R-PU', unitsPerDay: 14 }, { resourceId: 'R-WJ', unitsPerDay: 1 }],
      budgetCost: 40000, progress: 1, actualFactor: 1.02,
    },
  ];

  let previousFloorConcrete = 'A07';
  for (let level = 1; level <= 6; level += 1) {
    const rebarId = `F${level}-R`;
    const concreteId = `F${level}-C`;
    seeds.push({
      id: rebarId,
      code: `3.${level}.1`,
      name: `${level}F 柱墙梁板钢筋与模板`,
      wbsId: 'W3',
      durationDays: 6,
      predecessors: [{ activityId: previousFloorConcrete, type: 'FS', lagDays: 0 }],
      resources: [
        { resourceId: 'R-GJ', unitsPerDay: 16 },
        { resourceId: 'R-MG', unitsPerDay: 14 },
        { resourceId: 'R-TD', unitsPerDay: 1 },
      ],
      budgetCost: 180000,
      progress: level <= 5 ? 1 : level === 6 ? 0.4 : 0,
      actualFactor: 1.07,
    });
    seeds.push({
      id: concreteId,
      code: `3.${level}.2`,
      name: `${level}F 楼板混凝土浇筑`,
      wbsId: 'W3',
      durationDays: 3,
      predecessors: [{ activityId: rebarId, type: 'FS', lagDays: 0 }],
      resources: [
        { resourceId: 'R-HN', unitsPerDay: 12 },
        { resourceId: 'R-BC', unitsPerDay: 1 },
        { resourceId: 'R-HNT', unitsPerDay: 55 },
        { resourceId: 'R-TD', unitsPerDay: 1 },
      ],
      budgetCost: 120000,
      progress: level <= 4 ? 1 : level === 5 ? 0.8 : 0,
      actualFactor: 1.08,
    });
    previousFloorConcrete = concreteId;
  }

  seeds.push(
    {
      id: 'A20', code: '4.1', name: '砌体工程', wbsId: 'W4',
      durationDays: 12,
      predecessors: [{ activityId: 'F3-C', type: 'SS', lagDays: 3 }],
      resources: [{ resourceId: 'R-QZ', unitsPerDay: 12 }, { resourceId: 'R-TD', unitsPerDay: 1 }],
      budgetCost: 260000, progress: 0.6, actualFactor: 1.05,
    },
    {
      id: 'A21', code: '4.2', name: '屋面工程', wbsId: 'W4',
      durationDays: 8,
      predecessors: [{ activityId: 'F6-C', type: 'FS', lagDays: 0 }],
      resources: [{ resourceId: 'R-PU', unitsPerDay: 10 }],
      budgetCost: 180000, progress: 0, actualFactor: 1.0,
    },
    {
      id: 'A22', code: '5.1', name: '机电预留预埋与管道', wbsId: 'W5',
      durationDays: 18,
      predecessors: [{ activityId: 'F2-C', type: 'SS', lagDays: 2 }],
      resources: [{ resourceId: 'R-JD', unitsPerDay: 11 }],
      budgetCost: 420000, progress: 0.85, actualFactor: 1.06,
    },
    {
      id: 'A23', code: '5.2', name: '电气与暖通安装', wbsId: 'W5',
      durationDays: 16,
      predecessors: [{ activityId: 'A22', type: 'SS', lagDays: 10 }],
      resources: [{ resourceId: 'R-JD', unitsPerDay: 14 }],
      budgetCost: 380000, progress: 0.35, actualFactor: 1.02,
    },
    {
      id: 'A24', code: '6.1', name: '室内抹灰', wbsId: 'W6',
      durationDays: 12,
      predecessors: [{ activityId: 'A20', type: 'SS', lagDays: 6 }],
      resources: [{ resourceId: 'R-ZX', unitsPerDay: 12 }],
      budgetCost: 240000, progress: 0.2, actualFactor: 1.02,
    },
    {
      id: 'A25', code: '6.2', name: '门窗安装', wbsId: 'W6',
      durationDays: 8,
      predecessors: [{ activityId: 'A24', type: 'SS', lagDays: 4 }],
      resources: [{ resourceId: 'R-ZX', unitsPerDay: 8 }],
      budgetCost: 200000, progress: 0.1, actualFactor: 1.01,
    },
    {
      id: 'A26', code: '6.3', name: '精装修', wbsId: 'W6',
      durationDays: 14,
      predecessors: [{ activityId: 'A25', type: 'SS', lagDays: 4 }],
      resources: [{ resourceId: 'R-ZX', unitsPerDay: 16 }],
      budgetCost: 480000, progress: 0, actualFactor: 1.0,
    },
    {
      id: 'A27', code: '7.1', name: '室外工程', wbsId: 'W7',
      durationDays: 10,
      predecessors: [{ activityId: 'A21', type: 'SS', lagDays: 5 }],
      resources: [{ resourceId: 'R-PU', unitsPerDay: 10 }, { resourceId: 'R-WJ', unitsPerDay: 1 }],
      budgetCost: 220000, progress: 0, actualFactor: 1.0,
    },
    {
      id: 'A28', code: '7.2', name: '系统调试', wbsId: 'W7',
      durationDays: 6,
      predecessors: [
        { activityId: 'A23', type: 'FS', lagDays: 0 },
        { activityId: 'A26', type: 'FS', lagDays: 0 },
      ],
      resources: [{ resourceId: 'R-JD', unitsPerDay: 10 }],
      budgetCost: 90000, progress: 0, actualFactor: 1.0,
    },
    {
      id: 'A29', code: '7.3', name: '竣工验收', wbsId: 'W7',
      durationDays: 0, isMilestone: true,
      predecessors: [
        { activityId: 'A28', type: 'FS', lagDays: 0 },
        { activityId: 'A27', type: 'FS', lagDays: 0 },
      ],
      resources: [],
      budgetCost: 50000, progress: 0, actualFactor: 1.0,
    },
  );

  return seeds;
}

const boq: BoqItem[] = [
  { id: 'B01', code: '010101', description: '土方开挖', unit: 'm³', quantity: 8600, unitRate: 12, wbsId: 'W1' },
  { id: 'B02', code: '010501', description: '基础混凝土 C35', unit: 'm³', quantity: 1200, unitRate: 520, wbsId: 'W2' },
  { id: 'B03', code: '010515', description: '基础钢筋', unit: 't', quantity: 168, unitRate: 5600, wbsId: 'W2' },
  { id: 'B04', code: '010502', description: '主体结构混凝土 C30', unit: 'm³', quantity: 3600, unitRate: 500, wbsId: 'W3' },
  { id: 'B05', code: '010516', description: '主体结构钢筋', unit: 't', quantity: 540, unitRate: 5450, wbsId: 'W3' },
  { id: 'B06', code: '010401', description: '砌体工程', unit: 'm³', quantity: 1450, unitRate: 380, wbsId: 'W4' },
  { id: 'B07', code: '010901', description: '屋面防水', unit: 'm²', quantity: 2800, unitRate: 95, wbsId: 'W4' },
  { id: 'B08', code: '030404', description: '电气配管配线', unit: 'm', quantity: 18600, unitRate: 28, wbsId: 'W5' },
  { id: 'B09', code: '031001', description: '给排水管道', unit: 'm', quantity: 6400, unitRate: 86, wbsId: 'W5' },
  { id: 'B10', code: '011101', description: '室内抹灰', unit: 'm²', quantity: 22000, unitRate: 36, wbsId: 'W6' },
  { id: 'B11', code: '010801', description: '门窗安装', unit: 'm²', quantity: 3100, unitRate: 620, wbsId: 'W6' },
  { id: 'B12', code: '050101', description: '室外道路与绿化', unit: 'm²', quantity: 4200, unitRate: 180, wbsId: 'W7' },
];

const risks: Risk[] = [
  {
    id: 'RK1', title: '主体结构进度落后约 18 天', severity: 'high', probability: 0.75,
    impactDays: 18, impactCost: 320000, activityId: 'F3-C',
    mitigation: '对 4F 以上结构增加钢筋工班组，并采用分区流水施工。',
  },
  {
    id: 'RK2', title: '塔吊资源在结构与砌体交叉期超配', severity: 'high', probability: 0.6,
    impactDays: 6, impactCost: 90000, activityId: 'A20',
    mitigation: '错峰安排塔吊，或临时增加 1 台汽车吊承担砌体垂直运输。',
  },
  {
    id: 'RK3', title: '混凝土供应能力不足', severity: 'medium', probability: 0.4,
    impactDays: 4, impactCost: 80000, activityId: 'F4-C',
    mitigation: '锁定两家搅拌站，并设置每日供应上限与备用泵车。',
  },
  {
    id: 'RK4', title: '机电预埋与结构穿插冲突', severity: 'medium', probability: 0.35,
    impactDays: 6, impactCost: 120000, activityId: 'A22',
    mitigation: '提前完成机电深化设计，按楼层移交作业面。',
  },
  {
    id: 'RK5', title: '雨季影响回填与室外工程', severity: 'medium', probability: 0.3,
    impactDays: 5, impactCost: 60000, activityId: 'A07',
    mitigation: '关注天气窗口，准备排水与覆盖措施。',
  },
  {
    id: 'RK6', title: '装修材料价格波动', severity: 'low', probability: 0.25,
    impactDays: 0, impactCost: 150000, activityId: 'A26',
    mitigation: '对主要材料提前锁价并签订框架采购协议。',
  },
];

export function sampleProject(): Project {
  const activities = buildSeeds().map(toActivity);
  return {
    id: 'PRJ-DEMO-6F',
    name: '六层办公楼样板工程',
    description:
      '钢筋混凝土框架结构办公楼，用于验证 BIM—进度—成本—EVM—现场核验的完整数据闭环。全部数据为演示用模拟数据。',
    currency: 'CNY',
    startDate: '2026-03-02',
    dataDate: '2026-06-15',
    baselineVersion: 'BL-2026-03-02',
    workweek: [1, 2, 3, 4, 5],
    activities,
    resources,
    boq,
    wbs,
    risks,
  };
}
