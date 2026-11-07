/**
 * 테스트용 PDF — 바이너리 픽스처를 커밋하지 않으려고 코드로 만든다. 교차 참조 표의 오프셋을 **바이트로** 정확히 계산하므로
 * 판독기가 복구 경로를 타지 않는다.
 *
 *   - `minimalPdf` — 쪽마다 Helvetica 텍스트 한 줄(빈 문자열이면 텍스트 없는 쪽). 텍스트는 ASCII 만(괄호·역슬래시 없이).
 *   - `textBombPdf` — 1쪽은 평범한 한 줄, 2쪽은 Flate 로 압축한 `BT (AAAA…) Tj ET` 폭탄(풀면 `decodedMb` MB).
 *   - `koreanCidPdf` — 내장하지 않은 한국어 CID 글꼴(`/Encoding /KSCms-UHC-H`, Adobe-Korea1) · ToUnicode 없음. 텍스트는 CP949 바이트.
 *     오래된 한국어 PDF 의 모양 — CMap 없이는 텍스트가 빈다.
 *   - `missingSecondPagePdf` — 2쪽이 없는 객체를 가리킨다(1쪽을 읽은 뒤 쪽 오류).
 */

import { deflateSync } from 'node:zlib';

/** 객체 본문들(1번부터) → PDF. 1번이 Catalog 여야 한다. */
export function pdfFromObjects(objects: readonly (string | Uint8Array)[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  let position = parts[0]?.length ?? 0;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(position);
    const part = Buffer.concat([Buffer.from(`${String(i + 1)} 0 obj\n`), Buffer.from(body), Buffer.from('\nendobj\n')]);
    parts.push(part);
    position += part.length;
  });
  let tail = `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  tail += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  tail += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(position)}\n%%EOF\n`;
  parts.push(Buffer.from(tail));
  return new Uint8Array(Buffer.concat(parts));
}

function stream(content: Uint8Array, deflate = false): Uint8Array {
  const data = deflate ? deflateSync(content, { level: 9 }) : Buffer.from(content);
  const filter = deflate ? ' /Filter /FlateDecode' : '';
  return Buffer.concat([Buffer.from(`<< /Length ${String(data.length)}${filter} >>\nstream\n`), data, Buffer.from('\nendstream')]);
}

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

function page(contentsRef: number, fontRef: number): string {
  return `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${String(fontRef)} 0 R >> >> /Contents ${String(contentsRef)} 0 R >>`;
}

export function minimalPdf(pages: readonly string[]): Uint8Array {
  const objects: (string | Uint8Array)[] = [];
  const kids = pages.map((_, i) => `${String(4 + i * 2)} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`);
  objects.push(HELVETICA);
  pages.forEach((text, i) => {
    objects.push(page(5 + i * 2, 3));
    objects.push(stream(Buffer.from(text === '' ? '' : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`)));
  });
  return pdfFromObjects(objects);
}

export function textBombPdf(firstPageText: string, decodedMb: number): Uint8Array {
  const line = 'BT /F1 1 Tf (AAAAAAAAAAAAAAAAAAAAAAAAAAAA) Tj ET\n';
  const bomb = Buffer.from(line.repeat(Math.ceil((decodedMb * 1024 * 1024) / line.length)));
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    HELVETICA,
    page(5, 3),
    stream(Buffer.from(`BT /F1 12 Tf 72 720 Td (${firstPageText}) Tj ET`)),
    page(7, 3),
    stream(bomb, true),
  ]);
}

export function koreanCidPdf(cp949: Uint8Array): Uint8Array {
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /KSCms-UHC-H /DescendantFonts [6 0 R] >>',
    page(5, 3),
    stream(Buffer.from(`BT /F1 12 Tf 72 720 Td <${Buffer.from(cp949).toString('hex')}> Tj ET`)),
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 2 >> /FontDescriptor 7 0 R >>',
    '<< /Type /FontDescriptor /FontName /HYGoThic-Medium /Flags 6 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
  ]);
}

export function missingSecondPagePdf(firstPageText: string): Uint8Array {
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 99 0 R] /Count 2 >>',
    HELVETICA,
    page(5, 3),
    stream(Buffer.from(`BT /F1 12 Tf 72 720 Td (${firstPageText}) Tj ET`)),
  ]);
}
