import { computeDashboard, importMspdi, sampleProject } from '@apcc/core';
import type { DashboardPayload } from '@apcc/core';

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
