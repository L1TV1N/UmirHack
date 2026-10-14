import { useState, type FormEvent } from 'react';
import type { AccountDto } from '../../../src/types';
import { api, ApiError, fmtDate } from '../api';
import { useSession } from '../App';

export function Profile() {
  const { account, setAccount } = useSession();
  const [f, setF] = useState({ company: account.company, contactName: account.contactName, phone: account.phone ?? '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ account: AccountDto }>('PUT', '/profile', { company: f.company, contactName: f.contactName, phone: f.phone || undefined });
      setAccount(r.account);
      setMsg({ ok: true, text: 'Сохранено' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Не удалось сохранить' });
    }
  };
  const change = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', '/auth/change-password', pw);
      setPw({ currentPassword: '', newPassword: '' });
      setPwMsg({ ok: true, text: 'Пароль изменён' });
    } catch (err) {
      setPwMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Не удалось изменить пароль' });
    }
  };

  return (
    <>
      <h1 className="h1">Компания</h1>
      <div className="grid2 narrow">
        <section className="panel pad">
          <h2>Данные поставщика</h2>
          <dl className="facts">
            <div>
              <dt>ИНН</dt>
              <dd className="mono">{account.inn}</dd>
            </div>
            <div>
              <dt>Почта для входа</dt>
              <dd>{account.email}</dd>
            </div>
            <div>
              <dt>В кабинете с</dt>
              <dd>{fmtDate(account.createdAt)}</dd>
            </div>
          </dl>
          <form onSubmit={(e) => void save(e)}>
            <label>
              Название компании
              <input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} required maxLength={160} />
            </label>
            <label>
              Контактное лицо
              <input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} required maxLength={120} />
            </label>
            <label>
              Телефон
              <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={40} />
            </label>
            {msg && <p className={msg.ok ? 'ok-note' : 'alert'}>{msg.text}</p>}
            <button className="btn primary" type="submit">
              Сохранить
            </button>
          </form>
        </section>
        <section className="panel pad">
          <h2>Пароль</h2>
          <form onSubmit={(e) => void change(e)}>
            <label>
              Текущий пароль
              <input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required autoComplete="current-password" />
            </label>
            <label>
              Новый пароль
              <input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required minLength={10} autoComplete="new-password" />
              <span className="hint">Не короче 10 знаков</span>
            </label>
            {pwMsg && <p className={pwMsg.ok ? 'ok-note' : 'alert'}>{pwMsg.text}</p>}
            <button className="btn" type="submit">
              Сменить пароль
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
