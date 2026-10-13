import { INVOICE_MATCH_LABELS, formatQty, type InvoiceCapabilitiesDto, type InvoiceDto } from '@zapas/shared';
import { Download, ExternalLink, ScanText } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { post } from '../../api/client';
import { useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { errorMessage } from '../../lib/errors';
import { fmtDate } from '../../lib/format';
import { toBase64 } from '../Operations/InvoiceImportDialog';
import styles from './Testing.module.scss';

interface Sample {
  file: string;
  kind: 'photo' | 'xml';
  title: string;
  supplier: string;
  what: string;
  expect: string[];
}

/** Файлы лежат в public/test-invoices, их рисует tools/make-invoice-images.mjs, а XML собирает `npm run sample-upd`. */
export const SAMPLES: Sample[] = [
  {
    file: '01-donskoy-torg12.jpg',
    kind: 'photo',
    title: 'Чистый скан ТОРГ-12',
    supplier: 'Молочный комбинат «Донской»',
    what: 'Ровный скан, названия как в нашей номенклатуре, у каждой строки срок годности. Образец «как должно быть».',
    expect: ['Поставщик найден по ИНН', 'Пять строк сопоставлены по названию', 'Сроки подставлены из накладной', 'Загрузите её ещё раз после прихода: система скажет, что накладная уже принята'],
  },
  {
    file: '02-azovskiy-upd.jpg',
    kind: 'photo',
    title: 'УПД, цена с НДС, свои названия',
    supplier: 'Мясокомбинат «Азовский»',
    what: 'Поставщик пишет названия по-своему («Филе грудки цыплёнка-бройлера охл.»), а цена указана вместе с НДС.',
    expect: ['Строки сопоставлены по похожести или с кандидатами на выбор', 'Проверьте цену: в накладной она с НДС, без него должно быть на десятую часть меньше'],
  },
  {
    file: '03-hleb4-foto.jpg',
    kind: 'photo',
    title: 'Фото под углом на столе',
    supplier: 'Хлебозавод №4',
    what: 'Лист снят с наклоном и с тенью, как снимают на телефон. Единицы «шт», срок на два дня.',
    expect: ['Три строки прочитаны и сопоставлены', 'Количества штучные, сроки у всех строк совпадают'],
  },
  {
    file: '04-zernovaya-neizvestnyy-tovar.jpg',
    kind: 'photo',
    title: 'Печать и товар, которого у нас нет',
    supplier: 'Агрофирма «Зерновая»',
    what: 'Круглая печать поверх таблицы и кетчуп, которого нет в номенклатуре. Показывает, что делать с неопознанной строкой.',
    expect: ['Три строки сопоставлены', 'Кетчуп остаётся без продукта: выберите его вручную или заведите карточку', 'Проверьте поставщика: модель может принять за него ИНН покупателя'],
  },
  {
    file: '05-svezhiy-urozhay-nechetkoe-foto.jpg',
    kind: 'photo',
    title: 'Нечёткое фото',
    supplier: 'ТД «Свежий урожай»',
    what: 'Размытый снимок, жёлтая бумага, наклон в другую сторону. Проверка на устойчивость.',
    expect: ['Шесть строк прочитаны', 'Модель может перепутать похожие слова («гладкие» и «грунтовые»), поэтому сверяйте названия с бумагой'],
  },
  {
    file: '06-upd-donskoy.xml',
    kind: 'xml',
    title: 'УПД файлом (XML)',
    supplier: 'Молочный комбинат «Донской»',
    what: 'Файл в том виде, как его отдают 1С и операторы ЭДО (windows-1251). Распознавать нечего: всё читается точно.',
    expect: ['Сопоставление по штрихкоду, по названию и с пересчётом граммов в килограммы', 'Одна строка (мороженое) без пары', 'Номера ВСД и коды маркировки попадают в приход'],
  },
];

const INVOICE_UNIT_SHORT = { kg: 'кг', g: 'г', t: 'т', l: 'л', ml: 'мл', pcs: 'шт' } as const;
const howTone = { barcode: 'ok', mapping: 'ok', name: 'ok', similar: 'amber' } as const;

function Result({ sample, invoice }: { sample: Sample; invoice: InvoiceDto }) {
  const unmatched = invoice.lines.filter((l) => !l.match).length;
  return (
    <Panel title={`Что получилось: ${sample.title}`} subtitle="Так строки накладной выглядят в диалоге «Приход по накладной». Ничего не проведено">
      <dl className={styles.invoiceHead}>
        <div>
          <dt>Поставщик</dt>
          <dd>
            {invoice.supplier ? invoice.supplier.name : 'не распознан'}
            {invoice.supplier?.how && <Chip tone="ok">найден {invoice.supplier.how === 'inn' ? 'по ИНН' : 'по названию'}</Chip>}
            {invoice.supplier && !invoice.supplier.supplierId && <Chip tone="amber">нет в справочнике</Chip>}
          </dd>
        </div>
        <div>
          <dt>Накладная</dt>
          <dd>{invoice.number ?? 'без номера'}{invoice.date ? ` от ${fmtDate(invoice.date)}` : ''}</dd>
        </div>
        <div>
          <dt>Сумма</dt>
          <dd>{invoice.total != null ? `${invoice.total.toLocaleString('ru-RU')} ₽` : 'не указана'}</dd>
        </div>
      </dl>
      {invoice.alreadyReceived && <p className={styles.note}>Эта накладная уже принята: документ {invoice.alreadyReceived.documentNumber} от {fmtDate(invoice.alreadyReceived.receivedOn)}.</p>}
      {invoice.warnings.map((w) => (
        <p key={w} className={styles.note}>{w}</p>
      ))}
      <div className={styles.tableScroll}>
        <table>
          <thead>
            <tr>
              <th>В накладной</th>
              <th>Продукт у нас</th>
              <th className={styles.num}>Количество</th>
              <th className={styles.num}>Цена</th>
              <th>Срок</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l) => (
              <tr key={l.index}>
                <td>{l.name}</td>
                <td>
                  {l.match ? (
                    <>
                      {l.match.product.name} <Chip tone={howTone[l.match.how]}>{INVOICE_MATCH_LABELS[l.match.how]}</Chip>
                    </>
                  ) : (
                    <Chip tone="danger">не найден{l.candidates.length ? `, вариантов: ${l.candidates.length}` : ''}</Chip>
                  )}
                </td>
                <td className={styles.num}>{l.converted ? formatQty(l.converted.quantity, l.match?.product.unit ?? 'pcs') : `${l.quantity}${l.unit ? ` ${INVOICE_UNIT_SHORT[l.unit]}` : ''}`}</td>
                <td className={styles.num}>{l.converted?.price ?? l.price ?? 'нет'}</td>
                <td>{l.expiresOn ? fmtDate(l.expiresOn) : 'нет'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ margin: 0, padding: '10px 14px' }}>
        {unmatched ? `Без продукта: ${unmatched}. ` : 'Все строки нашли продукт. '}
        Чтобы довести дело до прихода, загрузите этот же файл в <Link to="/operations?tab=receipt">«Операции → Приход»</Link>, кнопка «Приход по накладной».
      </p>
    </Panel>
  );
}

