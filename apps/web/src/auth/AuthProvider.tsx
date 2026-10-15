import { hasRole, type EmailVerificationPendingDto, type RegisterBody, type Role, type SessionDto, type TwoFactorChallengeDto, type UserDto } from '@zapas/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, refreshSession, session } from '../api/client';
import { isTransient } from '../api/transient';
import { clearCatalog } from '../lib/catalog';
import { clearWaiterCache } from '../lib/waiterCache';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthValue {
  status: Status;
  user: UserDto | null;
  /** Сессия оборвалась сама (истекла или закрыта администратором), а не по кнопке «Выйти». */
  sessionEnded: boolean;
  /** Вход по паролю. Если нужен код (подтверждение входа или почты), сессии ещё нет: возвращается запрос кода. */
  login(email: string, password: string): Promise<TwoFactorChallengeDto | EmailVerificationPendingDto | null>;
  /** Второй шаг входа: код из Telegram или резервный код. */
  verifyTwoFactor(challengeId: string, code: string): Promise<void>;
  /** Новый код для входа; возвращает обновлённый запрос. */
  resendTwoFactor(challengeId: string): Promise<{ challengeId: string; delivered: boolean; expiresIn: number; resendAfter: number }>;
  /** Новая организация и её первый администратор. Если на сервере включено подтверждение почты, сессии нет: возвращается запрос кода. */
  register(body: RegisterBody): Promise<EmailVerificationPendingDto | null>;
  /** Код из письма завершает регистрацию или вход. */
  verifyEmail(email: string, code: string): Promise<void>;
  /** Новое письмо с кодом. */
  resendEmail(email: string): Promise<{ resendAfter: number }>;
  logout(): Promise<void>;
  can(role: Role): boolean;
}

const Ctx = createContext<AuthValue | null>(null);

// Последний вошедший пользователь, чтобы без связи открыть приложение, сканировать и оформлять документы в очередь.
// Пароля и токенов здесь нет. Настоящую проверку сессии сервер делает, как только связь вернётся.
const LAST_USER_KEY = 'zapas.lastUser';
const OFFLINE_TTL_MS = 14 * 86_400_000;

function rememberUser(user: UserDto | null): void {
  try {
    if (user) localStorage.setItem(LAST_USER_KEY, JSON.stringify({ user, at: Date.now() }));
    else localStorage.removeItem(LAST_USER_KEY);
  } catch {
    // хранилище недоступно: без связи войти не получится, но это не ошибка
  }
}

function recallUser(): UserDto | null {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { user?: UserDto; at?: number };
    return saved.user && typeof saved.at === 'number' && Date.now() - saved.at < OFFLINE_TTL_MS ? saved.user : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<UserDto | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const signedIn = useRef(false);
  const leaving = useRef(false);
  const qc = useQueryClient();

  const apply = useCallback(
    (s: SessionDto | null) => {
      if (!s && signedIn.current && !leaving.current) setSessionEnded(true);
      if (s) setSessionEnded(false);
      if (s || signedIn.current) rememberUser(s?.user ?? null);
      // каталог с ценами не остаётся на устройстве после выхода
      if (!s && signedIn.current) {
        void clearCatalog();
        void clearWaiterCache();
      }
      signedIn.current = s !== null;
      session.set(s?.accessToken ?? null);
      setUser(s?.user ?? null);
      setStatus(s ? 'authenticated' : 'anonymous');
      if (!s) qc.clear();
    },
    [qc],
  );

  useEffect(() => {
    let alive = true;
    void refreshSession()
      .then((s) => {
        if (alive) apply(s);
      })
      .catch((err) => {
        if (!alive) return;
        // нет связи при запуске: если недавно входили, работаем в режиме без связи, иначе просим войти
        const cached = isTransient(err) ? recallUser() : null;
        if (cached) {
          signedIn.current = true;
          setUser(cached);
          setStatus('authenticated');
        } else {
          apply(null);
        }
      });
    // связь вернулась: подтверждаем сессию на сервере и получаем настоящий токен
    const onOnline = () => {
      if (!session.token() && signedIn.current) void refreshSession().catch(() => undefined);
    };
    window.addEventListener('online', onOnline);
    const off = session.subscribe((s) => {
      if (alive) apply(s);
    });
    return () => {
      alive = false;
      off();
      window.removeEventListener('online', onOnline);
    };
  }, [apply]);

  const login = useCallback(
    async (email: string, password: string): Promise<TwoFactorChallengeDto | EmailVerificationPendingDto | null> => {
      const res = await api<SessionDto | TwoFactorChallengeDto | EmailVerificationPendingDto>('POST', '/auth/login', { body: { email, password }, auth: false });
      if ('twoFactorRequired' in res || 'emailVerificationRequired' in res) return res;
      apply(res);
      return null;
    },
    [apply],
  );

  const verifyTwoFactor = useCallback(
    async (challengeId: string, code: string) => {
      const s = await api<SessionDto>('POST', '/auth/2fa/verify', { body: { challengeId, code }, auth: false });
      apply(s);
    },
    [apply],
  );

  const resendTwoFactor = useCallback(
    (challengeId: string) => api<{ challengeId: string; delivered: boolean; expiresIn: number; resendAfter: number }>('POST', '/auth/2fa/resend', { body: { challengeId }, auth: false }),
    [],
  );

  const register = useCallback(
    async (body: RegisterBody): Promise<EmailVerificationPendingDto | null> => {
      const res = await api<SessionDto | EmailVerificationPendingDto>('POST', '/auth/register', { body, auth: false });
      if ('emailVerificationRequired' in res) return res;
      apply(res);
      return null;
    },
    [apply],
  );

  const verifyEmail = useCallback(
    async (email: string, code: string) => {
      const s = await api<SessionDto>('POST', '/auth/verify-email', { body: { email, code }, auth: false });
      apply(s);
    },
    [apply],
  );

  const resendEmail = useCallback((email: string) => api<{ resendAfter: number }>('POST', '/auth/verify-email/resend', { body: { email }, auth: false }), []);

  const logout = useCallback(async () => {
    leaving.current = true;
    try {
      await api('POST', '/auth/logout', { body: undefined, auth: false });
    } catch {
      // нет связи: локально всё равно выходим, токен доступа живёт в памяти и исчезнет вместе со страницей
    } finally {
      apply(null);
      leaving.current = false;
    }
  }, [apply]);

  const value = useMemo<AuthValue>(
    () => ({ status, user, sessionEnded, login, verifyTwoFactor, resendTwoFactor, register, verifyEmail, resendEmail, logout, can: (role) => (user ? hasRole(user.role, role) : false) }),
    [status, user, sessionEnded, login, verifyTwoFactor, resendTwoFactor, register, verifyEmail, resendEmail, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('AuthProvider не подключён');
  return ctx;
}
