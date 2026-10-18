import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockMedia } from './media';

describe('browser entry', () => {
  it('fails clearly if the HTML root is missing', async () => {
    vi.resetModules();
    await expect(import('../src/main')).rejects.toThrow(
      'Не найден корневой элемент приложения.',
    );
    vi.resetModules();
  });
  it('mounts the actual application and its theme control', async () => {
    const system = mockMedia(false);
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ status: 'ready' }))),
        ),
    );
    const container = document.createElement('div');
    container.id = 'root';
    document.body.append(container);
    window.history.replaceState(null, '', '/');
    // Import the real entry rather than a mocked bootstrap or a second test-only tree.
    let unmount: () => void = vi.fn();
    await act(async () => {
      const entry = await import('../src/main');
      unmount = () => {
        entry.root.unmount();
      };
    });
    expect(
      await screen.findByRole('heading', { name: 'Личный словарь' }),
    ).not.toBeNull();
    expect(screen.getByRole('combobox', { name: 'Тема' })).not.toBeNull();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(await screen.findByText('Сервис готов')).not.toBeNull();
    expect(system.listeners.size).toBe(1);
    act(() => {
      unmount();
    });
    expect(system.listeners.size).toBe(0);
    container.remove();
  });
});
