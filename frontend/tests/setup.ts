import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { mockMedia } from './media';

configure({
  getElementError: () => new Error('Element assertion failed (DOM redacted)'),
});

beforeEach(() => {
  mockMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-preset');
});
