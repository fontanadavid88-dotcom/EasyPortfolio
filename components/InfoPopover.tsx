import React, { useEffect, useRef, useState } from 'react';

interface InfoPopoverProps {
  title: string;
  ariaLabel: string;
  renderContent: (close: () => void) => React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  popoverClassName?: string;
}

export const InfoPopover: React.FC<InfoPopoverProps> = ({ title, ariaLabel, renderContent, onOpenChange, popoverClassName }) => {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (!popoverRef.current || !buttonRef.current) return;
      if (!popoverRef.current.contains(e.target as Node) && !buttonRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        className="p-1.5 rounded-full text-slate-500 hover:text-slate-800 hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-primary transition"
        onClick={() => {
          setOpen(o => !o);
        }}
      >
        <span className="material-symbols-outlined text-[22px]">info</span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          className={`absolute right-0 mt-2 w-80 z-50 bg-white border border-borderSoft rounded-xl shadow-xl p-4 text-sm text-slate-800 ${popoverClassName || ''}`}
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="font-bold text-slate-900">{title}</div>
            <button
              type="button"
              className="text-slate-400 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-primary rounded"
              onClick={close}
              aria-label="Chiudi"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
          <div className="space-y-2">{renderContent(close)}</div>
        </div>
      )}
    </div>
  );
};
