import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeDashboard,
  computeEvm,
  computeSchedule,
  sampleProject,
} from '../src/index';
import { makeActivity, makeProject } from './helpers';

function closeTo(actual: number, expected: number, digits: number, message: string) {
  const tolerance = 0.5 * 10 ** -digits;
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

test('单活动 EVM：PV、EV、SPI、CPI 与 EAC', () => {
  const project = makeProject(
    [
      makeActivity({
        id: 'A',
        durationDays: 2,
        budgetCost: 100,
        percentComplete: 0.5,
        actualCost: 60,
        status: 'inProgress',
      }),
    ],
    { dataDate: '2026-03-03' },
  );
  const schedule = computeSchedule(project);
  const { snapshot } = computeEvm(project, schedule);
  assert.equal(snapshot.bac, 100);
  assert.equal(snapshot.pv, 100);
  assert.equal(snapshot.ev, 50);
  assert.equal(snapshot.ac, 60);
  closeTo(snapshot.spi, 0.5, 6, 'SPI');
  closeTo(snapshot.cpi, 50 / 60, 6, 'CPI');
  closeTo(snapshot.eac, 120, 6, 'EAC');
  closeTo(snapshot.etc, 60, 6, 'ETC');
  closeTo(snapshot.vac, -20, 6, 'VAC');
});

test('未开工的活动不计入已完价值与实际成本', () => {
  const project = makeProject(
    [
      makeActivity({ id: 'A', durationDays: 2, budgetCost: 100, percentComplete: 1, actualCost: 90, status: 'done' }),
      makeActivity({
        id: 'B',
        durationDays: 2,
        budgetCost: 100,
        percentComplete: 0.5,
        actualCost: 60,
        status: 'inProgress',
        predecessors: [{ activityId: 'A', type: 'FS', lagDays: 0 }],
      }),
    ],
    { dataDate: '2026-03-02' },
  );
  const schedule = computeSchedule(project);
  const { snapshot } = computeEvm(project, schedule);
  assert.equal(snapshot.ev, 100);
  assert.equal(snapshot.ac, 90);
});

test('样例工程基线：29 活动、关键路径 22、105 工作日、SPI/CPI 稳定', () => {
  const project = sampleProject();
  const schedule = computeSchedule(project);
  assert.equal(schedule.activities.length, 29);
  assert.equal(schedule.criticalPath.length, 22);
  assert.equal(schedule.projectDurationDays, 105);
  assert.equal(schedule.projectFinish, '2026-07-24');
  assert.equal(schedule.warnings.length, 0);

  const dashboard = computeDashboard(project);
  assert.equal(dashboard.evm.bac, 4_940_000);
  closeTo(dashboard.evm.spi, 0.837, 3, 'SPI');
  closeTo(dashboard.evm.cpi, 0.944, 3, 'CPI');
  closeTo(dashboard.evm.percentComplete, 0.549, 3, '完成率');
  assert.equal(dashboard.series.length > 10, true);
  assert.equal(dashboard.floors.length, 6);
  assert.equal(dashboard.bim.elements.length, 138);
  assert.equal(dashboard.cost.lines.length, 7);
});
