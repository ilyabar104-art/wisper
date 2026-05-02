import React, { useEffect, useState } from 'react';

interface Entry {
  id: number;
  ts: number;
  text: string;
  duration_ms: number;
  model: string;
}

export default function History() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    refresh(query);
  }, [query]);

  async function refresh(q: string) {
    const list = (await window.wisper.historyList(q)) as Entry[];
    setEntries(list);
  }

  async function handleDelete(id: number) {
    await window.wisper.historyDelete(id);
    refresh(query);
  }

  function copy(text: string) {
    window.wisper.clipboardWrite(text);
  }

  return (
    <div className="history">
      <input
        className="search"
        placeholder="Search transcriptions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {entries.length === 0 && <p className="muted">No transcriptions yet.</p>}
      <ul>
        {entries.map((e) => (
          <li key={e.id}>
            <div className="meta">
              <span>{new Date(e.ts).toLocaleString()}</span>
              <span className="muted"> · {e.model} · {Math.round(e.duration_ms)}ms</span>
            </div>
            <div className="text">{e.text}</div>
            <div className="actions">
              <button onClick={() => copy(e.text)}>Copy</button>
              <button onClick={() => handleDelete(e.id)}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
