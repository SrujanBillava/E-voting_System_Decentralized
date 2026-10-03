import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * On client-side navigation (the pathname actually CHANGED): set the document title and move focus to <main>, so keyboard and
 * screen-reader users start at the new page. Comparing with the previous pathname (instead of "skip the first run") keeps the
 * initial page load untouched even when React StrictMode runs the effect twice in development.
 */
export function useRouteFocus(suffix: string) {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const main = document.getElementById("main");
    main?.focus({ preventScroll: false });
    window.scrollTo({ top: 0 });
    const h1 = main?.querySelector("h1")?.textContent?.trim();
    document.title = h1 ? `${h1} · ${suffix}` : suffix;
  }, [pathname, suffix]);
}

/** Per-page title; call from each page component. */
export function usePageTitle(title: string, suffix = "VoteChain") {
  useEffect(() => {
    document.title = `${title} · ${suffix}`;
  }, [title, suffix]);
}
