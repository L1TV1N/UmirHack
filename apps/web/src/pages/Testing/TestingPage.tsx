import { isValidGtin, type Page, type ProductDto, type SelfCheckDto, type SelfCheckItemDto } from '@zapas/shared';
import { Printer, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip, type Tone } from '../../components/Chip/Chip';
import { Checkbox, Input } from '../../components/Controls/Controls';
import { ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { PageHeader, Panel } from '../../components/Panel/Panel';
import { Tabs } from '../../components/Tabs/Tabs';
import { useToast } from '../../components/Toast/Toast';
import { eanBits } from '../../lib/ean';
import { fmtDateTime } from '../../lib/format';
import { useUrlState } from '../../lib/useUrlState';
import { Invoices } from './Invoices';
import styles from './Testing.module.scss';

type Tab = 'barcodes' | 'invoices' | 'checks' | 'scenarios';
const TABS: Tab[] = ['barcodes', 'invoices', 'checks', 'scenarios'];

function Bars({ code }: { code: string }) {
  const r = eanBits(code);
  if (!r) return null;
  const quiet = 9;
  const w = r.bits.length + quiet * 2;
  const rects: ReactElement[] = [];
  for (let i = 0; i < r.bits.length; ) {
    if (r.bits[i] !== '1') {
      i += 1;
      continue;
    }
    let j = i;
    while (r.bits[j] === '1') j += 1;
    rects.push(<rect key={i} x={quiet + i} y={0} width={j - i} height={60} />);
    i = j;
  }
  return (
    <div className={styles.bars}>
      <svg viewBox={`0 0 ${w} 60`} preserveAspectRatio="none" role="img" aria-label={`Штрихкод ${code}`} shapeRendering="crispEdges" fill="#000">
        {rects}
      </svg>
      <span>{code}</span>
    </div>
  );
}

function Barcodes() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const products = useGet<Page<ProductDto>>('/products', { limit: 200, active: true }, { staleTime: 60_000 });
  const rows = useMemo(() => {
    const text = q.trim().toLowerCase();
    return (products.data?.items ?? []).filter((p) => p.barcode && isValidGtin(p.barcode) && eanBits(p.barcode) && (!text || `${p.name} ${p.sku} ${p.barcode}`.toLowerCase().includes(text)));
  }, [products.data, q]);

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      window.setTimeout(() => setCopied((c) => (c === code ? null : c)), 1500);
    } catch {
      toast.error('Не удалось скопировать');
    }
  };

  return (
    <Panel>
      <div className={styles.toolbar}>
        <Input type="search" aria-label="Поиск штрихкода" placeholder="Название, артикул или номер" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button icon={<Printer size={15} />} onClick={() => window.print()}>Печать</Button>
        <span className="muted">{products.data ? `Штрихкодов EAN: ${rows.length}` : ''}</span>
      </div>
      <p className="muted noPrint" style={{ margin: 0, padding: '10px 14px 0' }}>
        Наведите камеру в «Операциях» на штрихкод с экрана или распечатайте лист. Нажатие на карточку копирует номер: его можно вставить в поле «Сканировать» как ручной ввод.
      </p>
      {products.isError && <div style={{ padding: 14 }}><ErrorNote error={products.error} onRetry={() => void products.refetch()} /></div>}
      {products.isLoading && <Loading />}
      {products.data && rows.length === 0 && <p className="muted" style={{ padding: 14 }}>Ничего не нашлось</p>}
      <div className={styles.grid}>
        {rows.map((p) => (
          <button key={p.id} type="button" className={styles.card} onClick={() => void copy(p.barcode as string)} aria-label={`${p.name}, штрихкод ${p.barcode}: нажмите, чтобы скопировать номер`}>
            <Bars code={p.barcode as string} />
            <strong>{p.name}</strong>
            <small>{p.sku} · {p.categoryName}</small>
            {copied === p.barcode && <span className={styles.copied}>Номер скопирован</span>}
          </button>
        ))}
      </div>
    </Panel>
  );
}

const STATUS_TONE: Record<SelfCheckItemDto['status'], Tone> = { ok: 'ok', warn: 'amber', fail: 'danger' };
const STATUS_TEXT: Record<SelfCheckItemDto['status'], string> = { ok: 'в порядке', warn: 'внимание', fail: 'сбой' };

