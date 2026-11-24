import type { BimElement, BimModel } from './bim';
import type { Activity } from './types';

/**
 * 模拟实景核验：从 BIM 构件表面采样生成“现场点云”，按实际完成比例截断，
 * 注入构件缺失、安装偏移与材料堆场等受控偏差，再用体素占用做覆盖率与偏差核验。
 *
 * 注意：这是合成数据，不是无人机或激光扫描的真实采集结果；后续接入真实点云时，
 * 只需替换采样来源，核验指标与界面的数据结构保持不变。
 */

export interface RealityPoint {
  /** 与 BIM 一致：x 向右、y 向前、z 向上，单位 m */
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  /** 到设计表面的距离，单位 m */
  deviation: number;
  extra: boolean;
  elementGuid: string | null;
}

export type RealityIssueType = 'missing' | 'offset' | 'extra';

export interface RealityIssue {
  type: RealityIssueType;
  elementGuid: string | null;
  elementName: string;
  activityCode: string;
  activityId: string;
  detail: string;
  deviation: number;
}

export interface RealityLevelStat {
  level: number;
  label: string;
  expected: number;
  observed: number;
  matched: number;
}

export interface RealitySummary {
  simulated: true;
  generatedAt: string;
  totalPoints: number;
  extraPoints: number;
  matchedPoints: number;
  coverage: number;
  meanDeviation: number;
  maxDeviation: number;
  tolerance: number;
  overThreshold: number;
  expectedElements: number;
  observedElements: number;
  missingElements: number;
  levels: RealityLevelStat[];
  issues: RealityIssue[];
  note: string;
}

export interface RealityCapture {
  summary: RealitySummary;
  points: RealityPoint[];
}

interface RealityOptions {
  seed?: number;
  /** 每个构件的基准采样点数 */
  density?: number;
}

const VOXEL = 0.25;
const TOLERANCE = 0.03;

const TYPE_RGB: Record<BimElement['ifcType'], [number, number, number]> = {
  IfcSlab: [154, 165, 177],
  IfcColumn: [184, 193, 204],
  IfcBeam: [170, 180, 192],
  IfcFooting: [141, 153, 174],
  IfcWall: [203, 213, 225],
  IfcWindow: [103, 232, 249],
  IfcDoor: [180, 83, 9],
  IfcRoof: [148, 163, 184],
  IfcBuildingElementProxy: [251, 146, 60],
};

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function isVertical(element: BimElement): boolean {
  if (
    element.ifcType === 'IfcColumn' ||
    element.ifcType === 'IfcWall' ||
    element.ifcType === 'IfcWindow' ||
    element.ifcType === 'IfcDoor'
  ) {
    return true;
  }
  const { x, y, z } = element.size;
  return z > Math.min(x, y) * 1.2;
}

/** 在盒体表面采样，返回设计表面上的点。 */
function sampleSurface(
  element: BimElement,
  random: () => number,
  progress: number,
): { x: number; y: number; z: number } | null {
  const { size, position } = element;
  const vertical = isVertical(element);
  const minZ = position.z - size.z / 2;
  const maxZ = vertical
    ? minZ + size.z * Math.min(1, Math.max(0, progress))
    : position.z + size.z / 2;

  const areas = [
    size.y * size.z, // +x
    size.y * size.z, // -x
    size.x * size.z, // +y
    size.x * size.z, // -y
    size.x * size.y, // +z
    size.x * size.y, // -z
  ];
  const total = areas.reduce((sum, area) => sum + area, 0);
  let pick = random() * total;
  let face = 0;
  while (face < 5 && pick > areas[face]) {
    pick -= areas[face];
    face += 1;
  }
  const u = random();
  const v = random();
  let point: { x: number; y: number; z: number };
  if (face === 0) point = { x: position.x + size.x / 2, y: position.y - size.y / 2 + u * size.y, z: minZ + v * size.z };
  else if (face === 1) point = { x: position.x - size.x / 2, y: position.y - size.y / 2 + u * size.y, z: minZ + v * size.z };
  else if (face === 2) point = { x: position.x - size.x / 2 + u * size.x, y: position.y + size.y / 2, z: minZ + v * size.z };
  else if (face === 3) point = { x: position.x - size.x / 2 + u * size.x, y: position.y - size.y / 2, z: minZ + v * size.z };
  else if (face === 4) point = { x: position.x - size.x / 2 + u * size.x, y: position.y - size.y / 2 + v * size.y, z: position.z + size.z / 2 };
  else point = { x: position.x - size.x / 2 + u * size.x, y: position.y - size.y / 2 + v * size.y, z: minZ };
  if (point.z > maxZ + 1e-6) return null;
  return point;
}

