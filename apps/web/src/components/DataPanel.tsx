import { useEffect, useRef, useState } from 'react';
import type { ImportResult, StoredProjectSummary } from '../api';
import {
  activateProject,
  deleteProject,
  importProjectXml,
  listProjects,
  loadDashboard,
  saveActiveProject,
} from '../api';
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
  const [projects, setProjects] = useState<StoredProjectSummary[]>([]);
  const [storageBusy, setStorageBusy] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  async function refreshProjects() {
    try {
      setProjects(await listProjects());
      setStorageError(null);
    } catch {
      setStorageError('项目存储需要 API 服务可用（npm run dev）。');
    }
  }

  useEffect(() => {
    void refreshProjects();
  }, []);

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
      if (result.source === 'api') await refreshProjects();
    } catch (error) {
      setFeedback({ tone: 'bad', text: `导入失败：${(error as Error).message}` });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleSave() {
    setStorageBusy('save');
    setFeedback(null);
    try {
      const saved = await saveActiveProject();
      await refreshProjects();
      setFeedback({
        tone: 'ok',
        text: `已保存「${saved.name}」v${saved.version}，共 ${saved.activityCount} 项活动。`,
      });
    } catch (error) {
      setFeedback({ tone: 'bad', text: `保存失败：${(error as Error).message}` });
    } finally {
      setStorageBusy(null);
    }
  }

  async function handleActivate(id: string) {
    setStorageBusy(id);
    setFeedback(null);
    try {
      const result = await activateProject(id);
      onImported(result);
      setFeedback({
        tone: 'ok',
        text: `已切换到「${result.data.project.name}」，数据日期 ${dateCn(result.data.project.dataDate)}。`,
      });
    } catch (error) {
      setFeedback({ tone: 'bad', text: `加载失败：${(error as Error).message}` });
    } finally {
      setStorageBusy(null);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`删除项目「${name}」及其历史版本？该操作不可撤销。`)) return;
    setStorageBusy(id);
    setFeedback(null);
    try {
      await deleteProject(id);
      const latest = await loadDashboard();
      onImported({ ...latest, warnings: [] });
      await refreshProjects();
      setFeedback({ tone: 'ok', text: `已删除「${name}」。` });
    } catch (error) {
      setFeedback({ tone: 'bad', text: `删除失败：${(error as Error).message}` });
    } finally {
      setStorageBusy(null);
    }
  }

  return (
    <section className="panel data-panel">
      <div className="panel-head">
        <h3>数据源与交换</h3>
        <span className="panel-count">阶段 3 · MSPDI + IFC4 + 本地存储</span>
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

        <div className="data-storage">
          <div className="data-storage-head">
            <span>项目存储（保存于 API 进程本地文件，重启不丢失）</span>
            <div className="data-storage-actions">
              <button
                type="button"
                className="btn btn-small"
                disabled={storageBusy !== null}
                onClick={() => void handleSave()}
              >
                {storageBusy === 'save' ? '保存中…' : '保存当前项目'}
              </button>
              <button
                type="button"
                className="btn btn-small"
                disabled={storageBusy !== null}
                onClick={() => void refreshProjects()}
              >
                刷新列表
              </button>
            </div>
          </div>
          {storageError && <p className="storage-hint">{storageError}</p>}
          {projects.length === 0 ? (
            <p className="storage-hint">暂无已保存项目；保存后可在此加载或切换。</p>
          ) : (
            <ul className="stored-list">
              {projects.map((project) => (
                <li className="stored-item" key={project.id}>
                  <div className="stored-meta">
                    <b>{project.name}</b>
                    <span>
                      {project.activityCount} 项活动 · v{project.version} ·{' '}
                      {project.updatedAt.slice(0, 10)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={storageBusy !== null}
                    onClick={() => void handleActivate(project.id)}
                  >
                    {storageBusy === project.id ? '加载中…' : '加载'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    disabled={storageBusy !== null}
                    onClick={() => void handleDelete(project.id, project.name)}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
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
