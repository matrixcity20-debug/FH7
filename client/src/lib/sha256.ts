/**
 * Streaming SHA-256 — browser-safe incremental hashing.
 * SubtleCrypto.digest() requires the full buffer upfront; this implementation
 * accepts data in arbitrary-size chunks so callers never need to load an
 * entire file into RAM at once.
 */

export function rot32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

export const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class SHA256Stream {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private totalLen = 0;

  update(data: Uint8Array): this {
    let off = 0;
    this.totalLen += data.length;
    while (off < data.length) {
      const take = Math.min(64 - this.bufLen, data.length - off);
      this.buf.set(data.subarray(off, off + take), this.bufLen);
      this.bufLen += take;
      off += take;
      if (this.bufLen === 64) { this.compress(this.buf); this.bufLen = 0; }
    }
    return this;
  }

  private compress(block: Uint8Array): void {
    const h = this.h;
    const w = new Uint32Array(64);
    const dv = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rot32(w[i - 15], 7) ^ rot32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rot32(w[i - 2], 17) ^ rot32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];
    for (let i = 0; i < 64; i++) {
      const S1 = rot32(e, 6) ^ rot32(e, 11) ^ rot32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rot32(a, 2) ^ rot32(a, 13) ^ rot32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  digest(): string {
    const totalBits = this.totalLen * 8;
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const padding = new Uint8Array(padLen + 8);
    padding[0] = 0x80;
    const dv = new DataView(padding.buffer);
    dv.setUint32(padLen, Math.floor(totalBits / 2 ** 32), false);
    dv.setUint32(padLen + 4, totalBits >>> 0, false);
    this.update(padding);
    return Array.from(this.h).map((n) => n.toString(16).padStart(8, "0")).join("");
  }
}

export async function hashFileStreaming(
  file: File,
  chunkSize = 2 * 1024 * 1024,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const sha = new SHA256Stream();
  let done = 0;
  while (done < file.size) {
    const slice = file.slice(done, done + chunkSize);
    const buf = await slice.arrayBuffer();
    sha.update(new Uint8Array(buf));
    done += buf.byteLength;
    onProgress?.(done, file.size);
  }
  return sha.digest();
}
