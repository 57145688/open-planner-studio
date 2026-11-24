import { useState } from 'react';
import type { AiProposal, DashboardPayload } from '@apcc/core';
import { applyProposal, chatWithAi } from '../api';
import { money, wan } from '../format';

interface AiAssistantPanelProps {
  data: DashboardPayload;
  onApplied: (data: DashboardPayload) => void;
}

const QUICK_PROMPTS = [
  '把关键路径压缩 5 天',
  '做一次资源平衡，限制顺延 20 天',
  '解释一下 SPI 为什么偏低',
  '生成本周周报',
];

type Busy = 'chat' | 'preview' | 'commit' | null;

interface PreviewState {
  proposal: AiProposal;
  dashboard: DashboardPayload;
  source: 'api' | 'local';
}

export function AiAssistantPanel({ data, onApplied }: AiAssistantPanelProps) {
  const [message, setMessage] = useState('');
  const [proposals, setProposals] = useState<AiProposal[]>([]);
  const [provider, setProvider] = useState<'local' | 'llm'>('local');
  const [source, setSource] = useState<'api' | 'local'>('local');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function ask(text: string) {
    const prompt = text.trim();
    if (!prompt) return;
    setBusy('chat');
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const result = await chatWithAi(prompt, data);
      setProposals(result.proposals);
      setProvider(result.provider);
      setSource(result.source);
      setMessage(prompt);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function dismiss(id: string) {
    setProposals((list) => list.filter((item) => item.id !== id));
    if (preview?.proposal.id === id) setPreview(null);
  }

  async function handlePreview(proposal: AiProposal) {
    setBusy('preview');
    setError(null);
    setNotice(null);
    try {
      const result = await applyProposal(proposal, 'preview', data);
      setPreview({
        proposal,
        dashboard: result.dashboard,
        source: result.source,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleCommit() {
    if (!preview) return;
    if (preview.source === 'local') {
      setError('本地回退模式无法写入新版本，请先启动 API 服务。');
      return;
    }
    setBusy('commit');
    setError(null);
    try {
      const result = await applyProposal(preview.proposal, 'commit', data);
      onApplied(result.dashboard);
      setNotice(`已提交「${preview.proposal.title}」并生成新版本。`);
      setPreview(null);
      setProposals([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const previewDeltaDuration =
    preview && preview.dashboard.schedule
      ? preview.dashboard.schedule.projectDurationDays - data.schedule.projectDurationDays
      : 0;

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>阶段 4 · AI 控制助手</h3>
        <span className="panel-count">
          {provider === 'llm' ? '大模型 Provider' : '本地规则引擎'} ·{' '}
          {source === 'api' ? 'API 在线' : '离线回退'}
        </span>
      </div>

      <div className="ai-input-row">
        <input
          type="text"
          value={message}
          placeholder="例如：把关键路径压缩 5 天，成本上限 3%"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void ask(message);
          }}
          maxLength={500}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void ask(message)}
          disabled={busy !== null || message.trim() === ''}
        >
          {busy === 'chat' ? '生成中…' : '生成提案'}
        </button>
      </div>

      <div className="ai-quick">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            type="button"
            key={prompt}
            className="ai-quick-chip"
            onClick={() => void ask(prompt)}
            disabled={busy !== null}
          >
            {prompt}
          </button>
        ))}
      </div>

      {error ? <p className="opt-alert">{error}</p> : null}
      {notice ? <p className="opt-success">{notice}</p> : null}

      <div className="ai-proposals">
        {proposals.map((proposal) => (
          <div className={`ai-proposal ai-proposal-${proposal.intent}`} key={proposal.id}>
            <div className="ai-proposal-head">
              <strong>{proposal.title}</strong>
              <div className="ai-badges">
                <span className={`chip ${proposal.provider === 'llm' ? 'chip-source-api' : 'chip-source-local'}`}>
                  {proposal.provider === 'llm' ? '大模型' : '本地规则'}
                </span>
                <span className={`chip ${proposal.requiresApproval ? 'chip-warn' : ''}`}>
                  {proposal.requiresApproval ? '需审批' : '仅说明'}
                </span>
              </div>
            </div>
            <p className="ai-summary">{proposal.summary}</p>
            {proposal.bullets.length > 0 ? (
              <ul className="ai-bullets">
                {proposal.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
            {proposal.impact.durationDeltaDays !== null ||
            proposal.impact.costDelta !== null ? (
              <div className="ai-impact">
                {proposal.impact.durationDeltaDays !== null ? (
                  <span>
                    工期 {proposal.impact.durationDeltaDays > 0 ? '+' : ''}
                    {proposal.impact.durationDeltaDays} 天
                  </span>
                ) : null}
                {proposal.impact.costDelta !== null ? (
                  <span>追加成本 {money(proposal.impact.costDelta)} 元</span>
                ) : null}
                <span>{proposal.impact.note}</span>
              </div>
            ) : null}
            <div className="ai-actions">
              {proposal.operation ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void handlePreview(proposal)}
                  disabled={busy !== null}
                >
                  {busy === 'preview' ? '计算中…' : '预览影响'}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => dismiss(proposal.id)}
                disabled={busy !== null}
              >
                忽略
              </button>
            </div>
          </div>
        ))}
      </div>

      {preview ? (
        <div className="ai-preview">
          <div className="ai-preview-head">
            <strong>预览：{preview.proposal.title}</strong>
            <span className={`chip ${preview.source === 'api' ? 'chip-source-api' : 'chip-source-local'}`}>
              {preview.source === 'api' ? 'API 计算' : '本地计算'}
            </span>
          </div>
          <div className="ai-preview-metrics">
            <div>
              <span>工期</span>
              <strong>
                {data.schedule.projectDurationDays} → {preview.dashboard.schedule.projectDurationDays}{' '}
                天
                <em className={previewDeltaDuration > 0 ? 'bad' : 'good'}>
                  {previewDeltaDuration > 0 ? '+' : ''}
                  {previewDeltaDuration}
                </em>
              </strong>
            </div>
            <div>
              <span>EAC</span>
              <strong>
                {wan(preview.dashboard.evm.eac)}
                <em className={preview.dashboard.evm.eac > data.evm.eac ? 'bad' : 'good'}>
                  {preview.dashboard.evm.eac > data.evm.eac ? '+' : '−'}
                  {money(Math.abs(preview.dashboard.evm.eac - data.evm.eac))}
                </em>
              </strong>
            </div>
            <div>
              <span>SPI / CPI</span>
              <strong>
                {preview.dashboard.evm.spi.toFixed(2)} / {preview.dashboard.evm.cpi.toFixed(2)}
              </strong>
            </div>
          </div>
          <div className="ai-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleCommit()}
              disabled={busy !== null || preview.source === 'local'}
            >
              {busy === 'commit' ? '提交中…' : '提交为新版本'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setPreview(null)}
              disabled={busy !== null}
            >
              取消
            </button>
          </div>
          {preview.source === 'local' ? (
            <p className="opt-hint">离线预览不可提交；启动 API 后可写入新版本。</p>
          ) : null}
        </div>
      ) : null}

      <p className="panel-foot">
        AI 只能提出赶工、资源平衡或说明性内容，影响量由确定性求解器复算；写回需预览 → 审批 →
        提交，不会直接改写基准版本。
      </p>
    </section>
  );
}
