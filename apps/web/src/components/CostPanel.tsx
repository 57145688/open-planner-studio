import type { CostBreakdown } from '@apcc/core';
import { dateCn, pct, wan } from '../format';

function signedWan(value: number): string {
  const sign = value < 0 ? '−' : value > 0 ? '+' : '';
  return `${sign}${wan(Math.abs(value))}`;
}

export function CostPanel({ cost }: { cost: CostBreakdown }) {
  const totalBudget = cost.lines.reduce((sum, line) => sum + line.budget, 0);
  const totalEarned = cost.lines.reduce((sum, line) => sum + line.earned, 0);
  const totalActual = cost.lines.reduce((sum, line) => sum + line.actual, 0);
  const boqLines = cost.boq.slice().sort((a, b) => b.amount - a.amount);
  const delay = cost.finish.delayDays;

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>5D 成本执行（BOQ ↔ 活动）</h3>
        <span className="panel-count">
          BAC {wan(cost.bac)} · 已完价值 {wan(cost.ev)} · 实际成本 {wan(cost.ac)} · 偏差{' '}
          {signedWan(cost.cv)}
        </span>
      </div>

      <div className="cost-grid">
        <div className="cost-table-wrap">
          <table className="cost-table">
            <thead>
              <tr>
                <th>WBS</th>
                <th className="num">预算</th>
                <th className="num">已完价值</th>
                <th className="num">实际成本</th>
                <th className="num">偏差</th>
                <th>完成率</th>
              </tr>
            </thead>
            <tbody>
              {cost.lines.map((line) => (
                <tr key={line.wbsId}>
                  <td>
                    <b className="cost-code">{line.code}</b> {line.name}
                    <span className="cost-sub">{line.activityCount} 项活动</span>
                  </td>
                  <td className="num">{wan(line.budget)}</td>
                  <td className="num">{wan(line.earned)}</td>
                  <td className="num">{wan(line.actual)}</td>
                  <td className={`num ${line.variance < 0 ? 'neg' : 'pos'}`}>
                    {signedWan(line.variance)}
                  </td>
                  <td className="cost-progress-cell">
                    <div className="cost-progress">
                      <i style={{ width: `${Math.min(100, line.percent * 100)}%` }} />
                    </div>
                    <span>{pct(line.percent)}</span>
                  </td>
                </tr>
              ))}
              <tr className="cost-total">
                <td>合计</td>
                <td className="num">{wan(totalBudget)}</td>
                <td className="num">{wan(totalEarned)}</td>
                <td className="num">{wan(totalActual)}</td>
                <td className={`num ${totalEarned - totalActual < 0 ? 'neg' : 'pos'}`}>
                  {signedWan(totalEarned - totalActual)}
                </td>
                <td className="cost-progress-cell">
                  <span>{pct(totalBudget > 0 ? totalEarned / totalBudget : 0)}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="cost-note">
            BOQ 清单合计 {wan(cost.boqTotal)} · 与活动预算差额{' '}
            {cost.budgetGap >= 0 ? '' : '−'}
            {wan(Math.abs(cost.budgetGap))}（演示清单单价未按合同价校准，差额用于演示清单对账）。
            BOQ 金额已按 WBS 内活动预算比例分摊到活动。
          </p>
        </div>

        <div className="forecast">
          <div className="forecast-head">
            <span>完工预测</span>
            <strong>{dateCn(cost.finish.forecastFinish)}</strong>
            <small>
              计划 {dateCn(cost.finish.plannedFinish)} · SPI {cost.finish.spi.toFixed(2)} ·{' '}
              {delay > 0 ? `预计延后 ${delay} 个工作日` : '按计划完工'}
            </small>
          </div>
          {cost.forecasts.map((item) => (
            <div className={`fc-row ${item.vac >= 0 ? 'fc-ok' : 'fc-over'}`} key={item.method}>
              <div className="fc-title">
                <b>{item.name}</b>
                <span>EAC {wan(item.eac)}</span>
              </div>
              <div className="fc-meta">
                <span>ETC {wan(item.etc)}</span>
                <span>VAC {signedWan(item.vac)}</span>
              </div>
              <p>{item.note}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="boq-block">
        <div className="boq-head">
          <h4>BOQ 工程量与活动分摊</h4>
          <span>{boqLines.length} 项清单 · 按金额排序</span>
        </div>
        <div className="boq-scroll">
          <table className="cost-table boq-table">
            <thead>
              <tr>
                <th>编号</th>
                <th>清单项</th>
                <th className="num">工程量</th>
                <th className="num">单价</th>
                <th className="num">金额</th>
                <th>WBS</th>
                <th>关联活动</th>
                <th className="num">分摊预算</th>
              </tr>
            </thead>
            <tbody>
              {boqLines.map((line) => {
                const codes = line.allocations.map((item) => item.code);
                const shown = codes.slice(0, 3).join('、');
                return (
                  <tr key={line.id}>
                    <td className="cost-code">{line.code}</td>
                    <td>{line.description}</td>
                    <td className="num">
                      {line.quantity.toLocaleString('zh-CN')} {line.unit}
                    </td>
                    <td className="num">{line.unitRate.toLocaleString('zh-CN')}</td>
                    <td className="num">{wan(line.amount)}</td>
                    <td>{line.wbsName}</td>
                    <td className="boq-links">
                      {shown || '—'}
                      {codes.length > 3 ? ` 等 ${codes.length} 项` : ''}
                    </td>
                    <td className="num">{wan(line.allocatedBudget)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="panel-foot">
        已完价值与实际成本按数据日期口径统计，与上方 EVM 指标一致。EAC 为三种常用外推方法的并列
        结果（CPI 趋势、成本 × 进度综合、剩余按计划单价），用于暴露成本风险区间；后续阶段将接入
        ERPNext 实际成本回写与审批流。
      </p>
    </section>
  );
}
