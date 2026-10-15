import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAction } from './hooks';

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;

afterEach(() => {
  onlineManager.setOnline(true);
  cleanup();
});

describe('действия без связи', () => {
  it('операция выполняется и без связи, а не встаёт на паузу: документ сам решит, ставить ли себя в очередь', async () => {
    onlineManager.setOnline(false);
    const fn = vi.fn().mockResolvedValue({ queued: true });
    const { result } = renderHook(() => useAction(fn), { wrapper });
    act(() => result.current.mutate(undefined as never));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ queued: true });
  });

  it('ошибка операции доходит до вызывающего', async () => {
    onlineManager.setOnline(false);
    const { result } = renderHook(() => useAction(() => Promise.reject(new Error('нет сети'))), { wrapper });
    act(() => result.current.mutate(undefined as never));
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
