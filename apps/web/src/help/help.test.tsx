import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HelpButton } from '../components/Help/HelpButton';
import GuidePage from '../pages/Guide/GuidePage';
import { GUIDE_GROUPS, HELP, sectionForPath } from './content';
import { SHOTS } from './shots';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(cleanup);

describe('содержимое справки', () => {
  it('идентификаторы уникальны, группы известны, у каждого раздела есть пояснение и шаги', () => {
    expect(new Set(HELP.map((s) => s.id)).size).toBe(HELP.length);
    for (const s of HELP) {
      expect(GUIDE_GROUPS).toContain(s.group);
      expect(s.popup.what.length).toBeGreaterThan(20);
      expect(s.popup.how.length).toBeGreaterThan(0);
      expect(s.guide.length).toBeGreaterThan(0);
    }
  });

  it('длинных тире нет нигде', () => {
    expect(JSON.stringify(HELP)).not.toContain('—');
  });

  it('каждый раздел меню имеет справку', () => {
    for (const path of ['/', '/stock', '/operations', '/inventory', '/traceability', '/haccp', '/stop-list', '/hot-dishes', '/recommendations', '/orders', '/suppliers', '/products', '/dishes', '/reports', '/testing', '/admin']) {
      expect(sectionForPath(path), path).toBeDefined();
    }
    expect(sectionForPath('/inventory/abc')?.id).toBe('inventory');
    expect(sectionForPath('/guide')).toBeUndefined();
  });
});

describe('снимки экрана в руководстве', () => {
  const used = HELP.flatMap((s) => s.guide.flatMap((b) => ('shots' in b ? b.shots : [])));

  it('каждый снимок описан, лежит в public и подписан по пунктам', () => {
    expect(used.length).toBeGreaterThan(30);
    expect(new Set(used).size).toBe(used.length);
    for (const id of used) {
      const shot = SHOTS[id];
      expect(shot, id).toBeDefined();
      expect(existsSync(join(__dirname, '../../public/help-img', `${id}.jpg`)), id).toBe(true);
      expect(shot!.marks.length, id).toBeGreaterThan(0);
      expect(shot!.alt.length, id).toBeGreaterThan(5);
    }
  });

  it('описаний без снимков нет, длинных тире нет', () => {
    expect(Object.keys(SHOTS).sort()).toEqual([...used].sort());
    expect(JSON.stringify(SHOTS)).not.toContain('—');
  });

  it('на странице видны снимки и пронумерованные подписи, поиск находит и по ним', () => {
    render(
      <MemoryRouter initialEntries={['/guide']}>
        <GuidePage />
      </MemoryRouter>,
    );
    const img = screen.getByAltText(SHOTS.stock!.alt) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/help-img/stock.jpg');
    expect(img.closest('figure')!.querySelectorAll('li')).toHaveLength(SHOTS.stock!.marks.length);
    fireEvent.change(screen.getByLabelText('Поиск по руководству'), { target: { value: 'коридором неопределённости' } });
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toContain('Остатки');
  });
});

describe('кнопка «?»', () => {
  it('открывает пояснение раздела со ссылкой на руководство', () => {
    render(
      <MemoryRouter initialEntries={['/stop-list']}>
        <HelpButton />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Справка: Стоп-лист' }));
    expect(screen.getByText('Как пользоваться')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Подробнее в руководстве' }).getAttribute('href')).toBe('/guide#stoplist');
  });

  it('на странице без справки кнопки нет, вне маршрутизатора тоже', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/guide']}>
        <HelpButton />
      </MemoryRouter>,
    );
    expect(container.querySelector('button')).toBeNull();
    cleanup();
    const outside = render(<HelpButton />);
    expect(outside.container.querySelector('button')).toBeNull();
  });
});

describe('руководство', () => {
  it('показывает все разделы и ищет по тексту', () => {
    render(
      <MemoryRouter initialEntries={['/guide']}>
        <GuidePage />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(HELP.length);
    fireEvent.change(screen.getByLabelText('Поиск по руководству'), { target: { value: 'фасовка' } });
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toContain('Заказы поставщикам');
    expect(titles).not.toContain('Обзор');
    fireEvent.change(screen.getByLabelText('Поиск по руководству'), { target: { value: 'ничегонетакого' } });
    expect(screen.getByText(/Ничего не нашлось/)).toBeTruthy();
  });

  it('содержание подсвечивает поиск счётчиком, ссылки на разделы и просмотр снимка работают', () => {
    Object.assign(navigator, { clipboard: { writeText: () => Promise.resolve() } });
    render(
      <MemoryRouter initialEntries={['/guide']}>
        <GuidePage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Клавиша «\/» ставит курсор/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Поиск по руководству'), { target: { value: 'фасовка' } });
    expect(screen.getByText(/Найдено разделов: \d+/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Очистить поиск' }));
    expect((screen.getByLabelText('Поиск по руководству') as HTMLInputElement).value).toBe('');
    // крупный просмотр снимка
    fireEvent.click(screen.getAllByRole('button', { name: /открыть снимок крупно/ })[0] as HTMLElement);
    expect(screen.getAllByRole('img', { name: SHOTS.start!.alt }).length).toBeGreaterThan(1);
    // «следующий раздел» ведёт на соседнюю статью
    expect(screen.getAllByRole('link', { name: /Роли и права/ }).length).toBeGreaterThan(1);
  });
});
