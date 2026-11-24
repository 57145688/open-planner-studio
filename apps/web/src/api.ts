import {
  applyAiProposal,
  buildLocalProposals,
  buildRealityCapture,
  computeDashboard,
  crashProject,
  evidenceFromRealityCapture,
  levelResources,
  optimizeTimeCost,
  suggestProgressFromEvidence,
  importMspdi,
  sampleProject,
} from '@apcc/core';
import type {
  AiProposal,
  CrashOption,
  CrashResult,
  DashboardPayload,
  LevelingResult,
  ProgressSuggestionResult,
  Project,
} from '@apcc/core';

export interface LoadResult {
  data: DashboardPayload;
  source: 'api' | 'local';
}

export interface ImportResult extends LoadResult {
  warnings: string[];
}

export interface StoredProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  activityCount: number;
  versions: number;
}

async function responseError(response: Response): Promise<Error> {
  try {
    const payload = (await response.json()) as { error?: string };
    return new Error(payload?.error ?? `HTTP ${response.status}`);
  } catch {
    return new Error(`HTTP ${response.status}`);
  }
}

/**
 * Prefer the API gateway; fall back to in-browser computation so the console
 * always renders even when the API process is not running.
 */
export async function loadDashboard(): Promise<LoadResult> {
  try {
    const response = await fetch('/api/dashboard');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as DashboardPayload;
    if (!data?.schedule || !data?.evm) throw new Error('invalid payload');
    return { data, source: 'api' };
  } catch {
    return { data: computeDashboard(sampleProject()), source: 'local' };
  }
}

/**
 * Import MS Project XML through the API. When the gateway is unreachable,
 * parse and recompute in the browser using the same core package.
 */
export async function importProjectXml(xml: string): Promise<ImportResult> {
  try {
    const response = await fetch('/api/import/mspdi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xml }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as {
      dashboard: DashboardPayload;
      warnings: string[];
    };
    if (!payload?.dashboard?.schedule) throw new Error('invalid payload');
    return { data: payload.dashboard, warnings: payload.warnings ?? [], source: 'api' };
  } catch {
    const { project, warnings } = importMspdi(xml);
    return { data: computeDashboard(project), warnings, source: 'local' };
  }
}

