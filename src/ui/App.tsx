import { useEffect, useRef, useState } from 'react';
import { Coach } from '../coach/coach';
import { explainWithClaude, makeClient, type ClaudeClientLike } from '../coach/claude';
import { createEngine, type Engine } from '../engine/engine';
import { levelFor, summary } from '../profile/profile';
import { openDb, type Db, type Settings } from '../storage/db';
import type { ProfileData } from '../types';
import { GameScreen } from './GameScreen';
import { PatternsScreen } from './PatternsScreen';
import { SettingsScreen } from './SettingsScreen';

type Tab = 'play' | 'patterns' | 'settings';
const TABS: { tab: Tab; label: string }[] = [
  { tab: 'play', label: 'Play' }, { tab: 'patterns', label: 'My patterns' }, { tab: 'settings', label: 'Settings' },
];

/** Small seeded PRNG for reproducible opponent play (`?seed=`). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const params = new URLSearchParams(window.location.search);
const seedParam = params.get('seed');
const rng = seedParam !== null && Number.isFinite(Number(seedParam)) ? mulberry32(Number(seedParam)) : Math.random;
const startFen = params.get('fen') ?? undefined; // test-only

interface Loaded { db: Db; engine: Engine; coach: Coach }

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [profile, setProfileState] = useState<ProfileData | null>(null);
  const [tab, setTab] = useState<Tab>('play');
  const [claudeFailed, setClaudeFailed] = useState(false);

  const settingsRef = useRef<Settings | null>(null);
  const profileRef = useRef<ProfileData | null>(null);
  const gamesCount = useRef(0);
  const client = useRef<{ key: string; client: ClaudeClientLike } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = await openDb();
      const [s, p, games] = await Promise.all([db.getSettings(), db.getProfile(), db.listGames()]);
      if (cancelled) return;
      settingsRef.current = s;
      profileRef.current = p;
      gamesCount.current = games.length;
      const engine = createEngine();
      const coach = new Coach({
        engine,
        explain: async (packet) => {
          const { apiKey, model } = settingsRef.current!;
          if (!apiKey) return null;
          if (client.current?.key !== apiKey) client.current = { key: apiKey, client: await makeClient(apiKey) };
          const out = await explainWithClaude(packet, { client: client.current.client, model });
          setClaudeFailed(out === null);
          return out;
        },
        levelFor: (a) => levelFor(profileRef.current!, settingsRef.current!, a),
        profile: () => summary(profileRef.current!, Date.now(), gamesCount.current),
        themeCount: (t) => profileRef.current!.themes[t].count,
      });
      setSettingsState(s);
      setProfileState(p);
      setLoaded({ db, engine, coach });
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => { cancelled = true; };
  }, []);

  if (error) return <main className="app"><p className="card">Could not start: {error}</p></main>;
  if (!loaded || !settings || !profile) return <main className="app"><p className="status">Loading…</p></main>;
  const { db, engine, coach } = loaded;

  const onSettings = (s: Settings) => {
    settingsRef.current = s;
    setSettingsState(s);
    if (s.apiKey !== settings.apiKey) setClaudeFailed(false);
    db.saveSettings(s).catch(() => {});
  };
  const onProfile = (p: ProfileData) => {
    profileRef.current = p;
    setProfileState(p);
    db.saveProfile(p).catch(() => {});
    db.listGames().then((g) => { gamesCount.current = g.length; }, () => {});
  };

  return (
    <main className="app">
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.tab} type="button" aria-current={tab === t.tab ? 'page' : undefined}
            className={tab === t.tab ? 'active' : ''} onClick={() => setTab(t.tab)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {/* The game stays mounted so its loop and clock survive tab switches. */}
      <div hidden={tab !== 'play'}>
        <GameScreen
          db={db} engine={engine} coach={coach} profile={profile} settings={settings}
          onProfile={onProfile} onSettings={onSettings} rng={rng} startFen={startFen}
          coachOffline={!settings.apiKey || claudeFailed}
        />
      </div>
      {tab === 'patterns' && <PatternsScreen profile={profile} />}
      {tab === 'settings' && (
        <SettingsScreen
          db={db} settings={settings} profile={profile} onSettings={onSettings}
          onImported={() => window.location.reload()}
        />
      )}
    </main>
  );
}
