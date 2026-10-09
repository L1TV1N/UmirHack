import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScannerDialog, type ScanFeedback } from './ScannerDialog';

// jsdom не умеет модальные окна: эмулируем минимум
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

const ok = (message: string): ScanFeedback => ({ ok: true, message });

describe('окно сканера без камеры', () => {
  it('объясняет, почему камера недоступна на незащищённом адресе, и сразу даёт ввести код', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    render(<ScannerDialog open onClose={() => undefined} onCode={() => ok('x')} />);
    expect((await screen.findByRole('alert')).textContent).toContain('https');
    expect(screen.getByLabelText('Код вручную')).toBeTruthy();
  });

  it('введённый код уходит обработчику, ответ виден, поле очищается, тот же код можно ввести снова', async () => {
    const onCode = vi.fn().mockResolvedValue(ok('Молоко: 1 л'));
    render(<ScannerDialog open onClose={() => undefined} onCode={onCode} />);
    const input = await screen.findByLabelText('Код вручную');
    for (let i = 0; i < 2; i += 1) {
      fireEvent.change(input, { target: { value: '4006381333931' } });
      fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
      await waitFor(() => expect(onCode).toHaveBeenCalledTimes(i + 1));
    }
    expect(onCode).toHaveBeenNthCalledWith(1, '4006381333931');
    expect(screen.getAllByText('Молоко: 1 л')).toHaveLength(2);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('пустой ввод не отправляется', async () => {
    const onCode = vi.fn();
    render(<ScannerDialog open onClose={() => undefined} onCode={onCode} />);
    await screen.findByLabelText('Код вручную');
    expect((screen.getByRole('button', { name: 'Добавить' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onCode).not.toHaveBeenCalled();
  });

  it('ответ с признаком close закрывает окно', async () => {
    const onClose = vi.fn();
    render(<ScannerDialog open onClose={onClose} onCode={() => ({ ok: true, message: 'Введите вес', close: true })} />);
    fireEvent.change(await screen.findByLabelText('Код вручную'), { target: { value: '4006381333931' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('сбой обработчика показывается как ошибка, окно продолжает работать', async () => {
    const onCode = vi.fn().mockRejectedValueOnce(new Error('сбой')).mockResolvedValueOnce(ok('Хлеб: 1 шт'));
    render(<ScannerDialog open onClose={() => undefined} onCode={onCode} />);
    const input = await screen.findByLabelText('Код вручную');
    fireEvent.change(input, { target: { value: '111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(await screen.findByText('Не удалось обработать код')).toBeTruthy();
    fireEvent.change(input, { target: { value: '222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(await screen.findByText('Хлеб: 1 шт')).toBeTruthy();
  });
});

describe('сканер-«клавиатура»', () => {
  const type = (text: string, gap: number) => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (const ch of text) {
      fireEvent.keyDown(document.body, { key: ch });
      now += gap;
    }
    fireEvent.keyDown(document.body, { key: 'Enter' });
  };

  it('быстрые символы и Enter вне поля ввода считаются кодом', async () => {
    const onCode = vi.fn().mockResolvedValue(ok('Принято'));
    render(<ScannerDialog open onClose={() => undefined} onCode={onCode} />);
    await screen.findByLabelText('Код вручную');
    act(() => type('4006381333931', 10));
    await waitFor(() => expect(onCode).toHaveBeenCalledWith('4006381333931'));
  });

  it('медленный набор человеком кодом не считается', async () => {
    const onCode = vi.fn();
    render(<ScannerDialog open onClose={() => undefined} onCode={onCode} />);
    await screen.findByLabelText('Код вручную');
    act(() => type('4006381333931', 300));
    expect(onCode).not.toHaveBeenCalled();
  });

  it('короткая очередь символов не считается кодом', async () => {
    const onCode = vi.fn();
    render(<ScannerDialog open onClose={() => undefined} onCode={onCode} />);
    await screen.findByLabelText('Код вручную');
    act(() => type('123', 10));
    expect(onCode).not.toHaveBeenCalled();
  });
});

describe('камера', () => {
  it('код с камеры обрабатывается один раз, пока он в кадре, а треки камеры останавливаются при закрытии', async () => {
    vi.resetModules();
    vi.doMock('./decoder', () => ({ createDecoder: async () => ({ kind: 'zxing', decode: async () => '4006381333931', dispose: () => undefined }) }));
    const { ScannerDialog: Dialog } = await import('./ScannerDialog');

    const stop = vi.fn();
    const track = { stop, getCapabilities: () => ({}) } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue(stream) }, configurable: true });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get: () => 4, configurable: true });

    const onCode = vi.fn().mockResolvedValue(ok('Молоко: 1 л'));
    const { rerender } = render(<Dialog open onClose={() => undefined} onCode={onCode} />);
    await waitFor(() => expect(onCode).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 600));
    expect(onCode).toHaveBeenCalledTimes(1);

    rerender(<Dialog open={false} onClose={() => undefined} onCode={onCode} />);
    await waitFor(() => expect(stop).toHaveBeenCalled());
    vi.doUnmock('./decoder');
  });

  it('код, который убрали из кадра и показали снова, считается второй раз', async () => {
    vi.resetModules();
    const state = { visible: true };
    vi.doMock('./decoder', () => ({ createDecoder: async () => ({ kind: 'zxing', decode: async () => (state.visible ? '4006381333931' : null), dispose: () => undefined }) }));
    const { ScannerDialog: Dialog } = await import('./ScannerDialog');
    const track = { stop: vi.fn(), getCapabilities: () => ({}) } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue(stream) }, configurable: true });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get: () => 4, configurable: true });

    const onCode = vi.fn().mockResolvedValue(ok('Молоко'));
    render(<Dialog open onClose={() => undefined} onCode={onCode} />);
    await waitFor(() => expect(onCode).toHaveBeenCalledTimes(1), { timeout: 3000 });
    state.visible = false;
    await new Promise((r) => setTimeout(r, 1000));
    state.visible = true;
    await waitFor(() => expect(onCode).toHaveBeenCalledTimes(2), { timeout: 3000 });
    vi.doUnmock('./decoder');
  });

  it('отказ в доступе к камере объясняется человеческим языком и открывает ручной ввод', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
      configurable: true,
    });
    render(<ScannerDialog open onClose={() => undefined} onCode={() => ok('x')} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Доступ к камере закрыт');
    expect(screen.getByLabelText('Код вручную')).toBeTruthy();
  });
});
