const COMPOSER_CHROME_INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "wa-dropdown",
  "[contenteditable='true']",
  "[role='button']",
  "[role='listbox']",
  "[role='option']",
].join(",");

type ComposerTextareaResizeObserverState = {
  observer: ResizeObserver;
  adjustmentFrame: number | null;
};

type ComposerPopoverAnchorObserverState = {
  resizeObserver: ResizeObserver | null;
  toggleObserver: MutationObserver | null;
  viewport: VisualViewport | null;
  updateFrame: number | null;
  scheduleUpdate: () => void;
};

const composerTextareaResizeObservers = new WeakMap<
  HTMLTextAreaElement,
  ComposerTextareaResizeObserverState
>();
const composerPopoverAnchorObservers = new WeakMap<
  HTMLElement,
  ComposerPopoverAnchorObserverState
>();

const COMPOSER_POPOVER_GAP_PX = 6;
// max-height constrains the menu's scrollable box before its border/padding;
// include that chrome so the outer panel retains a viewport gutter.
const COMPOSER_POPOVER_VIEWPORT_INSET_PX = 28;

function updateComposerPopoverAnchor(el: HTMLElement) {
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const layoutViewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const composerTop = el.getBoundingClientRect().top;
  const bottom = layoutViewportHeight - composerTop + COMPOSER_POPOVER_GAP_PX;
  const maxHeight = composerTop - viewportTop - COMPOSER_POPOVER_VIEWPORT_INSET_PX;
  el.style.setProperty("--chat-composer-popover-bottom", `${Math.max(0, bottom)}px`);
  el.style.setProperty("--chat-composer-popover-max-height", `${Math.max(0, maxHeight)}px`);
}

function observeComposerPopoverAnchor(el: HTMLElement) {
  if (composerPopoverAnchorObservers.has(el)) {
    return;
  }
  const viewport = window.visualViewport;
  const state: ComposerPopoverAnchorObserverState = {
    resizeObserver: null,
    toggleObserver: null,
    viewport,
    updateFrame: null,
    scheduleUpdate: () => {
      if (state.updateFrame !== null) {
        return;
      }
      state.updateFrame = requestAnimationFrame(() => {
        state.updateFrame = null;
        if (composerPopoverAnchorObservers.get(el) === state) {
          updateComposerPopoverAnchor(el);
        }
      });
    },
  };
  if (typeof ResizeObserver === "function") {
    state.resizeObserver = new ResizeObserver(state.scheduleUpdate);
    state.resizeObserver.observe(el);
  }
  if (typeof MutationObserver === "function") {
    state.toggleObserver = new MutationObserver(state.scheduleUpdate);
    state.toggleObserver.observe(el, {
      attributes: true,
      attributeFilter: ["open"],
      subtree: true,
    });
  }
  window.addEventListener("resize", state.scheduleUpdate);
  viewport?.addEventListener("resize", state.scheduleUpdate);
  viewport?.addEventListener("scroll", state.scheduleUpdate);
  composerPopoverAnchorObservers.set(el, state);
  updateComposerPopoverAnchor(el);
}

export function disconnectComposerPopoverAnchorObserver(el: HTMLElement) {
  const state = composerPopoverAnchorObservers.get(el);
  composerPopoverAnchorObservers.delete(el);
  if (!state) {
    return;
  }
  state.resizeObserver?.disconnect();
  state.toggleObserver?.disconnect();
  window.removeEventListener("resize", state.scheduleUpdate);
  state.viewport?.removeEventListener("resize", state.scheduleUpdate);
  state.viewport?.removeEventListener("scroll", state.scheduleUpdate);
  if (state.updateFrame !== null) {
    cancelAnimationFrame(state.updateFrame);
  }
}

export function replaceComposerPopoverAnchor(
  previous: HTMLElement | null,
  element?: Element,
): HTMLElement | null {
  const next = element instanceof HTMLElement ? element : null;
  if (previous && previous !== next) {
    disconnectComposerPopoverAnchorObserver(previous);
  }
  if (next) {
    observeComposerPopoverAnchor(next);
  }
  return next;
}

function updateTextareaOverflow(el: HTMLTextAreaElement) {
  el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
}

// Slack the one-line budget keeps in hand. It covers the surface padding and the
// gaps between the footer groups — deliberately not read from CSS, so the layout
// owner needs no copy of the stylesheet's geometry — plus enough room that the
// caret never sits flush against the first control.
const COMPOSER_SINGLE_LINE_RESERVE_PX = 32;
// Collapsing back to one line must not chase the character that caused the last
// expansion, so the wider layout is held briefly. Expansion is never delayed:
// text that no longer fits has to wrap in the same frame it stops fitting.
const COMPOSER_LAYOUT_COLLAPSE_LOCK_MS = 150;

