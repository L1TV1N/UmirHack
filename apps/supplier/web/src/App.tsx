import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router';
import type { AccountDto } from '../../src/types';
import { api, ApiError } from './api';
import { AuthPage } from './pages/AuthPage';
import { Buyers } from './pages/Buyers';
import { Dashboard } from './pages/Dashboard';
import { OrderPage } from './pages/OrderPage';
import { Orders } from './pages/Orders';
import { Profile } from './pages/Profile';

interface Session {
  account: AccountDto;
  setAccount(a: AccountDto): void;
  logout(): Promise<void>;
}
const Ctx = createContext<Session | null>(null);
export const useSession = (): Session => {
  const v = useContext(Ctx);
  if (!v) throw new Error('Нет сессии');
  return v;
};

function Shell({ children }: { children: ReactNode }) {
  const { account, logout } = useSession();
  const navigate = useNavigate();
  return (
    <div className="shell">
      <header className="top">
        <div className="top-inner">
          <NavLink to="/" className="brand" aria-label="Отгрузка, на главную">
            <span className="brand-mark" aria-hidden="true" />
            <span>Отгрузка</span>
            <small>кабинет поставщика</small>
          </NavLink>
          <nav className="nav" aria-label="Разделы">
            <NavLink to="/" end>Сводка</NavLink>
            <NavLink to="/orders">Заказы</NavLink>
            <NavLink to="/buyers">Покупатели</NavLink>
            <NavLink to="/profile">Компания</NavLink>
          </nav>
          <div className="who">
            <span title={account.email}>{account.company}</span>
            <button
              className="link"
              onClick={() => {
                void logout().then(() => navigate('/login'));
              }}
            >
              Выйти
            </button>
          </div>
        </div>
      </header>
      <main className="page">{children}</main>
      <footer className="foot">Отгрузка работает отдельно от «Запаса» и обменивается с ним заказами. Статусы видны обеим сторонам.</footer>
    </div>
  );
}

export function App() {
  const [account, setAccount] = useState<AccountDto | null | undefined>(undefined);
  useEffect(() => {
    api<{ account: AccountDto }>('GET', '/auth/me')
      .then((r) => setAccount(r.account))
      .catch((e: unknown) => setAccount(e instanceof ApiError && e.status === 401 ? null : null));
  }, []);

  if (account === undefined) return <div className="boot">Загрузка…</div>;

  if (account === null) {
    return (
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" onDone={setAccount} />} />
        <Route path="/register" element={<AuthPage mode="register" onDone={setAccount} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const session: Session = {
    account,
    setAccount,
    logout: async () => {
      await api('POST', '/auth/logout');
      setAccount(null);
    },
  };
  return (
    <Ctx.Provider value={session}>
      <Shell>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/orders/:id" element={<OrderPage />} />
          <Route path="/buyers" element={<Buyers />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/register" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </Ctx.Provider>
  );
}
