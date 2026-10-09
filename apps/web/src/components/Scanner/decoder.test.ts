// @vitest-environment node
import { parseScan } from '@zapas/shared';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import * as zx from '@zxing/library';
import { describe, expect, it } from 'vitest';
import { decodeImageData } from './decoder';

/** Настоящие картинки штрихкодов, нарисованные bwip-js, проходят через тот же разбор, что и кадры с камеры. */
function read(name: string): string | null {
  const png = PNG.sync.read(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.png`, import.meta.url))));
  const reader = new zx.MultiFormatReader();
  reader.setHints(
    new Map<zx.DecodeHintType, unknown>([
      [zx.DecodeHintType.POSSIBLE_FORMATS, [zx.BarcodeFormat.EAN_13, zx.BarcodeFormat.EAN_8, zx.BarcodeFormat.UPC_A, zx.BarcodeFormat.CODE_128, zx.BarcodeFormat.DATA_MATRIX, zx.BarcodeFormat.QR_CODE]],
      [zx.DecodeHintType.TRY_HARDER, true],
    ]),
  );
  return decodeImageData(zx, reader, { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height });
}

describe('распознавание картинок', () => {
  it('EAN-13 и EAN-8', () => {
    expect(read('ean13')).toBe('4006381333931');
    expect(read('ean8')).toBe('96385074');
  });

  it('Code 128 и QR с цифрами штрихкода', () => {
    expect(read('code128')).toBe('4607000010005');
    expect(read('qr')).toBe('4006381333931');
  });

  it('GS1 DataMatrix: GTIN, срок годности, партия и серийный номер', () => {
    const text = read('gs1dm');
    expect(text).not.toBeNull();
    const scan = parseScan(text as string);
    expect(scan).toMatchObject({ kind: 'gs1', gtin: '04607000011119', expiresOn: '2026-12-31', batch: 'LOT7', serial: 'SN12345', marked: true });
  });

  it('марка «Честного знака» без срока: GTIN и признак марки', () => {
    const scan = parseScan(read('gs1dm-kiz') as string);
    expect(scan).toMatchObject({ kind: 'gs1', gtin: '04607000011119', expiresOn: null, marked: true });
    expect(scan.serial).toBe('abcDEF12345678');
  });

  it('пустой кадр даёт null, а не исключение', () => {
    const reader = new zx.MultiFormatReader();
    const white = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
    expect(decodeImageData(zx, reader, white)).toBeNull();
  });
});
