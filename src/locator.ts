import type { Locator, Page } from "playwright";

export interface ElementTarget {
  /** ARIA role, e.g. "button", "link", "textbox". Combine with `name` for best precision. */
  role?: string;
  /** Accessible name, used together with `role`. */
  name?: string;
  /** Visible text to match, when role isn't known. */
  text?: string;
  /** Raw CSS selector, as a last resort. */
  selector?: string;
}

export function resolveLocator(page: Page, target: ElementTarget): Locator {
  if (target.role) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return page.getByRole(target.role as any, target.name ? { name: target.name } : undefined);
  }
  if (target.text) {
    return page.getByText(target.text, { exact: false });
  }
  if (target.selector) {
    return page.locator(target.selector);
  }
  throw new Error("Provide at least one of: role (+name), text, or selector to locate the element.");
}

export interface ElementDescription {
  tag: string;
  label: string;
  selector: string;
}

// Runs in-page: read tag/label/selector for whatever element the locator
// resolved to, so the event we log carries the same fields the Chrome
// extension already captures from real DOM clicks (elementTag,
// elementLabel, elementSelector).
export async function describeElement(locator: Locator): Promise<ElementDescription> {
  return locator.evaluate((el: Element) => {
    function cssSelector(node: Element): string {
      if (node.id) return `#${node.id}`;
      const path: string[] = [];
      let cur: Element | null = node;
      while (cur && cur.nodeType === 1 && path.length < 6) {
        let part = cur.tagName.toLowerCase();
        if (typeof cur.className === "string" && cur.className.trim()) {
          const cls = cur.className.trim().split(/\s+/).slice(0, 2).join(".");
          if (cls) part += `.${cls}`;
        }
        const parent: Element | null = cur.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
          if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
        }
        path.unshift(part);
        cur = parent;
      }
      return path.join(" > ");
    }

    const label =
      el.getAttribute("aria-label") ||
      (el as HTMLElement).innerText?.trim().slice(0, 80) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.tagName.toLowerCase();

    return { tag: el.tagName.toLowerCase(), label, selector: cssSelector(el) };
  });
}

const DESTRUCTIVE_PATTERNS = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bapagar\b/i,
  /\beliminar\b/i,
  /\bpay\b/i,
  /\bpagar\b/i,
  /\bpurchase\b/i,
  /\bcomprar\b/i,
  /\bcheckout\b/i,
  /\bconfirm\b/i,
  /\bconfirmar\b/i,
  /\bplace order\b/i,
  /\bsubmit order\b/i,
  /\bcancel subscription\b/i,
  /\bunsubscribe\b/i,
];

export function isDestructiveLabel(label: string | undefined | null): boolean {
  if (!label) return false;
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(label));
}

const SANDBOX_HINTS = ["localhost", "127.0.0.1", ".local", "staging", "sandbox", "preview", "dev.", "test."];

// Soft signal only — used to warn, never to block. There's no reliable way
// to know a URL is "production" from its hostname alone.
export function looksLikeSandbox(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return SANDBOX_HINTS.some((hint) => h.includes(hint));
}
