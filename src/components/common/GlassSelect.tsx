import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface GlassSelectOption {
  value: string;
  label: string;
}

interface GlassSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: GlassSelectOption[];
  disabled?: boolean;
  /** Extra classes for the trigger button (sizing / width per call site). */
  className?: string;
  /** Extra classes for the popover menu (e.g. min-width). */
  menuClassName?: string;
  ariaLabel?: string;
  title?: string;
  /** Optional leading icon rendered inside the trigger. */
  leadingIcon?: React.ReactNode;
  /** Hide the selected label in the trigger (icon-only trigger). */
  hideLabel?: boolean;
}

/**
 * Glassmorphic popover select. Replaces native <select> elements (which pick
 * up Windows blue highlight chrome) with a blurred dark-plum menu, crimson
 * hover/active states and a scale+fade entrance.
 *
 * While the menu is open the root carries `data-select-menu-open="true"` so a
 * modal's own capture-phase Escape handler can yield to the menu (one Escape
 * press closes the menu, the next closes the modal).
 */
export const GlassSelect: React.FC<GlassSelectProps> = ({
  value,
  onChange,
  options,
  disabled = false,
  className = '',
  menuClassName = '',
  ariaLabel,
  title,
  leadingIcon,
  hideLabel = false,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);

  // Outside click + Escape dismissal (mutually exclusive with sibling panels).
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className ? '' : 'w-full'}`} data-select-menu-open={open ? 'true' : undefined}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title || selected?.label}
        onClick={() => setOpen((prev) => !prev)}
        className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 text-xs font-semibold text-zinc-200 outline-none transition-all ${
          open
            ? 'border-rose-400/50 bg-white/[0.08] ring-2 ring-rose-500/15'
            : 'border-white/[0.09] bg-[#0f0b15]/85 hover:border-white/[0.18] hover:bg-white/[0.05]'
        } ${disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'} ${className || 'h-10 w-full'}`}
      >
        {leadingIcon && <span className="pointer-events-none shrink-0 text-zinc-500">{leadingIcon}</span>}
        {!hideLabel && <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? value}</span>}
        <ChevronDown
          className={`pointer-events-none h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-200 ${open ? 'rotate-180 text-rose-300' : ''} ${disabled ? 'opacity-40' : ''}`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={`glass-dropdown animate-pop-in absolute left-0 top-full z-[90] mt-1.5 max-h-64 w-full min-w-[9rem] overflow-y-auto rounded-xl p-1 ${menuClassName}`}
        >
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors ${
                  isSelected ? 'bg-rose-500/15 text-rose-200' : 'text-zinc-300 hover:bg-rose-500/10 hover:text-white'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-rose-400" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
