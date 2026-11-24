import { Router } from 'express';
import {
  applyCrashCuts,
  applyLevelingSolution,
  computeDashboard,
  crashProject,
  levelResources,
  optimizeTimeCost,
  type CrashOption,
  type LevelingResult,
  type Project,
} from '@apcc/core';
import { optimizerAvailable, requestCrash, requestLeveling } from './optimizerClient';

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clampRatio(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0.005, Math.min(0.1, num));
}

async function runLeveling(project: Project, maxShiftDays: number): Promise<LevelingResult> {
  const remote = await requestLeveling(project, maxShiftDays);
  if (remote) {
    return applyLevelingSolution(project, remote.starts, {
      maxShiftDays,
      solver: 'ortools',
      notes: [
        `OR-Tools CP-SAT 求解状态 ${remote.status}，用时 ${remote.solveSeconds}s，最优工期 ${remote.makespan} 个工作日。`,
      ],
    });
  }
  return levelResources(project, { maxShiftDays });
}

async function runCrash(
  project: Project,
  targetDays: number,
  costCapRatio: number,
  maxCutRatio: number,
): Promise<CrashOption> {
  const remote = await requestCrash(project, targetDays, costCapRatio, maxCutRatio);
  if (remote) {
    const bac = project.activities.reduce((sum, activity) => sum + activity.budgetCost, 0);
    return applyCrashCuts(project, remote.cuts, {
      id: 'crash-ortools',
      name: `OR-Tools 赶工 ${targetDays} 天`,
      description: `CP-SAT 在成本上限 ${Math.round(bac * costCapRatio).toLocaleString('zh-CN')} 元内求得的压缩方案。`,
      targetDays,
      costCap: Math.round(bac * costCapRatio),
      costCapRatio,
      maxCutRatio,
      solver: 'ortools',
    });
  }
  return crashProject(project, targetDays, {
    id: 'crash-local',
    name: `本地赶工 ${targetDays} 天`,
    description: '本地贪心求解：按单位赶工成本从低到高压缩关键路径。',
    costCapRatio,
    maxCutRatio,
  });
}

export function createOptimizerRouter(
  getProject: () => Project,
  commitProject: (project: Project) => void,
): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const remote = await optimizerAvailable();
    res.json({
      ok: true,
      remote,
      solver: remote ? 'ortools' : 'local',
      hint: remote
        ? 'OR-Tools 求解服务在线。'
        : '未连接 OR-Tools 服务，将使用本地确定性求解器（npm run optimizer 可启动服务）。',
    });
  });

  router.get('/plan', (_req, res) => {
    res.json(optimizeTimeCost(getProject()));
  });

  router.post('/leveling', async (req, res) => {
    const maxShiftDays = clampInt(req.body?.maxShiftDays, 1, 60, 30);
    res.json(await runLeveling(getProject(), maxShiftDays));
  });

  router.post('/crash', async (req, res) => {
    const targetDays = clampInt(req.body?.targetDays, 1, 60, 8);
    const costCapRatio = clampRatio(req.body?.costCapRatio, 0.03);
    const maxCutRatio = clampRatio(req.body?.maxCutRatio, 0.4);
    res.json(await runCrash(getProject(), targetDays, costCapRatio, maxCutRatio));
  });

  /** 预览通过后提交为新版本（预览与提交共用同一个确定性计算）。 */
  router.post('/commit', async (req, res) => {
    const project = getProject();
    const kind = req.body?.kind;
    if (kind === 'leveling') {
      const maxShiftDays = clampInt(req.body?.maxShiftDays, 1, 60, 30);
      const result = await runLeveling(project, maxShiftDays);
      commitProject(result.project);
      res.json({
        kind,
        solver: result.solver,
        dashboard: computeDashboard(result.project),
        summary: {
          delayDays: result.delayDays,
          baselineOverloaded: result.baseline.overloadedResources,
          leveledOverloaded: result.leveled.overloadedResources,
          moves: result.moves.length,
        },
      });
      return;
    }
    if (kind === 'crash') {
      const targetDays = clampInt(req.body?.targetDays, 1, 60, 8);
      const costCapRatio = clampRatio(req.body?.costCapRatio, 0.03);
      const maxCutRatio = clampRatio(req.body?.maxCutRatio, 0.4);
      const option = await runCrash(project, targetDays, costCapRatio, maxCutRatio);
      commitProject(option.project);
      res.json({
        kind,
        solver: option.solver,
        dashboard: computeDashboard(option.project),
        summary: {
          achievedDays: option.achievedDays,
          addedCost: option.addedCost,
          durationDays: option.durationDays,
          moves: option.moves.length,
        },
      });
      return;
    }
    res.status(400).json({ error: 'kind 只支持 leveling 或 crash。' });
  });

  return router;
}
