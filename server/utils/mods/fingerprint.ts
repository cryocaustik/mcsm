/** CurseForge's unsigned MurmurHash2 (seed 1), excluding ASCII whitespace. */
export function curseforgeFingerprint(input: Uint8Array): number {
  // TypedArray.filter allocates and copies through a callback for every byte.
  // Count first, then assemble Murmur words directly without a filtered buffer.
  let length = 0;
  for (let index = 0; index < input.length; index++) {
    const byte = input[index]!;
    if (byte !== 9 && byte !== 10 && byte !== 13 && byte !== 32) length++;
  }
  const m = 0x5bd1e995;
  let hash = (1 ^ length) >>> 0;
  let word = 0;
  let shift = 0;
  for (let index = 0; index < input.length; index++) {
    const byte = input[index]!;
    if (byte === 9 || byte === 10 || byte === 13 || byte === 32) continue;
    word |= byte << shift;
    shift += 8;
    if (shift === 32) {
      word = Math.imul(word, m);
      word ^= word >>> 24;
      word = Math.imul(word, m);
      hash = Math.imul(hash, m) ^ word;
      word = 0;
      shift = 0;
    }
  }
  if (shift) {
    hash = Math.imul(hash ^ word, m);
  }
  hash ^= hash >>> 13;
  hash = Math.imul(hash, m);
  hash ^= hash >>> 15;
  return hash >>> 0;
}
