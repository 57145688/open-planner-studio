import { useEffect, useState } from 'react';
import type { DashboardPayload } from '@apcc/core';
import { loadDashboard } from './api';
import type { ImportResult } from './api';
import { FloorStack, GanttChart, ResourceHistogram, SCurveChart } from './components/Charts';
import { BimViewer } from './components/BimViewer';
import { CostPanel } from './components/CostPanel';
import { DataPanel } from './components/DataPanel';
import { RealCasePanel } from './components/RealCasePanel';
import { RealityPanel } from './components/RealityPanel';
import {
  Header,
  InsightsPanel,
  KpiGrid,
  PhasePanel,
  RiskPanel,
  ScenarioPanel,
  Sidebar,
} from './components/Panels';
import { pct } from './format';

export default function App() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [source, setSource] = useState<'api' | 'local'>('local');

  useEffect(() => {
    let alive = true;
    loadDashboard().then((result) => {
      if (!alive) return;
      setData(result.data);
      setSource(result.source);
    });
    return () => {
      alive = false;
    };
  }, []);

  function handleImported(result: ImportResult) {
    setData(result.data);
    setSource(result.source);
  }

  if (!data) {
    return (
      <div className="boot">
        <div className="boot-mark">AP</div>
        <p>正在计算排程与挣值指标…</p>
      </div>
    );
  }

  const { evm, schedule, resources, series } = data;
  const doneFloors = data.floors.filter((f) => f.status === 'done').length;
  const activeFloor = data.floors.find((f) => f.status === 'active');

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Header data={data} source={source} />
        <KpiGrid data={data} />

        <div className="grid-two">
          <section className="panel">
            <div className="panel-head">
              <h3>挣值曲线（PV / EV / AC）</h3>
              <span className="panel-count">
                完成 {pct(evm.percentComplete)} · SPI {evm.spi.toFixed(2)} · CPI{' '}
                {evm.cpi.toFixed(2)}
              </span>
            </div>
            <SCurveChart
              series={series}
              workingDays={schedule.workingDays}
              dataDate={data.project.dataDate}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h3>楼层进度（4D）</h3>
              <span className="panel-count">
                {doneFloors}/6 层完成
                {activeFloor ? ` · ${activeFloor.label} 施工中` : ''}
              </span>
            </div>
            <FloorStack floors={data.floors} />
            <p className="panel-foot">
              每层构件已与主体结构与混凝土活动绑定，可在下方 4D 视图中按数据日期回放。
            </p>
          </section>
        </div>

        {data.bim ? (
          <BimViewer model={data.bim} schedule={schedule} dataDate={data.project.dataDate} />
        ) : null}

        <section className="panel">
          <div className="panel-head">
            <h3>进度计划与关键路径</h3>
            <span className="panel-count">
              {schedule.activities.length} 项活动 · 关键路径 {schedule.criticalPath.length} 项
              {schedule.warnings.length > 0 ? ` · ${schedule.warnings[0]}` : ''}
            </span>
          </div>
          <GanttChart schedule={schedule} activities={data.activities} />
        </section>

        <CostPanel cost={data.cost} />

        <RealCasePanel />

        <RealityPanel
          model={data.bim}
          activities={data.activities}
          summary={data.reality}
          dataDate={data.project.dataDate}
        />

        <div className="grid-three">
          <section className="panel">
            <div className="panel-head">
              <h3>资源投入</h3>
              <span className="panel-count">按周平均</span>
            </div>
            <ResourceHistogram
              daily={resources.laborDaily}
              peak={resources.laborPeak}
              unit="人"
            />
            <div className="res-summary">
              <div>
                <span>人工峰值</span>
                <strong>{resources.laborPeak} 人/日</strong>
              </div>
              <div>
                <span>机械峰值</span>
                <strong>{resources.equipmentPeak} 台/日</strong>
              </div>
              <div>
                <span>超配资源</span>
                <strong>
                  {resources.loads.filter((l) => l.overloaded).length} 项
                </strong>
              </div>
            </div>
          </section>

          <RiskPanel risks={data.risks} />
          <InsightsPanel insights={data.insights} />
        </div>

        <ScenarioPanel
          scenarios={data.scenarios}
          baseline={{ durationDays: schedule.projectDurationDays, eac: evm.eac }}
        />

        <DataPanel currentName={data.project.name} onImported={handleImported} />

        <div className="grid-two footer-grid">
          <PhasePanel />
          <section className="panel">
            <div className="panel-head">
              <h3>数据一致性说明</h3>
              <span className="panel-count">阶段 3–5</span>
            </div>
            <ul className="note-list">
              <li>计划数据、实际成本与进度均为模拟数据，用于验证算法与界面。</li>
              <li>排程采用简化工作日历（周一至周五，未含节假日），后续接入完整节假日日历与 OPS 引擎。</li>
              <li>EVM 的 PV / EV / AC 按活动计划窗口分摊，单一数据日期，不含历史快照。</li>
              <li>
                BOQ 金额按 WBS 内活动预算比例分摊，EAC 为三种外推方法并列结果，尚未接入采招与
                实际成本单据。
              </li>
              <li>
                真实案例面板使用 CyberbuildLab 公开样例（Apache-2.0）的 LiDAR 点云与
                IFC2X3 模型，并附一个由该点云转换的 3DGS 格式验证样本（非训练产物）；
                覆盖率为模型表面被点云证据覆盖的比例，受扫描视角遮挡影响，不等同于合同
                进度，也不作为 3DGS 重建精度结论。
              </li>
              <li>
                实景核验使用 BIM 表面合成的点云并注入缺失、偏移与堆场点，仅用于验证核验流程，
                不代表真实无人机或激光扫描精度。
              </li>
              <li>
                4D 模型为程序化生成的 IFC4 演示模型（结构、砌体、门窗、屋面、机电），构件与活动
                1:N 绑定，用于验证回放链路。
              </li>
              <li>任何 AI 建议都不会直接改写基准；写回采用预览 → 审批 → 提交三级流程。</li>
            </ul>
          </section>
        </div>

        <footer className="foot">
          阶段 5 前置 实景核验 · 阶段 3 5D 成本 · 阶段 2 4D 构件回放 · 目标方案 B（Open Planner
          Studio + IfcOpenShell + ERPNext + OpenProject + OR-Tools + WebODM）
        </footer>
      </main>
    </div>
  );
}
