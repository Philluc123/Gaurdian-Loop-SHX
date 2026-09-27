// Small ASR-tolerant matching helper, local to this module.
//
// Rules are expressed as a set of canonical lowercase "terms" that must all
// appear within a bounded token window of each other (order-independent).
// Each term tolerates the class of speech-to-text errors documented in
// IMPLEMENTATION_PROMPT.md (dropped/added/substituted/transposed letters)
// via a length-scaled edit-distance budget, rather than a hardcoded list of
// known typos.

export interface Token {
  word: string; // normalized (lowercased, punctuation stripped)
  start: number; // offset into the original text
  end: number;
}

export interface Span {
  start: number;
  end: number;
}

export interface Pattern {
  terms: string[]; // canonical lowercase words, no punctuation
  window: number; // max number of consecutive tokens to search within
}

const WORD_RE = /[A-Za-z']+/g;

function normalizeWord(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, "");
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_RE.exec(text)) !== null) {
    const word = normalizeWord(match[0]);
    if (word.length === 0) continue;
    tokens.push({ word, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

// Damerau-Levenshtein distance (optimal string alignment: adjacent
// transpositions cost 1), which is what most single-error ASR mistakes
// look like ("beleive" for "believe", "arested" for "arrested").
function editDistance(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  const d: number[][] = [];
  for (let i = 0; i <= al; i++) {
    d.push(new Array(bl + 1).fill(0));
    d[i][0] = i;
  }
  for (let j = 0; j <= bl; j++) d[0][j] = j;

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2][j - 2] + cost);
      }
      d[i][j] = best;
    }
  }
  return d[al][bl];
}

// Short words tolerate no noise (too easy to collide with unrelated words);
// medium/long words tolerate the single-substitution/insertion/deletion/
// transposition errors that real ASR output actually produces.
function maxAllowedDistance(word: string): number {
  if (word.length <= 3) return 0;
  if (word.length <= 6) return 1;
  return 2;
}

function fuzzyEquals(canonical: string, actual: string): boolean {
  if (canonical === actual) return true;
  const maxD = maxAllowedDistance(canonical);
  if (maxD === 0) return false;
  if (Math.abs(canonical.length - actual.length) > maxD) return false;
  return editDistance(canonical, actual) <= maxD;
}

function matchTermsInWindow(terms: string[], windowTokens: Token[]): number[] | null {
  const used = new Set<number>();
  const indices: number[] = [];
  for (const term of terms) {
    let found = -1;
    for (let i = 0; i < windowTokens.length; i++) {
      if (used.has(i)) continue;
      if (fuzzyEquals(term, windowTokens[i].word)) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    used.add(found);
    indices.push(found);
  }
  return indices;
}

// Finds every window of `pattern.window` consecutive tokens that contains a
// fuzzy match for each of `pattern.terms` (each term consumes a distinct
// token; order within the window doesn't matter). Returns the tight span
// (into the original text) covering just the matched tokens.
export function findPatternMatches(tokens: Token[], pattern: Pattern): Span[] {
  const spans: Span[] = [];
  const n = tokens.length;
  const windowSize = Math.max(pattern.window, pattern.terms.length);

  for (let start = 0; start < n; start++) {
    const end = Math.min(n, start + windowSize);
    const windowTokens = tokens.slice(start, end);
    if (windowTokens.length < pattern.terms.length) continue;

    const localIndices = matchTermsInWindow(pattern.terms, windowTokens);
    if (!localIndices) continue;

    const globalIndices = localIndices.map((i) => start + i);
    const minIdx = Math.min(...globalIndices);
    const maxIdx = Math.max(...globalIndices);
    spans.push({ start: tokens[minIdx].start, end: tokens[maxIdx].end });
  }

  return spans;
}
