/**
 * 真实案例核验：把外部点云（LiDAR 扫描，或 3DGS 训练导出的 .ply 点源）
 * 与 IFC / 其它三维模型的构件表面对比，得到构件级覆盖率、偏差与时序差值。
 *
 * 数据边界：
 * - 本模块只做几何对比，不训练 3DGS，也不推断合同进度；
 * - 覆盖率是「模型表面被点云证据覆盖的比例」，会受扫描视角遮挡影响；
 * - 点云与模型需处于同一坐标系，或由调用方提供平移对位量。
 */

export interface PointCloudPoint {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
}

export interface PointCloudBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ParsedPointCloud {
  points: PointCloudPoint[];
  /** 文件头声明的原始点数 */
  sourcePointCount: number;
  /** 采样/降采样后的实际点数 */
  pointCount: number;
  bounds: PointCloudBounds;
  hasColor: boolean;
  format: string;
  /** 是否按 3DGS 的 f_dc_* 球谐系数还原颜色 */
  gaussianSplatColors: boolean;
  comments: string[];
}

export interface PlyParseOptions {
  /** 体素边长（m）；大于 0 时按体素取平均降采样 */
  voxel?: number;
  /** 最多保留点数，超出时按体素降采样到接近该值 */
  maxPoints?: number;
}

interface PlyProperty {
  name: string;
  type: string;
}

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

interface PlyHeader {
  format: string;
  comments: string[];
  elements: PlyElement[];
  dataStart: number;
}

const TYPE_SIZE: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
  int64: 8,
  uint64: 8,
};

const SH_C0 = 0.28209479177387814;

const DEFAULT_RGB: [number, number, number] = [148, 163, 184];

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function readHeader(bytes: Uint8Array): PlyHeader {
  const decoder = new TextDecoder('ascii');
  const probe = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
  const marker = probe.indexOf('end_header');
  if (marker < 0) throw new Error('PLY 缺少 end_header，文件可能不完整。');
  const after = probe.indexOf('\n', marker);
  if (after < 0) throw new Error('PLY 头缺少换行，文件可能不完整。');
  const lines = probe.slice(0, marker).split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== 'ply') throw new Error('不是 PLY 文件。');

  let format = '';
  const comments: string[] = [];
  const elements: PlyElement[] = [];
  for (const rawLine of lines.slice(1)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'format') {
      format = parts[1] ?? '';
    } else if (parts[0] === 'comment') {
      comments.push(line.slice(8));
    } else if (parts[0] === 'element') {
      elements.push({
        name: parts[1] ?? '',
        count: Number(parts[2] ?? 0),
        properties: [],
      });
    } else if (parts[0] === 'property') {
      const target = elements[elements.length - 1];
      if (!target) continue;
      if (parts[1] === 'list') {
        // 样例点云不含 list 属性；遇到时直接跳过该元素后续读取。
        target.properties.push({ name: parts[4] ?? 'list', type: 'list' });
      } else {
        target.properties.push({ name: parts[2] ?? '', type: parts[1] ?? '' });
      }
    }
  }
  if (!format) throw new Error('PLY 缺少 format 声明。');
  return { format, comments, elements, dataStart: after + 1 };
}

function vertexElement(header: PlyHeader): PlyElement {
  const vertex = header.elements.find((element) => element.name === 'vertex');
  if (!vertex) throw new Error('PLY 缺少 vertex 元素。');
  return vertex;
}

function propertyOffset(element: PlyElement): Map<string, number> {
  const offsets = new Map<string, number>();
  let offset = 0;
  for (const property of element.properties) {
    offsets.set(property.name, offset);
    offset += TYPE_SIZE[property.type] ?? 0;
  }
  return offsets;
}

function strideOf(element: PlyElement): number {
  return element.properties.reduce((sum, property) => sum + (TYPE_SIZE[property.type] ?? 0), 0);
}

function readNumber(
  view: DataView,
  offset: number,
  type: string,
  littleEndian: boolean,
): number {
  switch (type) {
    case 'char':
    case 'int8':
      return view.getInt8(offset);
    case 'uchar':
    case 'uint8':
      return view.getUint8(offset);
    case 'short':
    case 'int16':
      return view.getInt16(offset, littleEndian);
    case 'ushort':
    case 'uint16':
      return view.getUint16(offset, littleEndian);
    case 'int':
    case 'int32':
      return view.getInt32(offset, littleEndian);
    case 'uint':
    case 'uint32':
      return view.getUint32(offset, littleEndian);
    case 'float':
    case 'float32':
      return view.getFloat32(offset, littleEndian);
    case 'double':
    case 'float64':
      return view.getFloat64(offset, littleEndian);
    default:
      return Number.NaN;
  }
}

