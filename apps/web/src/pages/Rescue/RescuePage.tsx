import {
  cancelReservationBody,
  formatMoney,
  plural,
  reserveBody,
  ruDate,
  type PublicOfferDto,
  type PublicRescueDto,
  type PublicVenueDto,
  type ReservationReceiptDto,
} from '@zapas/shared';
import { Leaf, MapPin } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../../api/client';
import { useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Checkbox, Field, Input } from '../../components/Controls/Controls';
import { Dialog } from '../../components/Dialog/Dialog';
import { BrandMark } from '../../components/Layout/Brand';
import styles from './RescuePage.module.scss';

const UNITS: Record<string, string> = { kg: 'кг', g: 'г', l: 'л', ml: 'мл', pcs: 'шт' };
const unitName = (u: string): string => UNITS[u] ?? u;
const hhmm = (iso: string): string => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function dayText(daysLeft: number, expiresOn: string): string {
  if (daysLeft <= 0) return 'годен сегодня';
  if (daysLeft === 1) return 'годен до завтра';
  return `годен до ${ruDate(expiresOn).slice(0, 5)}`;
}

function OfferRow({ offer, onPick }: { offer: PublicOfferDto; onPick: (o: PublicOfferDto) => void }) {
  return (
    <li className={styles.offer}>
      <div className={styles.what}>
        <strong>{offer.productName}</strong>
        <span className={styles.sub}>
          {dayText(offer.daysLeft, offer.expiresOn)} · осталось {offer.available} {unitName(offer.unit)}
        </span>
      </div>
      <div className={styles.price}>
        <Chip tone="ok">-{offer.percent}%</Chip>
        <b>{formatMoney(offer.price)}</b>
        <s>{formatMoney(offer.oldPrice)}</s>
        <small>за {unitName(offer.unit)}</small>
      </div>
      <Button variant="primary" size="sm" onClick={() => onPick(offer)}>
        Забронировать
      </Button>
    </li>
  );
}

export function ReserveDialog({
  venue,
  offer,
  holdMinutes,
  onClose,
  onDone,
}: {
  venue: PublicVenueDto | null;
  offer: PublicOfferDto | null;
  holdMinutes: number;
  onClose: () => void;
  onDone: (receipt: ReservationReceiptDto, phone: string) => void;
}) {
  const [qty, setQty] = useState('1');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [trap, setTrap] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setQty('1');
    setError(null);
    setBusy(false);
  }, [offer?.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!offer) return;
    setError(null);
    const parsed = reserveBody.safeParse({ offerId: offer.id, quantity: Number(qty.replace(',', '.')), name, phone, consent, ...(trap ? { website: trap } : {}) });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Проверьте данные');
      return;
    }
    if (parsed.data.quantity > offer.perGuestMax) {
      setError(`Можно не больше ${offer.perGuestMax} ${unitName(offer.unit)} за раз`);
      return;
    }
    setBusy(true);
    try {
      const receipt = await api<ReservationReceiptDto>('POST', '/public/rescue/reservations', { body: parsed.data, auth: false });
      onDone(receipt, parsed.data.phone);
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 429 ? `${err.message}. Подождите немного и попробуйте снова.` : err.message) : 'Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  };

  const total = offer ? Math.round(Number(qty.replace(',', '.')) * offer.price * 100) / 100 : 0;
  return (
    <Dialog
      open={offer !== null}
      onClose={onClose}
      title={offer ? `Бронь: ${offer.productName}` : 'Бронь'}
      subtitle={venue?.name}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="reserve-form" loading={busy}>
            Забронировать
          </Button>
        </>
      }
    >
      <form id="reserve-form" onSubmit={submit} noValidate className={styles.form}>
        <p className={styles.hint}>Оплата на месте. Бронь держится {holdMinutes} минут, потом товар вернётся на витрину.</p>
        {error && (
          <div className={styles.alert} role="alert">
            {error}
          </div>
        )}
        <Field label={`Сколько, ${offer ? unitName(offer.unit) : ''}`} hint={offer ? `Не больше ${offer.perGuestMax} за раз` : undefined}>
          {(p) => <Input {...p} numeric value={qty} onChange={(e) => setQty(e.target.value)} />}
        </Field>
        <Field label="Ваше имя">{(p) => <Input {...p} autoComplete="given-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Телефон" hint="Чтобы кассир нашёл бронь и мог предупредить, если что-то изменится">
          {(p) => <Input {...p} type="tel" autoComplete="tel" placeholder="+7 900 123-45-67" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        <div className={styles.trap} aria-hidden="true">
          <label>
            Сайт
            <input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
          </label>
        </div>
        <Checkbox
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          label="Согласен, что имя и телефон будут храниться только для этой брони и будут стёрты через месяц"
        />
        <p className={styles.total}>
          К оплате на месте: <b>{formatMoney(Number.isFinite(total) ? total : 0)}</b>
        </p>
      </form>
    </Dialog>
  );
}

