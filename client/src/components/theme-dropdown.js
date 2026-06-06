// Theme dropdown — menu renders on document.body to avoid clipping.

import { ThemeManager } from '../themes/manager.js';

let container = null;
let trigger = null;
let menu = null;
let menuHome = null;
let valueEl = null;
let isOpen = false;
let themes = [];

function bindOptions() {
  if (!menu) return;
  menu.querySelectorAll('.theme-dropdown-option').forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const themeId = opt.dataset.themeId;
      if (themeId) selectTheme(themeId);
    });
  });
}

function syncFromActiveTheme() {
  if (!valueEl || !menu) return;
  const activeId = ThemeManager.getActiveThemeId();
  const theme = themes.find((t) => t.id === activeId) || themes[0];
  if (!theme) return;

  valueEl.textContent = theme.name;
  menu.querySelectorAll('.theme-dropdown-option').forEach((opt) => {
    const selected = opt.dataset.themeId === theme.id;
    opt.classList.toggle('is-selected', selected);
    opt.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function positionMenu() {
  if (!trigger || !menu) return;
  const rect = trigger.getBoundingClientRect();
  const gap = 6;
  menu.style.position = 'fixed';
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + gap}px`;
  menu.style.width = `${Math.max(rect.width, 220)}px`;
  menu.style.zIndex = '99999';

  const menuHeight = menu.offsetHeight;
  const spaceBelow = window.innerHeight - rect.bottom - gap;
  if (menuHeight > spaceBelow && rect.top > spaceBelow) {
    menu.style.top = `${Math.max(8, rect.top - gap - menuHeight)}px`;
  }
}

function openMenu() {
  if (!container || !trigger || !menu) return;
  isOpen = true;
  trigger.setAttribute('aria-expanded', 'true');
  container.classList.add('is-open');

  if (!menuHome) menuHome = menu.parentElement;
  document.body.appendChild(menu);
  menu.hidden = false;
  menu.classList.add('is-portaled');
  positionMenu();

  setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
}

function closeMenu() {
  if (!container || !trigger || !menu) return;
  isOpen = false;
  trigger.setAttribute('aria-expanded', 'false');
  container.classList.remove('is-open');
  menu.hidden = true;
  menu.classList.remove('is-portaled');
  if (menuHome) menuHome.appendChild(menu);
  document.removeEventListener('click', onOutsideClick);
}

function onOutsideClick(e) {
  if (container?.contains(e.target) || menu?.contains(e.target)) return;
  closeMenu();
}

function selectTheme(themeId) {
  ThemeManager.setTheme(themeId);
  syncFromActiveTheme();
  closeMenu();
}

export class ThemeDropdown {
  static init() {
    container = document.getElementById('themeDropdown');
    trigger = document.getElementById('themeDropdownTrigger');
    menu = document.getElementById('themeDropdownMenu');
    valueEl = document.getElementById('themeDropdownValue');

    if (!container || !trigger || !menu || !valueEl) {
      console.error('[ThemeDropdown] Required elements not found');
      return false;
    }

    themes = ThemeManager.getRegisteredThemes();
    bindOptions();
    syncFromActiveTheme();

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isOpen) closeMenu();
      else openMenu();
    });

    window.addEventListener('themeChanged', syncFromActiveTheme);
    window.addEventListener('resize', () => { if (isOpen) positionMenu(); });
    window.addEventListener('layoutScaled', () => { if (isOpen) positionMenu(); });

    return true;
  }
}
