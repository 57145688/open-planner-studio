import { useMemo } from 'react';
import { workingIndexFor } from '@apcc/core';
import type {
  Activity,
  FloorStatus,
  ScheduledActivity,
  ScheduleResult,
  SeriesPoint,
} from '@apcc/core';
import { dateCn, wan } from '../format';

export function SCurveChart({
  series,
  workingDays,
  dataDate,
}: {
  series: SeriesPoint[];
  workingDays: string[];
  dataDate: string;
}) {
  if (series.length === 0) return null;
  const width = 660;
  const height = 260;
  const padL = 58;
  const padR = 18;
  const padT = 16;
  const padB = 30;
  const lastIndex = Math.max(1, series[series.length - 1].index);
  const maxValue = Math.max(
    1,
    ...series.map((p) => Math.max(p.pv, p.ev, p.ac)),
  );

  const x = (index: number) =>
    padL + (index / lastIndex) * (width - padL - padR);
  const y = (value: number) =>
    padT + (1 - value / maxValue) * (height - padT - padB);

  const line = (key: 'pv' | 'ev' | 'ac') =>
    series
      .map(
        (p, i) => `${i === 0 ? 'M' : 'L'}${x(p.index).toFixed(1)},${y(p[key]).toFixed(1)}`,
      )
      .join(' ');

  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxValue);
  const dataIdx = workingIndexFor(workingDays, dataDate);
  const dataX =
    dataIdx >= 0 ? x(Math.min(dataIdx, lastIndex)) : null;

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img">
        {gridValues.map((value) => (
          <g key={value}>
            <line
              x1={padL}
              x2={width - padR}
              y1={y(value)}
              y2={y(value)}
              className="chart-grid"
            />
            <text x={padL - 8} y={y(value) + 4} className="chart-axis" textAnchor="end">
              {wan(value)}
            </text>
          </g>
        ))}

        {dataX !== null && (
          <g>
            <line
              x1={dataX}
              x2={dataX}
              y1={padT}
              y2={height - padB}
              className="chart-datadate"
            />
            <text x={dataX + 4} y={padT + 10} className="chart-datadate-label">
              数据日期 {dateCn(dataDate)}
            </text>
          </g>
        )}

        <path d={line('pv')} className="series-pv" />
        <path d={line('ev')} className="series-ev" />
        <path d={line('ac')} className="series-ac" />

        <text
          x={padL}
          y={height - 8}
          className="chart-axis"
          textAnchor="start"
        >
          {series[0] ? dateCn(series[0].date) : ''}
        </text>
        <text
          x={width - padR}
          y={height - 8}
          className="chart-axis"
          textAnchor="end"
        >
          {series[series.length - 1] ? dateCn(series[series.length - 1].date) : ''}
        </text>
      </svg>
      <div className="chart-legend">
        <span className="legend-item"><i className="legend-dot pv" />计划值 PV</span>
        <span className="legend-item"><i className="legend-dot ev" />挣值 EV</span>
        <span className="legend-item"><i className="legend-dot ac" />实际成本 AC</span>
      </div>
    </div>
  );
}

