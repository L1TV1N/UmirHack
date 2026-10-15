import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LIVE_OFF_HINT, LIVE_ON_HINT, LiveBadge } from './LiveBadge';

afterEach(cleanup);

describe('индикатор живого обновления', () => {
  it('пока поток открыт, пишет «Обновляется сразу»', () => {
    render(<LiveBadge live />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toBe('Обновляется сразу');
    expect(badge.getAttribute('title')).toBe(LIVE_ON_HINT);
  });

  it('без потока честно говорит, как обновляются данные, и не обещает опрос раз в минуту', () => {
    render(<LiveBadge live={false} />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toBe('Без живого обновления');
    expect(badge.getAttribute('title')).toBe(LIVE_OFF_HINT);
    expect(LIVE_OFF_HINT).toContain('15 секунд');
    expect(LIVE_OFF_HINT).not.toContain('раз в минуту');
  });
});