export interface RealityCaseEpochMeta {
  id: string;
  label: string;
  date: string;
  kind: string;
  capture: string;
  sourcePoints: number;
  points: number;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

export interface RealityCaseMeta {
  id: string;
  title: string;
  subtitle: string;
  dataKind: string;
  defaultTolerance: number;
  source: {
    repository: string;
    url: string;
    license: string;
    citation: string;
    doi: string;
    originalFiles: string[];
  };
  processing: {
    tool: string;
    method: string;
    sourcePoints: number;
    points: number;
    outputBytes: number;
    format: string;
    gaussianSplatColors: boolean;
  };
  epochs: RealityCaseEpochMeta[];
  files: { scan: string; model: string; verify3dgs?: string };
  verification?: {
    label: string;
    file: string;
    points: number;
    bytes: number;
    method: string;
    caveat: string;
  };
  boundary: string;
}

/** 真实案例元数据；仅在 API 可用时返回。 */
export async function loadRealityCase(): Promise<RealityCaseMeta> {
  const response = await fetch('/api/reality/case');
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as RealityCaseMeta;
}

/** 拉取案例资产（PLY / IFC）为二进制。 */
export async function fetchRealityAsset(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw await responseError(response);
  return response.arrayBuffer();
}

/** 已保存项目列表，仅 API 可用；失败时抛出，由界面提示。 */
export async function listProjects(): Promise<StoredProjectSummary[]> {
  const response = await fetch('/api/projects');
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as StoredProjectSummary[];
}

/** 把当前工作项目保存为新版本。 */
export async function saveActiveProject(): Promise<StoredProjectSummary> {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw await responseError(response);
  const payload = (await response.json()) as { project: StoredProjectSummary };
  return payload.project;
}

/** 激活已保存项目并返回新的仪表盘数据。 */
export async function activateProject(id: string): Promise<ImportResult> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/activate`, {
    method: 'POST',
  });
  if (!response.ok) throw await responseError(response);
  const payload = (await response.json()) as { dashboard: DashboardPayload };
  if (!payload?.dashboard?.schedule) throw new Error('invalid payload');
  return { data: payload.dashboard, warnings: [], source: 'api' };
}

/** 删除项目。 */
export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw await responseError(response);
}

/**
 * 从仪表盘数据还原项目对象，用于 API 不可用时的本地计算回退。
 * 资源单价与 BOQ 明细不参与优化计算，缺失字段以 0 或空值补齐。
 */
export function dashboardToProject(data: DashboardPayload): Project {
  const wbsIdByName = new Map(data.wbs.map((node) => [node.name, node.id] as const));
  return {
    id: data.project.id,
    name: data.project.name,
    description: data.project.description,
    currency: data.project.currency,
    startDate: data.project.startDate,
    dataDate: data.project.dataDate,
    baselineVersion: data.project.baselineVersion,
    workweek: data.project.workweek ?? [1, 2, 3, 4, 5],
    activities: data.activities,
    resources: data.resources.loads.map((load) => ({
      id: load.resourceId,
      name: load.name,
      type: load.type,
      unit: load.unit,
      capacityPerDay: load.capacityPerDay,
      unitCost: 0,
    })),
    boq: data.cost.boq.map((item) => ({
      id: item.id,
      code: item.code,
      description: item.description,
      unit: item.unit,
      quantity: item.quantity,
      unitRate: item.unitRate,
      wbsId: wbsIdByName.get(item.wbsName) ?? '',
    })),
    wbs: data.wbs,
    risks: data.risks,
  };
}

export interface OptimizerResult<T> {
  result: T;
  source: 'api' | 'local';
}

/** 资源平衡：优先调用优化网关（含 OR-Tools），失败时本地回退。 */
export async function runLeveling(
  data: DashboardPayload,
  maxShiftDays = 30,
): Promise<OptimizerResult<LevelingResult>> {
  try {
    const response = await fetch('/api/optimize/leveling', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxShiftDays }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { result: (await response.json()) as LevelingResult, source: 'api' };
  } catch {
    return {
      result: levelResources(dashboardToProject(data), { maxShiftDays }),
      source: 'local',
    };
  }
}

/** 自定义赶工。 */
export async function runCrash(
  data: DashboardPayload,
  targetDays: number,
  costCapRatio = 0.03,
): Promise<OptimizerResult<CrashOption>> {
  try {
    const response = await fetch('/api/optimize/crash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDays, costCapRatio }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { result: (await response.json()) as CrashOption, source: 'api' };
  } catch {
    return {
      result: crashProject(dashboardToProject(data), targetDays, {
        id: 'crash-local',
        name: `本地赶工 ${targetDays} 天`,
        costCapRatio,
      }),
      source: 'local',
    };
  }
}

/** 三档赶工方案。 */
export async function runCrashPlan(
  data: DashboardPayload,
): Promise<OptimizerResult<CrashResult>> {
  try {
    const response = await fetch('/api/optimize/plan');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { result: (await response.json()) as CrashResult, source: 'api' };
  } catch {
    return { result: optimizeTimeCost(dashboardToProject(data)), source: 'local' };
  }
}

export interface CommitOptimizerResult {
  kind: 'leveling' | 'crash';
  solver: 'local' | 'ortools';
  dashboard: DashboardPayload;
  summary: Record<string, number>;
}

/** 预览确认后把优化结果提交为新版本（仅 API 可用）。 */
export async function commitOptimizer(
  kind: 'leveling' | 'crash',
  params: Record<string, number>,
): Promise<CommitOptimizerResult> {
  const response = await fetch('/api/optimize/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, ...params }),
  });
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as CommitOptimizerResult;
}

export interface AiChatResult {
  provider: 'local' | 'llm';
  model: string | null;
  proposals: AiProposal[];
  source: 'api' | 'local';
}

/** AI 网关对话：优先 API（可接大模型），失败时本地规则引擎。 */
export async function chatWithAi(
  message: string,
  data: DashboardPayload,
): Promise<AiChatResult> {
  try {
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!response.ok) throw await responseError(response);
    const payload = (await response.json()) as {
      provider: 'local' | 'llm';
      model: string | null;
      proposals: AiProposal[];
    };
    return { ...payload, source: 'api' };
  } catch {
    const project = dashboardToProject(data);
    return {
      provider: 'local',
      model: null,
      proposals: buildLocalProposals(message, project),
      source: 'local',
    };
  }
}

export interface AiApplyResult {
  mode: 'preview' | 'commit';
  title: string;
  dashboard: DashboardPayload;
  impact: AiProposal['impact'];
  source: 'api' | 'local';
}

/** 预览或提交 AI 提案；本地模式只能预览。 */
export async function applyProposal(
  proposal: AiProposal,
  mode: 'preview' | 'commit',
  data: DashboardPayload,
): Promise<AiApplyResult> {
  try {
    const response = await fetch(
      `/api/ai/proposals/${encodeURIComponent(proposal.id)}/apply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      },
    );
    if (!response.ok) throw await responseError(response);
    const payload = (await response.json()) as {
      mode: 'preview' | 'commit';
      title: string;
      dashboard: DashboardPayload;
      impact: AiProposal['impact'];
    };
    return { ...payload, source: 'api' };
  } catch (error) {
    if (mode === 'commit') throw error;
    const project = dashboardToProject(data);
    const candidate = applyAiProposal(project, proposal);
    return {
      mode: 'preview',
      title: proposal.title,
      impact: proposal.impact,
      dashboard: computeDashboard(candidate),
      source: 'local',
    };
  }
}

