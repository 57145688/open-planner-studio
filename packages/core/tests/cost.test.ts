import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCostBreakdown,
  computeEvm,
  computeSchedule,
  sampleProject,
} from '../src/index';

test('WBS 成本合计与 EVM 口径一致', () => {
  const project = sampleProject();
  const schedule = computeSchedule(project);
  const { snapshot } = computeEvm(project, schedule);
  const cost = computeCostBreakdown(project, schedule, snapshot);

  assert.equal(cost.lines.length, 7);
  const budget = cost.lines.reduce((sum, line) => sum + line.budget, 0);
  const earned = cost.lines.reduce((sum, line) => sum + line.earned, 0);
  const actual = cost.lines.reduce((sum, line) => sum + line.actual, 0);
  assert.equal(budget, snapshot.bac);
  assert.ok(Math.abs(earned - snapshot.ev) <= 1e-6);
  assert.ok(Math.abs(actual - snapshot.ac) <= 1e-6);
});

test('EVM 预测提供三种方法且完工日期按 SPI 顺延', () => {
  const project = sampleProject();
  const schedule = computeSchedule(project);
  const { snapshot } = computeEvm(project, schedule);
  const cost = computeCostBreakdown(project, schedule, snapshot);

  assert.equal(cost.forecasts.length, 3);
  assert.deepEqual(
    cost.forecasts.map((item) => item.method),
    ['cpi', 'composite', 'plan'],
  );
  assert.ok(Math.abs(cost.forecasts[0].eac - snapshot.eac) <= 1e-6);
  assert.ok(cost.forecasts[1].eac >= cost.forecasts[0].eac);
  assert.equal(cost.finish.forecastFinish, '2026-08-03');
  assert.equal(cost.finish.delayDays, 6);
});

test('BOQ 分摊到活动后金额守恒，且清单总额与预算差额可追溯', () => {
  const project = sampleProject();
  const schedule = computeSchedule(project);
  const { snapshot } = computeEvm(project, schedule);
  const cost = computeCostBreakdown(project, schedule, snapshot);

  assert.equal(cost.boq.length, project.boq.length);
  for (const line of cost.boq) {
    const allocated = line.allocations.reduce((sum, item) => sum + item.amount, 0);
    assert.ok(
      Math.abs(allocated - line.amount) <= line.allocations.length,
      `${line.code} 分摊金额与清单金额偏差过大`,
    );
    assert.ok(line.allocations.length > 0);
  }
  const boqTotal = cost.boq.reduce((sum, line) => sum + line.amount, 0);
  assert.equal(cost.boqTotal, boqTotal);
  assert.equal(cost.budgetGap, cost.bac - boqTotal);
});
