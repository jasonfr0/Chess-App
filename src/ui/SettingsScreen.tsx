import { useState } from 'react';
import type { ModelId } from '../coach/claude';
import type { Db, Settings } from '../storage/db';
import type { Area, CoachLevel, ProfileData } from '../types';

const MODELS: { id: ModelId; label: string; cost: string }[] = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', cost: '~$0.25–0.50/game' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', cost: '~$0.50–1/game' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', cost: '~1–3¢/game' },
];
const AREAS: { area: Area; label: string }[] = [
  { area: 'opening', label: 'Opening' }, { area: 'middlegame', label: 'Middlegame' }, { area: 'endgame', label: 'Endgame' },
];
const LEVELS: CoachLevel[] = ['full', 'guided', 'light', 'solo'];
const CLOCKS: (number | null)[] = [null, 10, 15, 30];

/** One tiny plain-text request to check the key works. */
async function testKey(apiKey: string, model: ModelId): Promise<string> {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    await client.messages.create({
      model,
      max_tokens: 16,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the word OK.' }],
    });
    return 'OK: the key works.';
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

interface Props {
  db: Db;
  settings: Settings;
  profile: ProfileData;
  onSettings: (s: Settings) => void;
  onImported: () => void;
}

export function SettingsScreen({ db, settings, profile, onSettings, onImported }: Props) {
  const [keyDraft, setKeyDraft] = useState(settings.apiKey);
  const [keyStatus, setKeyStatus] = useState('');
  const [backupStatus, setBackupStatus] = useState('');
  const update = (patch: Partial<Settings>) => onSettings({ ...settings, ...patch });

  const saveKey = (key: string) => { if (key !== settings.apiKey) update({ apiKey: key.trim() }); };

  const onTest = async () => {
    const key = keyDraft.trim();
    saveKey(key);
    if (!key) { setKeyStatus('Enter a key first.'); return; }
    setKeyStatus('Testing…');
    setKeyStatus(await testKey(key, settings.model));
  };

  const onExport = async () => {
    const json = await db.exportAll();
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `chess-coach-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setBackupStatus('Backup downloaded (your API key is not included).');
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      await db.importAll(await file.text());
      setBackupStatus('Backup restored.');
      onImported();
    } catch (e) {
      setBackupStatus(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="screen settings">
      <section className="card">
        <h2>Claude coach</h2>
        <label htmlFor="api-key">API key</label>
        <input
          id="api-key" type="password" autoComplete="off" value={keyDraft} placeholder="sk-ant-…"
          onChange={(e) => setKeyDraft(e.target.value)} onBlur={() => saveKey(keyDraft)}
        />
        <p className="muted">Stored on this device only. Without a key the coach uses built-in explanations.</p>
        <div className="actions">
          <button type="button" onClick={onTest}>Test key</button>
        </div>
        {keyStatus && <p role="status">{keyStatus}</p>}

        <label htmlFor="model">Model</label>
        <select id="model" value={settings.model} onChange={(e) => update({ model: e.target.value as ModelId })}>
          {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} · {m.cost}</option>)}
        </select>
        <p className="muted">
          Sonnet 5.5 is the default. Estimated cost: {MODELS.find((m) => m.id === settings.model)?.cost}.
        </p>
      </section>

      <section className="card">
        <h2>Coaching level</h2>
        {AREAS.map(({ area, label }) => (
          <div className="row" key={area}>
            <label htmlFor={`level-${area}`}>{label}</label>
            <select
              id={`level-${area}`}
              value={settings.levelOverride[area] ?? 'auto'}
              onChange={(e) => {
                const levelOverride = { ...settings.levelOverride };
                if (e.target.value === 'auto') delete levelOverride[area];
                else levelOverride[area] = e.target.value as CoachLevel;
                update({ levelOverride });
              }}
            >
              <option value="auto">Auto (now {profile.levels[area]})</option>
              {LEVELS.map((l) => <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>)}
            </select>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Clock</h2>
        <div className="row">
          <label htmlFor="clock">Minutes per side</label>
          <select
            id="clock"
            value={settings.clockMinutes ?? 'off'}
            onChange={(e) => update({ clockMinutes: e.target.value === 'off' ? null : Number(e.target.value) })}
          >
            {CLOCKS.map((c) => <option key={c ?? 'off'} value={c ?? 'off'}>{c === null ? 'Off' : `${c} minutes`}</option>)}
          </select>
        </div>
        <p className="muted">Takes effect from your next game. Opponent strength: {settings.opponentRating}.</p>
      </section>

      <section className="card">
        <h2>Backup</h2>
        <div className="actions">
          <button type="button" onClick={onExport}>Export backup</button>
          <label className="button">
            Import backup
            <input type="file" accept="application/json,.json" hidden onChange={(e) => onImport(e.target.files?.[0])} />
          </label>
        </div>
        {backupStatus && <p role="status">{backupStatus}</p>}
      </section>
    </div>
  );
}
