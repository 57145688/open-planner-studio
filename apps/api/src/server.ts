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

const app = express();
app.use(cors());
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));

let activeProject = sampleProject();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'apcc-api', version: '0.1.0' });
});

app.get('/api/project', (_req, res) => {
  res.json(activeProject);
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
    res.json({ dashboard: computeDashboard(project), warnings });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`[apcc-api] listening on http://localhost:${port}`);
});
