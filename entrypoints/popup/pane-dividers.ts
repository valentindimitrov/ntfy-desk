import { browser } from 'wxt/browser';
import { elements, isPageMode, saveLocal } from './state';

interface DividerOptions {
  divider: HTMLElement;
  pane: HTMLElement;
  property: string;
  key: string;
  stored: unknown;
  min: number;
  limit?: number;
  direction: 1 | -1;
  minInbox: number;
}

function setupDivider({ divider, pane, property, key, stored, min, limit = Infinity, direction, minInbox }: DividerOptions): void {
  const { mainView, notificationsSection } = elements;
  const setWidth = (width: number) => mainView.style.setProperty(property, `${width}px`);
  if (typeof stored === 'number' && Number.isFinite(stored)) {
    setWidth(Math.max(min, Math.min(limit, stored)));
  }

  const bounds = () => {
    const width = pane.getBoundingClientRect().width;
    const spare = notificationsSection.getBoundingClientRect().width - minInbox;
    return { width: Math.round(width), max: Math.max(min, Math.min(limit, Math.round(width + spare))) };
  };
  const saveWidth = (width: number) => {
    void saveLocal({ [key]: width }).catch(() => {
      // The current view can still be resized if storage is unavailable.
    });
  };

  divider.setAttribute('aria-valuemin', String(min));
  const observer = new ResizeObserver(() => {
    if (divider.offsetWidth === 0) return;
    const { width, max } = bounds();
    divider.setAttribute('aria-valuemax', String(max));
    divider.setAttribute('aria-valuenow', String(width));
    divider.setAttribute('aria-valuetext', `${width} pixels`);
  });
  observer.observe(divider);
  observer.observe(pane);
  observer.observe(notificationsSection);

  let drag: { pointerId: number; startX: number; startWidth: number; width: number; max: number; previous: string } | undefined;
  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    divider.focus();
    divider.setPointerCapture(event.pointerId);
    const { width, max } = bounds();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      width,
      max,
      previous: mainView.style.getPropertyValue(property),
    };
  });
  divider.addEventListener('pointermove', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    const change = direction * (event.clientX - drag.startX);
    const width = Math.max(min, Math.min(drag.max, drag.startWidth + change));
    if (width === drag.width) return;
    setWidth(width);
    drag.width = width;
  });
  divider.addEventListener('lostpointercapture', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    if (drag.width !== drag.startWidth) saveWidth(drag.width);
    else mainView.style.setProperty(property, drag.previous);
    drag = undefined;
  });

  divider.addEventListener('keydown', (event) => {
    const { width, max } = bounds();
    let target: number;
    switch (event.key) {
      case 'ArrowLeft':
        target = width - direction * 16;
        break;
      case 'ArrowRight':
        target = width + direction * 16;
        break;
      case 'Home':
        target = min;
        break;
      case 'End':
        target = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextWidth = Math.max(min, Math.min(max, target));
    if (width === nextWidth) return;
    setWidth(nextWidth);
    saveWidth(nextWidth);
  });
}

export async function setupPaneDividers(): Promise<void> {
  const { mainView, topicDivider, topicSidebar, sendDivider, sendSection } = elements;
  const topicsKey = isPageMode ? 'topicsPaneWidth' : 'popupTopicsPaneWidth';
  const sendKey = isPageMode ? 'sendPaneWidth' : 'popupSendPaneWidth';
  const stored = await browser.storage.local.get([topicsKey, sendKey]).catch((): Record<string, unknown> => ({}));
  const style = getComputedStyle(mainView);
  const size = (property: string) => Number.parseFloat(style.getPropertyValue(property));
  const minInbox = size('--min-inbox-width');
  setupDivider({
    divider: topicDivider,
    pane: topicSidebar,
    property: '--topics-width',
    key: topicsKey,
    stored: stored[topicsKey],
    min: size('--min-topic-width'),
    limit: size('--max-topic-width'),
    direction: 1,
    minInbox,
  });
  setupDivider({
    divider: sendDivider,
    pane: sendSection,
    property: '--send-width',
    key: sendKey,
    stored: stored[sendKey],
    min: size('--min-send-width'),
    direction: -1,
    minInbox,
  });
}