function voxelKey(x: number, y: number, z: number): string {
  return `${Math.floor(x / VOXEL)},${Math.floor(y / VOXEL)},${Math.floor(z / VOXEL)}`;
}

function isNear(set: Set<string>, x: number, y: number, z: number): boolean {
  const bx = Math.floor(x / VOXEL);
  const by = Math.floor(y / VOXEL);
  const bz = Math.floor(z / VOXEL);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        if (set.has(`${bx + dx},${by + dy},${bz + dz}`)) return true;
      }
    }
  }
  return false;
}

export function buildRealityCapture(
  model: BimModel,
  activities: Activity[],
  options: RealityOptions = {},
): RealityCapture {
  const density = Math.max(30, Math.round(options.density ?? 150));
  const random = mulberry32(options.seed ?? 20260615);
  const activityById = new Map(activities.map((activity) => [activity.id, activity]));
  const progressOf = (element: BimElement): number => {
    const activity = activityById.get(element.activityId);
    return activity ? Math.max(0, Math.min(1, activity.percentComplete)) : 1;
  };

  const expected = model.elements.filter((element) => progressOf(element) > 0);
  const expectedGuids = new Set(expected.map((element) => element.guid));

  // 选定注入缺失的构件：优先已完成的结构构件
  const missingCandidates = expected
    .filter(
      (element) =>
        progressOf(element) >= 0.9 &&
        (element.ifcType === 'IfcColumn' ||
          element.ifcType === 'IfcBeam' ||
          element.ifcType === 'IfcWindow'),
    )
    .sort((a, b) => hashString(a.guid) - hashString(b.guid));
  const missing = new Set(missingCandidates.slice(0, 3).map((element) => element.guid));

  // 安装偏移：按 GUID 哈希选约 14%，另指定一个 12cm 的大偏差柱
  const offsets = new Map<string, { x: number; y: number; z: number }>();
  for (const element of expected) {
    const hash = hashString(element.guid);
    if (hash % 100 >= 14) continue;
    const magnitude = 0.02 + random() * 0.05;
    const angle = random() * Math.PI * 2;
    offsets.set(element.guid, {
      x: Math.cos(angle) * magnitude,
      y: Math.sin(angle) * magnitude,
      z: (random() - 0.5) * 0.012,
    });
  }
  const forced = expected
    .filter((element) => element.ifcType === 'IfcColumn' && element.level === 4)
    .sort((a, b) => hashString(a.guid) - hashString(b.guid))[0];
  if (forced) offsets.set(forced.guid, { x: 0.12, y: 0.03, z: 0 });

  // BIM 设计表面体素，用于覆盖率判定；与实际完成比例无关
  const designVoxels = new Set<string>();
  for (const element of model.elements) {
    for (let index = 0; index < 90; index += 1) {
      const point = sampleSurface(element, random, 1);
      if (point) designVoxels.add(voxelKey(point.x, point.y, point.z));
    }
  }

  const points: RealityPoint[] = [];
  const elementStats = new Map<
    string,
    { deviation: number; count: number; matched: number }
  >();
  const levelStats = new Map<number, { expected: number; observed: number; matched: number }>();
  for (const level of model.levels) {
    levelStats.set(level.level, { expected: 0, observed: 0, matched: 0 });
  }

  for (const element of expected) {
    const stats = levelStats.get(element.level);
    if (stats) stats.expected += 1;
    if (missing.has(element.guid)) continue;

    const progress = progressOf(element);
    const offset = offsets.get(element.guid);
    const rgb = TYPE_RGB[element.ifcType];
    let count = 0;
    let matchedCount = 0;
    let deviationSum = 0;

    for (let attempt = 0; attempt < density * 3 && count < density; attempt += 1) {
      const base = sampleSurface(element, random, progress);
      if (!base) continue;
      const noise = () => (random() - 0.5) * 0.012;
      const x = base.x + (offset?.x ?? 0) + noise();
      const y = base.y + (offset?.y ?? 0) + noise();
      const z = base.z + (offset?.z ?? 0) + noise();
      const deviation = Math.hypot(x - base.x, y - base.y, z - base.z);
      const matched = isNear(designVoxels, x, y, z);
      points.push({
        x,
        y,
        z,
        r: Math.max(0, Math.min(255, Math.round(rgb[0] + (random() - 0.5) * 18))),
        g: Math.max(0, Math.min(255, Math.round(rgb[1] + (random() - 0.5) * 18))),
        b: Math.max(0, Math.min(255, Math.round(rgb[2] + (random() - 0.5) * 18))),
        deviation,
        extra: false,
        elementGuid: element.guid,
      });
      count += 1;
      if (matched) matchedCount += 1;
      deviationSum += deviation;
    }

    if (count > 0) {
      elementStats.set(element.guid, {
        deviation: deviationSum / count,
        count,
        matched: matchedCount,
      });
      if (stats) {
        stats.observed += 1;
        if (matchedCount > 0) stats.matched += 1;
      }
    }
  }

  // 材料堆场 / 脚手架：不属于模型的多余点
  const extraCount = 90;
  const baseX = model.footprint.width * 0.15;
  const baseY = -3.2;
  for (let index = 0; index < extraCount; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = random() * 1.6;
    points.push({
      x: baseX + Math.cos(angle) * radius,
      y: baseY + Math.sin(angle) * radius,
      z: random() * 1.3,
      r: 122 + Math.round(random() * 20),
      g: 113 + Math.round(random() * 20),
      b: 104 + Math.round(random() * 20),
      deviation: 0.5,
      extra: true,
      elementGuid: null,
    });
  }

  const realPoints = points.filter((point) => !point.extra);
  const matchedPoints = realPoints.filter((point) => isNear(designVoxels, point.x, point.y, point.z)).length;
  const deviations = realPoints.map((point) => point.deviation);
  const meanDeviation =
    deviations.length > 0 ? deviations.reduce((sum, value) => sum + value, 0) / deviations.length : 0;
  const maxDeviation = deviations.length > 0 ? Math.max(...deviations) : 0;

  const issues: RealityIssue[] = [];
  for (const element of missingCandidates.slice(0, 3)) {
    const activity = activityById.get(element.activityId);
    issues.push({
      type: 'missing',
      elementGuid: element.guid,
      elementName: element.name,
      activityId: element.activityId,
      activityCode: activity?.code ?? '—',
      detail: '实景点云中未检测到该构件，计划显示已完成',
      deviation: 0,
    });
  }
  const offsetIssues = [...elementStats.entries()]
    .filter(([, stats]) => stats.deviation > 0.045)
    .sort((a, b) => b[1].deviation - a[1].deviation)
    .slice(0, 6)
    .map(([guid, stats]) => {
      const element = model.byGuid[guid];
      const activity = activityById.get(element.activityId);
      return {
        type: 'offset' as const,
        elementGuid: guid,
        elementName: element.name,
        activityId: element.activityId,
        activityCode: activity?.code ?? '—',
        detail: `实测表面相对设计平均偏移 ${(stats.deviation * 1000).toFixed(0)} mm`,
        deviation: stats.deviation,
      };
    });
  issues.push(...offsetIssues);
  issues.push({
    type: 'extra',
    elementGuid: null,
    elementName: '材料堆场 / 临时设施',
    activityId: '',
    activityCode: '—',
    detail: `检测到 ${extraCount} 个不属于当前模型的点，疑似堆场或脚手架`,
    deviation: 0.5,
  });

  const observedElements = expected.length - missing.size;
  const levels: RealityLevelStat[] = model.levels.map((level) => {
    const stats = levelStats.get(level.level) ?? { expected: 0, observed: 0, matched: 0 };
    return { level: level.level, label: level.label, ...stats };
  });

  const summary: RealitySummary = {
    simulated: true,
    generatedAt: new Date().toISOString(),
    totalPoints: realPoints.length,
    extraPoints: extraCount,
    matchedPoints,
    coverage: realPoints.length > 0 ? matchedPoints / realPoints.length : 0,
    meanDeviation,
    maxDeviation,
    tolerance: TOLERANCE,
    overThreshold: deviations.filter((value) => value > TOLERANCE).length,
    expectedElements: expected.length,
    observedElements,
    missingElements: missing.size,
    levels,
    issues,
    note: `按实际完成比例合成，构件缺失 ${missing.size} 个；设计表面体素 ${VOXEL * 1000} mm，容差 ${TOLERANCE * 1000} mm。`,
  };

  return { summary, points };
}

/** 仅生成核验摘要，供仪表盘载荷使用，避免传输完整点云。 */
export function summarizeReality(
  model: BimModel,
  activities: Activity[],
  options: RealityOptions = {},
): RealitySummary {
  return buildRealityCapture(model, activities, options).summary;
}
