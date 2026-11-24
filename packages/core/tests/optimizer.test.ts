import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeResources,
  computeSchedule,
  crashProject,
  levelResources,
  optimizeTimeCost,
  sampleProject,
} from '../src/index';
import { makeActivity, makeProject } from './helpers';

test('资源平衡消除样例工程的超配并给出顺延明细', () => {
  const project = sampleProject();
  const baseline = computeSchedule(project);
  const baselineResources = computeResources(project, baseline);
  assert.ok(
    baselineResources.loads.some((load) => load.overloaded),
    '样例工程应存在资源超配，否则测试前提不成立',
  );

  const result = levelResources(project);
  assert.equal(result.solver, 'local');
  assert.ok(result.baseline.overloadedResources > 0);
  assert.equal(result.leveled.overloadedResources, 0);
  assert.ok(result.moves.length > 0);
  assert.ok(result.delayDays > 0, '消除超配应带来一定工期顺延');

  const rescheduled = computeSchedule(result.project);
  assert.equal(rescheduled.projectDurationDays, result.leveled.durationDays);
  assert.equal(rescheduled.projectFinish, result.leveled.finishDate);
});

test('资源平衡不修改传入的基准项目', () => {
  const project = sampleProject();
  const before = structuredClone(project);
  levelResources(project);
  assert.deepEqual(project, before);
  assert.ok(project.activities.every((activity) => activity.notEarlierThan === undefined));
});

test('无资源约束的项目做平衡不会增加工期', () => {
  const project = makeProject([
    makeActivity({ id: 'A', durationDays: 3 }),
    makeActivity({
      id: 'B',
      durationDays: 2,
      predecessors: [{ activityId: 'A', type: 'FS', lagDays: 0 }],
    }),
  ]);
  const result = levelResources(project);
  assert.equal(result.delayDays, 0);
  assert.equal(result.moves.length, 0);
  assert.equal(result.leveled.durationDays, 5);
});

test('顺延窗口过小时给出容量不足提示', () => {
  const project = sampleProject();
  const result = levelResources(project, { maxShiftDays: 0 });
  assert.ok(result.leveled.overloadedResources > 0);
  assert.ok(result.notes.some((note) => note.includes('无法通过顺延消除超配')));
});

test('赶工压缩关键路径且追加成本不超过上限', () => {
  const project = sampleProject();
  const baseline = computeSchedule(project);
  const option = crashProject(project, 8, {
    id: 'test-crash',
    name: '测试赶工',
    costCapRatio: 0.03,
    maxCutRatio: 0.4,
  });

  assert.ok(option.achievedDays > 0);
  assert.ok(option.achievedDays <= 8);
  assert.ok(option.durationDays < baseline.projectDurationDays);
  assert.ok(option.addedCost <= option.costCap);
  assert.ok(option.moves.length > 0);
  for (const move of option.moves) {
    assert.equal(move.afterDuration, move.beforeDuration - move.cutDays);
    assert.ok(move.cutDays > 0);
  }

  const rescheduled = computeSchedule(option.project);
  assert.equal(rescheduled.projectDurationDays, option.durationDays);
});

test('赶工不修改传入的基准项目', () => {
  const project = sampleProject();
  const before = structuredClone(project);
  crashProject(project, 5, { costCapRatio: 0.02 });
  assert.deepEqual(project, before);
});

test('三档赶工方案工期与成本单调递增', () => {
  const result = optimizeTimeCost(sampleProject());
  assert.equal(result.options.length, 3);
  const [minCost, balanced, maxTime] = result.options;
  assert.ok(minCost.achievedDays <= balanced.achievedDays);
  assert.ok(balanced.achievedDays <= maxTime.achievedDays);
  assert.ok(minCost.addedCost <= maxTime.addedCost);
  for (const option of result.options) {
    assert.ok(option.durationDays <= result.baseline.durationDays);
  }
});
