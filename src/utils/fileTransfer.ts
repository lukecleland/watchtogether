/**
 * Chunked file transfer over the data channel.
 *
 * ## Why
 * Files used to travel as a single message: the whole thing base64-encoded and
 * assembled one character at a time on the main thread. A four-minute MP3 is
 * about 5.8MB, which became a ~7.7MB string built by repeated concatenation,
 * froze the tab while it was built, and arrived — if it arrived — as one
 * enormous message with nothing to show for it until it was completely done.
 *
 * This sends the file in chunks instead, which buys three things:
 *
 * - the tab stays responsive, because no step handles more than one chunk
 * - progress is knowable, because the receiver counts chunks against a total
 * - the panel can appear immediately and fill in, rather than the sender
 *   staring at nothing until the whole file lands
 *
 * ## Wire format
 * `file-begin` announces a transfer and which panel it belongs to, then
 * `file-chunk` messages carry the bytes in order, then the receiver assembles
 * on the final chunk. Chunks are base64: strings survive any serialisation the
 * data channel might use, and the 33% overhead is worth not having to care.
 *
 * ## Backpressure
 * A data channel will happily accept more than it can send and buffer the
 * difference in memory. The sender waits whenever the buffer is deep, which is
 * what stops a large file ballooning the tab's memory on the way out.
 */

/** Bytes per chunk before encoding. 48KB becomes ~64KB of base64. */
export const CHUNK_SIZE = 48 * 1024;

/** Pause sending once this much is queued but unsent. */
const HIGH_WATER_MARK = 1 * 1024 * 1024;

/**
 * Base64 for one chunk.
 *
 * `String.fromCharCode(...bytes)` would blow the call stack on a chunk this
 * size, so it goes in blocks.
 */
export function chunkToBase64(bytes: Uint8Array): string {
  let binary = "";
  const block = 8192;
  for (let i = 0; i < bytes.length; i += block) {
    binary += String.fromCharCode(...bytes.subarray(i, i + block));
  }
  return btoa(binary);
}

export function base64ToChunk(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface TransferMeta {
  transferId: string;
  panelId: string;
  fileName: string;
  mimeType: string;
  size: number;
  chunks: number;
}

interface Incoming {
  meta: TransferMeta;
  parts: (Uint8Array<ArrayBuffer> | undefined)[];
  received: number;
}

/**
 * Reassembles incoming transfers. Chunks are placed by index rather than
 * appended, so an out-of-order delivery can't silently corrupt the file.
 */
export class TransferReceiver {
  private open = new Map<string, Incoming>();

  begin(meta: TransferMeta) {
    this.open.set(meta.transferId, {
      meta,
      parts: new Array(meta.chunks),
      received: 0
    });
  }

  /** Returns the finished File once the last chunk lands, else null. */
  accept(transferId: string, index: number, data: string): { file: File; meta: TransferMeta } | null {
    const t = this.open.get(transferId);
    if (!t) return null;
    if (t.parts[index] === undefined) t.received++;
    t.parts[index] = base64ToChunk(data);
    if (t.received < t.meta.chunks) return null;

    this.open.delete(transferId);
    const file = new File(t.parts.filter(Boolean) as Uint8Array<ArrayBuffer>[], t.meta.fileName, {
      type: t.meta.mimeType
    });
    return { file, meta: t.meta };
  }

  /** 0–1, or null when nothing is arriving for that panel. */
  progressFor(panelId: string): number | null {
    for (const t of this.open.values()) {
      if (t.meta.panelId === panelId) return t.meta.chunks ? t.received / t.meta.chunks : 0;
    }
    return null;
  }

  abort(transferId: string) {
    this.open.delete(transferId);
  }

  clear() {
    this.open.clear();
  }
}

/** How deep the outgoing buffer is, when the channel exposes it. */
function bufferedAmount(conn: unknown): number {
  const dc = (conn as { dataChannel?: RTCDataChannel } | null)?.dataChannel;
  return dc?.bufferedAmount ?? 0;
}

/**
 * Slice a file and hand each chunk to `send`, pausing whenever the channel's
 * outgoing buffer is deep. `onProgress` reports 0–1 as chunks go out.
 */
export async function sendFileInChunks(
  file: File,
  conn: unknown,
  send: (msg: { index: number; data: string; last: boolean }) => void,
  onProgress?: (fraction: number) => void,
  isCancelled?: () => boolean
): Promise<void> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const chunks = Math.max(1, Math.ceil(buffer.length / CHUNK_SIZE));

  for (let i = 0; i < chunks; i++) {
    if (isCancelled?.()) return;

    // Let the channel drain before adding to it
    let guard = 0;
    while (bufferedAmount(conn) > HIGH_WATER_MARK && guard < 600) {
      await new Promise(r => setTimeout(r, 50));
      guard++;
    }

    const slice = buffer.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    send({ index: i, data: chunkToBase64(slice), last: i === chunks - 1 });
    onProgress?.((i + 1) / chunks);

    // Yield between chunks so encoding a large file never blocks input
    if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
  }
}

/** Chunk count for a file, so `file-begin` can advertise a total. */
export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / CHUNK_SIZE));
}
