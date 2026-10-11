// Small WAV helpers for album export (detailed design 10.5).

/** Offset and length of the "data" chunk of a RIFF/WAVE file. */
export function dataChunk(wav: Uint8Array): { offset: number; length: number } {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let p = 12;
  while (p + 8 <= wav.length) {
    const id = String.fromCharCode(wav[p], wav[p + 1], wav[p + 2], wav[p + 3]);
    const size = v.getUint32(p + 4, true);
    if (id === "data") return { offset: p + 8, length: Math.min(size, wav.length - p - 8) };
    p += 8 + size + (size & 1);
  }
  throw new Error("WAV の data チャンクが見つかりません");
}

/** 44-byte PCM WAV header for `dataBytes` of interleaved stereo integer samples. */
export function pcmHeader(dataBytes: number, sampleRate: number, bits: number): Uint8Array {
  const h = new Uint8Array(44);
  const v = new DataView(h.buffer);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => (h[o + i] = c.charCodeAt(0)));
  const blockAlign = 2 * (bits / 8);
  tag(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bits, true);
  tag(36, "data");
  v.setUint32(40, dataBytes, true);
  return h;
}

/** CUE sheet; `starts` are sample offsets at `sampleRate` (detailed design 10.5). */
export function cueSheet(fileName: string, albumTitle: string, titles: string[], starts: number[], sampleRate: number): string {
  const msf = (samples: number) => {
    const frames = Math.round((samples / sampleRate) * 75);
    const mm = Math.floor(frames / (75 * 60));
    const ss = Math.floor(frames / 75) % 60;
    const ff = frames % 75;
    return [mm, ss, ff].map((n) => String(n).padStart(2, "0")).join(":");
  };
  const q = (s: string) => s.replace(/"/g, "'");
  const lines = [`TITLE "${q(albumTitle)}"`, `FILE "${q(fileName)}" WAVE`];
  titles.forEach((t, i) => lines.push(`  TRACK ${String(i + 1).padStart(2, "0")} AUDIO`, `    TITLE "${q(t)}"`, `    INDEX 01 ${msf(starts[i])}`));
  return lines.join("\r\n") + "\r\n";
}

export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").trim() || "untitled";
}
