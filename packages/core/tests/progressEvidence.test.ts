import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyProgressSuggestions,
  buildBimModel,
  buildRealityCapture,
  evidenceFromRealityCapture,
  sampleProject,
  suggestProgressFromEvidence,
} from '../src/index';
import type { ProgressEvidenceItem } from '../src/index';

function evidenceFromCurrentProgress(
  project: ReturnType<typeof sampleProject>,
): ProgressEvidenceItem[] {
  const model = buildBimModel(project);
  const activityById = new Map(project.activities.map((activity) => [activity.id, activity]));
  return model.elements.map((element) => ({
    elementId: element.guid,
    coverage: activityById.get(element.activityId)?.percentComplete ?? 0,
  }));
}

test('覆盖率与当前进度一致时判定为 consistent', () => {
  const project = sampleProject();
  const model = buildBimModel(project);
  const result = suggestProgressFromEvidence(project, model, evidenceFromCurrentProgress(project));

  assert.ok(result.activities.length > 0);
  assert.equal(result.totals.behind, 0);
  assert.equal(result.totals.ahead, 0);
  assert.equal(result.totals.unverified, 0);
  assert.ok(result.totals.consistent > 0);
  assert.ok(Math.abs(result.totals.meanDelta) <= 0.01);
});

test('覆盖率低于计划时给出落后建议与缺失缺口', () => {
  const project = sampleProject();
  const model = buildBimModel(project);
  const target = project.activities.find((activity) => activity.id === 'F6-R');
  assert.ok(target, '样例工程应包含 6F 结构活动');

  const evidence = evidenceFromCurrentProgress(project).map((item) =>
    model.byGuid[item.elementId]?.activityId === 'F6-R' ? { ...item, coverage: 0 } : item,
  );

  const result = suggestProgressFromEvidence(project, model, evidence);
  const suggestion = result.activities.find((item) => item.activityId === 'F6-R');
  assert.ok(suggestion);
  assert.equal(suggestion.status, 'behind');
  assert.equal(suggestion.suggestedPercent, 0);
  assert.ok(suggestion.delta < 0);
  assert.equal(
    suggestion.gaps.length,
    model.elements.filter((element) => element.activityId === 'F6-R').length,
  );
  assert.ok(suggestion.gaps.every((gap) => gap.reason === 'missing'));
});

test('没有任何实景证据时活动标记为未核验且不改变建议值', () => {
  const project = sampleProject();
  const model = buildBimModel(project);
  const result = suggestProgressFromEvidence(project, model, []);

  assert.ok(result.activities.length > 0);
  assert.equal(result.totals.unverified, result.activities.length);
  for (const suggestion of result.activities) {
    assert.equal(suggestion.status, 'unverified');
    assert.equal(suggestion.suggestedPercent, suggestion.currentPercent);
    assert.equal(suggestion.delta, 0);
  }
});

test('应用建议只写入候选项目，不修改基准', () => {
  const project = sampleProject();
  const before = structuredClone(project);
  const model = buildBimModel(project);
  const evidence = evidenceFromCurrentProgress(project).map((item) =>
    model.byGuid[item.elementId]?.activityId === 'F6-R' ? { ...item, coverage: 0 } : item,
  );
  const result = suggestProgressFromEvidence(project, model, evidence);
  const applied = applyProgressSuggestions(project, result, { activityIds: ['F6-R'] });

  assert.deepEqual(project, before);
  assert.deepEqual(applied.applied, ['F6-R']);
  assert.equal(applied.skipped.length, 0);
  const updated = applied.project.activities.find((activity) => activity.id === 'F6-R');
  assert.equal(updated?.percentComplete, 0);
  assert.equal(updated?.status, 'planned');
});

test('合成实景点云能识别注入的缺失构件并产生证据缺口', () => {
  const project = sampleProject();
  const model = buildBimModel(project);
  const capture = buildRealityCapture(model, project.activities);
  const result = suggestProgressFromEvidence(
    project,
    model,
    evidenceFromRealityCapture(capture.evidence),
    { source: 'simulated' },
  );

  assert.equal(result.source, 'simulated');
  assert.ok(result.totals.gaps >= 3, '应至少识别出 3 个注入缺失的构件');
  assert.ok(result.totals.missing >= 3);
  assert.ok(result.activities.some((item) => item.gaps.length > 0));
  for (const suggestion of result.activities) {
    assert.ok(suggestion.suggestedPercent >= 0 && suggestion.suggestedPercent <= 1);
  }
});
