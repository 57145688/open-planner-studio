import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeSchedule,
  exportMspdi,
  importMspdi,
  sampleProject,
} from '../src/index';

test('MSPDI 导出后可完整回环导入，关键指标不丢失', () => {
  const source = sampleProject();
  const xml = exportMspdi(source);
  assert.match(xml, /^<\?xml/);
  assert.match(xml, /<Project/);

  const { project, warnings } = importMspdi(xml);
  assert.deepEqual(warnings, []);
  assert.equal(project.activities.length, source.activities.length);
  assert.equal(project.resources.length, source.resources.length);
  assert.equal(project.wbs.length, source.wbs.length);

  const before = computeSchedule(source);
  const after = computeSchedule(project);
  assert.equal(after.projectDurationDays, before.projectDurationDays);
  assert.equal(after.projectFinish, before.projectFinish);
  assert.equal(after.criticalPath.length, before.criticalPath.length);
  assert.equal(after.warnings.length, 0);
});

test('MSPDI 回环保留活动名称、逻辑关系与完成进度', () => {
  const source = sampleProject();
  const { project } = importMspdi(exportMspdi(source));
  const original = new Map(source.activities.map((activity) => [activity.code, activity]));
  for (const activity of project.activities) {
    const match = original.get(activity.code);
    assert.ok(match, `导入后缺少活动 ${activity.code}`);
    assert.equal(activity.name, match.name);
    assert.equal(activity.predecessors.length, match.predecessors.length);
    assert.equal(activity.percentComplete, match.percentComplete);
  }
});
