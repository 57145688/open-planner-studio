import type { BimElement, BimModel } from './bim';
import type { RealityElementEvidence } from './reality';
import type { Project } from './types';

/**
 * 由实景证据（构件覆盖率）生成活动进度建议与证据缺口。
 *
 * 口径说明：
 * - 建议值 = 按构件表面积加权的覆盖率；覆盖率 ≥ completionCoverage 时按 100% 计，
 *   用于吸收扫描视角遮挡带来的少量缺测。
 * - 覆盖率是「证据强度」，不等同于合同计量或质量验收结论。
 * - 只生成建议，不修改基准；写回需经预览 → 审批 → 提交。
 */

export type ProgressEvidenceSource = 'realcase' | 'simulated';
export type ProgressSuggestionStatus = 'behind' | 'ahead' | 'consistent' | 'unverified';
export type EvidenceGapReason = 'missing' | 'partial' | 'offset';

export interface ProgressEvidenceItem {
  /** 与 BimElement.guid 对齐 */
  elementId: string;
  /** 设计表面被实景点云覆盖的比例，0..1 */
  coverage: number;
  meanDeviation?: number;
  maxDeviation?: number;
}

export interface EvidenceGap {
  elementId: string;
  name: string;
  ifcType: string;
  level: number;
  coverage: number;
  reason: EvidenceGapReason;
  detail: string;
}

export interface ActivityEvidenceSummary {
  elements: number;
  weightedCoverage: number;
  observed: number;
  partial: number;
  insufficient: number;
  meanDeviation: number;
  maxDeviation: number;
}

export interface ActivityProgressSuggestion {
  activityId: string;
  code: string;
  name: string;
  wbsId: string;
  currentPercent: number;
  suggestedPercent: number;
  delta: number;
  status: ProgressSuggestionStatus;
  confidence: 'high' | 'medium' | 'low';
  evidence: ActivityEvidenceSummary;
  gaps: EvidenceGap[];
}

export interface ProgressSuggestionTotals {
  activities: number;
  behind: number;
  ahead: number;
  consistent: number;
  unverified: number;
  gaps: number;
  missing: number;
  partial: number;
  offset: number;
  meanDelta: number;
  meanCoverage: number;
}

export interface ProgressSuggestionResult {
  generatedAt: string;
  dataDate: string;
  source: ProgressEvidenceSource;
  description: string;
  activities: ActivityProgressSuggestion[];
  totals: ProgressSuggestionTotals;
  notes: string[];
}

