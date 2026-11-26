/**
 * Words a ~350-rated beginner won't know. Claude output containing any is discarded, and
 * templates must contain none. Matching is case-insensitive and whole-word/phrase.
 */
export const BANNED_TERMS: readonly string[] = [
  'outpost', 'tempo', 'prophylaxis', 'initiative', 'zwischenzug', 'positional', 'weakness complex',
  'pawn structure', 'space advantage', 'compensation', 'dynamic', 'static',
];

const PATTERNS = BANNED_TERMS.map((term) => ({
  term,
  // Whole word or phrase (any whitespace between words); plurals count too.
  re: new RegExp(`\\b${term.split(' ').join('\\s+')}(?:s|es)?\\b`, 'i'),
}));

/** The banned terms found in `text`, in list order. Empty means the text is clean. */
export function findJargon(text: string): string[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.term);
}
