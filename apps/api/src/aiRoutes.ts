import { Router } from 'express';
import {
  applyAiProposal,
  buildLocalProposals,
  computeDashboard,
  type AiProposal,
  type Project,
} from '@apcc/core';
import { aiConfig, generateLlmProposals } from './aiProvider';

interface StoredProposal {
  proposal: AiProposal;
  projectId: string;
  createdAt: number;
}

const PROPOSAL_TTL_MS = 30 * 60 * 1000;

export function createAiRouter(deps: {
  getProject: () => Project;
  commitProject: (project: Project) => void;
}): Router {
  const proposals = new Map<string, StoredProposal>();
  const router = Router();

  function prune(): void {
    const now = Date.now();
    for (const [id, item] of proposals) {
      if (now - item.createdAt > PROPOSAL_TTL_MS) proposals.delete(id);
    }
  }

  router.get('/status', (_req, res) => {
    const config = aiConfig();
    res.json({
      provider: config ? 'llm' : 'local',
      model: config?.model ?? null,
      hint: config
        ? '已接入 OpenAI 兼容模型，提案仍受白名单操作约束。'
        : '未配置模型，使用本地规则引擎（结果可复现、不联网）。',
    });
  });

  router.post('/chat', async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      res.status(400).json({ error: '请求体需提供 message 文本。' });
      return;
    }
    if (message.length > 500) {
      res.status(400).json({ error: 'message 长度不能超过 500 字。' });
      return;
    }

    prune();
    const project = deps.getProject();
    const remote = await generateLlmProposals(message, project);
    const list = remote?.proposals ?? buildLocalProposals(message, project);
    const createdAt = Date.now();
    for (const proposal of list) {
      proposals.set(proposal.id, { proposal, projectId: project.id, createdAt });
    }

    res.json({
      provider: remote ? 'llm' : 'local',
      model: remote?.model ?? null,
      projectId: project.id,
      proposals: list,
    });
  });

  /** 预览（mode=preview）或提交（mode=commit）提案。 */
  router.post('/proposals/:id/apply', (req, res) => {
    prune();
    const item = proposals.get(req.params.id);
    if (!item) {
      res.status(404).json({ error: '提案不存在或已过期，请重新生成。' });
      return;
    }
    const project = deps.getProject();
    if (project.id !== item.projectId) {
      res.status(409).json({ error: '当前项目已切换，请重新生成提案。' });
      return;
    }

    let candidate: Project;
    try {
      candidate = applyAiProposal(project, item.proposal);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }

    const mode = req.body?.mode === 'commit' ? 'commit' : 'preview';
    if (mode === 'commit') {
      deps.commitProject(candidate);
      proposals.delete(item.proposal.id);
    }

    res.json({
      mode,
      title: item.proposal.title,
      impact: item.proposal.impact,
      dashboard: computeDashboard(candidate),
    });
  });

  router.delete('/proposals/:id', (req, res) => {
    proposals.delete(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
