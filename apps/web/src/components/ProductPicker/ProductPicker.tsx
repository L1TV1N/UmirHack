import { UNIT_LABELS, type Page, type ProductDto } from '@zapas/shared';
import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useGet } from '../../api/hooks';
import { Input } from '../Controls/Controls';
import styles from './ProductPicker.module.scss';

export type PickedProduct = Pick<ProductDto, 'id' | 'name' | 'unit'>;

interface Props {
  value: PickedProduct | null;
  onChange: (product: ProductDto | null) => void;
  sellableOnly?: boolean;
  id?: string;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
  placeholder?: string;
  disabled?: boolean;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ProductPicker({ value, onChange, sellableOnly, id, invalid, describedBy, placeholder = 'Название или артикул', disabled }: Props) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listEl = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const q = useDebounced(text.trim(), 180);

  const results = useGet<Page<ProductDto>>(
    '/products',
    { q, limit: 12, active: true, ...(sellableOnly ? { sellable: true } : {}) },
    { enabled: open && !value, staleTime: 30_000 },
  );
  const items = results.data?.items ?? [];

  useEffect(() => setCursor(0), [q]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !listEl.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Список рисуется поверх страницы, а не внутри карточки: у карточек overflow:hidden, и он обрезал бы выпадающий список.
  // Если снизу мало места, список раскрывается вверх.
  useLayoutEffect(() => {
    if (!open || value) return;
    const update = () => {
      const box = input.current?.getBoundingClientRect();
      if (!box) return;
      const below = window.innerHeight - box.bottom - 12;
      const above = box.top - 12;
      const up = below < 200 && above > below;
      const width = Math.max(box.width, 280);
      const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
      setPlace(up ? { left, width, bottom: window.innerHeight - box.top + 4, maxHeight: Math.min(280, above) } : { left, width, top: box.bottom + 4, maxHeight: Math.min(280, below) });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, value, text]);

  const choose = (p: ProductDto) => {
    onChange(p);
    setText('');
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setCursor((c) => Math.min(c + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter' && open && items[cursor]) {
      e.preventDefault();
      choose(items[cursor] as ProductDto);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={styles.root} ref={root}>
      <div className={styles.box}>
        <Input
          ref={input}
          {...(id ? { id } : { 'aria-label': 'Продукт' })}
          role="combobox"
          aria-expanded={open && !value}
          aria-controls={listId}
          aria-activedescendant={open && !value && items[cursor] ? `${listId}-${cursor}` : undefined}
          aria-autocomplete="list"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          disabled={disabled ?? false}
          placeholder={value ? '' : placeholder}
          value={value ? value.name : text}
          readOnly={Boolean(value)}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => !value && setOpen(true)}
          onKeyDown={onKey}
          style={value ? { paddingRight: 34, fontWeight: 600 } : undefined}
        />
        {value && !disabled && (
          <button type="button" className={styles.clear} onClick={() => onChange(null)} aria-label="Сбросить выбор">
            <X size={15} />
          </button>
        )}
      </div>
      {open && !value && place &&
        createPortal(
        <ul ref={listEl} className={styles.list} id={listId} role="listbox" style={{ left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}>
          {results.isLoading && <li className={styles.note}>Ищем…</li>}
          {!results.isLoading && items.length === 0 && <li className={styles.note}>Ничего не найдено</li>}
          {items.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === cursor}
              className={styles.option}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(p);
              }}
              onMouseEnter={() => setCursor(i)}
            >
              <span>
                {p.name}
                <br />
                <small>{p.sku}</small>
              </span>
              <small>{UNIT_LABELS[p.unit]}</small>
            </li>
          ))}
        </ul>,
        root.current?.closest('dialog') ?? document.body,
        )}
    </div>
  );
}
