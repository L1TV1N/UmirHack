import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CacheStatusDto } from '@zapas/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const confirm = vi.fn();
let data: CacheStatusDto;

vi.mock('../../api/client', () => ({ post: (...a: unknown[]) => post(...a) }));
vi.mock('../../api/hooks', () => ({
  useGet: () => ({ data, isError: false, isLoading: false }),
  useAction: (fn: (v: never) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: never, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => toast }));
vi.mock('../../components/Toast/Confirm', () => ({ useConfirm: () => confirm }));

import { CachePanel } from './CachePanel';

const stats = (over = {}) => ({
  hits: 90, misses: 4, joined: 5, stale: 1, failures: 0, invalidations: 12, taggedInvalidations: 10, loads: 4,
  lastLoadMs: 41, avgLoadMs: 44.5, maxLoadMs: 52, entries: 3, maxEntries: 8, ttlSeconds: 20, heavyMs: 250, hitRatio: 0.96, ...over,
});

afterEach(cleanup);

describe('страница кеша', () => {
  it('показывает долю попаданий, ключи и состояние одного экземпляра', () => {
    data = { snapshots: stats(), aggregates: stats({ hitRatio: 0.5 }), liveClients: 2, cluster: { enabled: false, connected: false, sent: 0, received: 0, sendErrors: 0, reconnects: 0, lastError: null } };
    render(<CachePanel />);
    expect(screen.getByText('96%')).toBeTruthy();
    expect(screen.getAllByText('3 из 8').length).toBe(2);
    expect(screen.getByText('Один экземпляр')).toBeTruthy();
    expect(screen.getByText(/клиентов с живым обновлением: 2/)).toBeTruthy();
  });

  it('при включённой синхронизации показывает, работает ли она, и последнюю ошибку', () => {
    data = { snapshots: stats(), aggregates: stats(), liveClients: 0, cluster: { enabled: true, connected: false, sent: 7, received: 3, sendErrors: 1, reconnects: 2, lastError: 'connection refused' } };
    render(<CachePanel />);
    expect(screen.getByText(/Синхронизация потеряна/)).toBeTruthy();
    expect(screen.getByText(/connection refused/)).toBeTruthy();
  });

  it('сброс кеша спрашивает подтверждение', async () => {
    data = { snapshots: stats(), aggregates: stats(), liveClients: 0, cluster: { enabled: false, connected: false, sent: 0, received: 0, sendErrors: 0, reconnects: 0, lastError: null } };
    confirm.mockResolvedValueOnce(false);
    render(<CachePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить кеш' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    post.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить кеш' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/cache/flush'));
  });
});