function normalizeColor(value: number, type: string): number {
  const scaled = type === 'float' || type === 'float32' || type === 'double' || type === 'float64'
    ? value * 255
    : value;
  if (!Number.isFinite(scaled)) return 0;
  return Math.max(0, Math.min(255, Math.round(scaled)));
}

function computeBounds(points: PointCloudPoint[]): PointCloudBounds {
  if (points.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    if (point.x < min[0]) min[0] = point.x;
    if (point.y < min[1]) min[1] = point.y;
    if (point.z < min[2]) min[2] = point.z;
    if (point.x > max[0]) max[0] = point.x;
    if (point.y > max[1]) max[1] = point.y;
    if (point.z > max[2]) max[2] = point.z;
  }
  return { min, max };
}

function voxelKey(x: number, y: number, z: number, voxel: number): string {
  return `${Math.floor(x / voxel)},${Math.floor(y / voxel)},${Math.floor(z / voxel)}`;
}

/** 体素降采样：同一体素内取坐标与颜色均值，保留少量代表点。 */
export function voxelDownsample(
  points: PointCloudPoint[],
  voxel: number,
): PointCloudPoint[] {
  if (!(voxel > 0)) return points;
  interface Acc {
    count: number;
    x: number;
    y: number;
    z: number;
    r: number;
    g: number;
    b: number;
  }
  const buckets = new Map<string, Acc>();
  for (const point of points) {
    const key = voxelKey(point.x, point.y, point.z, voxel);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.x += point.x;
      bucket.y += point.y;
      bucket.z += point.z;
      bucket.r += point.r;
      bucket.g += point.g;
      bucket.b += point.b;
    } else {
      buckets.set(key, {
        count: 1,
        x: point.x,
        y: point.y,
        z: point.z,
        r: point.r,
        g: point.g,
        b: point.b,
      });
    }
  }
  const result: PointCloudPoint[] = [];
  for (const bucket of buckets.values()) {
    result.push({
      x: bucket.x / bucket.count,
      y: bucket.y / bucket.count,
      z: bucket.z / bucket.count,
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count),
    });
  }
  return result;
}

