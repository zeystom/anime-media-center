import React, { useEffect, useRef } from 'react'

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  onLongPress: () => void
  holdDelay?: number
}

/** A normal click keeps the configured behavior; holding opens manual search. */
export const DownloadActionButton: React.FC<Props> = ({
  onLongPress,
  holdDelay = 550,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onPointerCancel,
  onContextMenu,
  ...props
}) => {
  const timerRef = useRef<number | null>(null)
  const longPressFiredRef = useRef(false)

  const clearTimer = () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = null
  }

  useEffect(() => clearTimer, [])

  return (
    <button
      {...props}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        if (event.button !== 0 || props.disabled) return
        longPressFiredRef.current = false
        clearTimer()
        timerRef.current = window.setTimeout(() => {
          longPressFiredRef.current = true
          onLongPress()
        }, holdDelay)
      }}
      onPointerUp={(event) => { clearTimer(); onPointerUp?.(event) }}
      onPointerLeave={(event) => { clearTimer(); onPointerLeave?.(event) }}
      onPointerCancel={(event) => { clearTimer(); onPointerCancel?.(event) }}
      onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event) }}
      onClick={(event) => {
        if (longPressFiredRef.current) {
          event.preventDefault()
          event.stopPropagation()
          longPressFiredRef.current = false
          return
        }
        onClick?.(event)
      }}
    />
  )
}
