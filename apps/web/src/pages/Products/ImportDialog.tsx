import type { ImportPreviewDto, ImportResultDto, ImportRowDto } from '@zapas/shared';
import { FileSpreadsheet } from 'lucide-react';
import { useRef, useState } from 'react';
import { post } from '../../api/client';
import { useAction } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Checkbox } from '../../components/Controls/Controls';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { toBase64 } from '../Operations/InvoiceImportDialog';
import styles from './ImportDialog.module.scss';

const MAX_BYTES = 2_000_000;
const FIELD_NAMES: Record<string, string> = {
  sku: 'артикул',
  barcode: 'штрихкод',
  name: 'название',
  category: 'категория',
  unit: 'единица',
  price: 'цена',
  cost: 'себестоимость',
  minStock: 'минимум',
  shelfLifeDays: 'срок годности',
  requiresMarking: 'маркировка',
  requiresVsd: 'ВСД',
};
const ACTION_CHIP: Record<ImportRowDto['action'], { tone: 'ok' | 'info' | 'neutral' | 'danger'; label: string }> = {
  create: { tone: 'ok', label: 'новый' },
  update: { tone: 'info', label: 'изменится' },
  skip: { tone: 'neutral', label: 'без изменений' },
  error: { tone: 'danger', label: 'ошибка' },
};

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [createCategories, setCreateCategories] = useState(true);
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = useAction((body: object) => post<ImportResultDto>('/products/import', body), ['/products', '/categories', '/stock', '/analytics', '/stop-list']);

  const close = () => {
    setContent(null);
    setFileName('');
    setPreview(null);
    setError(null);
    onClose();
  };

  const run = async (data: string, categories: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await post<ImportPreviewDto>('/products/import/preview', { content: data, createCategories: categories }));
    } catch (err) {
      setPreview(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) return setError('Файл больше 2 МБ: разбейте его на части');
    const data = toBase64(new Uint8Array(await file.arrayBuffer()));
    setContent(data);
    setFileName(file.name);
    await run(data, createCategories);
  };

  const toggleCategories = (value: boolean) => {
    setCreateCategories(value);
    if (content) void run(content, value);
  };

  const submit = () => {
    if (!content) return;
    apply.mutate(
      { content, createCategories },
      {
        onSuccess: (r) => {
          toast.success(`Создано ${r.created}, изменено ${r.updated}${r.skipped ? `, пропущено ${r.skipped}` : ''}`);
          close();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const todo = preview ? preview.create + preview.update : 0;
  const unknown = preview?.columns.filter((c) => !c.field && c.header) ?? [];
  const known = preview?.columns.filter((c) => c.field) ?? [];

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Импорт номенклатуры из CSV"
      subtitle="Выгрузка из iiko, 1С или Excel. Сначала показываем, что изменится, и только потом записываем"
      width={820}
      footer={
        <>
          <Button onClick={close}>Отмена</Button>
          <Button variant="primary" disabled={!preview || todo === 0} loading={apply.isPending} onClick={submit}>
            {preview ? `Применить: новых ${preview.create}, изменится ${preview.update}` : 'Применить'}
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <p className={styles.hint}>
          Колонки находятся по названию: «Артикул» или «Код», «Наименование», «Группа», «Ед. изм.», «Цена», «Себестоимость», «Штрихкод». Нужна хотя бы колонка артикула. У существующего продукта меняется только то, что указано в файле, единица измерения не меняется никогда.
        </p>
        <div className={styles.pick}>
          <input
            ref={input}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            hidden
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <Button icon={<FileSpreadsheet size={16} />} loading={busy} onClick={() => input.current?.click()}>
            {fileName ? 'Выбрать другой файл' : 'Выбрать файл CSV'}
          </Button>
          {fileName && <span className="muted">{fileName}</span>}
          <Checkbox label="Создавать новые категории" checked={createCategories} onChange={(e) => toggleCategories(e.target.checked)} />
        </div>

        {error && <ErrorNote message={error} />}

        {preview && (
          <>
            <div className={styles.stats}>
              <Chip tone="ok">новых: {preview.create}</Chip>
              <Chip tone="info">изменится: {preview.update}</Chip>
              <Chip>без изменений: {preview.skip}</Chip>
              {preview.errors > 0 && <Chip tone="danger">с ошибками: {preview.errors}, они пропустятся</Chip>}
              {preview.newCategories.length > 0 && <Chip tone="amber">новые категории: {preview.newCategories.join(', ')}</Chip>}
            </div>
            <p className={styles.columns}>
              Распознано: {known.map((c) => `«${c.header}» как ${FIELD_NAMES[c.field as string] ?? c.field}`).join(', ') || 'ничего'}.
              {unknown.length > 0 && ` Не используются: ${unknown.map((c) => `«${c.header}»`).join(', ')}.`} Кодировка {preview.encoding === 'utf-8' ? 'UTF-8' : 'Windows-1251'}.
            </p>
            <div className={styles.table} role="table" aria-label="Строки файла">
              {preview.rows.map((r) => {
                const chip = ACTION_CHIP[r.action];
                return (
                  <div key={r.line} className={styles.row} role="row">
                    <span className={styles.line}>№ {r.line}</span>
                    <div className={styles.what}>
                      <strong>{r.name ?? '—'}</strong>
                      <small>{r.sku ?? 'без артикула'}</small>
                      <span>
                        <Chip tone={chip.tone}>{chip.label}</Chip>
                      </span>
                    </div>
                    <div className={styles.notes}>
                      {r.changes.map((c) => (
                        <span key={c}>{c}</span>
                      ))}
                      {r.messages.map((m) => (
                        <span key={m} className={r.action === 'error' ? styles.bad : undefined}>
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {preview.total > preview.rows.length && <p className={styles.hint}>Показаны первые {preview.rows.length} строк из {preview.total}, ошибки в начале списка.</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}
