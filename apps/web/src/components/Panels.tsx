import type {
  DashboardPayload,
  Insight,
  Risk,
  ScenarioResult,
} from '@apcc/core';
import { dateCn, money, pct, ratio, wan } from '../format';

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export function Sidebar() {
  const nav = [
    { label: '项目概览', active: true },
    { label: '进度与关键路径', active: false },
    { label: '资源与平衡', active: false },
    { label: '成本与 EVM', active: false },
    { label: '风险与问题', active: false },
    { label: '情景与优化', active: false },
    { label: '现场实景核验', active: false, badge: '阶段5' },
    { label: '数据源与设置', active: false },
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">AP</div>
        <div className="brand-text">
          <strong>AI 项目控制中心</strong>
          <span>Project Control Center</span>
        </div>
      </div>
      <nav className="nav">
        {nav.map((item) => (
          <button
            type="button"
            key={item.label}
            className={`nav-item${item.active ? ' active' : ''}`}
          >
            <span className="nav-indicator" />
            <span className="nav-label">{item.label}</span>
            {item.badge && <span className="nav-badge">{item.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="phase-chip">当前：阶段 3 · 5D 成本</div>
        <p>数据为演示用模拟数据，不代表真实工程。</p>
        <p>目标架构：方案 B · 首期落地：方案 A</p>
      </div>
    </aside>
  );
}

export function Header({
  data,
  source,
}: {
  data: DashboardPayload;
  source: 'api' | 'local';
}) {
  const { project } = data;
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{project.name}</h1>
        <p>{project.description}</p>
      </div>
      <div className="topbar-meta">
        <div className={`chip chip-source-${source}`}>
          {source === 'api' ? 'API 网关' : '本地计算回退'}
        </div>
        <div className="chip chip-warn">模拟数据</div>
        <div className="meta-item">
          <span>数据日期</span>
          <strong>{dateCn(project.dataDate)}</strong>
        </div>
        <div className="meta-item">
          <span>基准</span>
          <strong>{project.baselineVersion}</strong>
        </div>
        <div className="meta-item">
          <span>更新</span>
          <strong>{new Date(data.generatedAt).toLocaleTimeString('zh-CN')}</strong>
        </div>
      </div>
    </header>
  );
}

function KpiCard({
  label,
  value,
  sub,
  note,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  note: string;
  tone: Tone;
}) {
  return (
    <div className={`kpi kpi-${tone}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
      <div className="kpi-note">{note}</div>
    </div>
  );
}

export function KpiGrid({ data }: { data: DashboardPayload }) {
  const { evm, schedule } = data;
  const spiTone: Tone = evm.spi >= 1 ? 'good' : evm.spi >= 0.95 ? 'warn' : 'bad';
  const cpiTone: Tone = evm.cpi >= 1 ? 'good' : evm.cpi >= 0.95 ? 'warn' : 'bad';
  const eacTone: Tone = evm.eac <= evm.bac ? 'good' : 'warn';
  const planGap = evm.percentComplete - evm.plannedPercent;
  const progressTone: Tone = planGap >= 0 ? 'good' : planGap > -0.05 ? 'warn' : 'bad';

  return (
    <section className="kpi-grid">
      <KpiCard
        label="进度绩效 SPI"
        value={ratio(evm.spi)}
        sub={`完成 ${pct(evm.percentComplete)} / 计划 ${pct(evm.plannedPercent)}`}
        note={`进度偏差 SV ${wan(evm.sv)}`}
        tone={spiTone}
      />
      <KpiCard
        label="成本绩效 CPI"
        value={ratio(evm.cpi)}
        sub={`EV ${wan(evm.ev)} / AC ${wan(evm.ac)}`}
        note={`成本偏差 CV ${wan(evm.cv)}`}
        tone={cpiTone}
      />
      <KpiCard
        label="预测完工成本 EAC"
        value={wan(evm.eac)}
        sub={`预算 BAC ${wan(evm.bac)}`}
        note={`偏差 VAC ${wan(evm.vac)}`}
        tone={eacTone}
      />
      <KpiCard
        label="预测完工日期"
        value={dateCn(schedule.projectFinish)}
        sub={`${schedule.projectDurationDays} 个工作日`}
        note={`关键路径 ${schedule.criticalPath.length} 项活动`}
        tone="neutral"
      />
      <KpiCard
        label="整体完成率"
        value={pct(evm.percentComplete)}
        sub={`计划应完成 ${pct(evm.plannedPercent)}`}
        note={`剩余 ETC ${wan(evm.etc)}`}
        tone={progressTone}
      />
    </section>
  );
}

const severityLabel: Record<Risk['severity'], string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export function RiskPanel({ risks }: { risks: Risk[] }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>风险与问题</h3>
        <span className="panel-count">{risks.length} 项</span>
      </div>
      <ul className="risk-list">
        {risks.map((risk) => (
          <li className={`risk risk-${risk.severity}`} key={risk.id}>
            <div className="risk-top">
              <span className={`sev sev-${risk.severity}`}>
                {severityLabel[risk.severity]}
              </span>
              <span className="risk-title">{risk.title}</span>
            </div>
            <div className="risk-meta">
              概率 {(risk.probability * 100).toFixed(0)}% · 影响 {risk.impactDays} 天 ·{' '}
              {wan(risk.impactCost)}
            </div>
            <div className="risk-mitigation">{risk.mitigation}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function InsightsPanel({ insights }: { insights: Insight[] }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>AI 管理建议</h3>
        <span className="panel-count">基于当前指标</span>
      </div>
      <div className="insight-list">
        {insights.map((insight) => (
          <div className={`insight insight-${insight.level}`} key={insight.id}>
            <div className="insight-title">{insight.title}</div>
            <div className="insight-detail">{insight.detail}</div>
            <div className="insight-action">建议：{insight.action}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ScenarioPanel({
  scenarios,
  baseline,
}: {
  scenarios: ScenarioResult[];
  baseline: { durationDays: number; eac: number };
}) {
  const best = scenarios.reduce(
    (acc, item) => (item.durationDays < acc.durationDays ? item : acc),
    scenarios[0],
  );
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>赶工情景比较</h3>
        <span className="panel-count">
          目标：追回工期，成本增幅 ≤ 3%
        </span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>情景</th>
              <th>工期（工作日）</th>
              <th>较基准</th>
              <th>预测完工成本</th>
              <th>成本偏差</th>
              <th>人工峰值</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr className="table-baseline">
              <td>当前基准</td>
              <td>{baseline.durationDays}</td>
              <td>—</td>
              <td>{wan(baseline.eac)}</td>
              <td>—</td>
              <td>—</td>
              <td>按现有逻辑与资源计算</td>
            </tr>
            {scenarios.map((scenario) => (
              <tr
                key={scenario.id}
                className={scenario.id === best.id ? 'table-best' : ''}
              >
                <td>
                  <div className="scenario-name">{scenario.name}</div>
                  <div className="scenario-desc">{scenario.description}</div>
                </td>
                <td>{scenario.durationDays}</td>
                <td className={scenario.durationDelta <= 0 ? 'good' : 'bad'}>
                  {scenario.durationDelta > 0 ? '+' : ''}
                  {scenario.durationDelta} 天
                </td>
                <td>{wan(scenario.eac)}</td>
                <td className={scenario.costDelta <= 0 ? 'good' : 'bad'}>
                  {scenario.costDelta > 0 ? '+' : ''}
                  {money(scenario.costDelta)} 元
                </td>
                <td>
                  {scenario.peakLabor} 人 / {scenario.peakEquipment} 台
                </td>
                <td className="scenario-risk">{scenario.riskNote}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="panel-foot">
        情景结果为确定性排程重算的模拟值，用于方案比较；正式写回需经预览 → 审批 → 提交。
      </p>
    </div>
  );
}

export function PhasePanel() {
  const phases = [
    { name: '阶段 0 · 骨架与控制台', status: 'done' },
    { name: '阶段 1 · 排程引擎与 MSPDI 数据交换', status: 'done' },
    { name: '阶段 2 · BIM / 4D 构件绑定', status: 'done' },
    { name: '阶段 3 · 5D 成本与 EVM 预测', status: 'active' },
    { name: '阶段 4 · AI 网关与 OR-Tools 优化', status: 'todo' },
    { name: '阶段 5 · 无人机实景核验', status: 'todo' },
  ];
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>建设路线</h3>
        <span className="panel-count">分期交付</span>
      </div>
      <ul className="phase-list">
        {phases.map((phase) => (
          <li className={`phase phase-${phase.status}`} key={phase.name}>
            <span className="phase-dot" />
            <span>{phase.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
