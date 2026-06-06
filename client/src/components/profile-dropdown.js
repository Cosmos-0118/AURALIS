// Profile dropdown — menu renders on document.body to avoid clipping.

export const PROFILE_OPTIONS = [
  { id: 'zenith', label: 'ZENITH' },
  { id: 'hyper_immersive', label: 'HYPER IMMERSIVE' },
  { id: 'concert', label: 'CONCERT' },
  { id: 'cinema', label: 'CINEMA' },
  { id: 'audiophile', label: 'AUDIOPHILE' },
  { id: 'basshead', label: 'BASSHEAD' },
];

let container = null;
let trigger = null;
let menu = null;
let menuHome = null;
let valueEl = null;
let isOpen = false;
let selectedProfile = 'zenith';

function bindOptions() {
  if (!menu) return;
  menu.querySelectorAll('.profile-dropdown-option').forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const profileId = opt.dataset.profileId;
      if (profileId) selectProfile(profileId);
    });
  });
}

function syncSelection() {
  if (!valueEl || !menu) return;
  const profile = PROFILE_OPTIONS.find((p) => p.id === selectedProfile) || PROFILE_OPTIONS[0];
  if (!profile) return;

  valueEl.textContent = profile.label;
  menu.querySelectorAll('.profile-dropdown-option').forEach((opt) => {
    const selected = opt.dataset.profileId === profile.id;
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

function selectProfile(profileId) {
  const profile = PROFILE_OPTIONS.find((p) => p.id === profileId);
  if (!profile) return;
  selectedProfile = profile.id;
  syncSelection();
  closeMenu();
  window.dispatchEvent(new CustomEvent('profileChanged', { detail: { profile: profile.id } }));
}

function resolveInitialProfile() {
  const envProfile = import.meta.env.VITE_AURALIS_PROFILE;
  if (envProfile && PROFILE_OPTIONS.some((p) => p.id === envProfile)) {
    return envProfile;
  }
  const defaultOpt = menu?.querySelector('.profile-dropdown-option.is-selected');
  if (defaultOpt?.dataset.profileId) return defaultOpt.dataset.profileId;
  return 'zenith';
}

export class ProfileDropdown {
  static init() {
    container = document.getElementById('profileDropdown');
    trigger = document.getElementById('profileDropdownTrigger');
    menu = document.getElementById('profileDropdownMenu');
    valueEl = document.getElementById('profileDropdownValue');

    if (!container || !trigger || !menu || !valueEl) {
      console.error('[ProfileDropdown] Required elements not found');
      return false;
    }

    selectedProfile = resolveInitialProfile();
    bindOptions();
    syncSelection();

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isOpen) closeMenu();
      else openMenu();
    });

    window.addEventListener('resize', () => { if (isOpen) positionMenu(); });
    window.addEventListener('layoutScaled', () => { if (isOpen) positionMenu(); });

    return true;
  }

  static getValue() {
    return selectedProfile;
  }
}
