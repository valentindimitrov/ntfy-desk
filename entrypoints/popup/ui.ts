// Small UI helpers: status lines, tooltips and drag-and-drop reordering of badges.

import { elements } from './state';

export type StatusType = 'success' | 'error' | 'warning';
const hideTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export function clearStatus(target: HTMLElement): void {
  clearTimeout(hideTimers.get(target));
  hideTimers.delete(target);
  target.textContent = '';
  target.classList.remove('visible');
}

function show(target: HTMLElement, message: string, type: StatusType): void {
  clearTimeout(hideTimers.get(target));
  target.textContent = message;
  target.className = `status visible ${type}`;
  if (type === 'success')
    hideTimers.set(
      target,
      setTimeout(() => clearStatus(target), 3000),
    );
  else hideTimers.delete(target);
}

export function showStatus(message: string, type: StatusType): void {
  show(elements.status, message, type);
}

export function showReceiveStatus(message: string, type: StatusType): void {
  show(elements.receiveActionStatus, message, type);
}

export function showSettingsStatus(message: string, type: StatusType): void {
  show(elements.settingsStatus, message, type);
}

/** Space kept between a tooltip and its element, and between a tooltip and the window's edges */
const TOOLTIP_GAP = 8;

/**
 * Where a tooltip goes: centred over its element, or under it when there is no room above, and moved
 * sideways to stay within the window (from its left edge first, when the tooltip is wider than the window).
 */
function tooltipPosition(anchor: DOMRect, box: DOMRect): { top: number; left: number } {
  const above = anchor.top - box.height - TOOLTIP_GAP;
  const centred = anchor.left + (anchor.width - box.width) / 2;
  return {
    top: above >= 0 ? above : anchor.bottom + TOOLTIP_GAP,
    left: centred < TOOLTIP_GAP ? TOOLTIP_GAP : Math.min(centred, window.innerWidth - box.width - TOOLTIP_GAP),
  };
}

/** How long the pointer rests on an element before its tooltip shows */
const TOOLTIP_DELAY = 1000;

/** Moves an element's title to data-tooltip, so the browser's own tooltip doesn't show as well; returns the text */
function adoptTitle(element: HTMLElement): string | null {
  const title = element.getAttribute('title');
  if (title !== null) {
    element.removeAttribute('title');
    element.setAttribute('data-tooltip', title);
  }
  return element.getAttribute('data-tooltip');
}

/** Custom tooltips after 1 s: an element's title moves to data-tooltip to suppress the native one */
export function setupTooltips(): void {
  const tooltip = elements.tooltip;
  // The element under the pointer, and the timer that will show its tooltip
  let hovered: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function dismiss(): void {
    clearTimeout(timer);
    tooltip.classList.remove('visible');
    hovered = null;
  }

  function show(element: HTMLElement, text: string): void {
    if (!element.isConnected) return;
    tooltip.textContent = text;
    tooltip.classList.add('visible');
    const { top, left } = tooltipPosition(element.getBoundingClientRect(), tooltip.getBoundingClientRect());
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  document.addEventListener('mouseover', ({ target }) => {
    const element = (target as Element).closest<HTMLElement>('[title], [data-tooltip]');
    if (hovered) {
      // Moving within the same element keeps its timer running
      if (element === hovered) return;
      dismiss();
    }
    const text = element && adoptTitle(element);
    if (!element || !text) return;
    hovered = element;
    timer = setTimeout(() => {
      if (hovered === element) show(element, text);
    }, TOOLTIP_DELAY);
  });

  document.addEventListener('mouseout', ({ target, relatedTarget }) => {
    if (!hovered) return;
    const from = target as Element;
    const leavesHovered = from === hovered || from.closest('[data-tooltip]') === hovered;
    // Moving onto a child of the element doesn't count as leaving it
    if (leavesHovered && !(relatedTarget instanceof Node && hovered.contains(relatedTarget))) dismiss();
  });
}

/** The tag or topic badge being dragged: its kind and position, or null while nothing is */
let dragged: { type: string; index: number } | null = null;

/** Make a badge draggable; onMove(from, to) is called when it is dropped on another badge of the same type */
export function setupDragAndDrop(element: HTMLElement, index: number, type: string, onMove: (from: number, to: number) => void): void {
  // A badge takes a drop only from another badge of its own kind
  const takes = (source: typeof dragged): source is { type: string; index: number } =>
    source !== null && source.type === type && source.index !== index;
  const unmark = () => element.classList.remove('drag-over');

  element.draggable = true;
  element.addEventListener('dragstart', ({ dataTransfer }) => {
    dragged = { type, index };
    element.classList.add('dragging');
    dataTransfer?.setData('text/plain', String(index));
    if (dataTransfer) dataTransfer.effectAllowed = 'move';
  });
  // Dropping is allowed only where dragover's default is prevented
  element.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });
  element.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (takes(dragged)) element.classList.add('drag-over');
  });
  element.addEventListener('dragleave', unmark);
  element.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    unmark();
    // The badges are drawn again after a move, so dragend may never come: forget the drag here as well
    const source = dragged;
    dragged = null;
    if (takes(source)) onMove(source.index, index);
  });
  element.addEventListener('dragend', () => {
    element.classList.remove('dragging', 'drag-over');
    dragged = null;
  });
}

/** Move an item of an array in place (remove, then insert at the target index) */
export function moveItem<T>(items: T[], from: number, to: number): void {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) return;
  const [item] = items.splice(from, 1);
  if (item !== undefined) {
    items.splice(to, 0, item);
  }
}
