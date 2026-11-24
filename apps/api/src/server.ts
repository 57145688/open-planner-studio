import cors from 'cors';
import express from 'express';
import {
  SCENARIOS,
  buildBimModel,
  computeCostBreakdown,
  computeDashboard,
  computeEvm,
  computeSchedule,
  exportIfc,
  exportMspdi,
  importMspdi,
  sampleProject,
  simulateScenario,
} from '@apcc/core';
import { ProjectStore } from './store';

const app = express();
app.use(cors());
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));

const store = new ProjectStore(process.env.APCC_DATA_FILE ?? 'data/projects.json');
let activeProject = store.getActive() ?? sampleProject();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'apcc-api', version: '0.1.0' });
});

app.get('/api/project', (_req, res) => {
  res.json(activeProject);
});

/** 已保存项目列表（含版本数与活动数）。 */
app.get('/api/projects', (_req, res) => {
  res.json(store.list());
});

/** 读取指定项目的当前版本。 */
app.get('/api/projects/:id', (req, res) => {
  const project = store.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: `项目 ${req.params.id} 不存在。` });
    return;
  }
  res.json({ project });
});

/** 保存项目（不传 project 时保存当前工作项目），相同 id 视为新版本。 */
app.post('/api/projects', (req, res) => {
  const project = req.body?.project ?? activeProject;
  if (!project?.id || !Array.isArray(project.activities) || !Array.isArray(project.wbs)) {
    res.status(400).json({ error: '项目数据缺少 id、activities 或 wbs。' });
    return;
  }
  activeProject = project;
  const saved = store.save(project);
  res.status(201).json({ project: saved });
});

/** 切换当前工作项目。 */
app.post('/api/projects/:id/activate', (req, res) => {
  const project = store.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: `项目 ${req.params.id} 不存在。` });
    return;
  }
  activeProject = project;
  store.setActive(project.id);
  res.json({ dashboard: computeDashboard(project) });
});

/** 删除项目；若删除的是当前项目，则回退到样例工程。 */
app.delete('/api/projects/:id', (req, res) => {
  const removed = store.remove(req.params.id);
  if (!removed) {
    res.status(404).json({ error: `项目 ${req.params.id} 不存在。` });
    return;
  }
  if (activeProject.id === req.params.id) {
    activeProject = sampleProject();
  }
  res.json({ ok: true });
});

/** 版本历史。 */
app.get('/api/projects/:id/versions', (req, res) => {
  if (!store.get(req.params.id)) {
    res.status(404).json({ error: `项目 ${req.params.id} 不存在。` });
    return;
  }
  res.json(store.versions(req.params.id));
});

/** 恢复历史版本（作为新版本写入）。 */
app.post('/api/projects/:id/restore', (req, res) => {
  const version = Number(req.body?.version);
  if (!Number.isFinite(version)) {
    res.status(400).json({ error: '请求体需提供数字字段 version。' });
    return;
  }
  const restored = store.restore(req.params.id, version);
  if (!restored) {
    res.status(404).json({ error: `项目 ${req.params.id} 的版本 ${version} 不存在。` });
    return;
  }
  if (activeProject.id === req.params.id) {
    activeProject = restored;
  }
  res.json({ project: restored, dashboard: computeDashboard(restored) });
});

app.get('/api/dashboard', (_req, res) => {
  res.json(computeDashboard(activeProject));
});

app.get('/api/scenarios', (_req, res) => {
  res.json(SCENARIOS);
});

app.post('/api/scenarios/:id/simulate', (req, res) => {
  try {
    res.json(simulateScenario(activeProject, req.params.id));
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
});

/** 5D 成本执行：WBS 成本、BOQ 分摊与 EVM 完工预测。 */
app.get('/api/cost', (_req, res) => {
  const schedule = computeSchedule(activeProject);
  const { snapshot } = computeEvm(activeProject, schedule);
  res.json(computeCostBreakdown(activeProject, schedule, snapshot));
});

/** 4D 构件清单：楼层、构件尺寸与位置、活动绑定关系。 */
app.get('/api/bim/model', (_req, res) => {
  res.json(buildBimModel(activeProject));
});

/** 下载当前项目对应的 IFC4 样例模型。 */
app.get('/api/bim/sample.ifc', (_req, res) => {
  const ifc = exportIfc(buildBimModel(activeProject));
  res.setHeader('Content-Type', 'application/x-step; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="model-${activeProject.id}.ifc"`,
  );
  res.send(ifc);
});

/** 导出当前项目为 MS Project XML（MSPDI）。 */
app.get('/api/export/mspdi', (_req, res) => {
  const xml = exportMspdi(activeProject);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="project-${activeProject.id}.xml"`,
  );
  res.send(xml);
});

/** 导入 MS Project XML，成功后替换当前项目并返回新的仪表盘数据。 */
app.post('/api/import/mspdi', (req, res) => {
  const xml = typeof req.body === 'string' ? req.body : req.body?.xml;
  if (typeof xml !== 'string' || xml.trim() === '') {
    res.status(400).json({ error: '请求体需提供 XML 文本（JSON 字段 xml 或 application/xml 原始内容）。' });
    return;
  }
  try {
    const { project, warnings } = importMspdi(xml);
    activeProject = project;
    store.save(project);
    res.json({ dashboard: computeDashboard(project), warnings });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`[apcc-api] listening on http://localhost:${port}`);
});
