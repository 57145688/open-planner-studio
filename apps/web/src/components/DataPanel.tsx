import { useRef, useState } from 'react';
import type { ImportResult } from '../api';
import { importProjectXml } from '../api';
import { dateCn } from '../format';

interface Feedback {
  tone: 'ok' | 'bad';
  text: string;
  warnings?: string[];
}

export function DataPanel({
  currentName,
  onImported,
}: {
  currentName: string;
  onImported: (result: ImportResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setFeedback(null);
    try {
      const xml = await file.text();
      const result = await importProjectXml(xml);
      onImported(result);
      const { schedule, resources, project } = result.data;
      const warnings = result.warnings.slice(0, 3);
      const suffix =
        result.warnings.length > warnings.length
          ? `（仅显示前 ${warnings.length} 条，共 ${result.warnings.length} 条）`
          : '';
      setFeedback({
        tone: 'ok',
        text: `已载入「${project.name}」：${schedule.activities.length} 项活动、${resources.loads.length} 项资源，数据日期 ${dateCn(project.dataDate)}，来源 ${result.source === 'api' ? 'API 网关' : '浏览器本地解析'}。`,
        warnings: warnings.length > 0 ? [...warnings, ...(suffix ? [suffix] : [])] : undefined,
      });
    } catch (error) {
      setFeedback({ tone: 'bad', text: `导入失败：${(error as Error).message}` });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <section className="panel data-panel">
      <div className="panel-head">
        <h3>数据源与交换</h3>
        <span className="panel-count">阶段 2 · MSPDI + IFC4</span>
      </div>
      <div className="data-body">
        <div className="data-current">
          <span>当前项目</span>
          <strong>{currentName}</strong>
        </div>
        <div className="data-actions">
          <a className="btn btn-primary" href="/api/export/mspdi" download>
            导出 MS Project XML
          </a>
          <a className="btn" href="/api/bim/sample.ifc" download>
            下载 IFC4 模型
          </a>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? '正在导入…' : '导入 MS Project XML'}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".xml,application/xml,text/xml"
            className="file-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
        </div>
        {feedback && (
          <div className={`data-feedback ${feedback.tone === 'ok' ? 'data-ok' : 'data-bad'}`}>
            <p>{feedback.text}</p>
            {feedback.warnings && (
              <ul>
                {feedback.warnings.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="panel-foot">
          导出文件包含 WBS、任务、四种逻辑关系（FS/SS/FF/SF）与滞后、资源与分配、完成百分比和成本，
          可直接在 MS Project、ProjectLibre、OpenProject 中打开；导入会替换当前工作项目，但仍需在正式写入前审阅。
        </p>
      </div>
    </section>
  );
}
