import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBimModel,
  buildRealityCapture,
  sampleProject,
  summarizeReality,
} from '../src/index';

test('合成实景确定可重复，并注入缺失与多余点', () => {
  const project = sampleProject();
  const model = buildBimModel(project);
  const first = buildRealityCapture(model, project.activities);
  const second = buildRealityCapture(model, project.activities);

  assert.equal(first.points.length, second.points.length);
  assert.deepEqual(
    first.summary.issues.map((issue) => issue.elementName),
    second.summary.issues.map((issue) => issue.elementName),
  );
  assert.equal(first.summary.missingElements, 3);
  assert.equal(first.summary.extraPoints, 90);
  assert.ok(first.points.some((point) => point.extra));
  assert.ok(first.summary.coverage > 0.7 && first.summary.coverage <= 1);
  assert.ok(first.summary.maxDeviation > 0.09);
  assert.equal(first.summary.simulated, true);
});

test('楼层统计与应建构件数量一致', () => {
  const project = sampleProject();
  const model = buildBimModel(project);
  const { summary } = buildRealityCapture(model, project.activities);
  assert.equal(summary.levels.length, 6);
  const expected = summary.levels.reduce((sum, level) => sum + level.expected, 0);
  const observed = summary.levels.reduce((sum, level) => sum + level.observed, 0);
  assert.equal(expected, summary.expectedElements);
  assert.equal(observed, summary.expectedElements - summary.missingElements);
  assert.equal(observed, summary.observedElements);
});

test('未开工活动的构件不出现在实景点云中', () => {
  const project = sampleProject();
  const model = buildBimModel(project);
  const slab = model.elements.find(
    (element) => element.ifcType === 'IfcSlab' && element.level === 6,
  );
  assert.ok(slab);
  const { points } = buildRealityCapture(model, project.activities);
  assert.equal(points.some((point) => point.elementGuid === slab.guid), false);
});

test('竖向构件按完成比例截断高度', () => {
  const project = sampleProject();
  const model = buildBimModel(project);
  const wall = model.elements.find(
    (element) => element.ifcType === 'IfcWall' && element.level === 1,
  );
  assert.ok(wall);
  const { points } = buildRealityCapture(model, project.activities);
  const own = points.filter((point) => point.elementGuid === wall.guid);
  assert.ok(own.length > 0);
  const top = wall.position.z + wall.size.z / 2;
  const maxZ = Math.max(...own.map((point) => point.z));
  assert.ok(maxZ < top - 0.2, `墙顶被截断: maxZ=${maxZ}, top=${top}`);
});

test('摘要函数与完整点云核验结果一致', () => {
  const project = sampleProject();
  const model = buildBimModel(project);
  const full = buildRealityCapture(model, project.activities);
  const summary = summarizeReality(model, project.activities);
  assert.equal(summary.totalPoints, full.summary.totalPoints);
  assert.equal(summary.matchedPoints, full.summary.matchedPoints);
  assert.equal(summary.meanDeviation, full.summary.meanDeviation);
  assert.equal(summary.issues.length, full.summary.issues.length);
});
