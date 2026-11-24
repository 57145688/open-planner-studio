import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkingCalendar, parseIsoDate, toIsoDate, workingIndexFor } from '../src/index';

test('工作日历只包含工作日并跳过周末', () => {
  const days = buildWorkingCalendar('2026-03-02', [1, 2, 3, 4, 5], 6);
  assert.deepEqual(days, [
    '2026-03-02',
    '2026-03-03',
    '2026-03-04',
    '2026-03-05',
    '2026-03-06',
    '2026-03-09',
  ]);
});

test('起始日期落在周末时顺延到下一个工作日', () => {
  const days = buildWorkingCalendar('2026-03-07', [1, 2, 3, 4, 5], 2);
  assert.deepEqual(days, ['2026-03-09', '2026-03-10']);
});

test('workingIndexFor 返回不晚于目标日期的最后一个工作日', () => {
  const days = buildWorkingCalendar('2026-03-02', [1, 2, 3, 4, 5], 10);
  assert.equal(workingIndexFor(days, '2026-03-01'), -1);
  assert.equal(workingIndexFor(days, '2026-03-02'), 0);
  assert.equal(workingIndexFor(days, '2026-03-07'), 4);
  assert.equal(workingIndexFor(days, '2026-03-09'), 5);
});

test('ISO 日期解析使用 UTC，避免时区偏移', () => {
  assert.equal(toIsoDate(parseIsoDate('2026-03-02')), '2026-03-02');
});
