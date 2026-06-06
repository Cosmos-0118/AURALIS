// Auralis Theme Manager
// Centralized theme controller — applies semantic tokens and handles persistence.

import { themes } from './definitions.js';

const STORAGE_KEY = 'auralis-theme';

export class ThemeManager {
  static getRegisteredThemes() {
    return Object.values(themes);
  }

  static getTheme(themeId) {
    return themes[themeId] || themes.braun;
  }

  static getActiveThemeId() {
    return localStorage.getItem(STORAGE_KEY) || 'braun';
  }

  static init() {
    this.setTheme(this.getActiveThemeId());
  }

  static setTheme(themeId) {
    const theme = this.getTheme(themeId);
    const root = document.documentElement;

    Object.entries(theme.tokens).forEach(([token, value]) => {
      root.style.setProperty(token, value);
    });

    root.setAttribute('data-theme', theme.id);
    localStorage.setItem(STORAGE_KEY, theme.id);

    window.dispatchEvent(new CustomEvent('themeChanged', { detail: theme }));
  }

  /** Read a CSS custom property value from the document root. */
  static getToken(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
  }
}
