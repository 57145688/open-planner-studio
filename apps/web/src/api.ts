import { computeDashboard, importMspdi, sampleProject } from '@apcc/core';
import type { DashboardPayload } from '@apcc/core';

export interface LoadResult {
  data: DashboardPayload;
  source: 'api' | 'local';
}

export interface ImportResult extends LoadResult {
  warnings: string[];
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
