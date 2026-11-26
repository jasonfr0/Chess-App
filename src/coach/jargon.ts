/**
 * Words a ~350-rated beginner won't know. Claude output containing any is discarded, and
 * templates must contain none. Matching is case-insensitive and whole-word/phrase.
 */
export const BANNED_TERMS: readonly string[] = [
  'outpost', 'tempo', 'prophylaxis', 'initiative', 'zwischenzug', 'positional', 'weakness complex',
  'pawn structure', 'space advantage', 'compensation', 'dynamic', 'static',
];

/** Plurals that don't just add "s"/"es". */
const IRREGULAR: Record<string, string> = { tempo: 'tempi' };

const PATTERNS = BANNED_TERMS.map((term) => {
  const forms = [term, IRREGULAR[term]].filter(Boolean).map((t) => t.split(' ').join('\\s+'));
  // Whole word or phrase (any whitespace between words); plurals count too ("outposts", "tempi").
  return { term, re: new RegExp(`\\b(?:${forms.join('|')})(?:s|es)?\\b`, 'i') };
});

/** The banned terms found in `text`, in list order. Empty means the text is clean. */
export function findJargon(text: string): string[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.term);
}