export function GanttChart({
  schedule,
  activities,
}: {
  schedule: ScheduleResult;
  activities: Activity[];
}) {
  const total = Math.max(1, schedule.projectDurationDays);
  const rows = schedule.activities;
  const rowHeight = 27;

  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.id, index));
    return map;
  }, [rows]);

  /** 关键路径连线：两个端点均为关键活动时，按逻辑关系类型取锚点。 */
  const criticalLinks = useMemo(() => {
    const links: { key: string; path: string }[] = [];
    const xStart = (row: ScheduledActivity) => (row.startIndex / total) * 100;
    const xFinish = (row: ScheduledActivity) =>
      (Math.min(row.finishIndex + 1, total) / total) * 100;
    const yOf = (index: number) => index * rowHeight + rowHeight / 2;
    for (const activity of activities) {
      const successor = schedule.byId[activity.id];
      const toIndex = rowIndex.get(activity.id);
      if (!successor || !successor.critical || toIndex === undefined) continue;
      for (const relation of activity.predecessors) {
        const predecessor = schedule.byId[relation.activityId];
        const fromIndex = rowIndex.get(relation.activityId);
        if (!predecessor || !predecessor.critical || fromIndex === undefined) continue;
        const fromFinish = relation.type === 'FS' || relation.type === 'FF';
        const toFinish = relation.type === 'FF' || relation.type === 'SF';
        const x1 = fromFinish ? xFinish(predecessor) : xStart(predecessor);
        const x2 = toFinish ? xFinish(successor) : xStart(successor);
        const y1 = yOf(fromIndex);
        const y2 = yOf(toIndex);
        const elbow = x1 + Math.max(1.2, (x2 - x1) * 0.25);
        links.push({
          key: `${relation.activityId}->${activity.id}`,
          path: `M ${x1.toFixed(2)} ${y1} H ${elbow.toFixed(2)} V ${y2} H ${x2.toFixed(2)}`,
        });
      }
    }
    return links;
  }, [activities, schedule, rowIndex, total]);

  const months: { key: string; label: string; start: number; end: number }[] = [];
  for (let i = 0; i < total; i += 1) {
    const date = schedule.workingDays[i];
    if (!date) continue;
    const key = date.slice(0, 7);
    const label = `${key.slice(2, 4)}/${key.slice(5, 7)}`;
    const current = months[months.length - 1];
    if (!current || current.key !== key) {
      months.push({ key, label, start: i, end: i });
    } else {
      current.end = i;
    }
  }

  return (
    <div className="gantt">
      <div className="gantt-head">
        <div className="gantt-label-head">活动</div>
        <div className="gantt-timeline-head">
          {months.map((m) => (
            <div
              key={m.key}
              className="gantt-month"
              style={{
                left: `${(m.start / total) * 100}%`,
                width: `${((m.end - m.start + 1) / total) * 100}%`,
              }}
            >
              {m.label}
            </div>
          ))}
        </div>
      </div>

      <div className="gantt-body">
        {criticalLinks.length > 0 && (
          <svg
            className="gantt-links"
            viewBox={`0 0 100 ${rows.length * rowHeight}`}
            preserveAspectRatio="none"
            style={{ height: rows.length * rowHeight }}
            aria-hidden="true"
          >
            {criticalLinks.map((link) => (
              <path key={link.key} d={link.path} />
            ))}
          </svg>
        )}
        {rows.map((row) => {
          const left = (row.startIndex / total) * 100;
          const widthPct = Math.max(0.5, ((row.durationDays || 1) / total) * 100);
          const done = Math.max(0, Math.min(1, row.percentComplete)) * 100;
          const classes = [
            'gantt-bar',
            row.critical ? 'is-critical' : '',
            !row.critical && row.nearCritical ? 'is-near' : '',
            row.durationDays === 0 ? 'is-milestone' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div className="gantt-row" key={row.id}>
              <div className="gantt-label" title={row.name}>
                <span className="gantt-code">{row.code}</span>
                <span className="gantt-name">{row.name}</span>
              </div>
              <div className="gantt-track">
                <div
                  className={classes}
                  style={{ left: `${left}%`, width: `${widthPct}%` }}
                  title={`${row.name} · ${row.startDate} → ${row.finishDate} · TF ${row.totalFloat}d`}
                >
                  {row.durationDays > 0 && (
                    <span className="gantt-bar-progress" style={{ width: `${done}%` }} />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="chart-legend gantt-legend">
        <span className="legend-item"><i className="legend-dot normal" />普通活动</span>
        <span className="legend-item"><i className="legend-dot critical" />关键路径</span>
        <span className="legend-item"><i className="legend-link" />关键路径逻辑连线</span>
        <span className="legend-item"><i className="legend-dot near" />近关键</span>
        <span className="legend-item"><i className="legend-dot milestone" />里程碑</span>
      </div>
    </div>
  );
}

export function ResourceHistogram({
  daily,
  peak,
  unit,
}: {
  daily: number[];
  peak: number;
  unit: string;
}) {
  if (daily.length === 0) return null;
  const weeks: number[] = [];
  for (let i = 0; i < daily.length; i += 5) {
    const slice = daily.slice(i, i + 5);
    const avg = slice.reduce((sum, v) => sum + v, 0) / slice.length;
    weeks.push(avg);
  }
  const max = Math.max(1, ...weeks);

  return (
    <div className="histogram-wrap">
      <div className="histogram-meta">
        峰值 <strong>{Math.round(peak)}</strong> {unit}/日 · 按周平均
      </div>
      <div className="histogram">
        {weeks.map((value, index) => (
          <div className="hist-bar-wrap" key={index}>
            <div
              className="hist-bar"
              style={{ height: `${(value / max) * 100}%` }}
              title={`第 ${index + 1} 周：${value.toFixed(1)} ${unit}/日`}
            />
          </div>
        ))}
      </div>
      <div className="histogram-axis">
        <span>开工</span>
        <span>数据日期</span>
        <span>完工</span>
      </div>
    </div>
  );
}

export function FloorStack({ floors }: { floors: FloorStatus[] }) {
  return (
    <div className="floor-stack">
      {[...floors].reverse().map((floor) => (
        <div className={`floor floor-${floor.status}`} key={floor.level}>
          <span className="floor-label">{floor.label}</span>
          <div className="floor-track">
            <div
              className="floor-fill"
              style={{ width: `${Math.round(floor.percent * 100)}%` }}
            />
          </div>
          <span className="floor-pct">{Math.round(floor.percent * 100)}%</span>
        </div>
      ))}
      <div className="floor-ground" />
    </div>
  );
}

export function ScoreBar({
  value,
  max,
  tone,
}: {
  value: number;
  max: number;
  tone: 'duration' | 'cost';
}) {
  const width = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="score-bar">
      <div className={`score-bar-fill ${tone}`} style={{ width: `${width}%` }} />
    </div>
  );
}
