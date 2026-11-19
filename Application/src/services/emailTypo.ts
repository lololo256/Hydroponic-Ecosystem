/**
 * Suggests a correction when an e-mail domain looks like a typo of a common provider
 * (e.g. "gmial.com" -> "gmail.com", "gmail.con" -> "gmail.com").
 * Returns the corrected full address, or null when the domain looks fine / is unknown.
 */
const COMMON_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.co.th',
  'outlook.com',
  'outlook.co.th',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.th',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
];

/** Optimal string alignment distance (Levenshtein + adjacent transposition). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

export function suggestEmailCorrection(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (COMMON_DOMAINS.includes(domain)) return null;

  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of COMMON_DOMAINS) {
    const dist = editDistance(domain, candidate);
    if (dist < bestDistance) {
      best = candidate;
      bestDistance = dist;
    }
  }
  // 1-2 edits away from a known provider = very likely a typo; further away = a real other domain.
  const limit = domain.length <= 7 ? 1 : 2;
  if (best && bestDistance >= 1 && bestDistance <= limit) return `${local}@${best}`;
  return null;
}