const composerLayoutCollapseLocks = new WeakMap<HTMLElement, number>();

let composerTextMetricsContext: CanvasRenderingContext2D | null | undefined;

function measureComposerTextWidth(el: HTMLTextAreaElement, text: string): number | null {
  composerTextMetricsContext ??= document.createElement("canvas").getContext("2d");
  if (!composerTextMetricsContext) {
    return null;
  }
  const style = getComputedStyle(el);
  composerTextMetricsContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return composerTextMetricsContext.measureText(text).width;
}

// Distance from the first to the last laid-out child, so a group stretched by a
// grid fr track still reports what it actually occupies rather than its column.
function composerGroupContentWidth(group: Element | null): number {
  if (!(group instanceof HTMLElement)) {
    return 0;
  }
  const laidOut = [...group.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.offsetWidth > 0,
  );
  const first = laidOut[0];
  const last = laidOut.at(-1);
  if (!first || !last) {
    return 0;
  }
  return last.getBoundingClientRect().right - first.getBoundingClientRect().left;
}

function composerFitsOneLine(
  surface: HTMLElement,
  lede: HTMLElement,
  el: HTMLTextAreaElement,
): boolean {
  const draft = el.value;
  if (draft.includes("\n")) {
    return false;
  }
  // Anything docked above the editor — attachments, reply preview, dictation,
  // camera, run status — owns the vertical layout outright.
  if (lede.offsetHeight > 0) {
    return false;
  }
  // An empty composer still has to earn the compact shape: on a narrow viewport
  // the footer groups alone can leave no room for a caret, and collapsing there
  // would squeeze the editor to nothing.
  const textWidth = draft === "" ? 0 : measureComposerTextWidth(el, draft);
  if (textWidth === null) {
    return false;
  }
  const budget =
    surface.clientWidth -
    composerGroupContentWidth(surface.querySelector(".agent-chat__composer-lead")) -
    composerGroupContentWidth(surface.querySelector(".agent-chat__composer-mid")) -
    composerGroupContentWidth(surface.querySelector(".agent-chat__composer-trail"));
  return textWidth + COMPOSER_SINGLE_LINE_RESERVE_PX <= budget;
}

/**
 * Records which shape the composer is in. The surface is the single owner of
 * that fact: CSS reads the attribute for every height, radius and flow rule, so
 * nothing downstream has to re-derive "is this composer one line or many".
 */
export function updateComposerLayout(el: HTMLTextAreaElement): "single-line" | "multiline" {
  const surface = el.closest<HTMLElement>(".agent-chat__input");
  const lede = surface?.querySelector<HTMLElement>(".agent-chat__composer-lede");
  // A surface with no lede region has not declared what can dock above its
  // editor, so the first question this function asks — "is anything stacked on
  // top of the text?" — has no answer there. Those composers keep the plain
  // measured growth instead of being collapsed on a guess.
  if (!surface || !lede) {
    return "multiline";
  }
  const current = surface.dataset.composerLayout === "single-line" ? "single-line" : "multiline";
  const next = composerFitsOneLine(surface, lede, el) ? "single-line" : "multiline";
  if (next === current) {
    return current;
  }
  const now = performance.now();
  if (next === "single-line" && now < (composerLayoutCollapseLocks.get(surface) ?? 0)) {
    return current;
  }
  composerLayoutCollapseLocks.set(surface, now + COMPOSER_LAYOUT_COLLAPSE_LOCK_MS);
  surface.dataset.composerLayout = next;
  return next;
}

export function adjustTextareaHeight(el: HTMLTextAreaElement) {
  if (updateComposerLayout(el) === "single-line") {
    // The single-line shape is a fixed CSS box; leaving an inline height behind
    // would keep the surface at whatever the multiline pass last measured.
    el.style.height = "";
    el.style.overflowY = "";
    return;
  }
  // Hide the browser's scrollbar while measuring; restore it only when the
  // final CSS-constrained height actually clips the draft.
  el.style.overflowY = "hidden";
  el.style.height = "auto";
  // The owning surface declares its cap in CSS. Retain the historical fallback
  // for detached/test controls whose computed max-height is not a pixel value.
  const computedMaxHeight = getComputedStyle(el).maxHeight.trim();
  const pixelMaxHeight = /^(\d+(?:\.\d+)?)px$/u.exec(computedMaxHeight);
  const maxHeight = pixelMaxHeight ? Number(pixelMaxHeight[1]) : 150;
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  updateTextareaOverflow(el);
}

