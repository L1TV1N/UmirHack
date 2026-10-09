import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type Column } from './DataTable';

interface Row {
  id: string;
  name: string;
  qty: number;
}

const columns: Column<Row>[] = [
  { key: 'name', header: 'Продукт', cell: (r) => r.name },
  { key: 'qty', header: 'Количество', align: 'right', cell: (r) => r.qty },
];

describe('DataTable', () => {
  it('показывает строки и заголовки', () => {
    render(<DataTable columns={columns} rows={[{ id: '1', name: 'Молоко', qty: 5 }]} rowKey={(r) => r.id} />);
    expect(screen.getByRole('columnheader', { name: 'Продукт' })).toBeTruthy();
    expect(screen.getByText('Молоко')).toBeTruthy();
  });

  it('показывает пояснение, когда данных нет', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} empty="Остатков нет" />);
    expect(screen.getByText('Остатков нет')).toBeTruthy();
  });

  it('строка открывается и мышью, и клавиатурой', () => {
    const onRowClick = vi.fn();
    const row = { id: '1', name: 'Кефир', qty: 2 };
    render(<DataTable columns={columns} rows={[row]} rowKey={(r) => r.id} onRowClick={onRowClick} />);
    const tr = screen.getByText('Кефир').closest('tr') as HTMLElement;
    fireEvent.click(tr);
    fireEvent.keyDown(tr, { key: 'Enter' });
    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(tr.getAttribute('tabindex')).toBe('0');
  });

  it('пока данные грузятся, рисует заглушки, а не пустое состояние', () => {
    const { container } = render(<DataTable columns={columns} rows={undefined} rowKey={(r) => r.id} loading />);
    expect(container.querySelectorAll('tbody tr[aria-hidden="true"]').length).toBeGreaterThan(0);
    expect(screen.queryByText('Ничего не найдено')).toBeNull();
  });
});
