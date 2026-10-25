export type ColorTheme = 'light' | 'dark';

declare global {
  interface Window {
    legaTheme: {
      get: () => ColorTheme;
      set: (theme: ColorTheme) => void;
      apply: () => void;
    };
  }
}

export function setColorTheme(theme: ColorTheme) {
  window.legaTheme.set(theme);
}

export function toggleColorTheme() {
  setColorTheme(window.legaTheme.get() === 'dark' ? 'light' : 'dark');
}
