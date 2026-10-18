import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';

export function ThemeControl() {
  const { register, control } = useForm<{ theme: 'dark' | 'light' | 'system' }>(
    {
      defaultValues: { theme: 'dark' },
    },
  );
  const preference = useWatch({ control, name: 'theme' });

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.preset = 'hermes';
      document.documentElement.dataset.theme =
        preference === 'system'
          ? media.matches
            ? 'dark'
            : 'light'
          : preference;
    };
    apply();
    media.addEventListener('change', apply);
    return () => {
      media.removeEventListener('change', apply);
    };
  }, [preference]);

  return (
    <label>
      Тема{' '}
      <select {...register('theme')}>
        <option value="dark">Тёмная</option>
        <option value="light">Светлая</option>
        <option value="system">Системная</option>
      </select>
    </label>
  );
}
