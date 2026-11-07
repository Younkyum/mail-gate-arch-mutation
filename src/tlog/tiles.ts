/**
 * src/tlog/tiles.ts — **C2SP tlog-tiles** 경로·내용(c2sp.org/tlog-tiles, 2026-09-24 확인) — 전역 공개 로그의 정적 서빙.
 *
 *   - 타일 높이 8 · 폭 256 해시(8192바이트). 레벨 0 = 잎 해시, 레벨 L ≥ 1 = 아래 레벨 **완전** 타일 하나의 MTH.
 *     곧 레벨 L 의 j 번째 해시 = MTH(잎 [j·256^L, (j+1)·256^L)).
 *   - 경로 `<prefix>/tile/<L>/<N>[.p/<W>]`, N 은 세 자리씩 끊고 마지막 묶음 말고는 `x` 를 붙인다(1234067 → `x001/x234/067`).
 *     W(1~255)는 부분 타일의 폭.
 *   - 잎 묶음 `<prefix>/tile/entries/<N>[.p/<W>]` — big-endian uint16 길이 접두 + 잎 바이트의 나열.
 *   - `<prefix>/checkpoint` 는 가변(짧은 캐시), 타일·잎 묶음은 불변(긴 캐시).
 * 로그 크기가 1씩 늘 때마다 게시하므로 **레벨마다 가장 오른쪽 타일 하나**와 잎 묶음 하나를 쓰면 빠짐없이 덮인다.
 */

import { subtreeRoot } from './merkle';

export const TILE_WIDTH = 256;

export function encodeTileIndex(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('타일 번호는 0 이상 정수다');
  const pad = (value: number): string => String(value).padStart(3, '0');
  let rest = Math.floor(index / 1000);
  const parts = [pad(index % 1000)];
  while (rest > 0) {
    parts.unshift(`x${pad(rest % 1000)}`);
    rest = Math.floor(rest / 1000);
  }
  return parts.join('/');
}

export function tilePath(level: number | 'entries', index: number, width: number): string {
  if (!Number.isSafeInteger(width) || width < 1 || width > TILE_WIDTH) throw new RangeError('타일 폭은 1~256');
  const suffix = width === TILE_WIDTH ? '' : `.p/${String(width)}`;
  return `tile/${String(level)}/${encodeTileIndex(index)}${suffix}`;
}

export interface TileObject {
  /** 로그 접두사(`log/`) 아래의 상대 경로. */
  readonly path: string;
  readonly bytes: Buffer;
}

/** 크기 `size` 트리에서 새로 생기거나 바뀐 타일들(레벨마다 가장 오른쪽 하나) + 잎 묶음 하나. */
export function rightmostTiles(leafHashes: readonly Uint8Array[], entries: readonly Uint8Array[], size: number): TileObject[] {
  if (size < 1 || size > leafHashes.length || size > entries.length) throw new RangeError('size 가 잎 수와 맞지 않는다');
  const out: TileObject[] = [];
  let span = 1; // 레벨 L 의 해시 하나가 덮는 잎 수(256^L)
  for (let level = 0; ; level += 1) {
    const count = Math.floor(size / span);
    if (count === 0) break;
    const tile = Math.floor((count - 1) / TILE_WIDTH);
    const width = count - tile * TILE_WIDTH;
    const hashes: Buffer[] = [];
    for (let j = tile * TILE_WIDTH; j < count; j += 1) hashes.push(subtreeRoot(leafHashes, j * span, (j + 1) * span));
    out.push({ path: tilePath(level, tile, width), bytes: Buffer.concat(hashes) });
    if (level === 0) {
      const bundle: Buffer[] = [];
      for (let j = tile * TILE_WIDTH; j < count; j += 1) {
        const entry = entries[j] as Uint8Array;
        if (entry.length > 0xffff) throw new RangeError('잎이 64KiB 를 넘는다');
        const length = Buffer.alloc(2);
        length.writeUInt16BE(entry.length);
        bundle.push(length, Buffer.from(entry));
      }
      out.push({ path: tilePath('entries', tile, width), bytes: Buffer.concat(bundle) });
    }
    span *= TILE_WIDTH;
  }
  return out;
}
