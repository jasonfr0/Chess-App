import type { TeachMode, TeachState, TeachTopic, TopicState } from '../types';

export const FADE = { FREE_GAMES: 3, SHOWN_BEFORE_TRIAL: 5, SHOWN_AFTER_FALL_BACK: 3, WINDOW: 4, MISSES_TO_FALL_BACK: 2 } as const;

const ALWAYS_SHOW: readonly TeachTopic[] = ['opening', 'other'];
const ALL_TOPICS: readonly TeachTopic[] = ['opening', 'safety', 'captures', 'checks', 'development', 'endgame', 'other'];

export function emptyTeachState(): TeachState {
  return { gamesFinished: 0, topics: {} };
}

function fixedShow(s: TeachState, topic: TeachTopic): boolean {
  return s.gamesFinished < FADE.FREE_GAMES || ALWAYS_SHOW.includes(topic);
}

function initialTopic(topic: TeachTopic): TopicState {
  return { mode: topic === 'endgame' ? 'guide' : 'show', shown: 0, need: FADE.SHOWN_BEFORE_TRIAL, recent: [] };
}

export function modeFor(s: TeachState | undefined, topic: TeachTopic): TeachMode {
  const state = s ?? emptyTeachState();
  if (fixedShow(state, topic)) return 'show';
  return (state.topics[topic] ?? initialTopic(topic)).mode;
}

/** One counted turn. `mode` is the mode the turn was presented in. */
export function recordTurn(
  s: TeachState | undefined,
  topic: TeachTopic,
  turn: { mode: TeachMode; flagged: boolean; openedOptions: boolean },
): TeachState {
  if (!s) return emptyTeachState();
  if (fixedShow(s, topic)) return s;
  const cur = s.topics[topic] ?? initialTopic(topic);
  let next: TopicState;
  if (turn.mode === 'show') {
    const shown = cur.shown + 1;
    next = shown >= cur.need ? { mode: 'guide', shown: 0, need: cur.need, recent: [] } : { ...cur, mode: 'show', shown, recent: [] };
  } else {
    const recent = [...cur.recent, !turn.flagged && !turn.openedOptions].slice(-FADE.WINDOW);
    const misses = recent.filter(ok => !ok).length;
    next = misses >= FADE.MISSES_TO_FALL_BACK
      ? { mode: 'show', shown: 0, need: FADE.SHOWN_AFTER_FALL_BACK, recent: [] }
      : { ...cur, mode: 'guide', recent };
  }
  return { ...s, topics: { ...s.topics, [topic]: next } };
}

export function finishGame(s: TeachState | undefined): TeachState {
  const base = s ?? emptyTeachState();
  return { ...base, gamesFinished: base.gamesFinished + 1 };
}

/** Topics whose mode differs between two states (by modeFor), for the recap. */
export function topicChanges(before: TeachState | undefined, after: TeachState): { topic: TeachTopic; to: TeachMode }[] {
  const out: { topic: TeachTopic; to: TeachMode }[] = [];
  for (const topic of ALL_TOPICS) {
    if (ALWAYS_SHOW.includes(topic)) continue;
    const to = modeFor(after, topic);
    if (modeFor(before, topic) !== to) out.push({ topic, to });
  }
  return out;
}
