import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { exportIfc } from '@apcc/core';
import type { BimElement, BimModel, ScheduledActivity, ScheduleResult } from '@apcc/core';

type Phase = 'done' | 'active' | 'planned';

interface BimViewerProps {
  model: BimModel;
  schedule: ScheduleResult;
  dataDate: string;
}

interface MeshEntry {
  mesh: THREE.Mesh;
  element: BimElement;
}

interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  pivot: THREE.Group;
  meshes: MeshEntry[];
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  frameId: number;
  observer: ResizeObserver;
}

const PHASE_COLOR: Record<Phase, number> = {
  done: 0x0f9d76,
  active: 0xe08a1e,
  planned: 0xaebccd,
};

const TYPE_LABEL: Record<BimElement['ifcType'], string> = {
  IfcSlab: '楼板',
  IfcColumn: '框架柱',
  IfcBeam: '主梁',
  IfcFooting: '承台',
  IfcWall: '墙体',
  IfcWindow: '窗',
  IfcDoor: '门',
  IfcRoof: '屋面',
  IfcBuildingElementProxy: '机电管线',
};

function phaseAt(
  schedule: ScheduleResult,
  activityId: string,
  index: number,
): { phase: Phase; ratio: number } {
  const activity: ScheduledActivity | undefined = schedule.byId[activityId];
  if (!activity) return { phase: 'planned', ratio: 0 };
  if (index >= activity.finishIndex) return { phase: 'done', ratio: 1 };
  if (index >= activity.startIndex) {
    const span = Math.max(1, activity.finishIndex - activity.startIndex);
    return {
      phase: 'active',
      ratio: Math.min(1, Math.max(0, (index - activity.startIndex) / span)),
    };
  }
  return { phase: 'planned', ratio: 0 };
}

const PHASE_RANK: Record<Phase, number> = { planned: 0, active: 1, done: 2 };
const GATED_TYPES = new Set<BimElement['ifcType']>([
  'IfcWall',
  'IfcWindow',
  'IfcDoor',
  'IfcRoof',
  'IfcBuildingElementProxy',
]);

/** 每层结构楼板活动（编码 3.L.2），作为围护/机电的施工前置条件。 */
function buildLevelGates(schedule: ScheduleResult): Map<number, ScheduledActivity> {
  const gates = new Map<number, ScheduledActivity>();
  for (const activity of schedule.activities) {
    const match = /^3\.(\d+)\.2$/.exec(activity.code);
    if (match) gates.set(Number(match[1]), activity);
  }
  return gates;
}

/**
 * 构件状态。围护、门窗、屋面与机电不能先于本层结构完成，
 * 因此用本层楼板活动做一次单调约束，避免演示时出现“上部先装窗”的错觉。
 */
function elementProgress(
  schedule: ScheduleResult,
  element: BimElement,
  index: number,
  gates: Map<number, ScheduledActivity>,
): { phase: Phase; ratio: number } {
  const own = phaseAt(schedule, element.activityId, index);
  if (!GATED_TYPES.has(element.ifcType)) return own;
  const gate = gates.get(element.level);
  if (!gate) return own;
  const gateProgress = phaseAt(schedule, gate.id, index);
  if (PHASE_RANK[gateProgress.phase] < PHASE_RANK[own.phase]) return gateProgress;
  if (own.phase === 'active' && gateProgress.phase === 'active') {
    return { phase: 'active', ratio: Math.min(own.ratio, gateProgress.ratio) };
  }
  return own;
}

function closestWorkingIndex(schedule: ScheduleResult, date: string): number {
  const exact = schedule.workingDays.indexOf(date);
  if (exact >= 0) return exact;
  const target = new Date(date).getTime();
  let bestIndex = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  schedule.workingDays.forEach((day, index) => {
    const delta = Math.abs(new Date(day).getTime() - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function buildMaterial(phase: Phase): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: PHASE_COLOR[phase],
    metalness: 0.08,
    roughness: 0.78,
    transparent: phase === 'planned',
    opacity: phase === 'planned' ? 0.32 : 1,
  });
}

function decorate(
  pivot: THREE.Group,
  entries: MeshEntry[],
  geometry: THREE.BufferGeometry,
  element: BimElement,
): void {
  const material = buildMaterial('planned');
  const mesh = new THREE.Mesh(geometry, material);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 28),
    new THREE.LineBasicMaterial({ color: 0x1f2a37, transparent: true, opacity: 0.24 }),
  );
  mesh.add(edges);
  mesh.userData.guid = element.guid;
  pivot.add(mesh);
  entries.push({ mesh, element });
}

