import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeControl } from '../src/ThemeControl';
import { mockMedia } from './media';

describe('theme preference', () => {
  it('defaults to dark, allows light/dark/system and follows live system changes', async () => {
    const system = mockMedia(false);
    const { unmount } = render(<ThemeControl />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-preset')).toBe('hermes');
    const user = userEvent.setup();
    const preference = screen.getByRole('combobox', { name: 'Тема' });
    await user.selectOptions(preference, 'light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    act(() => {
      system.change(true);
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    await user.selectOptions(preference, 'system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    act(() => {
      system.change(false);
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    await user.selectOptions(preference, 'dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    unmount();
    expect(system.listeners.size).toBe(0);
  });
});
