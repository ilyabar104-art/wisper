import React, { useEffect, useState } from 'react';

interface ModelRow {
  id: string;
  label: string;
  filename: string;
  url: string;
  sizeMb: number;
  installed: boolean;
}

export default function ModelPicker({
  activeModel,
  onActiveChange,
}: {
  activeModel: string;
  onActiveChange: (id: string) => void;
}) {
  const [models, setModels] = useState<ModelRow[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});

  useEffect(() => {
    refresh();
    const off = window.wisper.onModelProgress((id, pct) => {
      setProgress((p) => ({ ...p, [id]: pct }));
      if (pct >= 100) refresh();
    });
    return () => { off(); };
  }, []);

  async function refresh() {
    const list = (await window.wisper.listModels()) as ModelRow[];
    setModels(list);
  }

  async function handleDownload(id: string) {
    setProgress((p) => ({ ...p, [id]: 0 }));
    try {
      await window.wisper.downloadModel(id);
    } catch (e) {
      alert((e as Error).message);
    }
    refresh();
  }

  async function handleSetActive(id: string) {
    try {
      await window.wisper.setActiveModel(id);
      onActiveChange(id);
      refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function handleDelete(id: string) {
    await window.wisper.deleteModel(id);
    setProgress((p) => { const n = { ...p }; delete n[id]; return n; });
    refresh();
  }

  return (
    <div className="models">
      <h3>Whisper Models</h3>
      <p className="hint">
        Models are downloaded to your user data directory. Large-v3-turbo is recommended.
      </p>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Size</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const pct = progress[m.id];
            const downloading = pct !== undefined && pct < 100 && !m.installed;
            return (
              <tr key={m.id} className={m.id === activeModel ? 'active-row' : ''}>
                <td>{m.label}</td>
                <td>{m.sizeMb} MB</td>
                <td>
                  {m.installed ? (
                    <span className="ok">Installed</span>
                  ) : downloading ? (
                    <span>Downloading {pct}%</span>
                  ) : (
                    <span className="muted">Not installed</span>
                  )}
                </td>
                <td>
                  {m.id === activeModel && m.installed && (
                    <span className="badge">Active</span>
                  )}
                  {m.id === activeModel && !m.installed && !downloading && (
                    <>
                      <span className="badge badge-warn">Active</span>
                      <button onClick={() => handleDownload(m.id)}>Download</button>
                    </>
                  )}
                  {m.id !== activeModel && !m.installed && !downloading && (
                    <button onClick={() => handleDownload(m.id)}>Download</button>
                  )}
                  {m.id !== activeModel && m.installed && (
                    <>
                      <button onClick={() => handleSetActive(m.id)}>Use</button>
                      <button className="btn-danger" onClick={() => handleDelete(m.id)}>Delete</button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
