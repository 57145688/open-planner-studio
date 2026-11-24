import { Fragment, useEffect, useMemo, useState } from 'react';
import type {
  ActivityProgressSuggestion,
  DashboardPayload,
  ProgressSuggestionResult,
} from '@apcc/core';
import { commitProgressSuggestions, loadProgressSuggestions } from '../api';
import { pct, wan } from '../format';

interface ProgressSuggestionPanelProps {
  data: DashboardPayload;
  onApplied: (data: DashboardPayload) => void;
}

type Filter = 'all' | 'behind' | 'ahead' | 'consistent' | 'unverified';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'behind', label: '落后' },
  { id: 'ahead', label: '超前' },
  { id: 'consistent', label: '一致' },
  { id: 'unverified', label: '未核验' },
];

const STATUS_LABEL: Record<ActivityProgressSuggestion['status'], string> = {
  behind: '落后',
  ahead: '超前',
  consistent: '一致',
  unverified: '未核验',
};

const GAP_LABEL: Record<'missing' | 'partial' | 'offset', string> = {
  missing: '缺失',
  partial: '部分观测',
  offset: '偏移',
};

const CONFIDENCE_LABEL: Record<ActivityProgressSuggestion['confidence'], string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export function ProgressSuggestionPanel({ data, onApplied }: ProgressSuggestionPanelProps) {
  const [result, setResult] = useState<ProgressSuggestionResult | null>(null);
  const [source, setSource] = useState<'api' | 'local'>('local');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [preview, setPreview] = useState<DashboardPayload | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setPreview(null);
    loadProgressSuggestions(data)
      .then((response) => {
        if (!alive) return;
        setResult(response.result);
        setSource(response.source);
        setSelected(
          new Set(
            response.result.activities
              .filter(
                (item) =>
                  (item.status === 'behind' || item.status === 'ahead') &&
                  item.confidence !== 'low',
              )
              .map((item) => item.activityId),
          ),
        );
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [data]);

  const visible = useMemo(() => {
    if (!result) return [];
    return filter === 'all'
      ? result.activities
      : result.activities.filter((item) => item.status === filter);
  }, [result, filter]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    if (!result) return;
    if (checked) {
      setSelected(
        new Set(
          visible
            .filter((item) => item.status !== 'unverified')
            .map((item) => item.activityId),
        ),
      );
    } else {
      setSelected(new Set());
    }
  }

  async function handlePreview() {
    if (selected.size === 0) {
      setError('请先选择需要写入的活动。');
      return;
    }
    setBusy('preview');
    setError(null);
    try {
      const applied = await commitProgressSuggestions(
        'preview',
        Array.from(selected),
      );
      setPreview(applied.dashboard);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleCommit() {
    if (source === 'local') {
      setError('本地回退模式无法写入新版本，请先启动 API 服务。');
      return;
    }
    setBusy('commit');
    setError(null);
    try {
      const applied = await commitProgressSuggestions(
        'commit',
        Array.from(selected),
      );
      onApplied(applied.dashboard);
      setNotice(`已提交 ${applied.applied.length} 项进度建议并生成新版本。`);
      setPreview(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const totals = result?.totals;
  const allVisibleSelected =
    visible.length > 0 &&
    visible
      .filter((item) => item.status !== 'unverified')
      .every((item) => selected.has(item.activityId));

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>阶段 5 · 施工进度识别建议</h3>
        <span className="panel-count">
          {loading
            ? '识别中…'
            : totals
              ? `识别 ${totals.activities} 项活动 · 落后 ${totals.behind} · 超前 ${totals.ahead} · 缺口 ${totals.gaps}`
              : '暂无结果'}
        </span>
      </div>

      <p className="pe-source">
        {result?.description ?? '正在基于构件级实景证据生成建议。'}
        <span className={`chip ${source === 'api' ? 'chip-source-api' : 'chip-source-local'}`}>
          {source === 'api' ? 'API 计算' : '离线计算'}
        </span>
      </p>

      <div className="pe-toolbar">
        <div className="pe-filters">
          {FILTERS.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`pe-filter${filter === item.id ? ' active' : ''}`}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              {result
                ? item.id === 'all'
                  ? ` ${result.totals.activities}`
                  : ` ${result.totals[item.id]}`
                : ''}
            </button>
          ))}
        </div>
        <div className="pe-actions">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setFilter('all')}
            disabled={busy !== null}
          >
            重置筛选
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={handlePreview}
            disabled={busy !== null || selected.size === 0 || source === 'local'}
          >
            {busy === 'preview' ? '预览中…' : '预览影响'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleCommit}
            disabled={busy !== null || selected.size === 0 || source === 'local'}
          >
            {busy === 'commit' ? '提交中…' : `提交选中 ${selected.size} 项`}
          </button>
        </div>
      </div>

      {error ? <p className="opt-alert">{error}</p> : null}
      {notice ? <p className="opt-success">{notice}</p> : null}

      {preview ? (
        <div className="pe-preview">
          <div className="ai-preview-head">
            <strong>提交预览</strong>
            <span className="chip chip-source-api">API 计算</span>
          </div>
          <div className="ai-preview-metrics">
            <div>
              <span>SPI / CPI</span>
              <strong>
                {data.evm.spi.toFixed(2)} / {data.evm.cpi.toFixed(2)} →{' '}
                {preview.evm.spi.toFixed(2)} / {preview.evm.cpi.toFixed(2)}
              </strong>
            </div>
            <div>
              <span>完成率</span>
              <strong>
                {pct(data.evm.percentComplete)} → {pct(preview.evm.percentComplete)}
              </strong>
            </div>
            <div>
              <span>EAC</span>
              <strong>
                {wan(data.evm.eac)} → {wan(preview.evm.eac)}
              </strong>
            </div>
          </div>
          <p className="opt-hint">
            预览结果未写入项目；确认无误后点击上方「提交选中」生成新版本。
          </p>
        </div>
      ) : null}

      {loading ? (
        <p className="pe-empty">正在对照构件证据计算活动进度…</p>
      ) : visible.length === 0 ? (
        <p className="pe-empty">当前筛选下没有活动。</p>
      ) : (
        <div className="table-wrap">
          <table className="table pe-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(event) => toggleAll(event.target.checked)}
                    aria-label="全选"
                  />
                </th>
                <th>活动</th>
                <th className="num">当前</th>
                <th className="num">建议</th>
                <th className="num">偏差</th>
                <th className="num">覆盖率</th>
                <th>置信度</th>
                <th className="num">证据缺口</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => {
                const disabled = item.status === 'unverified';
                const isExpanded = expanded === item.activityId;
                return (
                  <Fragment key={item.activityId}>
                    <tr className={`pe-row pe-row-${item.status}`}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(item.activityId)}
                          onChange={() => toggle(item.activityId)}
                          disabled={disabled}
                          aria-label={`选择 ${item.code}`}
                        />
                      </td>
                      <td>
                        <div className="pe-name">
                          <b>{item.code}</b> {item.name}
                        </div>
                        <span className={`pe-status pe-status-${item.status}`}>
                          {STATUS_LABEL[item.status]}
                        </span>
                      </td>
                      <td className="num">{pct(item.currentPercent)}</td>
                      <td className="num">{pct(item.suggestedPercent)}</td>
                      <td
                        className={`num ${
                          item.delta < 0 ? 'bad' : item.delta > 0 ? 'good' : ''
                        }`}
                      >
                        {item.delta > 0 ? '+' : ''}
                        {(item.delta * 100).toFixed(0)}%
                      </td>
                      <td className="num">{pct(item.evidence.weightedCoverage)}</td>
                      <td>
                        <span className={`pe-confidence pe-confidence-${item.confidence}`}>
                          {CONFIDENCE_LABEL[item.confidence]}
                        </span>
                      </td>
                      <td className="num">
                        {item.gaps.length > 0 ? (
                          <button
                            type="button"
                            className="pe-gap-toggle"
                            onClick={() =>
                              setExpanded(isExpanded ? null : item.activityId)
                            }
                          >
                            {item.gaps.length} 项
                            <i>{isExpanded ? '收起' : '查看'}</i>
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="pe-gaps-row">
                        <td />
                        <td colSpan={7}>
                          <ul className="pe-gaps">
                            {item.gaps.map((gap) => (
                              <li key={gap.elementId}>
                                <span className={`pe-gap pe-gap-${gap.reason}`}>
                                  {GAP_LABEL[gap.reason]}
                                </span>
                                <b>{gap.level}F</b> {gap.name}
                                <em>{gap.detail}</em>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="panel-foot">
        建议值按构件表面积加权，覆盖率 ≥ 90% 时按 100% 计以吸收遮挡；覆盖率是证据强度，
        不等同于合同计量或质量验收。写回采用预览 → 审批 → 提交，提交后生成新版本并保留历史快照。
      </p>
    </section>
  );
}
