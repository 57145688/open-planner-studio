import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  analyzeScanVsBim,
  diffRealCaseReports,
  parsePly,
  voxelDownsample,
} from '../src/index';
import type { BimSurface, PointCloudPoint } from '../src/index';

const scanPath = new URL('../../../examples/reality/Sample.scan.ply', import.meta.url);
const gaussianPath = new URL('../../../examples/reality/Sample.3dgs.ply', import.meta.url);

function planeSurface(id: string, z: number): BimSurface {
  return {
    id,
    ifcType: 'IfcSlab',
    name: '测试平面',
    positions: [0, 0, z, 4, 0, z, 4, 3, z, 0, 3, z],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

function planePoints(z: number, offset = 0): PointCloudPoint[] {
  const points: PointCloudPoint[] = [];
  const steps = 60;
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      points.push({
        x: (4 * i) / steps,
        y: (3 * j) / steps,
        z: z + offset,
        r: 200,
        g: 200,
        b: 200,
      });
    }
  }
  return points;
}

test('解析真实降采样点云：点数、包围盒与真彩颜色', () => {
  const cloud = parsePly(readFileSync(scanPath));
  assert.equal(cloud.pointCount, 328299);
  assert.equal(cloud.sourcePointCount, 328299);
  assert.equal(cloud.format, 'binary_little_endian');
  assert.equal(cloud.hasColor, true);
  assert.equal(cloud.gaussianSplatColors, false);
  assert.ok(cloud.bounds.min[0] < -6.9 && cloud.bounds.max[0] > 4.5);
  assert.ok(cloud.bounds.max[2] > 2.5, 'Z 轴为高度方向');
  const sampled = cloud.points[0];
  assert.ok(sampled.r >= 0 && sampled.r <= 255);
});

test('解析 3DGS 格式样本的 f_dc_* 颜色与坐标', () => {
  const cloud = parsePly(readFileSync(gaussianPath));
  assert.equal(cloud.gaussianSplatColors, true);
  assert.equal(cloud.hasColor, true);
  assert.ok(cloud.pointCount > 50_000);
  assert.ok(cloud.bounds.min[2] < 0 && cloud.bounds.max[2] > 2);
  assert.ok(
    cloud.points.some(
      (point) => point.r !== 148 || point.g !== 163 || point.b !== 184,
    ),
    'f_dc_* 应还原为真彩而不是默认灰色',
  );
});

test('体素降采样确定可重复，并减少点数', () => {
  const source = [...planePoints(0), ...planePoints(1.5)];
  const first = voxelDownsample(source, 0.25);
  const second = voxelDownsample(source, 0.25);
  assert.ok(first.length > 0);
  assert.ok(first.length < source.length);
  assert.deepEqual(first, second);
});

test('表面点云覆盖完整时覆盖率为 1，偏移后判为证据不足', () => {
  const surfaces = [planeSurface('slab-1', 0)];
  const matched = analyzeScanVsBim(surfaces, planePoints(0), {
    tolerance: 0.08,
    samplesPerElement: 240,
  });
  assert.equal(matched.elements.length, 1);
  assert.ok(matched.overallCoverage > 0.995, `coverage=${matched.overallCoverage}`);
  assert.equal(matched.elements[0].status, 'observed');
  assert.equal(matched.observed, 1);

  const shifted = analyzeScanVsBim(surfaces, planePoints(0, 0.4), {
    tolerance: 0.08,
    samplesPerElement: 240,
  });
  assert.ok(shifted.overallCoverage < 0.02, `coverage=${shifted.overallCoverage}`);
  assert.equal(shifted.elements[0].status, 'insufficient');
});

test('多期对比给出覆盖率增量与新观测构件', () => {
  const surfaces = [planeSurface('slab-1', 0), planeSurface('slab-2', 1.5)];
  const previous = analyzeScanVsBim(surfaces, planePoints(0), {
    tolerance: 0.08,
    samplesPerElement: 160,
  });
  const current = analyzeScanVsBim(
    surfaces,
    [...planePoints(0), ...planePoints(1.5)],
    { tolerance: 0.08, samplesPerElement: 160 },
  );
  const delta = diffRealCaseReports(previous, current);
  assert.equal(delta.elements.length, 2);
  assert.equal(delta.observedDelta, 1);
  assert.ok(delta.coverageDelta > 0.4, `delta=${delta.coverageDelta}`);
  assert.equal(delta.newlyObserved.length, 1);
});

test('真实点云对照模型表面统计在合理区间', () => {
  const cloud = parsePly(readFileSync(scanPath));
  const [minX, minY] = cloud.bounds.min;
  const [maxX, maxY] = cloud.bounds.max;
  // 用扫描范围上的水平面近似吊顶，验证真实点云的分析链路与量级。
  const surface: BimSurface = {
    id: 'ceiling',
    ifcType: 'IfcCovering',
    name: '水平参考面',
    positions: [minX, minY, 2.4, maxX, minY, 2.4, maxX, maxY, 2.4, minX, maxY, 2.4],
    indices: [0, 1, 2, 0, 2, 3],
  };
  const report = analyzeScanVsBim([surface], cloud.points, {
    tolerance: 0.1,
    samplesPerElement: 300,
  });
  assert.ok(report.overallCoverage > 0.1 && report.overallCoverage < 0.9);
  assert.equal(report.byType.length, 1);
  assert.ok(report.byHeight.length >= 1);
  assert.ok(report.coveredArea <= report.totalArea);
  assert.ok(report.meanDeviation >= 0 && report.meanDeviation <= 0.1);
});
