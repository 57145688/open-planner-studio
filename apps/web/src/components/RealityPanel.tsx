import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildRealityCapture } from '@apcc/core';
import type { Activity, BimElement, BimModel, RealitySummary } from '@apcc/core';
import { pct } from '../format';

type ColorMode = 'deviation' | 'type';

interface RealityPanelProps {
  model: BimModel;
  activities: Activity[];
  summary: RealitySummary;
  dataDate: string;
}

const TYPE_RGB: Record<BimElement['ifcType'], [number, number, number]> = {
  IfcSlab: [154, 165, 177],
  IfcColumn: [184, 193, 204],
  IfcBeam: [170, 180, 192],
  IfcFooting: [141, 153, 174],
  IfcWall: [203, 213, 225],
  IfcWindow: [103, 232, 249],
  IfcDoor: [180, 83, 9],
  IfcRoof: [148, 163, 184],
  IfcBuildingElementProxy: [251, 146, 60],
};

const ISSUE_LABEL: Record<string, string> = {
  missing: '缺失',
  offset: '偏移',
  extra: '多余',
};

function deviationRgb(deviation: number, extra: boolean): [number, number, number] {
  if (extra) return [168, 85, 247];
  if (deviation < 0.03) return [22, 163, 74];
  if (deviation < 0.05) return [245, 158, 11];
  return [220, 38, 38];
}

function splatTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 30);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export function RealityPanel({ model, activities, summary, dataDate }: RealityPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const overlayRef = useRef<THREE.Group | null>(null);
  const colorsRef = useRef<{ deviation: Float32Array; type: Float32Array } | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('deviation');
  const [showBim, setShowBim] = useState(false);
  const [glError, setGlError] = useState(false);

  const capture = useMemo(
    () => buildRealityCapture(model, activities),
    [model, activities],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const width = host.clientWidth || 720;
    const height = host.clientHeight || 420;

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
    const height3d = model.levels.length * model.floorHeight;
    const center = new THREE.Vector3(
      model.footprint.width / 2,
      height3d / 2,
      -model.footprint.depth / 2,
    );
    const radius = Math.sqrt(
      (model.footprint.width / 2) ** 2 +
        (model.footprint.depth / 2) ** 2 +
        (height3d / 2) ** 2,
    );
    camera.position
      .copy(center)
      .addScaledVector(
        new THREE.Vector3(1, 0.7, 1.2).normalize(),
        (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05,
      );

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 10;
    controls.maxDistance = Math.max(model.footprint.width, height3d) * 5;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xffffff, 0xdbe4ee, 1.2));
    const grid = new THREE.GridHelper(
      Math.max(model.footprint.width, model.footprint.depth) * 2.2,
      32,
      0xd3dde8,
      0xe7eef5,
    );
    grid.position.set(center.x, 0, center.z);
    scene.add(grid);

    const positions = new Float32Array(capture.points.length * 3);
    const deviationColors = new Float32Array(capture.points.length * 3);
    const typeColors = new Float32Array(capture.points.length * 3);
    capture.points.forEach((point, index) => {
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.z;
      positions[index * 3 + 2] = -point.y;
      const devColor = deviationRgb(point.deviation, point.extra);
      deviationColors[index * 3] = devColor[0] / 255;
      deviationColors[index * 3 + 1] = devColor[1] / 255;
      deviationColors[index * 3 + 2] = devColor[2] / 255;
      const element = point.elementGuid ? model.byGuid[point.elementGuid] : null;
      const typeColor = element ? TYPE_RGB[element.ifcType] : [168, 85, 247];
      typeColors[index * 3] = typeColor[0] / 255;
      typeColors[index * 3 + 1] = typeColor[1] / 255;
      typeColors[index * 3 + 2] = typeColor[2] / 255;
    });
    colorsRef.current = { deviation: deviationColors, type: typeColors };

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(colorMode === 'deviation' ? deviationColors : typeColors, 3),
    );
    const material = new THREE.PointsMaterial({
      size: 0.34,
      map: splatTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      alphaTest: 0.08,
      sizeAttenuation: true,
    });
    const cloud = new THREE.Points(geometry, material);
    pointsRef.current = cloud;
    scene.add(cloud);

    // BIM 设计模型线框，用于与实景点云叠加比对
    const overlay = new THREE.Group();
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x1e293b,
      transparent: true,
      opacity: 0.22,
    });
    for (const element of model.elements) {
      const box = new THREE.BoxGeometry(element.size.x, element.size.z, element.size.y);
      const edges = new THREE.EdgesGeometry(box);
      box.dispose();
      const lines = new THREE.LineSegments(edges, lineMaterial);
      lines.position.set(element.position.x, element.position.z, -element.position.y);
      overlay.add(lines);
    }
    overlay.visible = showBim;
    overlayRef.current = overlay;
    scene.add(overlay);

    const observer = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    observer.observe(host);

    let frameId = 0;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      controls.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((item) => item.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
      pointsRef.current = null;
      overlayRef.current = null;
      colorsRef.current = null;
    };
    // 仅在模型或点云变化时重建场景
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, model]);

  useEffect(() => {
    const colors = colorsRef.current;
    const cloud = pointsRef.current;
    if (!colors || !cloud) return;
    cloud.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(
        colorMode === 'deviation' ? colors.deviation : colors.type,
        3,
      ),
    );
  }, [colorMode]);

  useEffect(() => {
    if (overlayRef.current) overlayRef.current.visible = showBim;
  }, [showBim]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>模拟实景核验（合成点云）</h3>
        <span className="panel-count">
          {summary.totalPoints.toLocaleString('zh-CN')} 点 · 覆盖 {pct(summary.coverage)} ·
          数据日期 {dataDate} · 非无人机采集
        </span>
      </div>

      <div className="reality-body">
        <div className="reality-stage" ref={hostRef}>
          <span className="reality-badge">合成实景 / 泼溅渲染</span>
          <div className="reality-legend">
            <span>
              <i className="legend-dot" style={{ background: '#16a34a' }} />
              &lt; 30 mm
            </span>
            <span>
              <i className="legend-dot" style={{ background: '#f59e0b' }} />
              30–50 mm
            </span>
            <span>
              <i className="legend-dot" style={{ background: '#dc2626' }} />
              &gt; 50 mm
            </span>
            <span>
              <i className="legend-dot" style={{ background: '#a855f7' }} />
              非模型点
            </span>
          </div>
          {glError ? (
            <div className="bim-loading">当前浏览器未启用 WebGL，无法渲染点云。</div>
          ) : null}
        </div>

        <aside className="reality-side">
          <div className="reality-kpis">
            <div>
              <span>覆盖率</span>
              <strong>{pct(summary.coverage)}</strong>
            </div>
            <div>
              <span>平均偏差</span>
              <strong>{(summary.meanDeviation * 1000).toFixed(0)} mm</strong>
            </div>
            <div>
              <span>最大偏差</span>
              <strong>{(summary.maxDeviation * 1000).toFixed(0)} mm</strong>
            </div>
            <div>
              <span>缺失构件</span>
              <strong>{summary.missingElements}</strong>
            </div>
          </div>

          <div className="reality-toggles">
            <button
              type="button"
              className={`btn btn-small ${colorMode === 'deviation' ? 'btn-primary' : ''}`}
              onClick={() => setColorMode('deviation')}
            >
              按偏差着色
            </button>
            <button
              type="button"
              className={`btn btn-small ${colorMode === 'type' ? 'btn-primary' : ''}`}
              onClick={() => setColorMode('type')}
            >
              按构件类型
            </button>
            <button
              type="button"
              className={`btn btn-small ${showBim ? 'btn-primary' : ''}`}
              onClick={() => setShowBim((value) => !value)}
            >
              {showBim ? '隐藏 BIM 线框' : '叠加 BIM 线框'}
            </button>
          </div>

          <div className="reality-levels">
            {summary.levels
              .slice()
              .reverse()
              .map((level) => (
                <div className="reality-level" key={level.level}>
                  <span>{level.label}</span>
                  <div className="reality-level-track">
                    <i
                      style={{
                        width: `${level.expected > 0 ? (level.observed / level.expected) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <b>
                    {level.observed}/{level.expected}
                  </b>
                  <small>{level.matched} 匹配</small>
                </div>
              ))}
          </div>

          <div className="reality-issues">
            <div className="reality-issues-head">
              <span>核验问题</span>
              <small>
                超差 {summary.overThreshold} 点 · 多余 {summary.extraPoints} 点
              </small>
            </div>
            <ul>
              {summary.issues.slice(0, 8).map((issue, index) => (
                <li className={`reality-issue issue-${issue.type}`} key={index}>
                  <b>{ISSUE_LABEL[issue.type] ?? issue.type}</b>
                  <div>
                    <span>{issue.elementName}</span>
                    <small>
                      {issue.activityCode} · {issue.detail}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      <p className="panel-foot">
        点云由 BIM 表面采样合成，按实际完成比例截断，并注入 3 个缺失构件、安装偏移与材料堆场。
        覆盖率用 {summary.tolerance * 1000} mm 容差、250 mm 体素做占用判断；接入真实无人机/激光点云后，
        可沿用同一套指标与界面。
      </p>
    </section>
  );
}
