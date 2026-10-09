import { parseScan, type ProductDto, type ScanResult } from '@zapas/shared';
import { ScanLine } from 'lucide-react';
import { useEffect, useState } from 'react';
import { loadCatalog, findProduct, refreshCatalog } from '../../lib/catalog';
import { Button } from '../Button/Button';
import { ScannerDialog, type ScanFeedback } from './ScannerDialog';

export interface ScanHit {
  product: ProductDto;
  scan: ScanResult;
}

interface Props {
  /** Что сделать с найденным продуктом. Ответ показывается в окне сканера. */
  onProduct: (hit: ScanHit) => Promise<ScanFeedback> | ScanFeedback;
  label?: string;
  size?: 'md' | 'sm';
  hint?: string;
  title?: string;
}

const short = (raw: string) => (raw.length > 24 ? `${raw.slice(0, 24)}…` : raw);

/** Кнопка «Сканировать»: открывает камеру, узнаёт продукт по коду (без связи тоже) и отдаёт его форме. */
export function ScanButton({ onProduct, label = 'Сканировать', size = 'md', hint, title }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadCatalog().then(() => refreshCatalog()).catch(() => undefined);
  }, [open]);

  const onCode = async (raw: string): Promise<ScanFeedback> => {
    const scan = parseScan(raw);
    if (!scan.key) return { ok: false, message: `«${short(raw)}» не похоже на штрихкод товара` };
    const { product, offline } = await findProduct(scan);
    if (!product) {
      return {
        ok: false,
        message: offline ? `Код ${short(scan.key.replace(/^0+/, ''))} не найден в сохранённом каталоге, связи нет` : `Код ${short(scan.key.replace(/^0+/, ''))} не найден в номенклатуре`,
      };
    }
    return onProduct({ product, scan });
  };

  return (
    <>
      <Button size={size} icon={<ScanLine size={size === 'sm' ? 15 : 16} />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ScannerDialog open={open} onClose={() => setOpen(false)} onCode={onCode} {...(hint ? { hint } : {})} {...(title ? { title } : {})} />
    </>
  );
}
