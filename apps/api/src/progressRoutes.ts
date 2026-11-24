import { Router } from 'express';
import {
  applyProgressSuggestions,
  buildBimModel,
  buildRealityCapture,
  computeDashboard,
  evidenceFromRealityCapture,
  suggestProgressFromEvidence,
  type ProgressSuggestionResult,
  type Project,
} from '@apcc/core';

/**
 * 进度识别：用构件级实景证据生成活动进度建议与证据缺口。
 * 当前证据来源为合成点云（演示），真实点云可复用同一套建议与审批接口。
 */
function buildSuggestions(project: Project): ProgressSuggestionResult {
  const model = buildBimModel(project);
  const capture = buildRealityCapture(model, project.activities);
  return suggestProgressFromEvidence(
    project,
    model,
    evidenceFromRealityCapture(capture.evidence),
    { source: 'simulated', ignoredElementTypes: ['IfcBuildingElementProxy'] },
  );
}

export function createProgressRouter(
  getProject: () => Project,
  commitProject: (project: Project) => void,
): Router {
  const router = Router();

  router.get('/suggestions', (_req, res) => {
    const project = getProject();
    const model = buildBimModel(project);
    const capture = buildRealityCapture(model, project.activities);
    const result = suggestProgressFromEvidence(
      project,
      model,
      evidenceFromRealityCapture(capture.evidence),
      { source: 'simulated', ignoredElementTypes: ['IfcBuildingElementProxy'] },
    );
    res.json({ ...result, reality: capture.summary });
  });

  /** 预览（mode=preview）或提交（mode=commit）选中的进度建议。 */
  router.post('/commit', (req, res) => {
    const project = getProject();
    const result = buildSuggestions(project);
    const rawIds = req.body?.activityIds;
    const activityIds = Array.isArray(rawIds)
      ? rawIds.filter((id: unknown): id is string => typeof id === 'string')
      : undefined;

    const applied = applyProgressSuggestions(project, result, { activityIds });
    const mode = req.body?.mode === 'commit' ? 'commit' : 'preview';
    if (mode === 'commit') commitProject(applied.project);

    res.json({
      mode,
      applied: applied.applied,
      skipped: applied.skipped,
      totals: result.totals,
      dashboard: computeDashboard(applied.project),
    });
  });

  return router;
}
