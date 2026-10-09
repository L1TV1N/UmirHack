import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScannerDialog } from '../Scanner/ScannerDialog';
import { Dialog } from './Dialog';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
});
afterEach(cleanup);

describe('окно, открытое из формы страницы', () => {
  it('в разметке стоит не внутри формы: вложенные формы Chrome не отправляет через React', () => {
    const { container } = render(
      <form>
        <Dialog open onClose={() => undefined} title="Окно">
          <span>Содержимое</span>
        </Dialog>
      </form>,
    );
    const dialog = screen.getByText('Содержимое').closest('dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.closest('form')).toBeNull();
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('ручной ввод кода не запускает отправку формы, в которой лежит кнопка сканера', async () => {
    const outer = vi.fn((e: React.FormEvent) => e.preventDefault());
    const onCode = vi.fn().mockResolvedValue({ ok: true, message: 'Принято' });
    render(
      <form onSubmit={outer}>
        <ScannerDialog open onClose={() => undefined} onCode={onCode} />
      </form>,
    );
    fireEvent.change(await screen.findByLabelText('Код вручную'), { target: { value: '4006381333931' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(await screen.findByText('Принято')).toBeTruthy();
    expect(onCode).toHaveBeenCalledWith('4006381333931');
    expect(outer).not.toHaveBeenCalled();
  });
});