/** 把 web-ifc 解析出的网格复制成 three 几何体。 */
function toGeometry(
  vertices: Float32Array,
  indices: Uint32Array,
  flatTransformation: number[],
): THREE.BufferGeometry {
  const count = Math.floor(vertices.length / 6);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = vertices[i * 6];
    positions[i * 3 + 1] = vertices[i * 6 + 1];
    positions[i * 3 + 2] = vertices[i * 6 + 2];
    normals[i * 3] = vertices[i * 6 + 3];
    normals[i * 3 + 1] = vertices[i * 6 + 4];
    normals[i * 3 + 2] = vertices[i * 6 + 5];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  geometry.applyMatrix4(new THREE.Matrix4().fromArray(flatTransformation));
  geometry.computeBoundingSphere();
  return geometry;
}

export function BimViewer({ model, schedule, dataDate }: BimViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bundleRef = useRef<SceneBundle | null>(null);
  const paintRef = useRef<((index: number) => void) | null>(null);
  const selectedRef = useRef<string | null>(null);

  const [engine, setEngine] = useState<'loading' | 'ifc' | 'boxes'>('loading');
  const [glError, setGlError] = useState(false);
  const [bimError, setBimError] = useState<string | null>(null);
  const [dayIndex, setDayIndex] = useState(() => closestWorkingIndex(schedule, dataDate));
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const total = Math.max(
    1,
    Math.min(schedule.projectDurationDays, schedule.workingDays.length),
  );
  const baseIndex = useMemo(
    () => Math.min(closestWorkingIndex(schedule, dataDate), total - 1),
    [schedule, dataDate, total],
  );
  const currentDate = schedule.workingDays[dayIndex] ?? dataDate;

  // 三维场景：按模型重建一次
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    const width = host.clientWidth || 720;
    const height = host.clientHeight || 400;
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
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.5, 400);

    const buildingHeight = model.levels.length * model.floorHeight;
    const center = new THREE.Vector3(
      model.footprint.width / 2,
      buildingHeight / 2,
      -model.footprint.depth / 2,
    );
    const radius = Math.sqrt(
      (model.footprint.width / 2) ** 2 +
        (model.footprint.depth / 2) ** 2 +
        (buildingHeight / 2) ** 2,
    );
    const fitDistance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.12;
    const span = Math.max(model.footprint.width, buildingHeight);
    camera.position
      .copy(center)
      .addScaledVector(new THREE.Vector3(1, 0.62, 1.15).normalize(), fitDistance);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 12;
    controls.maxDistance = span * 4;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xffffff, 0xdbe4ee, 1.35));
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.position.set(center.x + 40, 70, 30);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xc9d8ea, 0.55);
    fill.position.set(-30, 24, -40);
    scene.add(fill);

    const grid = new THREE.GridHelper(span * 2.4, 36, 0xd3dde8, 0xe7eef5);
    grid.position.set(center.x, 0, center.z);
    scene.add(grid);

    // web-ifc 输出的几何已是 Y 轴向上（x, y, z → x, z, -y），无需再旋转
    const pivot = new THREE.Group();
    scene.add(pivot);

    const entries: MeshEntry[] = [];
    const gates = buildLevelGates(schedule);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const paint = (index: number) => {
      for (const { mesh, element } of entries) {
        const material = mesh.material as THREE.MeshStandardMaterial;
        const { phase } = elementProgress(schedule, element, index, gates);
        const envelope =
          element.ifcType === 'IfcWall' ||
          element.ifcType === 'IfcWindow' ||
          element.ifcType === 'IfcDoor';
        const opacity = phase === 'planned' ? 0.24 : envelope ? 0.42 : 1;
        material.color.setHex(PHASE_COLOR[phase]);
        material.transparent = opacity < 1;
        material.opacity = opacity;
        material.depthWrite = opacity >= 1;
        const isSelected = element.guid === selectedRef.current;
        material.emissive.setHex(isSelected ? 0x1d4ed8 : 0x000000);
        material.emissiveIntensity = isSelected ? 0.55 : 0;
        const edge = mesh.children[0] as THREE.LineSegments | undefined;
        if (edge) {
          const edgeMaterial = edge.material as THREE.LineBasicMaterial;
          edgeMaterial.opacity = isSelected ? 0.9 : phase === 'planned' ? 0.12 : 0.24;
        }
      }
    };
    paintRef.current = paint;

    const loadBoxes = () => {
      for (const element of model.elements) {
        // 与 web-ifc 的 Y-up 输出保持一致
        const geometry = new THREE.BoxGeometry(
          element.size.x,
          element.size.z,
          element.size.y,
        );
        geometry.translate(
          element.position.x,
          element.position.z,
          -element.position.y,
        );
        decorate(pivot, entries, geometry, element);
      }
      paint(dayIndex);
      if (!disposed) setEngine('boxes');
    };

    const loadIfc = async () => {
      const ifcText = exportIfc(model);
      const [ifcModule, wasmModule] = await Promise.all([
        import('web-ifc'),
        import('web-ifc/web-ifc.wasm?url'),
      ]);
      const api = new ifcModule.IfcAPI();
      await api.Init(() => wasmModule.default);
      if (disposed) {
        api.Dispose();
        return;
      }
      const modelID = api.OpenModel(new TextEncoder().encode(ifcText));
      let streamed = 0;
      let sample = '';
      api.StreamAllMeshes(modelID, (flat) => {
        streamed += 1;
        const line = api.GetLine(modelID, flat.expressID, false) as
          | { GlobalId?: string | { value?: string } }
          | null;
        const raw = line?.GlobalId;
        const guid = typeof raw === 'string' ? raw : raw?.value;
        if (!sample) sample = JSON.stringify(line && Object.keys(line)).slice(0, 200);
        const element = guid ? model.byGuid[guid] : undefined;
        if (!element) return;
        const count = flat.geometries.size();
        for (let i = 0; i < count; i += 1) {
          const placed = flat.geometries.get(i);
          const ifcGeometry = api.GetGeometry(modelID, placed.geometryExpressID);
          const vertices = api.GetVertexArray(
            ifcGeometry.GetVertexData(),
            ifcGeometry.GetVertexDataSize(),
          );
          const indices = api.GetIndexArray(
            ifcGeometry.GetIndexData(),
            ifcGeometry.GetIndexDataSize(),
          );
          if (vertices.length < 18 || indices.length < 3) continue;
          decorate(
            pivot,
            entries,
            toGeometry(vertices, indices, placed.flatTransformation),
            element,
          );
        }
      });
      api.CloseModel(modelID);
      api.Dispose();
      if (entries.length === 0) {
        setBimError(`没有匹配到构件网格（streamed=${streamed}，字段=${sample}）`);
        loadBoxes();
        return;
      }
      paint(dayIndex);
      if (!disposed) setEngine('ifc');
    };

    loadIfc().catch((error: unknown) => {
      if (disposed) return;
      console.error('[bim] IFC 解析失败，改用盒体近似', error);
      setBimError(error instanceof Error ? error.message : String(error));
      entries.splice(0).forEach(({ mesh }) => {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        pivot.remove(mesh);
      });
      loadBoxes();
    });

    const onPointerDown = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };
    const onClick = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(
        entries.map((entry) => entry.mesh),
        false,
      );
      const guid = hits[0]?.object?.userData?.guid;
      selectedRef.current = typeof guid === 'string' ? guid : null;
      setSelectedGuid(selectedRef.current);
      paint(dayIndex);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
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

    const bundle: SceneBundle = {
      renderer,
      scene,
      camera,
      controls,
      pivot,
      meshes: entries,
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
      disposed = true;
      cancelAnimationFrame(bundle.frameId);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('click', onClick);
      controls.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
      bundleRef.current = null;
      paintRef.current = null;
      setEngine('loading');
    };
    // dayIndex 通过 paintRef 读取，避免重建场景
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, schedule]);

  // 数据日期变化时重新着色
  useEffect(() => {
    paintRef.current?.(dayIndex);
  }, [dayIndex, selectedGuid]);

  // 切换模型或数据日期时回到基准日
  useEffect(() => {
    setDayIndex(baseIndex);
    setSelectedGuid(null);
    selectedRef.current = null;
  }, [baseIndex, model]);

  // 工期变化（如导入新项目）时收敛滑杆范围
  useEffect(() => {
    setDayIndex((index) => Math.min(index, total - 1));
  }, [total]);

  // 自动播放
  useEffect(() => {
    if (!playing || total <= 1) return;
    const timer = window.setInterval(() => {
      setDayIndex((index) => (index + 1) % total);
    }, 160);
    return () => window.clearInterval(timer);
  }, [playing, total]);

  useEffect(() => {
    if (playing && dayIndex === total - 1) setPlaying(false);
  }, [playing, dayIndex, total]);

  const levels = useMemo(() => {
    const gates = buildLevelGates(schedule);
    return model.levels.map((level) => {
      const elements = model.elements.filter((element) => element.level === level.level);
      let done = 0;
      let active = 0;
      for (const element of elements) {
        const phase = elementProgress(schedule, element, dayIndex, gates).phase;
        if (phase === 'done') done += 1;
        else if (phase === 'active') active += 1;
      }
      return {
        ...level,
        done,
        active,
        planned: elements.length - done - active,
        count: elements.length,
      };
    });
  }, [model, schedule, dayIndex]);

  const selected = selectedGuid ? model.byGuid[selectedGuid] : null;
  const selectedActivity = selected ? schedule.byId[selected.activityId] : undefined;
  const selectedPhase = selected
    ? elementProgress(schedule, selected, dayIndex, buildLevelGates(schedule))
    : null;
  const engineLabel =
    engine === 'ifc' ? 'IFC4 / web-ifc 几何' : engine === 'boxes' ? '盒体近似（IFC 解析不可用）' : '解析中';

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>4D 构件回放（IFC4）</h3>
        <span className="panel-count">
          {model.elements.length} 个构件 · {model.levels.length} 层 · {currentDate}
        </span>
      </div>

      <div className="bim-body">
        <div className="bim-stage" ref={hostRef}>
          <span className="bim-badge" title={bimError ?? undefined}>
            {engineLabel}
          </span>
          <div className="bim-legend">
            <span>
              <i className="legend-dot" style={{ background: '#0f9d76' }} />
              已完成
            </span>
            <span>
              <i className="legend-dot" style={{ background: '#e08a1e' }} />
              进行中
            </span>
            <span>
              <i className="legend-dot" style={{ background: '#aebccd' }} />
              未开始
            </span>
          </div>
          {engine === 'loading' ? <div className="bim-loading">正在解析 IFC 几何…</div> : null}
          {glError ? (
            <div className="bim-loading">当前浏览器未启用 WebGL，无法渲染 4D 模型。</div>
          ) : null}
        </div>

        <aside className="bim-side">
          <div className="bim-date">
            <span>数据日期</span>
            <strong>{currentDate}</strong>
            <small>
              {dayIndex + 1} / {total} 工作日
            </small>
          </div>

          <input
            className="bim-slider"
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={dayIndex}
            onChange={(event) => {
              setPlaying(false);
              setDayIndex(Number(event.target.value));
            }}
          />

          <div className="bim-controls">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (dayIndex === total - 1) setDayIndex(0);
                setPlaying((value) => !value);
              }}
            >
              {playing ? '暂停' : '播放'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPlaying(false);
                setDayIndex(baseIndex);
              }}
            >
              回到数据日期
            </button>
          </div>

          <div className="bim-levels">
            {levels
              .slice()
              .reverse()
              .map((level) => (
                <div className="bim-level" key={level.level}>
                  <span className="bim-level-label">{level.label}</span>
                  <div className="bim-level-track">
                    <i
                      className="seg seg-done"
                      style={{ width: `${(level.done / level.count) * 100}%` }}
                    />
                    <i
                      className="seg seg-active"
                      style={{ width: `${(level.active / level.count) * 100}%` }}
                    />
                  </div>
                  <span className="bim-level-count">
                    {level.done + level.active}/{level.count}
                  </span>
                </div>
              ))}
          </div>

          <div className="bim-selected">
            {selected ? (
              <>
                <div className="bim-sel-head">
                  <strong>{selected.name}</strong>
                  <span className="bim-sel-type">{TYPE_LABEL[selected.ifcType]}</span>
                </div>
                <div className="bim-sel-row">
                  <span>楼层</span>
                  <b>
                    {selected.level}F · {selected.guid}
                  </b>
                </div>
                <div className="bim-sel-row">
                  <span>关联活动</span>
                  <b>
                    {selectedActivity
                      ? `${selectedActivity.code} ${selectedActivity.name}`
                      : '未绑定'}
                  </b>
                </div>
                {selectedActivity ? (
                  <div className="bim-sel-row">
                    <span>计划窗口</span>
                    <b>
                      {selectedActivity.startDate} → {selectedActivity.finishDate}
                    </b>
                  </div>
                ) : null}
                <div className="bim-sel-row">
                  <span>当日状态</span>
                  <b>
                    {selectedPhase?.phase === 'done'
                      ? '已完成'
                      : selectedPhase?.phase === 'active'
                        ? `进行中 ${Math.round((selectedPhase.ratio || 0) * 100)}%`
                        : '未开始'}
                  </b>
                </div>
              </>
            ) : (
              <p className="bim-sel-empty">点击模型中的构件，查看其关联的进度活动。</p>
            )}
          </div>
        </aside>
      </div>

      <p className="panel-foot">
        IFC4 演示模型由 core 程序化生成：{model.typeCounts.IfcColumn} 柱 /{' '}
        {model.typeCounts.IfcBeam} 梁 / {model.typeCounts.IfcSlab} 板 /{' '}
        {model.typeCounts.IfcFooting} 承台 / {model.typeCounts.IfcWall} 墙 /{' '}
        {model.typeCounts.IfcWindow} 窗 / {model.typeCounts.IfcDoor} 门 /{' '}
        {model.typeCounts.IfcRoof} 屋面 / {model.typeCounts.IfcBuildingElementProxy} 机电构件，
        经 web-ifc 解析几何后按数据日期着色；后续可替换为 IfcOpenShell 转换的真实项目模型。
      </p>
    </section>
  );
}
