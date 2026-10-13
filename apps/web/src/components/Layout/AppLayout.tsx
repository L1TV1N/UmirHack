import type { Role } from '@zapas/shared';
import { ROLE_LABELS } from '@zapas/shared';
import {
  Boxes,
  ChefHat,
  ChevronDown,
  ClipboardCheck,
  FileCheck2,
  Flame,
  KeyRound,
  LayoutDashboard,
  Lightbulb,
  LogOut,
  Menu,
  Check,
  Palette,
  Sparkles,
  Search,
  FlaskConical,
  User,
  OctagonX,
  Package,
  ArrowLeftRight,
  FileSpreadsheet,
  ShieldCheck,
  Send,
  ShoppingCart,
  BookOpen,
  Thermometer,
  Truck,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { fmtLongDate } from '../../lib/format';
import { THEMES, useTheme } from '../../lib/theme';
import { UI_MODES, useUiMode } from '../../lib/uiMode';
import { TeamBanner } from '../TeamBanner/TeamBanner';
import { useLiveUpdates } from '../../lib/useLiveUpdates';
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

export const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Учёт',
    items: [
      { to: '/', label: 'Обзор', icon: LayoutDashboard, end: true },
      { to: '/stock', label: 'Остатки', icon: Boxes },
      { to: '/operations', label: 'Операции', icon: ArrowLeftRight },
      { to: '/inventory', label: 'Инвентаризация', icon: ClipboardCheck },
      { to: '/traceability', label: 'Прослеживаемость', icon: FileCheck2, min: 'storekeeper' },
      { to: '/haccp', label: 'Журнал HACCP', icon: Thermometer },
    ],
  },
  {
    title: 'Решения',
    items: [
      { to: '/stop-list', label: 'Стоп-лист', icon: OctagonX },
      { to: '/hot-dishes', label: 'Горячие предложения', icon: Flame },
      { to: '/recommendations', label: 'Рекомендации', icon: Lightbulb },
      { to: '/orders', label: 'Заказы', icon: ShoppingCart, min: 'manager' },
      { to: '/suppliers', label: 'Поставщики', icon: Truck, min: 'manager' },
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
      { to: '/testing', label: 'Тестирование', icon: FlaskConical, min: 'manager' },
      { to: '/guide', label: 'Руководство', icon: BookOpen },
      { to: '/admin', label: 'Администрирование', icon: ShieldCheck, min: 'admin' },
    ],
  },
];

function UserMenu() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const { mode, setMode } = useUiMode();
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
          <div className={styles.menuGroup} role="group" aria-label="Тема оформления">
            <span className={styles.menuLabel}>
              <Palette size={14} aria-hidden="true" />
              Тема оформления
            </span>
            {THEMES.map((t) => (
              <button key={t.value} type="button" role="menuitemradio" aria-checked={theme === t.value} className={`${styles.menuItem} ${styles.themeItem}`} onClick={() => setTheme(t.value)}>
                <i className={`${styles.swatch} ${styles[`swatch_${t.value}`]}`} aria-hidden="true" />
                {t.label}
                {theme === t.value && <Check size={15} className={styles.themeCheck} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <div className={styles.menuGroup} role="group" aria-label="Вид интерфейса">
            <span className={styles.menuLabel}>
              <Sparkles size={14} aria-hidden="true" />
              Интерфейс
            </span>
            {UI_MODES.map((m) => (
              <button key={m.value} type="button" role="menuitemradio" aria-checked={mode === m.value} className={`${styles.menuItem} ${styles.themeItem}`} onClick={() => setMode(m.value)} title={m.hint}>
                <i className={`${styles.swatch} ${m.value === 'pro' ? styles.swatch_pro : styles.swatch_basic}`} aria-hidden="true" />
                {m.label}
                {mode === m.value && <Check size={15} className={styles.themeCheck} aria-hidden="true" />}
              </button>
            ))}
          </div>
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

const CommandPalette = lazy(() => import('../CommandPalette/CommandPalette'));

export function AppLayout() {
  const { can } = useAuth();
  const scope = useScope();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const { live } = useLiveUpdates();
  const { mode } = useUiMode();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => setNavOpen(false), [location.pathname]);

  // палитра команд есть только в расширенном виде
  useEffect(() => {
    if (mode !== 'pro') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode]);

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
          {mode === 'pro' && (
            <button type="button" className={styles.paletteButton} onClick={() => setPaletteOpen(true)} aria-label="Быстрый переход" title="Быстрый переход (Ctrl+K)">
              <Search size={15} aria-hidden="true" />
              <span>Быстрый переход</span>
              <kbd>Ctrl K</kbd>
            </button>
          )}
          <OfflineStatus />
          <NavLink to="/guide" className={styles.guideLink} title="Руководство пользователя">
            <BookOpen size={16} aria-hidden="true" />
            <span>Руководство</span>
          </NavLink>
          <span className={`${styles.live} ${live ? styles.liveOn : ''}`} title={live ? 'Данные обновляются сразу, как только что-то изменилось' : 'Живое обновление не подключено, данные обновляются раз в минуту'}>
            <i aria-hidden="true" />
            {live ? 'Обновляется сразу' : 'Без живого обновления'}
          </span>
          <span className={styles.today}>{fmtLongDate(new Date().toISOString())}</span>
          <UserMenu />
        </header>
        <main id="main" className={styles.content} tabIndex={-1}>
          <Outlet />
        </main>
        <TeamBanner />
        {mode === 'pro' && paletteOpen && (
          <Suspense fallback={null}>
            <CommandPalette onClose={() => setPaletteOpen(false)} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
