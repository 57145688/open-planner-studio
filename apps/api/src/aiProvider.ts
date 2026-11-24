import {
  sanitizeLlmProposal,
  type AiProposal,
  type LlmProposalInput,
  type Project,
} from '@apcc/core';

/**
 * OpenAI 兼容的模型接入层。未配置 APCC_AI_BASE_URL / APCC_AI_API_KEY 时返回 null，
 * 由 AI 路由回退到本地规则引擎。
 */

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function aiConfig(): AiConfig | null {
  const baseUrl = process.env.APCC_AI_BASE_URL?.trim();
  const apiKey = process.env.APCC_AI_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    model: process.env.APCC_AI_MODEL?.trim() || 'gpt-4o-mini',
  };
}

const SYSTEM_PROMPT = `你是施工项目控制中心的助手。只输出一个 JSON 对象，格式：
{"proposals":[{"intent":"crash|leveling|explain|weekly-report","title":"短标题","summary":"一句话摘要","operation":{...}}]}

规则：
- crash 的 operation 必须是 {"kind":"crash","targetDays":1-30}
- leveling 的 operation 必须是 {"kind":"leveling","maxShiftDays":1-30}
- explain 与 weekly-report 不需要 operation
- 不要输出任何其他操作、SQL、脚本或项目字段
- 最多返回 3 条提案`;

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

export async function generateLlmProposals(
  message: string,
  project: Project,
): Promise<{ proposals: AiProposal[]; model: string } | null> {
  const config = aiConfig();
  if (!config) return null;

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `项目：${project.name}\n数据日期：${project.dataDate}\n请求：${message}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return null;

    const json = extractJson(content);
    if (!json) return null;
    const parsed = JSON.parse(json) as { proposals?: LlmProposalInput[] };
    const proposals = (parsed.proposals ?? [])
      .map((item) => sanitizeLlmProposal(item, project))
      .filter((item): item is AiProposal => item !== null)
      .slice(0, 3);
    if (proposals.length === 0) return null;

    return { proposals, model: config.model };
  } catch {
    return null;
  }
}
