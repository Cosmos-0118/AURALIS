function measureTextWidth(el) {
  const style = window.getComputedStyle(el);
  const probe = document.createElement('span');
  probe.textContent = el.textContent;
  probe.style.cssText = `
    position: absolute;
    left: -9999px;
    top: 0;
    visibility: hidden;
    white-space: nowrap;
    font-family: ${style.fontFamily};
    font-size: ${style.fontSize};
    font-weight: ${style.fontWeight};
    letter-spacing: ${style.letterSpacing};
  `;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

export function applyRollingTitle(container, textEl, {
  distanceVar = '--marquee-distance',
  durationVar = '--marquee-duration',
  minDuration = 7,
  maxDuration = 16,
  pxPerSec = 14,
  varTarget = null,
} = {}) {
  if (!container || !textEl) return;

  const varsEl = varTarget || container;

  textEl.classList.remove('is-marquee');
  container.classList.remove('is-overflow', 'is-marquee');
  varsEl.style.removeProperty(distanceVar);
  varsEl.style.removeProperty(durationVar);

  const measureAndApply = () => {
    const containerWidth = container.clientWidth;
    if (containerWidth <= 0) return;

    const textWidth = measureTextWidth(textEl);
    const overflow = textWidth - containerWidth;
    if (overflow <= 4) return;

    container.classList.add('is-overflow', 'is-marquee');
    textEl.classList.add('is-marquee');
    varsEl.style.setProperty(distanceVar, `${overflow}px`);
    const duration = Math.min(maxDuration, Math.max(minDuration, overflow / pxPerSec));
    varsEl.style.setProperty(durationVar, `${duration}s`);
  };

  requestAnimationFrame(() => requestAnimationFrame(measureAndApply));
}

export function bindRollingTitleResize(container, textEl, options = {}) {
  if (!container) return null;

  const observer = new ResizeObserver(() => {
    if (textEl.textContent) applyRollingTitle(container, textEl, options);
  });
  observer.observe(container);
  return observer;
}
