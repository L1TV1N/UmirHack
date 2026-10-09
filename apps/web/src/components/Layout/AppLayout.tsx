import type { Role } from '@zapas/shared';
import { ROLE_LABELS } from '@zapas/shared';
import {
  Boxes,
  ChefHat,
  ChevronDown,
  ClipboardCheck,
  FileCheck2,
  KeyRound,
  LayoutDashboard,
  Lightbulb,
  LogOut,
  Menu,
  User,
  OctagonX,
  Package,
  ArrowLeftRight,
  FileSpreadsheet,
  ShieldCheck,
  Send,
  ShoppingCart,
} from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { fmtLongDate } from '../../lib/format';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { OfflineStatus } from './OfflineStatus';
import { TelegramDialog } from './TelegramDialog';
import { BrandMark } from './Brand';
import { Select } from '../Controls/Controls';
import styles from './Layout.module.scss';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  min?: Role;
  end?: boolean;
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Учёт',
    items: [
      { to: '/', label: 'Обзор', icon: LayoutDashboard, end: true },
      { to: '/stock', label: 'Остатки', icon: Boxes },
      { to: '/operations', label: 'Операции', icon: ArrowLeftRight },
      { to: '/inventory', label: 'Инвентаризация', icon: ClipboardCheck },
      { to: '/traceability', label: 'Прослеживаемость', icon: FileCheck2, min: 'storekeeper' },
    ],
  },
  {
    title: 'Решения',
    items: [
      { to: '/stop-list', label: 'Стоп-лист', icon: OctagonX },
      { to: '/recommendations', label: 'Рекомендации', icon: Lightbulb },
      { to: '/orders', label: 'Заказы', icon: ShoppingCart, min: 'manager' },
    ],
  },
  {
    title: 'Каталог',
    items: [
      { to: '/products', label: 'Номенклатура', icon: Package },
      { to: '/dishes', label: 'Блюда', icon: ChefHat },
    ],
  },
  {
    title: 'Система',
    items: [
      { to: '/reports', label: 'Отчёты', icon: FileSpreadsheet, min: 'manager' },
      { to: '/admin', label: 'Администрирование', icon: ShieldCheck, min: 'admin' },
    ],
  },
];

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;
  return (
    <div className={styles.user} ref={ref}>
      <button type="button" className={styles.userButton} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={styles.userName}>
          {user.fullName}
          <small>{ROLE_LABELS[user.role]}</small>
        </span>
        <User size={20} className={styles.userIcon} aria-hidden="true" />
        <ChevronDown size={16} className={styles.chevron} aria-hidden="true" />
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.menuHead}>
            <strong>{user.fullName}</strong>
            {user.email}
          </div>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              setPasswordOpen(true);
            }}
          >
            <KeyRound size={16} />
            Сменить пароль
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              setTelegramOpen(true);
            }}
          >
            <Send size={16} />
            Telegram
          </button>
          <button type="button" role="menuitem" className={styles.menuItem} onClick={() => void logout()}>
            <LogOut size={16} />
            Выйти
          </button>
        </div>
      )}
      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      <TelegramDialog open={telegramOpen} onClose={() => setTelegramOpen(false)} />
    </div>
  );
}

export function AppLayout() {
  const { can } = useAuth();
  const scope = useScope();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#main">
        К содержимому
      </a>
      {navOpen && <div className={styles.scrim} onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <aside className={`${styles.sidebar} ${navOpen ? styles.open : ''}`} aria-label="Разделы">
        <div className={styles.brand}>
          <BrandMark />
          <div>
            Запас
            <small>остатки и сроки</small>
          </div>
        </div>
        <nav className={styles.nav}>
          {GROUPS.map((g) => {
            const items = g.items.filter((i) => !i.min || can(i.min));
            if (items.length === 0) return null;
            return (
              <div key={g.title} style={{ display: 'contents' }}>
                <div className={styles.group}>{g.title}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.end ?? false} className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}>
                    <i.icon size={18} />
                    {i.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <button type="button" className={styles.menuButton} onClick={() => setNavOpen(true)} aria-label="Открыть меню">
            <Menu size={18} />
          </button>
          <div className={styles.scope}>
            <label htmlFor="scope-location">Точка</label>
            <Select id="scope-location" value={scope.activeId} onChange={(e) => scope.setActive(e.target.value)} disabled={scope.activeLocations.length <= 1}>
              {scope.activeLocations.length === 0 && <option value="all">Нет точек</option>}
              {scope.canSeeAll && <option value="all">{can('manager') ? 'Все точки' : 'Все мои точки'}</option>}
              {scope.activeLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          <div className={styles.spacer} />
          <OfflineStatus />
          <span className={styles.today}>{fmtLongDate(new Date().toISOString())}</span>
          <UserMenu />
        </header>
        <main id="main" className={styles.content} tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
