import React, { useId } from 'react'
import { formatFileSize, getDiskHealthStyle } from '../../utils/format'

interface DiskSpaceRingProps {
  driveLabel: string
  freeBytes: number | null
  totalBytes: number | null
  size?: number
  active?: boolean
}

export const DiskSpaceRing: React.FC<DiskSpaceRingProps> = ({
  driveLabel,
  freeBytes,
  totalBytes,
  size = 36,
  active = false,
}) => {
  const rawId = useId()
  const gradientId = `disk-ring-${rawId.replace(/:/g, '')}`

  const strokeWidth = 2.5
  const center = size / 2
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius

  const usedPercent =
    freeBytes != null && totalBytes != null && totalBytes > 0
      ? Math.min(100, Math.max(0, ((totalBytes - freeBytes) / totalBytes) * 100))
      : null
  const displayPercent = usedPercent != null ? (usedPercent > 0 ? Math.max(2, usedPercent) : 0) : null

  const { level } = getDiskHealthStyle(freeBytes)
  const labelText = (driveLabel || '').trim().slice(0, 3) || '•'

  const labelColorClass = active
    ? 'text-rose-200'
    : level === 'low'
    ? 'text-amber-200'
    : level === 'critical'
    ? 'text-rose-300'
    : 'text-zinc-200'

  const gradientStops =
    level === 'low'
      ? ['#D97706', '#F59E0B', '#FCD34D']
      : level === 'critical'
      ? ['#B81450', '#FF1E6D', '#FB7185']
      : ['#B81450', '#FF1E6D', '#FF85AE']

  const tooltip =
    usedPercent != null && freeBytes != null && totalBytes != null
      ? `${Math.round(usedPercent)}% used · ${formatFileSize(freeBytes)} free of ${formatFileSize(totalBytes)}`
      : 'Disk space unavailable'

  return (
    <div
      title={tooltip}
      style={{ width: size, height: size }}
      className="relative inline-flex shrink-0 items-center justify-center rounded-full select-none"
    >
      <div
        className={`absolute inset-[3px] rounded-full transition-colors ${
          active ? 'bg-rose-500/[0.12]' : 'bg-white/[0.03]'
        }`}
      />
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        aria-hidden="true"
        className={`absolute inset-0 -rotate-90 ${
          level === 'critical' ? 'drop-shadow-[0_0_5px_rgba(255,30,109,0.55)]' : ''
        }`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={gradientStops[0]} />
            <stop offset="55%" stopColor={gradientStops[1]} />
            <stop offset="100%" stopColor={gradientStops[2]} />
          </linearGradient>
        </defs>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="rgba(255, 255, 255, 0.08)"
          strokeWidth={strokeWidth}
        />
        {displayPercent != null && (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - displayPercent / 100)}
            className="transition-[stroke-dashoffset] duration-500 ease-out"
          />
        )}
      </svg>
      <span className={`relative font-mono text-[10px] font-semibold leading-none tracking-tight ${labelColorClass}`}>
        {labelText}
      </span>
    </div>
  )
}