/** 解析 PLY（binary little/big endian 或 ascii），支持 RGB 与 3DGS 的 f_dc_* 颜色。 */
export function parsePly(
  input: ArrayBuffer | Uint8Array,
  options: PlyParseOptions = {},
): ParsedPointCloud {
  const bytes = toBytes(input);
  const header = readHeader(bytes);
  for (const element of header.elements) {
    for (const property of element.properties) {
      if (property.type === 'list') {
        throw new Error('暂不支持含 list 属性的 PLY（常见于带面片的网格 PLY）。');
      }
      if (!(property.type in TYPE_SIZE)) {
        throw new Error(`不支持的 PLY 属性类型：${property.type}`);
      }
    }
  }
  const vertex = vertexElement(header);
  const offsets = propertyOffset(vertex);
  const stride = strideOf(vertex);
  if (!offsets.has('x') || !offsets.has('y') || !offsets.has('z')) {
    throw new Error('PLY 顶点缺少 x/y/z 属性。');
  }

  const propType = new Map(vertex.properties.map((property) => [property.name, property.type]));
  const hasRgb = propType.has('red') && propType.has('green') && propType.has('blue');
  const hasDc = propType.has('f_dc_0') && propType.has('f_dc_1') && propType.has('f_dc_2');
  const useDc = !hasRgb && hasDc;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const points: PointCloudPoint[] = [];

  const pushPoint = (x: number, y: number, z: number, rgb: [number, number, number]) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    points.push({ x, y, z, r: rgb[0], g: rgb[1], b: rgb[2] });
  };

  const colorAt = (pick: (name: string) => number): [number, number, number] => {
    if (hasRgb) {
      return [
        normalizeColor(pick('red'), propType.get('red') ?? 'uchar'),
        normalizeColor(pick('green'), propType.get('green') ?? 'uchar'),
        normalizeColor(pick('blue'), propType.get('blue') ?? 'uchar'),
      ];
    }
    if (useDc) {
      const channel = (name: string) => {
        const value = 0.5 + SH_C0 * pick(name);
        return Math.max(0, Math.min(255, Math.round(value * 255)));
      };
      return [channel('f_dc_0'), channel('f_dc_1'), channel('f_dc_2')];
    }
    return [...DEFAULT_RGB];
  };

  if (header.format === 'ascii') {
    const text = new TextDecoder('ascii').decode(bytes.subarray(header.dataStart));
    const tokens = text.split(/\s+/).filter(Boolean);
    let cursor = 0;
    for (const element of header.elements) {
      const width = element.properties.length;
      for (let i = 0; i < element.count; i += 1) {
        if (element.name === 'vertex') {
          const pick = (name: string) => {
            const index = element.properties.findIndex((property) => property.name === name);
            return index < 0 ? Number.NaN : Number(tokens[cursor + index]);
          };
          pushPoint(pick('x'), pick('y'), pick('z'), colorAt(pick));
        }
        cursor += width;
      }
    }
  } else {
    const littleEndian = header.format === 'binary_little_endian';
    if (!littleEndian && header.format !== 'binary_big_endian') {
      throw new Error(`不支持的 PLY 格式：${header.format}`);
    }
    let offset = header.dataStart;
    for (const element of header.elements) {
      if (element.name === 'vertex') {
        const base = offset;
        for (let i = 0; i < element.count; i += 1) {
          const at = base + i * stride;
          const pick = (name: string) => {
            const propertyOffsetValue = offsets.get(name);
            if (propertyOffsetValue === undefined) return Number.NaN;
            return readNumber(view, at + propertyOffsetValue, propType.get(name) ?? 'float', littleEndian);
          };
          pushPoint(pick('x'), pick('y'), pick('z'), colorAt(pick));
        }
        offset = base + element.count * stride;
      } else {
        offset += element.count * strideOf(element);
      }
    }
  }

  const sourcePointCount = points.length;
  let finalPoints = points;
  if (options.maxPoints && finalPoints.length > options.maxPoints) {
    // 以包围盒体积估算需要的体素，再逐次放大，最多 6 轮。
    const bounds = computeBounds(finalPoints);
    const span = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
      1,
    );
    let voxel = Math.max(0.01, span / 200);
    for (let round = 0; round < 6 && finalPoints.length > options.maxPoints; round += 1) {
      finalPoints = voxelDownsample(points, voxel);
      voxel *= 1.35;
    }
  } else if (options.voxel && options.voxel > 0) {
    finalPoints = voxelDownsample(finalPoints, options.voxel);
  }

  return {
    points: finalPoints,
    sourcePointCount,
    pointCount: finalPoints.length,
    bounds: computeBounds(finalPoints),
    hasColor: hasRgb || useDc,
    format: header.format,
    gaussianSplatColors: useDc,
    comments: header.comments,
  };
}

/** 构件表面：位置与索引需已转换到点云坐标系。 */
export interface BimSurface {
  id: string;
  ifcType: string;
  name: string;
  positions: Float32Array | number[];
  indices: Uint32Array | number[];
}

export type RealCaseStatus = 'observed' | 'partial' | 'insufficient';

export interface RealCaseElementResult {
  id: string;
  ifcType: string;
  name: string;
  area: number;
  samples: number;
  matchedSamples: number;
  coverage: number;
  meanDeviation: number;
  maxDeviation: number;
  status: RealCaseStatus;
}

export interface RealCaseTypeStat {
  ifcType: string;
  count: number;
  area: number;
  coverage: number;
  observed: number;
  partial: number;
  insufficient: number;
}

export interface RealCaseHeightStat {
  label: string;
  minZ: number;
  maxZ: number;
  area: number;
  coverage: number;
}

export interface RealCaseThresholds {
  observed: number;
  partial: number;
}

export interface RealCaseReport {
  tolerance: number;
  thresholds: RealCaseThresholds;
  points: number;
  surfaces: number;
  elements: RealCaseElementResult[];
  totalArea: number;
  coveredArea: number;
  overallCoverage: number;
  meanDeviation: number;
  maxDeviation: number;
  observed: number;
  partial: number;
  insufficient: number;
  byType: RealCaseTypeStat[];
  byHeight: RealCaseHeightStat[];
  note: string;
}

