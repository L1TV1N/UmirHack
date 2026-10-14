import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { OrderDetailDto } from '../../../src/types';
import { api, ApiError, fmtDate, fmtDateTime, money, qty, UNIT, useLoad } from '../api';
import { Loading, StatusBadge } from './ui';

type Action = 'confirm' | 'decline' | 'ship';
const TITLES: Record<Action, string> = { confirm: 'Подтвердить заказ', decline: 'Отказать в поставке', ship: 'Отметить отгрузку' };
const HINTS: Record<Action, string> = {
  confirm: 'Покупатель увидит, что заказ принят, и дату поставки, если укажете её.',
  decline: 'Причину увидит покупатель. Заказ закроется.',
  ship: 'Покупатель получит отметку об отгрузке и начнёт готовиться к приёмке.',
};

export function OrderPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useLoad<OrderDetailDto>(`/orders/${id}`);
  const [action, setAction] = useState<Action | null>(null);
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fresh, setFresh] = useState<OrderDetailDto | null>(null);

  const order = fresh ?? data;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!action) return;
    setBusy(true);
    setProblem(null);
    try {
      setFresh(await api<OrderDetailDto>('POST', `/orders/${id}/${action}`, { ...(note.trim() ? { note: note.trim() } : {}), ...(date ? { deliveryOn: date } : {}) }));
      setAction(null);
      setNote('');
      setDate('');
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setFresh(await api<OrderDetailDto>('POST', `/orders/${id}/refresh`));
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Не удалось обновить');
    } finally {
      setBusy(false);
      reload();
    }
  };

  return (
    <>
      <p className="crumbs">
        <Link to="/orders">Заказы</Link> / {order?.number ?? '…'}
      </p>
      <Loading error={error} loading={loading && !order}>
        {order && (
          <>
            <div className="order-head">
              <div>
                <h1 className="h1">
                  Заказ {order.number} <StatusBadge status={order.status} label={order.statusLabel} />
                </h1>
                <p className="muted lead">
                  {order.buyerOrg}, {order.buyerLocation}
                  {order.buyerAddress ? `, ${order.buyerAddress}` : ''}
                </p>
              </div>
              <div className="actions">
                <button className="btn" onClick={() => void refresh()} disabled={busy} title="Спросить «Запас», что с заказом сейчас">
                  Обновить у покупателя
                </button>
                {order.actions.includes('confirm') && (
                  <button className="btn primary" onClick={() => setAction('confirm')}>
                    Подтвердить
                  </button>
                )}
                {order.actions.includes('ship') && (
                  <button className="btn accent" onClick={() => setAction('ship')}>
                    Отгрузить
                  </button>
                )}
                {order.actions.includes('decline') && (
                  <button className="btn danger" onClick={() => setAction('decline')}>
                    Отказать
                  </button>
                )}
              </div>
            </div>
            {problem && !action && <div className="alert" role="alert">{problem}</div>}

            <div className="grid2">
              <section className="panel">
                <header>
                  <h2>Состав заказа</h2>
                </header>
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Артикул</th>
                        <th>Товар</th>
                        <th className="num">Количество</th>
                        <th className="num">Цена</th>
                        <th className="num">Сумма</th>
                        <th className="num">Принято</th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.items.map((l) => (
                        <tr key={l.sku + l.name}>
                          <td className="mono">{l.sku}</td>
                          <td>{l.name}</td>
                          <td className="num">
                            {qty(l.quantity)} {UNIT[l.unit]}
                          </td>
                          <td className="num">{money(l.unitCost)}</td>
                          <td className="num">{money(l.quantity * l.unitCost)}</td>
                          <td className="num">{l.receivedQty > 0 ? `${qty(l.receivedQty)} ${UNIT[l.unit]}` : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4}>Итого</td>
                        <td className="num">{money(order.total)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>

              <aside>
                <section className="panel">
                  <header>
                    <h2>Условия</h2>
                  </header>
                  <dl className="facts">
                    <div>
                      <dt>Получен</dt>
                      <dd>{fmtDate(order.receivedAt)}</dd>
                    </div>
                    <div>
                      <dt>Покупателю нужно к</dt>
                      <dd>{fmtDate(order.expectedOn)}</dd>
                    </div>
                    <div>
                      <dt>Вы обещали</dt>
                      <dd>{fmtDate(order.deliveryOn)}</dd>
                    </div>
                    {order.comment && (
                      <div>
                        <dt>Комментарий покупателя</dt>
                        <dd>{order.comment}</dd>
                      </div>
                    )}
                    {order.buyerNote && (
                      <div className="warn-note">
                        <dt>Решение покупателя</dt>
                        <dd>{order.buyerNote}</dd>
                      </div>
                    )}
                  </dl>
                </section>
                <section className="panel">
                  <header>
                    <h2>История</h2>
                  </header>
                  <ol className="timeline">
                    {[...order.events].reverse().map((e) => (
                      <li key={e.id}>
                        <time>{fmtDateTime(e.at)}</time>
                        <span>{e.text}</span>
                        <small className="muted">{e.actor}</small>
                      </li>
                    ))}
                  </ol>
                </section>
              </aside>
            </div>
          </>
        )}
      </Loading>

      {action && (
        <div className="modal-back" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setAction(null)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label={TITLES[action]} onSubmit={(e) => void submit(e)}>
            <h2>{TITLES[action]}</h2>
            <p className="muted">{HINTS[action]}</p>
            {problem && <div className="alert" role="alert">{problem}</div>}
            {action !== 'decline' && (
              <label>
                {action === 'confirm' ? 'Когда сможете привезти' : 'Дата поставки'}
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
            )}
            <label>
              {action === 'decline' ? 'Причина отказа' : 'Сообщение покупателю'}
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={300} required={action === 'decline'} placeholder={action === 'decline' ? 'Например, нет товара на складе' : 'Не обязательно'} />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setAction(null)}>
                Отмена
              </button>
              <button type="submit" className={`btn ${action === 'decline' ? 'danger' : 'primary'}`} disabled={busy}>
                {busy ? 'Отправляем…' : TITLES[action]}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
