import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

function renderApp(path = '/dictionary') {
  const client = new QueryClient();
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

describe('foundation shell', () => {
  it('reports unavailable without leaking backend details, then retries explicitly', async () => {
    let finish: (response: Response) => void = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'private database path' } }),
          { status: 503 },
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    vi.stubGlobal('fetch', fetcher);
    const { unmount, client } = renderApp();
    expect(
      await screen.findByText('Сервис недоступен. Повторите проверку.'),
    ).not.toBeNull();
    expect(screen.queryByText(/private database path/)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Проверить снова' }));
    expect(screen.getByRole('status').textContent).toContain(
      'Проверяем подключение',
    );
    expect(
      screen
        .getByRole('button', { name: 'Проверить снова' })
        .hasAttribute('disabled'),
    ).toBe(true);
    await act(async () => {
      finish(new Response(JSON.stringify({ status: 'ready' })));
      await Promise.resolve();
    });
    expect(await screen.findByText('Сервис готов')).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getQueryCache().getAll()).toEqual([]);
  });

  it('returns from an unknown path using the dictionary link', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ status: 'ready' }))),
    );
    renderApp('/missing');
    expect(
      screen.getByRole('heading', { name: 'Страница не найдена' }),
    ).not.toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole('link', { name: 'Вернуться в словарь' }));
    expect(
      screen.getByRole('heading', { name: 'Личный словарь' }),
    ).not.toBeNull();
    expect(await screen.findByText('Сервис готов')).not.toBeNull();
  });

  it('starts dictionary-first, reports actual readiness and never invents records', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    renderApp('/');
    expect(
      screen.getByRole('heading', { name: 'Личный словарь' }),
    ).not.toBeNull();
    expect(screen.getByRole('status').textContent).toContain(
      'Проверяем подключение',
    );
    expect(
      screen
        .getByRole('button', { name: 'Проверить снова' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByText('Словарь ещё не подключён')).not.toBeNull();
    await act(async () => {
      finish(new Response(JSON.stringify({ status: 'ready' })));
      await Promise.resolve();
    });
    expect(await screen.findByText('Сервис готов')).not.toBeNull();
    expect(screen.getByText(/не означает вход в аккаунт/)).not.toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Подключение' }));
    expect(
      screen.getByRole('heading', { name: 'Подключение к сервису' }),
    ).not.toBeNull();
    await user.click(screen.getByRole('link', { name: 'Словарь' }));
    expect(
      screen.getByRole('heading', { name: 'Личный словарь' }),
    ).not.toBeNull();
  });
});