export interface RealCaseOptions {
  /** 容差（m），默认 0.10 */
  tolerance?: number;
  /** 每个构件表面采样点数，默认 220 */
  samplesPerElement?: number;
  /** 充分观测阈值，默认 0.6 */
  observedThreshold?: number;
  /** 部分观测阈值，默认 0.25 */
  partialThreshold?: number;
  seed?: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

interface SampleSet {
  /** x,y,z 连续存放 */
  coordinates: number[];
  area: number;
}

function sampleSurface(
  positions: Float32Array | number[],
  indices: Uint32Array | number[],
  count: number,
  random: () => number,
): SampleSet {
  const triangles: number[] = [];
  const areas: number[] = [];
  let totalArea = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const area = 0.5 * Math.hypot(cx, cy, cz);
    if (!(area > 1e-9)) continue;
    triangles.push(a, b, c);
    areas.push(area);
    totalArea += area;
  }

  const coordinates: number[] = [];
  if (triangles.length === 0) return { coordinates, area: 0 };
  for (let sample = 0; sample < count; sample += 1) {
    let pick = random() * totalArea;
    let triangle = 0;
    while (triangle < areas.length - 1 && pick > areas[triangle]) {
      pick -= areas[triangle];
      triangle += 1;
    }
    const a = triangles[triangle * 3];
    const b = triangles[triangle * 3 + 1];
    const c = triangles[triangle * 3 + 2];
    let u = random();
    let v = random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    coordinates.push(
      positions[a] + (positions[b] - positions[a]) * u + (positions[c] - positions[a]) * v,
      positions[a + 1] + (positions[b + 1] - positions[a + 1]) * u + (positions[c + 1] - positions[a + 1]) * v,
      positions[a + 2] + (positions[b + 2] - positions[a + 2]) * u + (positions[c + 2] - positions[a + 2]) * v,
    );
  }
  return { coordinates, area: totalArea };
}

function cellHash(ix: number, iy: number, iz: number): number {
  return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0;
}

