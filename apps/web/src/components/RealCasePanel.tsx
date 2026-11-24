import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { analyzeScanVsBim, diffRealCaseReports, parsePly } from '@apcc/core';
import type { ParsedPointCloud, RealCaseReport, RealCaseStatus } from '@apcc/core';
import { fetchRealityAsset, loadRealityCase } from '../api';
import type { RealityCaseMeta } from '../api';
import { pct } from '../format';

interface CaseMesh {
  id: string;
  ifcType: string;
  name: string;
  /** web-ifc 世界坐标：X 向右、Y 向上、Z 向前 */
  positions: Float32Array;
  indices: Uint32Array;
}

interface Offset3 {
  x: number;
  y: number;
  z: number;
}

interface CaseEpoch {
  id: string;
  label: string;
  date: string;
  source: 'real' | 'upload' | '3dgs';
  fileName?: string;
  cloud: ParsedPointCloud;
  report: RealCaseReport;
}

interface StageBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  modelGroup: THREE.Group;
  cloud: THREE.Points;
  entries: { mesh: THREE.Mesh; id: string }[];
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  frameId: number;
  observer: ResizeObserver;
}

const STATUS_COLOR: Record<RealCaseStatus, number> = {
  observed: 0x0f9d76,
  partial: 0xe08a1e,
  insufficient: 0xdc2626,
};

const STATUS_LABEL: Record<RealCaseStatus, string> = {
  observed: '充分观测',
  partial: '部分观测',
  insufficient: '证据不足',
};

const TYPE_LABEL: Record<string, string> = {
  IfcWallStandardCase: '墙体',
  IfcWall: '墙体',
  IfcCovering: '吊顶/面层',
  IfcDoor: '门',
  IfcWindow: '窗',
  IfcSlab: '楼板',
  IfcColumn: '柱',
  IfcBeam: '梁',
  IfcRoof: '屋面',
  IfcBuildingElementProxy: '其它构件',
};

function typeLabel(ifcType: string): string {
  return TYPE_LABEL[ifcType] ?? ifcType.replace(/^Ifc/, '');
}

function splatTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 30);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 把点云坐标（Z 轴向上）转到 three / web-ifc 的 Y 轴向上坐标。 */
function toWorld(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

async function loadCaseMeshes(url: string): Promise<CaseMesh[]> {
  const [ifcModule, wasmModule] = await Promise.all([
    import('web-ifc'),
    import('web-ifc/web-ifc.wasm?url'),
  ]);
  const buffer = await fetchRealityAsset(url);
  const api = new ifcModule.IfcAPI();
  await api.Init(() => wasmModule.default);
  const modelID = api.OpenModel(new Uint8Array(buffer));
  const groups = new Map<
    number,
    { positions: number[]; indices: number[]; ifcType: string; name: string }
  >();
  try {
    api.StreamAllMeshes(modelID, (flat) => {
      const line = api.GetLine(modelID, flat.expressID, false) as {
        Name?: string | { value?: string };
        constructor?: { name?: string };
      } | null;
      const ifcType = line?.constructor?.name ?? 'IfcBuildingElementProxy';
      const rawName = line?.Name;
      const name =
        (typeof rawName === 'string' ? rawName : rawName?.value) ?? `#${flat.expressID}`;
      let group = groups.get(flat.expressID);
      if (!group) {
        group = { positions: [], indices: [], ifcType, name };
        groups.set(flat.expressID, group);
      }
      for (let i = 0; i < flat.geometries.size(); i += 1) {
        const placed = flat.geometries.get(i);
        const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
        const vertices = api.GetVertexArray(
          geometry.GetVertexData(),
          geometry.GetVertexDataSize(),
        );
        const indices = api.GetIndexArray(
          geometry.GetIndexData(),
          geometry.GetIndexDataSize(),
        );
        if (vertices.length < 18 || indices.length < 3) continue;
        const base = group.positions.length / 3;
        const t = placed.flatTransformation;
        for (let k = 0; k < vertices.length; k += 6) {
          const x = vertices[k];
          const y = vertices[k + 1];
          const z = vertices[k + 2];
          group.positions.push(
            t[0] * x + t[4] * y + t[8] * z + t[12],
            t[1] * x + t[5] * y + t[9] * z + t[13],
            t[2] * x + t[6] * y + t[10] * z + t[14],
          );
        }
        for (let k = 0; k < indices.length; k += 1) {
          group.indices.push(base + indices[k]);
        }
      }
    });
  } finally {
    api.CloseModel(modelID);
    api.Dispose();
  }
  return [...groups.entries()].map(([id, group]) => ({
    id: String(id),
    ifcType: group.ifcType,
    name: group.name,
    positions: new Float32Array(group.positions),
    indices: new Uint32Array(group.indices),
  }));
}

/** 把 web-ifc 世界坐标转成点云坐标系（X 右、Y 前、Z 上）后做覆盖对比。 */
function analyzeCloud(
  meshes: CaseMesh[],
  cloud: ParsedPointCloud,
  tolerance: number,
  offset: Offset3,
): RealCaseReport {
  const surfaces = meshes.map((mesh) => {
    const positions = new Float32Array(mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      positions[i] = mesh.positions[i] + offset.x;
      positions[i + 1] = -mesh.positions[i + 2] + offset.y;
      positions[i + 2] = mesh.positions[i + 1] + offset.z;
    }
    return {
      id: mesh.id,
      ifcType: mesh.ifcType,
      name: mesh.name,
      positions,
      indices: mesh.indices,
    };
  });
  return analyzeScanVsBim(surfaces, cloud.points, {
    tolerance,
    samplesPerElement: 220,
  });
}

function EpochChart({
  epochs,
  activeId,
  onSelect,
}: {
  epochs: CaseEpoch[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  if (epochs.length === 0) return null;
  const left = 26;
  const right = 286;
  const top = 18;
  const bottom = 82;
  const step = epochs.length > 1 ? (right - left) / (epochs.length - 1) : 0;
  const at = (index: number) => (epochs.length > 1 ? left + step * index : (left + right) / 2);
  const y = (coverage: number) => bottom - Math.max(0, Math.min(1, coverage)) * (bottom - top);
  const line = epochs
    .map((epoch, index) => `${at(index)},${y(epoch.report.overallCoverage)}`)
    .join(' ');
  return (
    <svg className="case-chart" viewBox="0 0 312 104" role="img" aria-label="实测期覆盖率变化">
      {[0, 0.5, 1].map((value) => (
        <g key={value}>
          <line
            x1={left}
            x2={right}
            y1={y(value)}
            y2={y(value)}
            stroke={value === 0 ? '#cbd5e1' : '#e2e8f0'}
            strokeDasharray={value === 0 ? undefined : '3 4'}
          />
          <text x={4} y={y(value) + 3} className="case-chart-axis">
            {Math.round(value * 100)}%
          </text>
        </g>
      ))}
      {epochs.length > 1 ? (
        <polyline points={line} fill="none" stroke="#1d4ed8" strokeWidth={2} />
      ) : null}
      {epochs.map((epoch, index) => {
        const cx = at(index);
        const cy = y(epoch.report.overallCoverage);
        const active = epoch.id === activeId;
        return (
          <g
            key={epoch.id}
            className="case-chart-point"
            onClick={() => onSelect(epoch.id)}
            role="button"
          >
            <circle cx={cx} cy={cy} r={active ? 5 : 3.5} fill={active ? '#1d4ed8' : '#93c5fd'} />
            <text x={cx} y={cy - 8} textAnchor="middle" className="case-chart-value">
              {Math.round(epoch.report.overallCoverage * 100)}%
            </text>
            <text x={cx} y={98} textAnchor="middle" className="case-chart-label">
              {epoch.date.slice(5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function RealCasePanel() {
  const [meta, setMeta] = useState<RealityCaseMeta | null>(null);
  const [meshes, setMeshes] = useState<CaseMesh[]>([]);
  const [epochs, setEpochs] = useState<CaseEpoch[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stage, setStage] = useState<'loading' | 'ready' | 'error'>('loading');
  const [status, setStatus] = useState('正在读取真实案例元数据…');
  const [error, setError] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState(0.1);
  const [offset, setOffset] = useState<Offset3>({ x: 0, y: 0, z: 0 });
  const [showCloud, setShowCloud] = useState(true);
  const [showModel, setShowModel] = useState(true);
  const [colorMode, setColorMode] = useState<'status' | 'design'>('status');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploadDate, setUploadDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CaseEpoch | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [glError, setGlError] = useState(false);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const bundleRef = useRef<StageBundle | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const active = epochs.find((epoch) => epoch.id === activeId) ?? epochs[0] ?? null;
  const displayed = preview ?? active;
  const activeIndex = active ? epochs.findIndex((epoch) => epoch.id === active.id) : -1;
  const previous = activeIndex > 0 ? epochs[activeIndex - 1] : null;
  const delta = useMemo(
    () =>
      !preview && previous && active
        ? diffRealCaseReports(previous.report, active.report)
        : null,
    [preview, previous, active],
  );
  const selected =
    displayed?.report.elements.find((element) => element.id === selectedId) ?? null;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setStatus('读取案例元数据…');
        const caseMeta = await loadRealityCase();
        if (!alive) return;
        setMeta(caseMeta);
        setTolerance(caseMeta.defaultTolerance);
        setStatus('解析 IFC 模型（web-ifc）…');
        const loadedMeshes = await loadCaseMeshes(caseMeta.files.model);
        if (!alive) return;
        setMeshes(loadedMeshes);
        setStatus('加载实测点云并计算覆盖…');
        const buffer = await fetchRealityAsset(caseMeta.files.scan);
        const cloud = parsePly(buffer);
        const report = analyzeCloud(loadedMeshes, cloud, caseMeta.defaultTolerance, {
          x: 0,
          y: 0,
          z: 0,
        });
        if (!alive) return;
        const realMeta = caseMeta.epochs[0];
        const epoch: CaseEpoch = {
          id: realMeta?.id ?? 'real',
          label: realMeta?.label ?? '实测期',
          date: realMeta?.date ?? '',
          source: 'real',
          cloud,
          report,
        };
        setEpochs([epoch]);
        setActiveId(epoch.id);
        setStage('ready');
      } catch (cause) {
        if (!alive) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStage('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 容差或对位偏移变化时重算全部实测期与 3DGS 验证样本
  useEffect(() => {
    if (meshes.length === 0) return;
    setEpochs((current) => {
      if (current.length === 0) return current;
      return current.map((epoch) => ({
        ...epoch,
        report: analyzeCloud(meshes, epoch.cloud, tolerance, offset),
      }));
    });
    setPreview((current) =>
      current
        ? { ...current, report: analyzeCloud(meshes, current.cloud, tolerance, offset) }
        : current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tolerance, offset.x, offset.y, offset.z, meshes]);

  // 三维场景：模型就绪后创建一次
  useEffect(() => {
    const host = hostRef.current;
    if (!host || meshes.length === 0) return;
    const width = host.clientWidth || 720;
    const height = host.clientHeight || 460;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setGlError(true);
      return;
    }
    setGlError(false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.05, 200);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xdbe4ee, 1.35));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(30, 60, 28);
    scene.add(sun);

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);
    const entries: { mesh: THREE.Mesh; id: string }[] = [];

    const buildModel = () => {
      for (const item of meshes) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(item.positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(item.indices, 1));
        geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({
          color: 0x94a3b8,
          metalness: 0.05,
          roughness: 0.82,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.id = item.id;
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geometry, 28),
          new THREE.LineBasicMaterial({
            color: 0x1f2a37,
            transparent: true,
            opacity: 0.26,
          }),
        );
        mesh.add(edges);
        modelGroup.add(mesh);
        entries.push({ mesh, id: item.id });
      }
      const box = new THREE.Box3().setFromObject(modelGroup);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(1, size.length() / 2);
      camera.position
        .copy(center)
        .addScaledVector(
          new THREE.Vector3(1, 0.7, 1.15).normalize(),
          (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05,
        );
      camera.near = Math.max(0.02, radius / 200);
      camera.far = radius * 40;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      const grid = new THREE.GridHelper(
        Math.max(size.x, size.z) * 2.2,
        32,
        0xd3dde8,
        0xe7eef5,
      );
      grid.position.set(center.x, box.min.y, center.z);
      scene.add(grid);
    };

    const cloudGeometry = new THREE.BufferGeometry();
    const cloudMaterial = new THREE.PointsMaterial({
      size: 0.05,
      map: splatTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      alphaTest: 0.04,
      sizeAttenuation: true,
    });
    const cloud = new THREE.Points(cloudGeometry, cloudMaterial);
    scene.add(cloud);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.495;

    buildModel();
    modelGroup.position.set(offset.x, offset.z, -offset.y);
    modelGroup.visible = showModel;
    cloud.visible = showCloud;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onClick = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(
        entries.map((entry) => entry.mesh),
        false,
      )[0];
      const id = hit?.object?.userData?.id;
      setSelectedId(typeof id === 'string' ? id : null);
    };
    renderer.domElement.addEventListener('click', onClick);

    const observer = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    observer.observe(host);

    const bundle: StageBundle = {
      renderer,
      scene,
      camera,
      controls,
      modelGroup,
      cloud,
      entries,
      raycaster,
      pointer,
      frameId: 0,
      observer,
    };
    bundleRef.current = bundle;
    const animate = () => {
      bundle.frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(bundle.frameId);
      observer.disconnect();
      renderer.domElement.removeEventListener('click', onClick);
      controls.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      });
      cloudMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      bundleRef.current = null;
    };
  }, [meshes]);

  // 切换实测期或 3DGS 样本：更新点云几何
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !displayed) return;
    const count = displayed.cloud.points.length;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    displayed.cloud.points.forEach((point, index) => {
      const [wx, wy, wz] = toWorld(point.x, point.y, point.z);
      positions[index * 3] = wx;
      positions[index * 3 + 1] = wy;
      positions[index * 3 + 2] = wz;
      colors[index * 3] = point.r / 255;
      colors[index * 3 + 1] = point.g / 255;
      colors[index * 3 + 2] = point.b / 255;
    });
    const geometry = bundle.cloud.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    bundle.cloud.visible = showCloud;
  }, [displayed, showCloud]);

  // 模型着色：状态 / 设计，以及选中高亮
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle) return;
    const report = displayed?.report;
    const byId = new Map(report?.elements.map((element) => [element.id, element]) ?? []);
    for (const { mesh, id } of bundle.entries) {
      const material = mesh.material as THREE.MeshStandardMaterial;
      const element = byId.get(id);
      const color =
        colorMode === 'status' && element ? STATUS_COLOR[element.status] : 0x94a3b8;
      material.color.setHex(color);
      material.opacity = colorMode === 'status' ? 0.42 : 0.28;
      material.emissive.setHex(id === selectedId ? 0x1d4ed8 : 0x000000);
      material.emissiveIntensity = id === selectedId ? 0.6 : 0;
      const edges = mesh.children[0] as THREE.LineSegments | undefined;
      if (edges) {
        const edgeMaterial = edges.material as THREE.LineBasicMaterial;
        edgeMaterial.opacity = id === selectedId ? 0.9 : 0.26;
      }
    }
  }, [displayed, colorMode, selectedId]);

  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle) return;
    bundle.modelGroup.position.set(offset.x, offset.z, -offset.y);
  }, [offset]);

  useEffect(() => {
    const bundle = bundleRef.current;
    if (bundle) bundle.cloud.visible = showCloud;
  }, [showCloud]);

  useEffect(() => {
    const bundle = bundleRef.current;
    if (bundle) bundle.modelGroup.visible = showModel;
  }, [showModel]);

  async function handleUpload(file: File) {
    if (meshes.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const cloud = parsePly(buffer, { maxPoints: 600_000 });
      const report = analyzeCloud(meshes, cloud, tolerance, offset);
      const date = uploadDate || today();
      const epoch: CaseEpoch = {
        id: `upload-${Date.now()}`,
        label: `${date} ${file.name}`,
        date,
        source: 'upload',
        fileName: file.name,
        cloud,
        report,
      };
      setEpochs((current) => [...current, epoch]);
      setActiveId(epoch.id);
      setPreview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handle3dgsPreview() {
    if (!meta?.files.verify3dgs || meshes.length === 0) return;
    if (preview) {
      setPreview(null);
      return;
    }
    setPreviewBusy(true);
    setError(null);
    try {
      const buffer = await fetchRealityAsset(meta.files.verify3dgs);
      const cloud = parsePly(buffer);
      const report = analyzeCloud(meshes, cloud, tolerance, offset);
      setPreview({
        id: 'verify-3dgs',
        label: meta.verification?.label ?? '3DGS 格式验证样本',
        date: '',
        source: '3dgs',
        cloud,
        report,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPreviewBusy(false);
    }
  }

  if (stage === 'error') {
    return (
      <section className="panel">
        <div className="panel-head">
          <h3>真实案例：点云（含 3DGS）vs IFC</h3>
          <span className="panel-count">未连接</span>
        </div>
        <div className="case-empty">
          <p>真实案例需要 API 提供 /api/reality/case 资产。</p>
          <p className="case-empty-detail">{error}</p>
          <p className="case-empty-detail">
            本地启动：npm run dev；若案例文件缺失，运行 npx tsx
            scripts/prepare-reality-case.ts。
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>真实案例：点云（含 3DGS）vs IFC（{meta?.subtitle ?? '加载中'}）</h3>
        <span className="panel-count">
          {stage === 'ready' && displayed
            ? preview
              ? `${displayed.cloud.pointCount.toLocaleString('zh-CN')} 点 · 覆盖 ${pct(
                  displayed.report.overallCoverage,
                )} · 3DGS 格式验证 · 非训练产物`
              : `${displayed.cloud.pointCount.toLocaleString('zh-CN')} 点 · 覆盖 ${pct(
                  displayed.report.overallCoverage,
                )} · ${displayed.date} 实测 · 非 3DGS 训练`
            : status}
        </span>
      </div>

      <div className="case-body">
        <div className="case-main">
          <div className="case-stage" ref={hostRef}>
            <span className="case-badge">
              {preview
                ? `3DGS 格式验证样本（${meta?.verification?.points.toLocaleString('zh-CN') ?? '—'} 点，实测转换） · 容差 ${Math.round(tolerance * 1000)} mm`
                : `真实 LiDAR 点云 + IFC2X3 · 容差 ${Math.round(tolerance * 1000)} mm`}
            </span>
            <div className="case-legend">
              <span>
                <i className="legend-dot" style={{ background: '#0f9d76' }} />
                充分观测
              </span>
              <span>
                <i className="legend-dot" style={{ background: '#e08a1e' }} />
                部分观测
              </span>
              <span>
                <i className="legend-dot" style={{ background: '#dc2626' }} />
                证据不足
              </span>
            </div>
            {stage !== 'ready' ? <div className="bim-loading">{status}</div> : null}
            {glError ? (
              <div className="bim-loading">当前浏览器未启用 WebGL，无法渲染点云。</div>
            ) : null}
          </div>

          <div className="case-strip">
            <div className="case-toggles">
              <button
                type="button"
                className={`btn ${showCloud ? 'btn-ghost' : ''}`}
                onClick={() => setShowCloud((value) => !value)}
              >
                {showCloud ? '隐藏点云' : '显示点云'}
              </button>
              <button
                type="button"
                className={`btn ${showModel ? 'btn-ghost' : ''}`}
                onClick={() => setShowModel((value) => !value)}
              >
                {showModel ? '隐藏模型' : '显示模型'}
              </button>
              <button
                type="button"
                className={`btn ${colorMode === 'status' ? 'btn-ghost' : ''}`}
                onClick={() =>
                  setColorMode((mode) => (mode === 'status' ? 'design' : 'status'))
                }
              >
                {colorMode === 'status' ? '状态着色' : '设计着色'}
              </button>
              <label className="case-field">
                容差
                <select
                  value={tolerance}
                  onChange={(event) => setTolerance(Number(event.target.value))}
                >
                  <option value={0.05}>50 mm</option>
                  <option value={0.1}>100 mm</option>
                  <option value={0.15}>150 mm</option>
                  <option value={0.2}>200 mm</option>
                </select>
              </label>
            </div>
            <div className="case-offsets">
              <span>对位偏移（m）</span>
              {(['x', 'y', 'z'] as const).map((axis) => (
                <label key={axis} className="case-field">
                  {axis.toUpperCase()}
                  <input
                    type="number"
                    step={0.02}
                    value={offset[axis]}
                    onChange={(event) =>
                      setOffset((current) => ({
                        ...current,
                        [axis]: Number(event.target.value) || 0,
                      }))
                    }
                  />
                </label>
              ))}
              <button
                type="button"
                className="btn"
                onClick={() => setOffset({ x: 0, y: 0, z: 0 })}
              >
                归零
              </button>
            </div>
          </div>

          <div className="case-notes">
            <p>
              {meta?.boundary ??
                '真实扫描点云与 IFC 设计模型的几何对比，不是 3DGS 训练结果。'}
            </p>
            <p>
              来源：
              <a href={meta?.source.url} target="_blank" rel="noreferrer">
                {meta?.source.repository ?? 'pcd-bim-matching-confidence'}
              </a>
              （{meta?.source.license ?? 'Apache-2.0'}） · 原始点云{' '}
              {meta?.processing.sourcePoints.toLocaleString('zh-CN') ?? '—'} 点，体素降采样至{' '}
              {meta?.processing.points.toLocaleString('zh-CN') ?? '—'} 点。
            </p>
          </div>
        </div>

        <aside className="case-side">
          <div className="reality-kpis">
            <div>
              <span>表面覆盖率</span>
              <strong>{displayed ? pct(displayed.report.overallCoverage) : '—'}</strong>
            </div>
            <div>
              <span>充分观测</span>
              <strong>
                {displayed
                  ? `${displayed.report.observed}/${displayed.report.elements.length}`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>平均偏差</span>
              <strong>
                {displayed ? `${(displayed.report.meanDeviation * 1000).toFixed(0)} mm` : '—'}
              </strong>
            </div>
            <div>
              <span>{preview ? '3DGS 点数' : '实测点数'}</span>
              <strong>
                {displayed ? displayed.cloud.pointCount.toLocaleString('zh-CN') : '—'}
              </strong>
            </div>
          </div>

          <div className="case-block">
            <div className="case-block-head">
              <span>实测期（时序）</span>
              <small>
                {epochs.length} 期 ·{' '}
                {preview
                  ? '当前为 3DGS 验证'
                  : active?.source === 'upload'
                    ? '本地上传'
                    : '案例数据'}
              </small>
            </div>
            <EpochChart
              epochs={epochs}
              activeId={preview ? null : (active?.id ?? null)}
              onSelect={(id) => {
                setPreview(null);
                setActiveId(id);
              }}
            />
            <div className="case-epochs">
              {epochs.map((epoch) => (
                <button
                  key={epoch.id}
                  type="button"
                  className={`case-epoch ${
                    !preview && epoch.id === active?.id ? 'is-active' : ''
                  }`}
                  onClick={() => {
                    setPreview(null);
                    setActiveId(epoch.id);
                  }}
                >
                  <i
                    className={
                      epoch.source === 'upload' ? 'case-epoch-dot upload' : 'case-epoch-dot'
                    }
                  />
                  <span>{epoch.label}</span>
                  <b>{pct(epoch.report.overallCoverage)}</b>
                </button>
              ))}
              {preview ? (
                <button
                  type="button"
                  className="case-epoch is-active"
                  onClick={() => setPreview(null)}
                >
                  <i className="case-epoch-dot format" />
                  <span>{preview.label}</span>
                  <b>{pct(preview.report.overallCoverage)}</b>
                </button>
              ) : null}
            </div>
            {preview ? (
              <p className="case-delta">
                当前显示 3DGS 格式验证样本：由实测点云转换，不是训练得到的高斯；覆盖率差异主要来自
                点密度与格式转换，不能作为重建精度结论。
              </p>
            ) : delta ? (
              <p className="case-delta">
                较上一期 {delta.coverageDelta >= 0 ? '+' : ''}
                {(delta.coverageDelta * 100).toFixed(1)} 个百分点 · 新充分观测{' '}
                {delta.observedDelta >= 0 ? '+' : ''}
                {delta.observedDelta} 个构件
                {delta.newlyObserved.length > 0
                  ? `（${delta.newlyObserved.slice(0, 2).join('、')}）`
                  : ''}
              </p>
            ) : (
              <p className="case-delta">
                {epochs.length > 1
                  ? '当前为首期，选择后续实测期可查看增量。'
                  : '目前仅一期真实实测。可上传后续 .ply 点云（含 3DGS 导出）形成时序对比。'}
              </p>
            )}
            <div className="case-upload">
              <label className="case-field">
                实测日期
                <input
                  type="date"
                  value={uploadDate}
                  onChange={(event) => setUploadDate(event.target.value)}
                />
              </label>
              <input
                ref={fileRef}
                type="file"
                accept=".ply,.PLY"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleUpload(file);
                }}
              />
              <button
                type="button"
                className="btn"
                disabled={busy || stage !== 'ready'}
                onClick={() => fileRef.current?.click()}
              >
                {busy ? '解析中…' : '追加实测期 (.ply)'}
              </button>
              {meta?.files.verify3dgs ? (
                <button
                  type="button"
                  className={`btn ${preview ? 'btn-ghost' : ''}`}
                  disabled={previewBusy || stage !== 'ready'}
                  onClick={() => void handle3dgsPreview()}
                >
                  {previewBusy
                    ? '载入中…'
                    : preview
                      ? '返回实测期'
                      : '查看 3DGS 格式样本'}
                </button>
              ) : null}
            </div>
            <p className="case-hint">
              {meta?.verification?.caveat ??
                '上传点云按案例坐标系（Z 向上、已配准）解析；3DGS 训练导出的 .ply 可直接作为新一期点源。'}
            </p>
            {error ? <p className="case-error">{error}</p> : null}
          </div>

          <div className="case-block">
            <div className="case-block-head">
              <span>构件覆盖</span>
              <small>按表面积排序</small>
            </div>
            <div className="case-elements">
              {displayed?.report.elements.map((element) => (
                <button
                  key={element.id}
                  type="button"
                  className={`case-el ${element.id === selectedId ? 'is-selected' : ''}`}
                  onClick={() => setSelectedId(element.id)}
                >
                  <i className={`case-dot status-${element.status}`} />
                  <span className="case-el-name" title={element.name}>
                    {typeLabel(element.ifcType)} · {element.name}
                  </span>
                  <span className="case-el-bar">
                    <i
                      style={{ width: `${Math.min(100, element.coverage * 100).toFixed(1)}%` }}
                    />
                  </span>
                  <b>{pct(element.coverage)}</b>
                </button>
              ))}
            </div>
          </div>

          {selected ? (
            <div className="case-selected">
              <div className="bim-sel-head">
                <strong>{typeLabel(selected.ifcType)}</strong>
                <span className={`case-status status-${selected.status}`}>
                  {STATUS_LABEL[selected.status]}
                </span>
              </div>
              <div className="bim-sel-row">
                <span>名称</span>
                <b>{selected.name}</b>
              </div>
              <div className="bim-sel-row">
                <span>表面积</span>
                <b>{selected.area.toFixed(2)} m²</b>
              </div>
              <div className="bim-sel-row">
                <span>覆盖率</span>
                <b>
                  {pct(selected.coverage)}（{selected.matchedSamples}/{selected.samples} 采样）
                </b>
              </div>
              <div className="bim-sel-row">
                <span>偏差</span>
                <b>
                  {selected.matchedSamples > 0
                    ? `均值 ${(selected.meanDeviation * 1000).toFixed(0)} mm · 最大 ${(
                        selected.maxDeviation * 1000
                      ).toFixed(0)} mm`
                    : '无容差内匹配点'}
                </b>
              </div>
            </div>
          ) : (
            <div className="case-selected empty">
              点击三维构件或下方列表查看单个构件的覆盖率与偏差。
            </div>
          )}

          {displayed ? (
            <div className="case-block">
              <div className="case-block-head">
                <span>高度分层覆盖</span>
                <small>扫描坐标系 Z</small>
              </div>
              <div className="reality-levels">
                {displayed.report.byHeight.map((band) => (
                  <div className="reality-level" key={band.label}>
                    <span className="bim-level-label">{band.label.split('–')[0]}</span>
                    <span className="reality-level-track">
                      <i style={{ width: `${Math.min(100, band.coverage * 100)}%` }} />
                    </span>
                    <b>{pct(band.coverage)}</b>
                    <small>{band.area.toFixed(0)} m²</small>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="case-block">
            <div className="case-block-head">
              <span>数据与许可</span>
              <small>{meta?.source.license ?? '—'}</small>
            </div>
            <p className="case-source">
              {meta?.source.citation ?? '等待案例元数据。'}
            </p>
            <div className="case-links">
              <a href={meta?.source.doi} target="_blank" rel="noreferrer">
                论文 DOI
              </a>
              <a href={meta?.files.scan} download>
                下载降采样点云
              </a>
              <a href={meta?.files.model} download>
                下载 IFC
              </a>
              {meta?.files.verify3dgs ? (
                <a href={meta.files.verify3dgs} download>
                  下载 3DGS 格式样本
                </a>
              ) : null}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
