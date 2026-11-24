import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSchedule } from '../src/index';
import { makeActivity, makeProject } from './helpers';

test('FS 链式关系：工期、开始/完成索引与关键路径', () => {
  const project = makeProject([
    makeActivity({ id: 'A', durationDays: 3 }),
    makeActivity({
      id: 'B',
      durationDays: 2,
      predecessors: [{ activityId: 'A', type: 'FS', lagDays: 0 }],
    }),
    makeActivity({
      id: 'C',
      durationDays: 1,
      predecessors: [{ activityId: 'B', type: 'FS', lagDays: 0 }],
    }),
  ]);
  const result = computeSchedule(project);
  assert.equal(result.projectDurationDays, 6);
  assert.equal(result.byId.A.startIndex, 0);
  assert.equal(result.byId.A.finishIndex, 2);
  assert.equal(result.byId.B.startIndex, 3);
  assert.equal(result.byId.C.finishIndex, 5);
  assert.equal(result.projectFinish, '2026-03-09');
  assert.deepEqual(result.criticalPath, ['A', 'B', 'C']);
  assert.equal(result.warnings.length, 0);
});

test('非关键活动具有总浮时且不影响完工日期', () => {
  const project = makeProject([
    makeActivity({ id: 'A', durationDays: 2 }),
    makeActivity({ id: 'B', durationDays: 1 }),
    makeActivity({
      id: 'C',
      durationDays: 1,
      predecessors: [
        { activityId: 'A', type: 'FS', lagDays: 0 },
        { activityId: 'B', type: 'FS', lagDays: 0 },
      ],
    }),
  ]);
  const result = computeSchedule(project);
  assert.equal(result.byId.B.startIndex, 0);
  assert.equal(result.byId.B.totalFloat, 1);
  assert.equal(result.byId.B.freeFloat, 1);
  assert.equal(result.byId.B.critical, false);
  assert.equal(result.byId.B.nearCritical, true);
  assert.deepEqual(result.criticalPath, ['A', 'C']);
});

test('SS 关系与滞后天数', () => {
  const project = makeProject([
    makeActivity({ id: 'A', durationDays: 5 }),
    makeActivity({
      id: 'B',
      durationDays: 3,
      predecessors: [{ activityId: 'A', type: 'SS', lagDays: 2 }],
    }),
  ]);
  const result = computeSchedule(project);
  assert.equal(result.byId.B.startIndex, 2);
  assert.equal(result.byId.B.finishIndex, 4);
  assert.equal(result.projectDurationDays, 5);
  assert.equal(result.byId.B.critical, true);
});

test('里程碑持续时间为 0，完成索引等于开始索引', () => {
  const project = makeProject([
    makeActivity({ id: 'A', durationDays: 2 }),
    makeActivity({
      id: 'M',
      durationDays: 0,
      isMilestone: true,
      predecessors: [{ activityId: 'A', type: 'FS', lagDays: 0 }],
    }),
  ]);
  const result = computeSchedule(project);
  assert.equal(result.byId.M.durationDays, 0);
  assert.equal(result.byId.M.startIndex, 2);
  assert.equal(result.byId.M.finishIndex, 2);
  assert.equal(result.projectDurationDays, 3);
});

test('循环逻辑不阻塞排程并给出告警', () => {
  const project = makeProject([
    makeActivity({
      id: 'A',
      durationDays: 1,
      predecessors: [{ activityId: 'B', type: 'FS', lagDays: 0 }],
    }),
    makeActivity({
      id: 'B',
      durationDays: 1,
      predecessors: [{ activityId: 'A', type: 'FS', lagDays: 0 }],
    }),
  ]);
  const result = computeSchedule(project);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /循环/);
  assert.equal(result.activities.length, 2);
});

test('引用不存在的前置活动时忽略该关系', () => {
  const project = makeProject([
    makeActivity({
      id: 'A',
      durationDays: 2,
      predecessors: [{ activityId: 'MISSING', type: 'FS', lagDays: 0 }],
    }),
  ]);
  const result = computeSchedule(project);
  assert.equal(result.byId.A.startIndex, 0);
  assert.equal(result.warnings.length, 0);
});
