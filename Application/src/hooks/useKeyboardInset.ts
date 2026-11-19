import { useEffect, useState } from 'react';

/**
 * Keeps form fields reachable while the on-screen keyboard is open.
 *
 * - If the WebView is NOT resized by the keyboard (Android edge-to-edge / iOS), the keyboard covers
 *   the bottom of the page and the scroll container has no room to scroll the last fields up.
 *   We measure the covered height with window.visualViewport and return it so the container can add
 *   that much bottom padding.
 * - When a text field gets focus, it is scrolled to the middle of the visible area.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => {
      if (!vv) return;
      const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setInset(covered > 80 ? covered : 0); // ignore small toolbar changes
    };

    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return;
      // wait for the keyboard animation, then bring the field into view
      window.setTimeout(() => {
        if (document.activeElement === el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 320);
    };

    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    document.addEventListener('focusin', onFocusIn);
    update();
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  return inset;
}
