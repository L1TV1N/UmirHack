import { LOCATION_KIND_LABELS, ROLE_LABELS, type LocationDto, type LocationKind } from '@zapas/shared';
import { Beer, Building2, ChefHat, Coffee, LogOut, Plus, ShoppingBag, Warehouse } from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { NewLocationDialog } from '../../components/LocationDialog/NewLocationDialog';
import { BrandMark } from '../../components/Layout/Brand';
import { Loading } from '../../components/Feedback/Feedback';
import { TeamMark } from '../../components/TeamBanner/TeamMark';
import styles from './SelectLocationPage.module.scss';

const ICONS: Record<LocationKind, ComponentType<{ size?: number }>> = {
  warehouse: Warehouse,
  kitchen: ChefHat,
  shop: ShoppingBag,
  cafe: Coffee,
  bar: Beer,
};

/** Первый экран после входа: заведение, с которым человек будет работать. Администратор может добавить новое. */
export default function SelectLocationPage() {
  const { user, can, logout } = useAuth();
  const scope = useScope();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const isAdmin = can('admin');

  useEffect(() => {
    document.title = 'Выбор заведения - Запас';
  }, []);

  if (!user) return null;
  const go = (l: LocationDto) => {
    scope.choose(l.id);
    navigate(user.role === 'waiter' ? '/waiter' : '/', { replace: true });
  };

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <div className={styles.brand}>
          <BrandMark size={30} />
          Запас
        </div>
        <div className={styles.who}>
          <span>
            {user.fullName}
            <small>
              {ROLE_LABELS[user.role]}
              {user.organizationName ? `, ${user.organizationName}` : ''}
            </small>
          </span>
          <button type="button" className={styles.out} onClick={() => void logout()}>
            <LogOut size={16} aria-hidden="true" />
            Выйти
          </button>
        </div>
      </header>

      <main className={styles.main}>
        <h1>Выберите заведение</h1>
        <p className={styles.lead}>
          {isAdmin ? 'Откройте заведение, чтобы работать с его остатками, или добавьте новое.' : 'Откройте заведение, с которым будете работать. Сменить его можно в любой момент.'}
        </p>

        {scope.loading ? (
          <Loading label="Загружаем заведения" />
        ) : (
          <div className={styles.grid}>
            {scope.activeLocations.map((l) => {
              const Icon = ICONS[l.kind];
              return (
                <button key={l.id} type="button" className={styles.card} onClick={() => go(l)}>
                  <span className={`${styles.icon} ${styles[`k_${l.kind}`]}`} aria-hidden="true">
                    <Icon size={22} />
                  </span>
                  <strong>{l.name}</strong>
                  <span className={styles.kind}>{LOCATION_KIND_LABELS[l.kind]}</span>
                  {l.address && <span className={styles.addr}>{l.address}</span>}
                </button>
              );
            })}
            {isAdmin && (
              <button type="button" className={`${styles.card} ${styles.add}`} onClick={() => setCreating(true)}>
                <span className={styles.icon} aria-hidden="true">
                  <Plus size={22} />
                </span>
                <strong>Добавить заведение</strong>
                <span className={styles.kind}>Склад, ресторан, магазин, кафе или бар</span>
              </button>
            )}
          </div>
        )}

        {!scope.loading && scope.activeLocations.length === 0 && (
          <div className={styles.empty}>
            <Building2 size={28} aria-hidden="true" />
            {isAdmin ? (
              <p>В организации «{user.organizationName}» пока нет заведений. Создайте первое, и можно будет принимать товар и вести стоп-лист.</p>
            ) : (
              <p>Вам пока не назначено ни одного заведения. Попросите администратора добавить вас в нужное.</p>
            )}
          </div>
        )}
        {isAdmin && (
          <p className={styles.more}>
            Сотрудников и права доступа можно настроить в разделе «Администрирование» после входа в любое заведение.
          </p>
        )}
      </main>

      <footer className={styles.foot}>
        <span>
          <TeamMark size={20} /> Сделано командой CyberPink228
        </span>
      </footer>

      {isAdmin && (
        <NewLocationDialog
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(l) => {
            setCreating(false);
            go(l);
          }}
        />
      )}
    </div>
  );
}
