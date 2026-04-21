import React from 'react';

export function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <div
      className={`checkbox-container${checked ? ' is-enabled' : ''}`}
      aria-label={ariaLabel}
      aria-checked={checked}
      role="switch"
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onChange(!checked);
        }
      }}
    >
      <input type="checkbox" checked={checked} readOnly tabIndex={-1} style={{ display: 'none' }} />
    </div>
  );
}