/** 用点云体素哈希对照构件表面采样，得到覆盖率与偏差。 */
export function analyzeScanVsBim(
  surfaces: BimSurface[],
  points: PointCloudPoint[],
  options: RealCaseOptions = {},
): RealCaseReport {
  const tolerance = options.tolerance ?? 0.1;
  const samplesPerElement = Math.max(20, Math.round(options.samplesPerElement ?? 220));
  const observedThreshold = options.observedThreshold ?? 0.6;
  const partialThreshold = options.partialThreshold ?? 0.25;
  const cell = Math.max(tolerance, 0.02);
  const toleranceSq = tolerance * tolerance;

  const grid = new Map<number, number[]>();
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const key = cellHash(
      Math.floor(point.x / cell),
      Math.floor(point.y / cell),
      Math.floor(point.z / cell),
    );
    const bucket = grid.get(key);
    if (bucket) bucket.push(index);
    else grid.set(key, [index]);
  }

  const elements: RealCaseElementResult[] = [];
  const bands = new Map<number, { area: number; coveredArea: number }>();
  let coveredArea = 0;
  let totalArea = 0;
  let deviationSum = 0;
  let deviationCount = 0;
  let maxDeviation = 0;

  for (const surface of surfaces) {
    const random = mulberry32(hashString(surface.id) ^ (options.seed ?? 0));
    const { coordinates, area } = sampleSurface(
      surface.positions,
      surface.indices,
      samplesPerElement,
      random,
    );
    let matched = 0;
    let elementDeviationSum = 0;
    let elementMax = 0;
    const sampleArea = area / Math.max(1, coordinates.length / 3);

    for (let i = 0; i < coordinates.length; i += 3) {
      const x = coordinates[i];
      const y = coordinates[i + 1];
      const z = coordinates[i + 2];
      const ix = Math.floor(x / cell);
      const iy = Math.floor(y / cell);
      const iz = Math.floor(z / cell);
      let best = Infinity;
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dz = -1; dz <= 1; dz += 1) {
            const bucket = grid.get(cellHash(ix + dx, iy + dy, iz + dz));
            if (!bucket) continue;
            for (const index of bucket) {
              const point = points[index];
              const d =
                (point.x - x) * (point.x - x) +
                (point.y - y) * (point.y - y) +
                (point.z - z) * (point.z - z);
              if (d < best) best = d;
            }
          }
        }
      }
      const band = Math.floor(z);
      const bandStat = bands.get(band) ?? { area: 0, coveredArea: 0 };
      bandStat.area += sampleArea;
      const hit = best <= toleranceSq;
      if (hit) {
        matched += 1;
        const deviation = Math.sqrt(best);
        elementDeviationSum += deviation;
        if (deviation > elementMax) elementMax = deviation;
        deviationSum += deviation;
        deviationCount += 1;
        if (deviation > maxDeviation) maxDeviation = deviation;
        bandStat.coveredArea += sampleArea;
        coveredArea += sampleArea;
      }
      bands.set(band, bandStat);
    }

    const coverage = coordinates.length === 0 ? 0 : matched / (coordinates.length / 3);
    const status: RealCaseStatus =
      coverage >= observedThreshold
        ? 'observed'
        : coverage >= partialThreshold
          ? 'partial'
          : 'insufficient';
    elements.push({
      id: surface.id,
      ifcType: surface.ifcType,
      name: surface.name,
      area,
      samples: Math.round(coordinates.length / 3),
      matchedSamples: matched,
      coverage,
      meanDeviation: matched > 0 ? elementDeviationSum / matched : 0,
      maxDeviation: elementMax,
      status,
    });
    totalArea += area;
  }

  elements.sort((a, b) => b.area - a.area);

  const typeMap = new Map<string, RealCaseTypeStat>();
  for (const element of elements) {
    const stat = typeMap.get(element.ifcType) ?? {
      ifcType: element.ifcType,
      count: 0,
      area: 0,
      coverage: 0,
      observed: 0,
      partial: 0,
      insufficient: 0,
    };
    stat.count += 1;
    stat.area += element.area;
    stat.coverage += element.area * element.coverage;
    stat[element.status] += 1;
    typeMap.set(element.ifcType, stat);
  }
  const byType = [...typeMap.values()]
    .map((stat) => ({
      ...stat,
      coverage: stat.area > 0 ? stat.coverage / stat.area : 0,
    }))
    .sort((a, b) => b.area - a.area);

  const byHeight: RealCaseHeightStat[] = [...bands.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([band, stat]) => ({
      label: `${band}–${band + 1} m`,
      minZ: band,
      maxZ: band + 1,
      area: stat.area,
      coverage: stat.area > 0 ? stat.coveredArea / stat.area : 0,
    }));

  const overallCoverage = totalArea > 0 ? coveredArea / totalArea : 0;
  return {
    tolerance,
    thresholds: { observed: observedThreshold, partial: partialThreshold },
    points: points.length,
    surfaces: surfaces.length,
    elements,
    totalArea,
    coveredArea,
    overallCoverage,
    meanDeviation: deviationCount > 0 ? deviationSum / deviationCount : 0,
    maxDeviation,
    observed: elements.filter((element) => element.status === 'observed').length,
    partial: elements.filter((element) => element.status === 'partial').length,
    insufficient: elements.filter((element) => element.status === 'insufficient').length,
    byType,
    byHeight,
    note:
      '覆盖率为模型表面采样点在点云容差内的比例，受扫描视角与遮挡影响，不等同于合同进度或质量验收结论。',
  };
}

export interface RealCaseElementDelta {
  id: string;
  name: string;
  ifcType: string;
  coverage: number;
  delta: number;
  status: RealCaseStatus;
}

export interface RealCaseDelta {
  overallCoverage: number;
  coverageDelta: number;
  observedDelta: number;
  elements: RealCaseElementDelta[];
  newlyObserved: string[];
  regressed: string[];
}

/** 两期对比：用于时序回放中的覆盖率增量与新出现的构件。 */
export function diffRealCaseReports(
  previous: RealCaseReport,
  current: RealCaseReport,
): RealCaseDelta {
  const before = new Map(previous.elements.map((element) => [element.id, element]));
  const elements: RealCaseElementDelta[] = current.elements.map((element) => {
    const prior = before.get(element.id);
    return {
      id: element.id,
      name: element.name,
      ifcType: element.ifcType,
      coverage: element.coverage,
      delta: element.coverage - (prior?.coverage ?? 0),
      status: element.status,
    };
  });
  const newlyObserved = elements
    .filter((element) => {
      const prior = before.get(element.id);
      return element.status === 'observed' && (!prior || prior.status !== 'observed');
    })
    .map((element) => element.name);
  return {
    overallCoverage: current.overallCoverage,
    coverageDelta: current.overallCoverage - previous.overallCoverage,
    observedDelta: current.observed - previous.observed,
    elements,
    newlyObserved,
    regressed: elements
      .filter((element) => element.delta < -0.1)
      .map((element) => element.name),
  };
}