export interface AiStatus {
  provider: 'local' | 'llm';
  model: string | null;
  hint: string;
}

/** 查询 AI 网关配置状态；不可用时返回本地状态。 */
export async function loadAiStatus(): Promise<AiStatus | null> {
  try {
    const response = await fetch('/api/ai/status');
    if (!response.ok) return null;
    return (await response.json()) as AiStatus;
  } catch {
    return null;
  }
}

export interface ProgressSuggestionResponse {
  result: ProgressSuggestionResult;
  source: 'api' | 'local';
}

/** 加载活动进度建议与证据缺口；API 不可用时用本地合成证据计算。 */
export async function loadProgressSuggestions(
  data: DashboardPayload,
): Promise<ProgressSuggestionResponse> {
  try {
    const response = await fetch('/api/progress/suggestions');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      result: (await response.json()) as ProgressSuggestionResult,
      source: 'api',
    };
  } catch {
    const model = data.bim;
    const capture = buildRealityCapture(model, data.activities);
    const result = suggestProgressFromEvidence(
      dashboardToProject(data),
      model,
      evidenceFromRealityCapture(capture.evidence),
      { source: 'simulated', ignoredElementTypes: ['IfcBuildingElementProxy'] },
    );
    return { result, source: 'local' };
  }
}

export interface CommitProgressResult {
  mode: 'preview' | 'commit';
  applied: string[];
  skipped: string[];
  totals: ProgressSuggestionResult['totals'];
  dashboard: DashboardPayload;
}

/** 预览或提交选中的进度建议（仅 API 可用）。 */
export async function commitProgressSuggestions(
  mode: 'preview' | 'commit',
  activityIds: string[],
): Promise<CommitProgressResult> {
  const response = await fetch('/api/progress/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, activityIds }),
  });
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as CommitProgressResult;
}
