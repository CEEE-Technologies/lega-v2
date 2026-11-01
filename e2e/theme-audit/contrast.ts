import type { Page } from "@playwright/test";

export interface ContrastIssue {
  path: string;
  text: string;
  color: string;
  background: string;
  ratio: number;
}

/**
 * Finds visible text whose colour is too close to the background it sits on
 * (WCAG contrast below `minRatio`). Backgrounds are composited up the
 * ancestor chain; text over images or gradients is skipped.
 */
export async function findLowContrastText(
  page: Page,
  minRatio = 2,
): Promise<ContrastIssue[]> {
  return page.evaluate((minRatio) => {
    type RGBA = [number, number, number, number];

    const parse = (value: string): RGBA | null => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    };
    const over = (top: RGBA, bottom: RGBA): RGBA => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i: number) =>
        (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    const luminance = ([r, g, b]: RGBA) => {
      const ch = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const contrast = (a: RGBA, b: RGBA) => {
      const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (l1 + 0.05) / (l2 + 0.05);
    };

    const backgroundOf = (el: Element | null): RGBA | "skip" => {
      const layers: RGBA[] = [];
      let node: Element | null = el;
      while (node) {
        const style = getComputedStyle(node);
        if (style.backgroundImage && style.backgroundImage !== "none") {
          return "skip";
        }
        const bg = parse(style.backgroundColor);
        if (bg && bg[3] > 0) {
          layers.push(bg);
          if (bg[3] >= 1) break;
        }
        node = node.parentElement;
      }
      let result: RGBA = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) {
        result = over(layers[i], result);
      }
      return result;
    };

    const describe = (el: Element) => {
      const parts: string[] = [];
      let node: Element | null = el;
      for (let depth = 0; node && depth < 4; depth++) {
        const cls = Array.from(node.classList)
          .filter((c) => !/^(css|sc)-/.test(c))
          .slice(0, 2)
          .join(".");
        parts.unshift(node.tagName.toLowerCase() + (cls ? `.${cls}` : ""));
        node = node.parentElement;
      }
      return parts.join(" > ");
    };

    const issues: any[] = [];
    const seen = new Set<string>();
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text;
      const text = (textNode.textContent || "").trim();
      if (!text) continue;
      const el = textNode.parentElement;
      if (!el || el.closest('script,style,noscript,svg,[aria-hidden="true"]'))
        continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.bottom < 0 || rect.top > innerHeight) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      // Skip elements faded on purpose (disabled controls, etc).
      let opacity = 1;
      for (let n: Element | null = el; n; n = n.parentElement) {
        opacity *= Number(getComputedStyle(n).opacity);
      }
      if (opacity < 0.6) continue;
      if (el.closest(".bp4-disabled,[disabled]")) continue;

      const bg = backgroundOf(el);
      if (bg === "skip") continue;
      const fg = parse(style.color);
      if (!fg) continue;
      const ratio = contrast(over(fg, bg), bg);
      if (ratio < minRatio) {
        const key = describe(el) + "|" + text.slice(0, 30);
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({
          path: describe(el),
          text: text.slice(0, 60),
          color: style.color,
          background: `rgb(${bg.slice(0, 3).map(Math.round).join(", ")})`,
          ratio: Math.round(ratio * 100) / 100,
        });
      }
    }
    return issues;
  }, minRatio);
}

export interface SurfaceIssue {
  path: string;
  background: string;
  size: string;
}

/**
 * Finds large panels painted for the other theme: dark panels in light mode
 * or light panels in dark mode. The navigation sidebar is always dark.
 */
export async function findWrongThemeSurfaces(
  page: Page,
  theme: "light" | "dark",
): Promise<SurfaceIssue[]> {
  return page.evaluate((theme) => {
    const issues: any[] = [];
    const lum = (r: number, g: number, b: number) => {
      const ch = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const describe = (el: Element) => {
      const parts: string[] = [];
      let node: Element | null = el;
      for (let depth = 0; node && depth < 4; depth++) {
        const cls = Array.from(node.classList)
          .filter((c) => !/^(css|sc)-/.test(c))
          .slice(0, 2)
          .join(".");
        parts.unshift(node.tagName.toLowerCase() + (cls ? `.${cls}` : ""));
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (
        el.closest(
          '.sidebar,.workspaces-sidebar,[class*="WorkspacesSidebar"],.bp4-button,.bp4-tag,.avatar,.bp4-tooltip,.bp4-popover-arrow,.setup-page__left-section,.bp4-progress-bar,svg',
        )
      )
        continue;
      const rect = el.getBoundingClientRect();
      if (rect.width * rect.height < 30_000 || rect.width < 120) continue;
      if (rect.bottom < 0 || rect.top > innerHeight) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const m = style.backgroundColor.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const [r, g, b, a = 1] = m[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      if (a < 0.9) continue;
      const l = lum(r, g, b);
      const wrong = theme === "light" ? l < 0.15 : l > 0.6;
      if (wrong) {
        issues.push({
          path: describe(el),
          background: style.backgroundColor,
          size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        });
      }
    }
    return issues;
  }, theme);
}
