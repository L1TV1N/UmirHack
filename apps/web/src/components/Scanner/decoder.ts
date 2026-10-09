/**
 * Распознавание кода по кадру с камеры. Если браузер умеет сам (BarcodeDetector в Chrome на Android),
 * берём его: он быстрее и точнее. Иначе подгружаем библиотеку ZXing: она чистый JavaScript, поэтому
 * работает под строгой политикой безопасности без eval и WebAssembly.
 */
export interface Decoder {
  readonly kind: 'native' | 'zxing';
  /** Текст первого найденного кода или null. */
  decode(video: HTMLVideoElement): Promise<string | null>;
  dispose(): void;
}

interface NativeBarcode {
  rawValue: string;
}
interface NativeDetector {
  detect(source: CanvasImageSource): Promise<NativeBarcode[]>;
}
interface NativeDetectorCtor {
  new (options?: { formats?: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'data_matrix', 'qr_code'];

async function nativeDecoder(): Promise<Decoder | null> {
  const Ctor = (globalThis as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const supported = await Ctor.getSupportedFormats();
    const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
    // без EAN-13 и DataMatrix делать нечего: пусть работает ZXing
    if (!formats.includes('ean_13') || !formats.includes('data_matrix')) return null;
    const detector = new Ctor({ formats });
    return {
      kind: 'native',
      async decode(video) {
        const found = await detector.detect(video);
        return found[0]?.rawValue ?? null;
      },
      dispose() {},
    };
  } catch {
    return null;
  }
}

const MAX_SIDE = 1024;

async function zxingDecoder(): Promise<Decoder> {
  const zx = await import('@zxing/library');
  const hints = new Map<unknown, unknown>([
    [
      zx.DecodeHintType.POSSIBLE_FORMATS,
      [zx.BarcodeFormat.EAN_13, zx.BarcodeFormat.EAN_8, zx.BarcodeFormat.UPC_A, zx.BarcodeFormat.UPC_E, zx.BarcodeFormat.CODE_128, zx.BarcodeFormat.DATA_MATRIX, zx.BarcodeFormat.QR_CODE],
    ],
    [zx.DecodeHintType.TRY_HARDER, true],
  ]);
  const reader = new zx.MultiFormatReader();
  reader.setHints(hints as Map<import('@zxing/library').DecodeHintType, unknown>);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  return {
    kind: 'zxing',
    async decode(video) {
      if (!ctx || !video.videoWidth) return null;
      const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return decodeImageData(zx, reader, ctx.getImageData(0, 0, canvas.width, canvas.height));
    },
    dispose() {
      reader.reset();
    },
  };
}

type Zx = typeof import('@zxing/library');

/** Яркость пикселей для ZXing: среднее по каналам, как делает библиотека для собственных источников. */
export function decodeImageData(zx: Zx, reader: InstanceType<Zx['MultiFormatReader']>, image: { data: Uint8ClampedArray; width: number; height: number }): string | null {
  const { data, width, height } = image;
  const luminance = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < luminance.length; i += 1, p += 4) {
    luminance[i] = ((data[p] as number) * 306 + (data[p + 1] as number) * 601 + (data[p + 2] as number) * 117) >> 10;
  }
  const bitmap = new zx.BinaryBitmap(new zx.HybridBinarizer(new zx.RGBLuminanceSource(luminance, width, height)));
  try {
    return reader.decode(bitmap).getText();
  } catch {
    // «кода в кадре нет» ZXing сообщает исключением, это обычное дело
    return null;
  }
}

export async function createDecoder(): Promise<Decoder> {
  return (await nativeDecoder()) ?? (await zxingDecoder());
}

