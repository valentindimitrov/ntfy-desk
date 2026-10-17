// Small UI helpers: status lines, tooltips, drag-and-drop reordering of badges, debounce.

import { elements } from './state';

export type StatusType = 'success' | 'error' | 'warning';

function show(target: HTMLElement, message: string, type: StatusType): void {
  target.textContent = message;
  target.className = `status visible ${type}`;
  setTimeout(() => target.classList.remove('visible'), 3000);
}

export function showStatus(message: string, type: StatusType): void {
  show(elements.status, message, type);
}

export function showSettingsStatus(message: string, type: StatusType): void {
  show(elements.settingsStatus, message, type);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number): (...args: A) => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

/** Custom tooltips after 1 s: an element's title moves to data-tooltip to suppress the native one */
export function setupTooltips(): void {
  const tooltip = elements.tooltip;
  let activeElement: HTMLElement | null = null;
  let tooltipTimeout: ReturnType<typeof setTimeout> | undefined;

  function hideTooltip(): void {
    tooltip.classList.remove('visible');
    activeElement = null;
  }

  function showTooltip(element: HTMLElement, text: string): void {
    if (!element.isConnected) return;

    tooltip.textContent = text;
    tooltip.classList.add('visible');

    const rect = element.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const margin = 8;

    // Above and centred; below if there's no room above; kept inside the window
    let top = rect.top - tooltipRect.height - margin;
    let left = rect.left + (rect.width - tooltipRect.width) / 2;
    if (top < 0) {
      top = rect.bottom + margin;
    }
    if (left < margin) {
      left = margin;
    } else if (left + tooltipRect.width > window.innerWidth - margin) {
      left = window.innerWidth - tooltipRect.width - margin;
    }

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  document.addEventListener('mouseover', (event) => {
    const target = (event.target as Element).closest<HTMLElement>('[title], [data-tooltip]');
    // Still on the same element: keep the timer
    if (activeElement && target === activeElement) {
      return;
    }
    if (activeElement) {
      clearTimeout(tooltipTimeout);
      hideTooltip();
    }
    if (!target) {
      return;
    }

    const title = target.getAttribute('title');
    if (title !== null) {
      target.setAttribute('data-tooltip', title);
      target.removeAttribute('title');
    }
    const text = target.getAttribute('data-tooltip');
    if (!text) return;

    activeElement = target;
    tooltipTimeout = setTimeout(() => {
      if (activeElement === target) {
        showTooltip(target, text);
      }
    }, 1000);
  });

  document.addEventListener('mouseout', (event) => {
    const target = event.target as Element;
    if (activeElement && (target === activeElement || target.closest('[data-tooltip]') === activeElement)) {
      // Moving to a child of the element doesn't leave it
      if (event.relatedTarget instanceof Node && activeElement.contains(event.relatedTarget)) {
        return;
      }
      clearTimeout(tooltipTimeout);
      hideTooltip();
    }
  });
}

// Drag-and-drop reordering of tag and topic badges
let dragSrcIndex: number | null = null;
let dragType: string | null = null;

/** Make a badge draggable; onMove(from, to) is called when it is dropped on another badge of the same type */
export function setupDragAndDrop(element: HTMLElement, index: number, type: string, onMove: (from: number, to: number) => void): void {
  element.draggable = true;

  element.addEventListener('dragstart', (event) => {
    dragSrcIndex = index;
    dragType = type;
    element.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
  });

  element.addEventListener('dragend', () => {
    element.classList.remove('dragging', 'drag-over');
    dragSrcIndex = null;
    dragType = null;
  });

  element.addEventListener('dragover', (event) => {
    event.preventDefault(); // allows dropping
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  });

  element.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (dragType === type && dragSrcIndex !== index) {
      element.classList.add('drag-over');
    }
  });

  element.addEventListener('dragleave', () => element.classList.remove('drag-over'));

  element.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('drag-over');

    // The badges are re-rendered, so dragend may not fire: reset here too
    const from = dragSrcIndex;
    const sameType = dragType === type;
    dragSrcIndex = null;
    dragType = null;
    if (sameType && from !== null && from !== index) {
      onMove(from, index);
    }
  });
}

/** Move an item of an array in place (remove, then insert at the target index) */
export function moveItem<T>(items: T[], from: number, to: number): void {
  const [item] = items.splice(from, 1);
  if (item !== undefined) {
    items.splice(to, 0, item);
  }
}
