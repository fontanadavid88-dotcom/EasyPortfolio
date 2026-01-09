import { useEffect, useRef, useState } from 'react';

type Size = { widthPx: number; heightPx: number };

export const useElementSize = <T extends HTMLElement>() => {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>({ widthPx: 0, heightPx: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const resize = () => {
      setSize({
        widthPx: el.clientWidth,
        heightPx: el.clientHeight
      });
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, ...size };
};
