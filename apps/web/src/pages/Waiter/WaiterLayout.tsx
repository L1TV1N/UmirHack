import { LOCATION_KIND_LABELS } from '@zapas/shared';
import { ChefHat, ClipboardList, Flame, KeyRound, LogOut, MapPin, OctagonX, ShoppingBag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { BrandMark } from '../../components/Layout/Brand';
import { ChangePasswordDialog } from '../../components/Layout/ChangePasswordDialog';
import { useLiveUpdates } from '../../lib/useLiveUpdates';
import styles from './Waiter.module.scss';

/** Рабочее место официанта: четыре вкладки, всё крупное и под палец. */
export default function WaiterLayout() {
  const { user, logout } = useAuth();
  const scope = useScope();
  const navigate = useNavigate();
  const [passwordOpen, setPasswordOpen] = useState(false);
  useLiveUpdates();

  useEffect(() => {
    document.title = 'Официант - Запас';
  }, []);

  const tabs = [
    { to: '/waiter', label: 'Заказ', icon: ShoppingBag, end: true },
    { to: '/waiter/orders', label: 'Мои заказы', icon: ClipboardList },
    { to: '/waiter/hot', label: 'Горячее', icon: Flame },
    { to: '/waiter/stop', label: 'Стоп-лист', icon: OctagonX },
  ];

  return (
    <div className={styles.shell}>
      <header className={styles.top}>
        <div className={styles.brand}>
          <BrandMark size={26} />
          <span>Запас</span>
        </div>
        <button type="button" className={styles.place} onClick={() => { scope.clear(); navigate('/select'); }} title="Выбрать другое заведение">
          <MapPin size={15} aria-hidden="true" />
          <span>
            {scope.selected?.name}
            <small>{scope.selected ? LOCATION_KIND_LABELS[scope.selected.kind] : ''}</small>
          </span>
        </button>
        <div className={styles.who}>
          <span>
            <ChefHat size={15} aria-hidden="true" />
            {user?.fullName}
          </span>
          <button type="button" onClick={() => setPasswordOpen(true)} aria-label="Сменить пароль" title="Сменить пароль">
            <KeyRound size={17} />
          </button>
          <button type="button" onClick={() => void logout()} aria-label="Выйти">
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <main className={styles.content}>
        <Outlet />
      </main>
      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      <nav className={styles.tabs} aria-label="Разделы официанта">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end ?? false} className={({ isActive }) => `${styles.tab} ${isActive ? styles.on : ''}`}>
            <t.icon size={20} />
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
