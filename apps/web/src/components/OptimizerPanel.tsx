import { useState } from 'react';
import type {
  CrashOption,
  CrashResult,
  DashboardPayload,
  LevelingResult,
} from '@apcc/core';
import { commitOptimizer, runCrash, runCrashPlan, runLeveling } from '../api';
import { money, wan } from '../format';

interface OptimizerPanelProps {
  data: DashboardPayload;
  onCommitted: (data: DashboardPayload) => void;
}

type Busy = 'leveling' | 'plan' | 'crash' | 'commit' | null;

function SolverBadge({ solver }: { solver: 'local' | 'ortools' }) {
  return (
    <span className={`chip ${solver === 'ortools' ? 'chip-solver-remote' : 'chip-solver-local'}`}>
      {solver === 'ortools' ? 'OR-Tools CP-SAT' : '本地求解器'}
    </span>
  );
}

function CrashCard({
  option,
  onCommit,
  busy,
}: {
  option: CrashOption;
  onCommit: (option: CrashOption) => void;
  busy: boolean;
}) {
  return (
    <div className="opt-card">
      <div className="opt-card-head">
        <div>
          <strong>{option.name}</strong>
          <p>{option.description}</p>
        </div>
        <SolverBadge solver={option.solver} />
      </div>
      <div className="opt-metrics">
        <div>
          <span>目标 / 实际压缩</span>
          <strong>
            {option.targetDays} / {option.achievedDays} 天
          </strong>
        </div>
        <div>
          <span>工期</span>
          <strong>{option.durationDays} 个工作日</strong>
        </div>
        <div>
          <span>追加成本</span>
          <strong>
            {money(option.addedCost)} / {money(option.costCap)} 元
          </strong>
        </div>
        <div>
          <span>预测完工成本 EAC</span>
          <strong>{wan(option.eac)}</strong>
        </div>
      </div>
      {option.moves.length > 0 ? (
        <table className="table opt-table">
          <thead>
            <tr>
              <th>活动</th>
              <th className="num">原工期</th>
              <th className="num">压缩</th>
              <th className="num">追加成本</th>
            </tr>
          </thead>
          <tbody>
            {option.moves.slice(0, 6).map((move) => (
              <tr key={move.id}>
                <td>
                  <b>{move.code}</b> {move.name}
                </td>
                <td className="num">{move.beforeDuration}</td>
                <td className="num">{move.cutDays}</td>
                <td className="num">{money(move.addedCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="opt-risk">{option.riskNote}</p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => onCommit(option)}
        disabled={busy || option.achievedDays === 0}
      >
        按此方案提交新版本
      </button>
    </div>
  );
}

export function OptimizerPanel({ data, onCommitted }: OptimizerPanelProps) {
  const [maxShiftDays, setMaxShiftDays] = useState(30);
  const [targetDays, setTargetDays] = useState(8);
  const [costCapRatio, setCostCapRatio] = useState(3);
  const [leveling, setLeveling] = useState<{
    result: LevelingResult;
    source: 'api' | 'local';
  } | null>(null);
  const [plan, setPlan] = useState<{ result: CrashResult; source: 'api' | 'local' } | null>(
    null,
  );
  const [custom, setCustom] = useState<{
    result: CrashOption;
    source: 'api' | 'local';
  } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function handleLeveling() {
    setBusy('leveling');
    setError(null);
    setMessage(null);
    try {
      setLeveling(await runLeveling(data, maxShiftDays));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handlePlan() {
    setBusy('plan');
    setError(null);
    setMessage(null);
    try {
      setPlan(await runCrashPlan(data));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleCustom() {
    setBusy('crash');
    setError(null);
    setMessage(null);
    try {
      setCustom(await runCrash(data, targetDays, costCapRatio / 100));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleCommit(kind: 'leveling' | 'crash', params: Record<string, number>) {
    setBusy('commit');
    setError(null);
    setMessage(null);
    try {
      const result = await commitOptimizer(kind, params);
      onCommitted(result.dashboard);
      setMessage(
        `已提交为新版本：${
          kind === 'leveling'
            ? `资源平衡顺延 ${result.summary.delayDays ?? 0} 天`
            : `压缩 ${result.summary.achievedDays ?? 0} 天，追加成本 ${money(result.summary.addedCost ?? 0)} 元`
        }。`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const levelingResult = leveling?.result;
  const remoteAvailable =
    leveling?.source === 'api' || plan?.source === 'api' || custom?.source === 'api';

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>阶段 4 · 资源平衡与工期-成本优化</h3>
        <span className="panel-count">
          {remoteAvailable ? 'OR-Tools 服务在线' : '本地确定性求解（OR-Tools 未连接）'}
        </span>
      </div>

      <div className="opt-controls">
        <label>
          <span>资源平衡最大顺延</span>
          <input
            type="number"
            min={1}
            max={60}
            value={maxShiftDays}
            onChange={(event) => setMaxShiftDays(Number(event.target.value))}
          />
          <em>工作日</em>
        </label>
        <button type="button" className="btn" onClick={handleLeveling} disabled={busy !== null}>
          {busy === 'leveling' ? '求解中…' : '运行资源平衡'}
        </button>

        <label>
          <span>赶工目标</span>
          <input
            type="number"
            min={1}
            max={60}
            value={targetDays}
            onChange={(event) => setTargetDays(Number(event.target.value))}
          />
          <em>工作日</em>
        </label>
        <label>
          <span>成本上限</span>
          <input
            type="number"
            min={0.5}
            max={10}
            step={0.5}
            value={costCapRatio}
            onChange={(event) => setCostCapRatio(Number(event.target.value))}
          />
          <em>% BAC</em>
        </label>
        <button type="button" className="btn" onClick={handleCustom} disabled={busy !== null}>
          {busy === 'crash' ? '求解中…' : '自定义赶工'}
        </button>
        <button type="button" className="btn" onClick={handlePlan} disabled={busy !== null}>
          {busy === 'plan' ? '求解中…' : '生成三档赶工方案'}
        </button>
      </div>

      {error ? <p className="opt-alert">{error}</p> : null}
      {message ? <p className="opt-success">{message}</p> : null}

      {levelingResult ? (
        <div className="opt-result">
          <div className="opt-card-head">
            <div>
              <strong>资源平衡结果</strong>
              <p>
                顺延 <b>{levelingResult.moves.length}</b> 项活动，工期增加{' '}
                <b>{levelingResult.delayDays}</b> 个工作日
              </p>
            </div>
            <SolverBadge solver={levelingResult.solver} />
          </div>
          <div className="opt-compare">
            <table className="table">
              <thead>
                <tr>
                  <th>指标</th>
                  <th className="num">平衡前</th>
                  <th className="num">平衡后</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>工期（工作日）</td>
                  <td className="num">{levelingResult.baseline.durationDays}</td>
                  <td className="num">{levelingResult.leveled.durationDays}</td>
                </tr>
                <tr>
                  <td>超配资源</td>
                  <td className="num">{levelingResult.baseline.overloadedResources}</td>
                  <td className={`num ${levelingResult.leveled.overloadedResources === 0 ? 'good' : 'bad'}`}>
                    {levelingResult.leveled.overloadedResources}
                  </td>
                </tr>
                <tr>
                  <td>超容量天数</td>
                  <td className="num">{levelingResult.baseline.overCapacityDays}</td>
                  <td className="num">{levelingResult.leveled.overCapacityDays}</td>
                </tr>
                <tr>
                  <td>人工 / 机械峰值</td>
                  <td className="num">
                    {levelingResult.baseline.laborPeak} / {levelingResult.baseline.equipmentPeak}
                  </td>
                  <td className="num">
                    {levelingResult.leveled.laborPeak} / {levelingResult.leveled.equipmentPeak}
                  </td>
                </tr>
              </tbody>
            </table>
            {levelingResult.moves.length > 0 ? (
              <div className="opt-moves">
                {levelingResult.moves.slice(0, 8).map((move) => (
                  <div className="opt-move" key={move.id}>
                    <b>{move.code}</b>
                    <span>{move.name}</span>
                    <em>+{move.shiftDays} 天</em>
                    <small>总浮时 {move.totalFloat} 天</small>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <ul className="opt-notes">
            {levelingResult.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => handleCommit('leveling', { maxShiftDays })}
            disabled={busy !== null || (leveling?.source ?? 'local') === 'local'}
          >
            {busy === 'commit' ? '提交中…' : '提交为新版本'}
          </button>
          {leveling?.source === 'local' ? (
            <p className="opt-hint">本地回退仅支持预览，启动 API 后才能提交新版本。</p>
          ) : null}
        </div>
      ) : null}

      {plan ? (
        <div className="opt-result">
          <div className="opt-card-head">
            <div>
              <strong>三档赶工方案</strong>
              <p>
                基准工期 {plan.result.baseline.durationDays} 个工作日，EAC{' '}
                {wan(plan.result.baseline.eac)}
              </p>
            </div>
            <SolverBadge solver={plan.result.solver} />
          </div>
          <div className="opt-plan-grid">
            {plan.result.options.map((option) => (
              <CrashCard
                key={option.id}
                option={option}
                busy={busy !== null || plan.source === 'local'}
                onCommit={(item) =>
                  handleCommit('crash', {
                    targetDays: item.targetDays,
                    costCapRatio: item.costCapRatio,
                    maxCutRatio: item.maxCutRatio,
                  })
                }
              />
            ))}
          </div>
          <ul className="opt-notes">
            {plan.result.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {custom ? (
        <div className="opt-result">
          <CrashCard
            option={custom.result}
            busy={busy !== null || custom.source === 'local'}
            onCommit={(item) =>
              handleCommit('crash', {
                targetDays: item.targetDays,
                costCapRatio: item.costCapRatio,
                maxCutRatio: item.maxCutRatio,
              })
            }
          />
        </div>
      ) : null}

      <p className="panel-foot">
        优化结果为候选方案，采用「预览 → 审批 → 提交」流程；提交会写入新版本并保留历史快照。
        未连接 OR-Tools 服务时自动使用本地确定性求解器，指标可复现但非全局最优。
      </p>
    </section>
  );
}