export function ReceiptDialog({ receipt, phone, onClose, onCancelled }: { receipt: ReservationReceiptDto | null; phone: string; onClose: () => void; onCancelled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    if (!receipt) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/public/rescue/reservations/cancel', { body: { code: receipt.code, phone }, auth: false });
      onCancelled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={receipt !== null}
      onClose={onClose}
      title="Бронь принята"
      subtitle={receipt?.venue}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={() => void cancel()} loading={busy}>
            Отменить бронь
          </Button>
          <Button variant="primary" onClick={onClose}>
            Готово
          </Button>
        </>
      }
    >
      {receipt && (
        <div className={styles.receipt}>
          <p>Назовите этот код на кассе:</p>
          <output className={styles.code} aria-label="Код брони">
            {receipt.code}
          </output>
          <p>
            {receipt.productName}: {receipt.quantity} {unitName(receipt.unit)}, к оплате {formatMoney(receipt.total)}
          </p>
          <p className={styles.hint}>
            Бронь держится до {hhmm(receipt.expiresAt)}.{receipt.address ? ` Адрес: ${receipt.address}.` : ''}
            {receipt.note ? ` ${receipt.note}` : ''}
          </p>
          <p className={styles.hint}>Сохраните код или сделайте снимок экрана: имя и телефон сайт не показывает.</p>
          {error && (
            <div className={styles.alert} role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function CancelDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = cancelReservationBody.safeParse({ code, phone });
    if (!parsed.success) return setMessage({ ok: false, text: parsed.error.issues[0]?.message ?? 'Проверьте данные' });
    setBusy(true);
    try {
      await api('POST', '/public/rescue/reservations/cancel', { body: parsed.data, auth: false });
      setMessage({ ok: true, text: 'Бронь отменена, спасибо, что предупредили.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Нет связи с сервером' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Отменить бронь"
      width={420}
      footer={
        <>
          <Button onClick={onClose}>Закрыть</Button>
          <Button variant="primary" type="submit" form="cancel-form" loading={busy}>
            Отменить
          </Button>
        </>
      }
    >
      <form id="cancel-form" onSubmit={submit} noValidate className={styles.form}>
        {message && (
          <div className={message.ok ? styles.okNote : styles.alert} role={message.ok ? 'status' : 'alert'}>
            {message.text}
          </div>
        )}
        <Field label="Код брони">{(p) => <Input {...p} maxLength={6} autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />}</Field>
        <Field label="Телефон, на который бронировали">{(p) => <Input {...p} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
      </form>
    </Dialog>
  );
}

/** Публичная витрина: уценённые продукты с близким сроком и бронь без оплаты. Вход не нужен. */
export default function RescuePage() {
  const { slug } = useParams();
  const path = slug ? `/public/rescue/${slug}` : '/public/rescue';
  const data = useGet<PublicRescueDto>(path, undefined, { refetchInterval: 30_000, staleTime: 10_000 });
  const [pick, setPick] = useState<{ venue: PublicVenueDto; offer: PublicOfferDto } | null>(null);
  const [receipt, setReceipt] = useState<{ value: ReservationReceiptDto; phone: string } | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  useEffect(() => {
    document.title = 'Спаси продукты';
  }, []);

  const venues = data.data?.venues ?? [];
  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <Link to="/rescue" className={styles.brand}>
          <BrandMark size={28} />
          Запас
        </Link>
        <span>Спаси продукты</span>
      </header>
      <main className={styles.main}>
        <section className={styles.hero}>
          <Leaf size={28} aria-hidden="true" />
          <h1>Хорошие продукты со скидкой, пока не истёк срок</h1>
          <p>
            Выберите товар и забронируйте: платить сейчас не нужно. Назовите код на кассе и заберите. Бронь держится {data.data?.holdMinutes ?? 120}{' '}
            {plural(data.data?.holdMinutes ?? 120, ['минуту', 'минуты', 'минут'])}.
          </p>
        </section>

        {data.isLoading && <p className={styles.state}>Загружаем предложения...</p>}
        {data.isError && (
          <p className={styles.state} role="alert">
            Не удалось загрузить витрину. Попробуйте обновить страницу.
          </p>
        )}
        {data.data && venues.length === 0 && (
          <div className={styles.state}>
            <strong>Сейчас предложений нет</strong>
            <p>Заглядывайте позже: товары со скидкой появляются, когда у продуктов подходит срок.</p>
          </div>
        )}

        {venues.map((v) => (
          <section key={v.slug} className={styles.venue} aria-label={v.name}>
            <header>
              <h2>{v.name}</h2>
              {v.address && (
                <span>
                  <MapPin size={14} aria-hidden="true" /> {v.address}
                </span>
              )}
              {v.note && <small>{v.note}</small>}
            </header>
            <ul>
              {v.offers.map((o) => (
                <OfferRow key={o.id} offer={o} onPick={(offer) => setPick({ venue: v, offer })} />
              ))}
            </ul>
          </section>
        ))}

        <p className={styles.foot}>
          <button type="button" onClick={() => setCancelOpen(true)}>
            У меня есть бронь, хочу отменить
          </button>
        </p>
      </main>

      <ReserveDialog
        venue={pick?.venue ?? null}
        offer={pick?.offer ?? null}
        holdMinutes={data.data?.holdMinutes ?? 120}
        onClose={() => setPick(null)}
        onDone={(value, phone) => {
          setPick(null);
          setReceipt({ value, phone });
          void data.refetch();
        }}
      />
      <ReceiptDialog
        receipt={receipt?.value ?? null}
        phone={receipt?.phone ?? ''}
        onClose={() => setReceipt(null)}
        onCancelled={() => {
          setReceipt(null);
          void data.refetch();
        }}
      />
      <CancelDialog open={cancelOpen} onClose={() => setCancelOpen(false)} />
    </div>
  );
}