function Checks() {
  const check = useGet<SelfCheckDto>('/selfcheck', undefined, { staleTime: 0, refetchOnWindowFocus: false });
  const items = check.data?.items ?? [];
  const groups = [...new Set(items.map((i) => i.group))];
  const count = (s: SelfCheckItemDto['status']) => items.filter((i) => i.status === s).length;
  return (
    <Panel
      title="Проверка системы"
      subtitle="Читает состояние базы, данных, настроек и подключений. Ничего не меняет"
      actions={<Button size="sm" icon={<RefreshCw size={14} />} loading={check.isFetching} onClick={() => void check.refetch()}>Проверить снова</Button>}
    >
      {check.isError && <div style={{ padding: 14 }}><ErrorNote error={check.error} onRetry={() => void check.refetch()} /></div>}
      {check.isLoading && <Loading />}
      {check.data && (
        <>
          <div className={styles.group}>
            <div className={styles.summary}>
              <Chip tone="ok">в порядке: {count('ok')}</Chip>
              <Chip tone="amber">внимание: {count('warn')}</Chip>
              <Chip tone="danger">сбоев: {count('fail')}</Chip>
              <span className="muted">проверено {fmtDateTime(check.data.checkedAt)}</span>
            </div>
          </div>
          {groups.map((g) => (
            <section key={g} className={styles.group}>
              <h3>{g}</h3>
              {items.filter((i) => i.group === g).map((i) => (
                <div key={i.id} className={styles.check}>
                  <Chip tone={STATUS_TONE[i.status]}>{STATUS_TEXT[i.status]}</Chip>
                  <span><strong>{i.title}</strong><small style={{ display: 'block' }}>{i.detail}</small></span>
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </Panel>
  );
}

interface Scenario {
  id: string;
  group: string;
  text: string;
  hint?: string;
  to?: string;
}

export const SCENARIOS: Scenario[] = [
  { id: 'scan-ean', group: 'Сканер', text: 'Открыть «Операции → Приход», нажать «Сканировать» и ввести штрихкод вручную с вкладки «Штрихкоды»', hint: 'Продукт должен подставиться в строку', to: '/operations?tab=receipt' },
  { id: 'scan-bad', group: 'Сканер', text: 'Ввести номер с неверной контрольной цифрой', hint: 'Сканер должен отказать понятным сообщением', to: '/operations?tab=receipt' },
  { id: 'scan-inv', group: 'Сканер', text: 'В инвентаризации найти позицию по штрихкоду', to: '/inventory' },
  { id: 'invoice-photo', group: 'Накладные', text: 'Разобрать фото из вкладки «Накладные»: поставщик и строки должны найтись, а неопознанная позиция остаться без пары', to: '/testing?tab=invoices' },
  { id: 'invoice-xml', group: 'Накладные', text: 'Загрузить XML-образец УПД в «Операции → Приход → Приход по накладной» и провести приход', to: '/operations?tab=receipt' },
  { id: 'receipt', group: 'Учёт', text: 'Провести приход со сроком годности и проверить партию в «Остатках → Партии»', to: '/operations?tab=receipt' },
  { id: 'fefo', group: 'Учёт', text: 'Списать продукт без выбора партии и убедиться, что ушла партия с ближайшим сроком', to: '/operations?tab=writeoff' },
  { id: 'transfer', group: 'Учёт', text: 'Переместить продукт на другую точку: срок и себестоимость партии не меняются', to: '/operations?tab=transfer' },
  { id: 'inventory', group: 'Учёт', text: 'Начать инвентаризацию, ввести расхождение и провести её', to: '/inventory' },
  { id: 'guest', group: 'Решения', text: 'Принять заказ гостя на блюдо, потом на слишком большое количество: должен быть отказ с причиной', to: '/operations?tab=sale' },
  { id: 'stoplist', group: 'Решения', text: 'Убедиться, что блюдо без ингредиента попало в стоп-лист и снялось после прихода', to: '/stop-list' },
  { id: 'hot', group: 'Решения', text: 'Открыть горячие предложения и сверить, что в приоритете блюда с близкими сроками', to: '/hot-dishes' },
  { id: 'order', group: 'Решения', text: 'Создать черновик заказа поставщику и открыть его', to: '/orders' },
  { id: 'pos', group: 'Интеграции', text: 'Подключить кассу, отправить чек из эмулятора и увидеть списание остатков', hint: 'npm run emulate:pos', to: '/admin?tab=keys' },
  { id: 'pos-unknown', group: 'Интеграции', text: 'Сопоставить неопознанную позицию кассы: ждавший чек должен пройти сам', to: '/admin?tab=keys' },
  { id: 'onec', group: 'Интеграции', text: 'Проверить подключение 1С, провести приход и найти документ в журнале выгрузки', hint: 'npm run emulate:onec', to: '/admin?tab=exchange' },
  { id: 'iiko', group: 'Интеграции', text: 'Скачать XML прихода для iiko из журнала операций', to: '/operations?tab=journal' },
  { id: 'haccp', group: 'Контроль', text: 'Записать замер температуры вне нормы и отметить корректирующее действие', to: '/haccp' },
  { id: 'vsd', group: 'Контроль', text: 'Погасить ВСД и найти его в разделе «Погашены»', to: '/traceability' },
  { id: 'offline', group: 'Надёжность', text: 'Отключить сеть, провести операцию и увидеть её в очереди, затем вернуть сеть', to: '/operations?tab=receipt' },
  { id: 'live', group: 'Надёжность', text: 'Открыть обзор в двух вкладках: изменение в одной должно появиться в другой без перезагрузки', to: '/' },
  { id: 'roles', group: 'Надёжность', text: 'Войти кладовщиком и наблюдателем: недоступные разделы и точки не видны', to: '/admin' },
  { id: 'themes', group: 'Вид', text: 'Переключить тему в меню пользователя: светлая, тёмная, разноцветная', to: '/' },
];

const KEY = 'zapas.testing.done';

function Scenarios() {
  const [done, setDone] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(done));
    } catch {
      /* отметки живут до перезагрузки */
    }
  }, [done]);
  const groups = [...new Set(SCENARIOS.map((s) => s.group))];
  const pct = Math.round((SCENARIOS.filter((s) => done.includes(s.id)).length / SCENARIOS.length) * 100);
  return (
    <Panel
      title="Чек-лист ручного тестирования"
      subtitle="Пройдите сценарии и отметьте сделанные. Отметки хранятся в этом браузере"
      actions={<Button size="sm" onClick={() => setDone([])}>Сбросить отметки</Button>}
    >
      <div className={styles.progress} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Пройдено сценариев"><i style={{ width: `${pct}%` }} /></div>
      <p className="muted" style={{ margin: 0, padding: '6px 14px 0' }}>Пройдено {done.length} из {SCENARIOS.length}</p>
      {groups.map((g) => (
        <section key={g} className={styles.group}>
          <h3>{g}</h3>
          {SCENARIOS.filter((s) => s.group === g).map((s) => (
            <div key={s.id} className={styles.check}>
              <Checkbox label="" aria-label={s.text} checked={done.includes(s.id)} onChange={(e) => setDone(e.target.checked ? [...done, s.id] : done.filter((x) => x !== s.id))} />
              <span>
                {s.to ? <Link to={s.to}>{s.text}</Link> : s.text}
                {s.hint && <small style={{ display: 'block' }}>{s.hint}</small>}
              </span>
            </div>
          ))}
        </section>
      ))}
    </Panel>
  );
}

export default function TestingPage() {
  const [url, setUrl] = useUrlState({ tab: 'barcodes' });
  const tab: Tab = TABS.includes(url.tab as Tab) ? (url.tab as Tab) : 'barcodes';
  useEffect(() => {
    document.title = 'Тестирование - Запас';
  }, []);
  return (
    <>
      <PageHeader title="Тестирование" subtitle="Штрихкоды для сканера, пакет тестовых накладных, проверка системы одной кнопкой и чек-лист ручных сценариев." />
      <Tabs<Tab>
        label="Разделы тестирования"
        value={tab}
        onChange={(v) => setUrl({ tab: v })}
        items={[
          { value: 'barcodes', label: 'Штрихкоды' },
          { value: 'invoices', label: 'Накладные' },
          { value: 'checks', label: 'Проверка системы' },
          { value: 'scenarios', label: 'Сценарии' },
        ]}
      />
      {tab === 'barcodes' && <Barcodes />}
      {tab === 'invoices' && <Invoices />}
      {tab === 'checks' && <Checks />}
      {tab === 'scenarios' && <Scenarios />}
    </>
  );
}
