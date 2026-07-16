export const ENCRYPTED_FRAGMENT_REGEX = /%%private-sync-encrypted:v1:[A-Za-z0-9_-]+%%/g;

export type EncryptedFragmentRange = {
  marker: string;
  start: number;
  end: number;
};

export function findEncryptedFragments(text: string): EncryptedFragmentRange[] {
  const fragments: EncryptedFragmentRange[] = [];
  for (const match of text.matchAll(ENCRYPTED_FRAGMENT_REGEX)) {
    const start = match.index ?? 0;
    fragments.push({
      marker: match[0],
      start,
      end: start + match[0].length
    });
  }
  return fragments;
}

export function findEncryptedFragmentAtOffset(text: string, offset: number): EncryptedFragmentRange | null {
  return findEncryptedFragments(text).find((fragment) => offset >= fragment.start && offset <= fragment.end) ?? null;
}

export function replaceEncryptedFragment(text: string, fragment: EncryptedFragmentRange, replacement: string): string {
  if (text.slice(fragment.start, fragment.end) !== fragment.marker) {
    throw new Error("Encrypted fragment changed before it could be replaced.");
  }
  return text.slice(0, fragment.start) + replacement + text.slice(fragment.end);
}

export function isEncryptedFragmentMarker(text: string): boolean {
  return /^%%private-sync-encrypted:v1:[A-Za-z0-9_-]+%%$/.test(text.trim());
}