export interface ProgressSuggestionOptions {
  /** 充分观测阈值，默认 0.6 */
  observedThreshold?: number;
  /** 部分观测阈值，默认 0.25 */
  partialThreshold?: number;
  /** 安装偏差容差（m），默认 0.03 */
  tolerance?: number;
  /** 判定「一致」的进度带，默认 0.05 */
  consistentBand?: number;
  /** 覆盖率按 100% 计的阈值，默认 0.9 */
  completionCoverage?: number;
  /** 忽略的构件类型（如合成场景中缺少详细几何的占位构件）。 */
  ignoredElementTypes?: string[];
  source?: ProgressEvidenceSource;
  description?: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 近似构件表面积，作为活动聚合权重。 */
function elementWeight(element: BimElement): number {
  const { x, y, z } = element.size;
  return Math.max(0.01, 2 * (x * y + y * z + x * z));
}

/** 把实景核验输出的构件证据转换为通用证据项。 */
export function evidenceFromRealityCapture(
  evidence: RealityElementEvidence[],
): ProgressEvidenceItem[] {
  return evidence.map((item) => ({
    elementId: item.elementGuid,
    coverage: item.coverage,
    meanDeviation: item.meanDeviation,
    maxDeviation: item.maxDeviation,
  }));
}

export function suggestProgressFromEvidence(
  project: Project,
  model: BimModel,
  evidence: ProgressEvidenceItem[],
  options: ProgressSuggestionOptions = {},
): ProgressSuggestionResult {
  const observedThreshold = options.observedThreshold ?? 0.6;
  const partialThreshold = options.partialThreshold ?? 0.25;
  const tolerance = options.tolerance ?? 0.03;
  const consistentBand = options.consistentBand ?? 0.05;
  const completionCoverage = options.completionCoverage ?? 0.9;
  const ignoredTypes = new Set(options.ignoredElementTypes ?? []);
  const source = options.source ?? 'realcase';

  const evidenceById = new Map(evidence.map((item) => [item.elementId, item] as const));
  const elementsByActivity = new Map<string, BimElement[]>();
  for (const element of model.elements) {
    if (ignoredTypes.has(element.ifcType)) continue;
    const list = elementsByActivity.get(element.activityId);
    if (list) list.push(element);
    else elementsByActivity.set(element.activityId, [element]);
  }

  const activities: ActivityProgressSuggestion[] = [];
  for (const activity of project.activities) {
    const elements = elementsByActivity.get(activity.id);
    if (!elements || elements.length === 0) continue;

    let weight = 0;
    let coverageWeighted = 0;
    let scoreWeighted = 0;
    let observed = 0;
    let partial = 0;
    let insufficient = 0;
    let deviationSum = 0;
    let deviationMax = 0;
    let deviationCount = 0;
    let hasEvidence = false;
    const gaps: EvidenceGap[] = [];

    for (const element of elements) {
      const item = evidenceById.get(element.guid);
      const coverage = item ? clamp01(item.coverage) : 0;
      if (item) hasEvidence = true;
      const areaWeight = elementWeight(element);
      weight += areaWeight;
      coverageWeighted += areaWeight * coverage;
      scoreWeighted += areaWeight * (coverage >= completionCoverage ? 1 : coverage);

      if (coverage >= observedThreshold) observed += 1;
      else if (coverage >= partialThreshold) partial += 1;
      else insufficient += 1;

      const meanDeviation = item?.meanDeviation ?? 0;
      const maxDeviation = item?.maxDeviation ?? 0;
      if (item) {
        deviationSum += meanDeviation;
        deviationMax = Math.max(deviationMax, maxDeviation);
        deviationCount += 1;
      }

      let reason: EvidenceGapReason | null = null;
      if (coverage < partialThreshold) reason = 'missing';
      else if (maxDeviation > tolerance) reason = 'offset';
      else if (coverage < observedThreshold) reason = 'partial';

      if (reason) {
        const detail =
          reason === 'missing'
            ? '实景点云中未检测到该构件'
            : reason === 'offset'
              ? `实测偏差 ${(maxDeviation * 1000).toFixed(0)} mm 超出 ±${(tolerance * 1000).toFixed(0)} mm`
              : `仅覆盖 ${(coverage * 100).toFixed(0)}%，存在遮挡或未完成`;
        gaps.push({
          elementId: element.guid,
          name: element.name,
          ifcType: element.ifcType,
          level: element.level,
          coverage: round2(coverage),
          reason,
          detail,
        });
      }
    }

    if (weight <= 0) continue;
    const currentPercent = round2(clamp01(activity.percentComplete));
    const suggestedPercent = hasEvidence
      ? round2(clamp01(scoreWeighted / weight))
      : currentPercent;
    const delta = round2(suggestedPercent - currentPercent);
    const status: ProgressSuggestionStatus = !hasEvidence
      ? 'unverified'
      : Math.abs(delta) <= consistentBand
        ? 'consistent'
        : delta < 0
          ? 'behind'
          : 'ahead';

    const confidence: ActivityProgressSuggestion['confidence'] =
      elements.length >= 3 && observed / elements.length >= 0.6
        ? 'high'
        : elements.length >= 2 && observed + partial >= 1
          ? 'medium'
          : 'low';

    activities.push({
      activityId: activity.id,
      code: activity.code,
      name: activity.name,
      wbsId: activity.wbsId,
      currentPercent,
      suggestedPercent,
      delta,
      status,
      confidence,
      evidence: {
        elements: elements.length,
        weightedCoverage: round2(weight > 0 ? coverageWeighted / weight : 0),
        observed,
        partial,
        insufficient,
        meanDeviation: deviationCount > 0 ? deviationSum / deviationCount : 0,
        maxDeviation: deviationMax,
      },
      gaps: gaps.sort(
        (a, b) => a.coverage - b.coverage || a.name.localeCompare(b.name),
      ),
    });
  }

  const order: Record<ProgressSuggestionStatus, number> = {
    behind: 0,
    ahead: 1,
    consistent: 2,
    unverified: 3,
  };
  activities.sort(
    (a, b) => order[a.status] - order[b.status] || a.delta - b.delta || a.code.localeCompare(b.code),
  );

  const totals: ProgressSuggestionTotals = {
    activities: activities.length,
    behind: activities.filter((item) => item.status === 'behind').length,
    ahead: activities.filter((item) => item.status === 'ahead').length,
    consistent: activities.filter((item) => item.status === 'consistent').length,
    unverified: activities.filter((item) => item.status === 'unverified').length,
    gaps: activities.reduce((sum, item) => sum + item.gaps.length, 0),
    missing: activities.reduce(
      (sum, item) => sum + item.gaps.filter((gap) => gap.reason === 'missing').length,
      0,
    ),
    partial: activities.reduce(
      (sum, item) => sum + item.gaps.filter((gap) => gap.reason === 'partial').length,
      0,
    ),
    offset: activities.reduce(
      (sum, item) => sum + item.gaps.filter((gap) => gap.reason === 'offset').length,
      0,
    ),
    meanDelta:
      activities.length > 0
        ? round2(
            activities
              .filter((item) => item.status !== 'unverified')
              .reduce((sum, item) => sum + item.delta, 0) /
              Math.max(
                1,
                activities.filter((item) => item.status !== 'unverified').length,
              ),
          )
        : 0,
    meanCoverage:
      activities.length > 0
        ? round2(
            activities.reduce(
              (sum, item) => sum + item.evidence.weightedCoverage,
              0,
            ) / activities.length,
          )
        : 0,
  };

  const notes = [
    `建议值按构件表面积加权；覆盖率 ≥ ${(completionCoverage * 100).toFixed(0)}% 时按 100% 计，以吸收视角遮挡。`,
    `覆盖率低于 ${(partialThreshold * 100).toFixed(0)}% 判为缺失，${(observedThreshold * 100).toFixed(0)}% 以下判为部分观测。`,
    '覆盖率是证据强度，不等同于合同计量或质量验收；提交前请核对证据缺口。',
  ];
  if (ignoredTypes.size > 0) {
    notes.push(
      `已忽略 ${[...ignoredTypes].join('、')} 等占位构件，相关活动不参与本次识别。`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    dataDate: project.dataDate,
    source,
    description:
      options.description ??
      (source === 'simulated'
        ? '基于 BIM 表面合成的模拟点云（非无人机实采），用于验证进度识别链路。'
        : '基于上传的实景点云与 IFC 模型比对结果。'),
    activities,
    totals,
    notes,
  };
}

export interface ApplyProgressOptions {
  /** 仅应用指定活动；缺省时应用落后与超前且置信度非 low 的活动。 */
  activityIds?: string[];
  includeLowConfidence?: boolean;
}

export interface AppliedProgressResult {
  project: Project;
  applied: string[];
  skipped: string[];
}

/** 将建议写入候选项目（不修改入参），供预览与提交使用。 */
export function applyProgressSuggestions(
  project: Project,
  result: ProgressSuggestionResult,
  options: ApplyProgressOptions = {},
): AppliedProgressResult {
  const candidate = structuredClone(project);
  const selected = new Set(
    options.activityIds ??
      result.activities
        .filter(
          (item) =>
            (item.status === 'behind' || item.status === 'ahead') &&
            (options.includeLowConfidence || item.confidence !== 'low'),
        )
        .map((item) => item.activityId),
  );

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const suggestion of result.activities) {
    if (!selected.has(suggestion.activityId)) continue;
    if (suggestion.status === 'unverified') {
      skipped.push(suggestion.activityId);
      continue;
    }
    const activity = candidate.activities.find((item) => item.id === suggestion.activityId);
    if (!activity) {
      skipped.push(suggestion.activityId);
      continue;
    }
    activity.percentComplete = suggestion.suggestedPercent;
    activity.status =
      suggestion.suggestedPercent >= 1
        ? 'done'
        : suggestion.suggestedPercent > 0
          ? 'inProgress'
          : 'planned';
    applied.push(suggestion.activityId);
  }

  return { project: candidate, applied, skipped };
}
