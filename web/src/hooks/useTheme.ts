import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem('score-theme');
      return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
      return 'system';
    }
  });

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      document.documentElement.dataset.theme = theme === 'system'
        ? media.matches ? 'dark' : 'light'
        : theme;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content',
        document.documentElement.dataset.theme === 'dark' ? '#100d15' : '#fbf8fb');
    };
    update();
    try {
      localStorage.setItem('score-theme', theme);
    } catch { /* Storage may be disabled. */ }
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);

  return { theme, setTheme };
}
