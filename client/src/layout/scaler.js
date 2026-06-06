// Responsive layout — sets a unitless scale factor (no transform on UI).

const DESIGN_WIDTH = 860;
const DESIGN_HEIGHT = 780;
const MIN_SCALE = 0.35;
const MAX_SCALE = 1.4;
const PADDING = 48;

export class LayoutScaler {
  static init() {
    LayoutScaler.update();
    window.addEventListener('resize', LayoutScaler.update, { passive: true });
    window.addEventListener('orientationchange', LayoutScaler.update, { passive: true });
  }

  static update() {
    const availW = Math.max(1, window.innerWidth - PADDING);
    const availH = Math.max(1, window.innerHeight - PADDING);
    
    const el = document.querySelector('.device-body');
    const layoutW = el ? el.offsetWidth : DESIGN_WIDTH;
    const layoutH = el ? el.offsetHeight : DESIGN_HEIGHT;

    const scaleW = availW / layoutW;
    const scaleH = availH / layoutH;
    const scale = Math.min(Math.max(Math.min(scaleW, scaleH), MIN_SCALE), MAX_SCALE);

    document.documentElement.style.setProperty('--layout-scale', String(scale));
    window.dispatchEvent(new CustomEvent('layoutScaled', { detail: { scale } }));
  }
}
