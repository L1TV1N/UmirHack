import { FileText, Camera } from 'lucide-react';
import { INVOICE_MATCH_LABELS, formatQty, type InvoiceCapabilitiesDto, type InvoiceDto } from '@zapas/shared';
import { useRef, useState } from 'react';
import { post } from '../../api/client';
import { useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Checkbox } from '../../components/Controls/Controls';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { errorMessage } from '../../lib/errors';
import { fmtDate } from '../../lib/format';
import styles from './InvoiceImportDialog.module.scss';

interface Props {
  open: boolean;
  onClose: () => void;
  onApply: (invoice: InvoiceDto) => void;
}

const MAX_XML = 3 * 1024 * 1024;
const MAX_SIDE = 2000;

/** Байты в base64 по кускам: один вызов на всё сразу не переживает большой файл. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/** Фото с телефона весит мегабайты: уменьшаем до 2000 px по длинной стороне, текста накладной это хватает. */
async function shrink(file: File): Promise<{ data: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }> {
  const raw = async () => ({ data: toBase64(new Uint8Array(await file.arrayBuffer())), mediaType: file.type as 'image/jpeg' });
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (blob) return { data: toBase64(new Uint8Array(await blob.arrayBuffer())), mediaType: 'image/jpeg' };
  } catch {
    // браузер не умеет уменьшать: отправим как есть, если влезет
  }
  return raw();
}

export function InvoiceImportDialog({ open, onClose, onApply }: Props) {
  const caps = useGet<InvoiceCapabilitiesDto>('/invoices/capabilities', undefined, { enabled: open, staleTime: 300_000 });
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<InvoiceDto | null>(null);
  const [confirmRepeat, setConfirmRepeat] = useState(false);

  const close = () => {
    setInvoice(null);
    setError(null);
    setConfirmRepeat(false);
    onClose();
  };

  const run = async (work: () => Promise<InvoiceDto>) => {
    setBusy(true);
    setError(null);
    setInvoice(null);
    setConfirmRepeat(false);
    try {
      setInvoice(await work());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_XML) return setError('Файл больше 3 МБ');
    void run(async () => post<InvoiceDto>('/invoices/parse', { format: 'upd', content: toBase64(new Uint8Array(await file.arrayBuffer())) }));
  };

  const onPhoto = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      const { data, mediaType } = await shrink(file);
      return post<InvoiceDto>('/invoices/parse-photo', { mediaType, image: data });
    });
  };

  const unmatched = invoice?.lines.filter((l) => !l.match).length ?? 0;
  const blocked = Boolean(invoice?.alreadyReceived) && !confirmRepeat;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Приход по накладной"
      subtitle="Файл УПД из ЭДО или 1С, или фото накладной. Строки попадут в форму прихода, ничего не проводится без вашей проверки"
      width={760}
      footer={
        <>
          <Button onClick={close}>Отмена</Button>
          <Button
            variant="primary"
            disabled={!invoice || invoice.lines.length === 0 || blocked}
            onClick={() => {
              if (invoice) onApply(invoice);
              close();
            }}
          >
            Заполнить приход{invoice ? ` (${invoice.lines.length})` : ''}
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <div className={styles.pick}>
          <input ref={fileInput} type="file" accept=".xml,text/xml,application/xml" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden onChange={(e) => { onPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          <Button icon={<FileText size={16} />} onClick={() => fileInput.current?.click()} loading={busy}>
            Загрузить УПД (XML)
          </Button>
          {caps.data?.photo && (
            <Button icon={<Camera size={16} />} onClick={() => photoInput.current?.click()} loading={busy}>
              Сфотографировать накладную
            </Button>
          )}
          {caps.data && !caps.data.photo && <span className="muted">Распознавание фото выключено: администратор не подключил сервис распознавания.</span>}
        </div>

        {error && <ErrorNote message={error} />}

        {invoice && (
          <>
            <dl className={styles.head}>
              <div>
                <dt>Поставщик</dt>
                <dd>
                  {invoice.supplier?.name ?? 'не указан'}
                  {invoice.supplier?.supplierId ? <Chip tone="ok">в справочнике</Chip> : invoice.supplier ? <Chip tone="amber">нет в справочнике</Chip> : null}
                </dd>
              </div>
              <div>
                <dt>Накладная</dt>
                <dd>
                  {invoice.number ? `№${invoice.number}` : 'без номера'}
                  {invoice.date ? ` от ${fmtDate(invoice.date)}` : ''}
                </dd>
              </div>
              <div>
                <dt>Строк</dt>
                <dd>
                  {invoice.lines.length}
                  {unmatched > 0 && <Chip tone="amber">без продукта: {unmatched}</Chip>}
                </dd>
              </div>
            </dl>

            {invoice.warnings.length > 0 && (
              <ul className={styles.warnings}>
                {invoice.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            {invoice.alreadyReceived && <Checkbox label={`Это не повтор, оприходовать ещё раз (уже есть ${invoice.alreadyReceived.documentNumber})`} checked={confirmRepeat} onChange={(e) => setConfirmRepeat(e.target.checked)} />}

            <div className={styles.table} role="table" aria-label="Строки накладной">
              {invoice.lines.map((l) => (
                <div key={l.index} className={styles.row} role="row">
                  <div className={styles.name}>
                    <strong>{l.name}</strong>
                    <small>
                      {formatQty(l.quantity)} {l.unit ?? ''}
                      {l.price !== null ? `, ${l.price} ₽` : ''}
                      {l.expiresOn ? `, годен до ${fmtDate(l.expiresOn)}` : ''}
                    </small>
                    {(l.vsd || l.marks.length > 0) && (
                      <small>
                        {l.vsd ? <Chip tone="info">ВСД в накладной</Chip> : null}
                        {l.marks.length > 0 ? <Chip tone="info">марок: {l.marks.length}</Chip> : null}
                      </small>
                    )}
                  </div>
                  <div className={styles.match}>
                    {l.match ? (
                      <>
                        <span>{l.match.product.name}</span>
                        <Chip tone={l.match.how === 'similar' ? 'amber' : 'ok'}>{INVOICE_MATCH_LABELS[l.match.how]}</Chip>
                        {l.unitMismatch && <Chip tone="danger">единицы не сходятся</Chip>}
                      </>
                    ) : (
                      <>
                        <Chip tone="amber">выберите продукт в форме</Chip>
                        {l.candidates.length > 0 && <small>Похожие: {l.candidates.map((c) => c.name).join(', ')}</small>}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