export function Invoices() {
  const caps = useGet<InvoiceCapabilitiesDto>('/invoices/capabilities', undefined, { staleTime: 300_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ sample: Sample; invoice: InvoiceDto } | null>(null);

  const run = async (sample: Sample) => {
    setBusy(sample.file);
    setError(null);
    try {
      const res = await fetch(`/test-invoices/${sample.file}`);
      if (!res.ok) throw new Error('Файл образца не нашёлся');
      const data = toBase64(new Uint8Array(await res.arrayBuffer()));
      const invoice =
        sample.kind === 'xml'
          ? await post<InvoiceDto>('/invoices/parse', { format: 'upd', content: data })
          : await post<InvoiceDto>('/invoices/parse-photo', { mediaType: 'image/jpeg', image: data });
      setShown({ sample, invoice });
    } catch (err) {
      setShown(null);
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const photoOff = caps.data && !caps.data.photo;

  return (
    <>
      <Panel title="Пакет тестовых накладных" subtitle="Шесть образцов на демо-данных: поставщики и товары те же, что в системе. Скачайте и загрузите в приход или разберите прямо здесь">
        {photoOff && <p className={styles.note}>Распознавание фото выключено: на сервере не задан ключ GigaChat. Образец с XML разбирается и без него.</p>}
        {error && <div style={{ padding: '0 14px 14px' }}><ErrorNote message={error} /></div>}
        <div className={styles.samples}>
          {SAMPLES.map((s) => (
            <article key={s.file} className={styles.sample}>
              {s.kind === 'photo' ? (
                <a href={`/test-invoices/${s.file}`} target="_blank" rel="noreferrer" aria-label={`Открыть образец «${s.title}» в полном размере`}>
                  <img src={`/test-invoices/${s.file}`} alt={`Образец накладной: ${s.title}`} loading="lazy" />
                </a>
              ) : (
                <div className={styles.xmlThumb} aria-hidden="true">XML</div>
              )}
              <div className={styles.sampleBody}>
                <h3>{s.title}</h3>
                <small>{s.supplier}</small>
                <p>{s.what}</p>
                <ul>
                  {s.expect.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
                <div className={styles.sampleActions}>
                  <Button size="sm" variant="primary" icon={<ScanText size={14} />} loading={busy === s.file} disabled={s.kind === 'photo' && photoOff === true} onClick={() => void run(s)}>
                    Разобрать здесь
                  </Button>
                  <a className={styles.link} href={`/test-invoices/${s.file}`} download>
                    <Download size={14} /> Скачать
                  </a>
                  {s.kind === 'photo' && (
                    <a className={styles.link} href={`/test-invoices/${s.file}`} target="_blank" rel="noreferrer">
                      <ExternalLink size={14} /> Открыть
                    </a>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </Panel>
      {shown && <Result sample={shown.sample} invoice={shown.invoice} />}
    </>
  );
}