export function observeTextareaOverflow(el: HTMLTextAreaElement) {
  if (typeof ResizeObserver !== "function" || composerTextareaResizeObservers.has(el)) {
    return;
  }
  let width = el.getBoundingClientRect().width;
  const observer = new ResizeObserver(() => {
    const nextWidth = el.getBoundingClientRect().width;
    if (nextWidth !== width) {
      width = nextWidth;
      const state = composerTextareaResizeObservers.get(el);
      if (state && state.adjustmentFrame === null) {
        state.adjustmentFrame = requestAnimationFrame(() => {
          state.adjustmentFrame = null;
          if (composerTextareaResizeObservers.get(el) === state) {
            adjustTextareaHeight(el);
          }
        });
      }
      return;
    }
    updateTextareaOverflow(el);
  });
  observer.observe(el);
  composerTextareaResizeObservers.set(el, { observer, adjustmentFrame: null });
}

export function disconnectTextareaOverflowObserver(el: HTMLTextAreaElement) {
  const state = composerTextareaResizeObservers.get(el);
  composerTextareaResizeObservers.delete(el);
  if (!state) {
    return;
  }
  state.observer.disconnect();
  if (state.adjustmentFrame !== null) {
    cancelAnimationFrame(state.adjustmentFrame);
  }
}

export function scheduleTextareaHeightAdjustment(el: HTMLTextAreaElement) {
  // Lit invokes ref callbacks before the textarea is connected and before its
  // controlled value is committed, so measure once the render has settled.
  queueMicrotask(() => {
    if (el.isConnected) {
      adjustTextareaHeight(el);
    }
  });
}

export function focusComposerFromChrome(event: MouseEvent | PointerEvent, connected: boolean) {
  if (event.defaultPrevented) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (event.type === "pointerdown") {
    // Cancel only pointer focus; click and popover-owned focus still run.
    if (
      event.button === 0 &&
      target.closest("summary, wa-dropdown>[slot='trigger'], .agent-chat__session-overrides-open")
    ) {
      event.preventDefault();
    }
    return;
  }
  if (!connected) {
    return;
  }
  if (target.closest(COMPOSER_CHROME_INTERACTIVE_SELECTOR)) {
    return;
  }
  const currentTarget = event.currentTarget;
  if (!(currentTarget instanceof HTMLElement)) {
    return;
  }
  currentTarget
    .querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
    ?.focus({ preventScroll: true });
}

export function preserveComposerFocusOnPrimaryAction(
  event: PointerEvent,
  textarea: HTMLTextAreaElement | null,
): void {
  const composerShell = textarea?.closest<HTMLElement>(".agent-chat__composer-shell");
  if (
    document.activeElement === textarea &&
    composerShell &&
    Number.parseFloat(getComputedStyle(composerShell).marginBottom) === 0
  ) {
    event.preventDefault();
  }
}

export function restoreHistoryCaret(target: HTMLTextAreaElement, direction: "up" | "down") {
  requestAnimationFrame(() => {
    if (document.activeElement !== target) {
      return;
    }
    adjustTextareaHeight(target);
    const caret = direction === "up" ? 0 : target.value.length;
    target.selectionStart = caret;
    target.selectionEnd = caret;
  });
}

// Shared by the slash and skill composer menus, which resolve their own
// active-option id but scroll the same ".slash-menu__scroll" viewport shape.
export function scrollActiveMenuOptionIntoView(activeId: string | null): void {
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    const activeOption = document.getElementById(activeId);
    const scrollRegion = activeOption?.closest<HTMLElement>(".slash-menu__scroll");
    if (!activeOption || !scrollRegion) {
      return;
    }
    const menuBounds = scrollRegion.getBoundingClientRect();
    const optionBounds = activeOption.getBoundingClientRect();
    // scrollIntoView also moves the short-landscape composer and page. Keep
    // keyboard navigation owned by the menu so textarea focus stays stable.
    if (optionBounds.top < menuBounds.top) {
      scrollRegion.scrollTop -= menuBounds.top - optionBounds.top;
    } else if (optionBounds.bottom > menuBounds.bottom) {
      scrollRegion.scrollTop += optionBounds.bottom - menuBounds.bottom;
    }
  });
}
