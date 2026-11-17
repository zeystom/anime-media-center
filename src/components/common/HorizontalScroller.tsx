import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'

interface HorizontalScrollerProps {
  children: React.ReactNode
  className?: string
  label?: string
  onEngageScroll?: () => void
}

interface OverscrollState {
  side: 'left' | 'right' | null
  progress: number
  pullPx: number
  railShiftPx: number
}

const EMPTY_OVERSCROLL: OverscrollState = { side: null, progress: 0, pullPx: 0, railShiftPx: 0 }
const PULL_THRESHOLD = 110
const RING_RADIUS = 20
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const WHEEL_RELEASE_MS = 150
const WHEEL_COOLDOWN_MS = 450

function computeOverscrollState(side: 'left' | 'right', rawOverscroll: number, deadzone: number): OverscrollState {
  const effectivePull = Math.max(0, rawOverscroll - deadzone)
  const progress = Math.min(1, effectivePull / PULL_THRESHOLD)
  const pullPx = effectivePull > 0 ? Math.min(44, Math.pow(effectivePull, 0.72) * 1.45) : 0
  const railShiftPx = effectivePull > 0 ? Math.min(18, Math.pow(effectivePull, 0.65) * 0.75) : 0
  return { side, progress, pullPx, railShiftPx }
}

function wrapScrollToEdge(element: HTMLDivElement, side: 'left' | 'right') {
  const maxScroll = element.scrollWidth - element.clientWidth
  if (maxScroll <= 2) return
  element.scrollTo({ left: side === 'right' ? 0 : maxScroll, behavior: 'smooth' })
}

const HorizontalScrollerImpl: React.FC<HorizontalScrollerProps> = ({ children, className = '', label = 'Scrollable items', onEngageScroll }) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const engagedRef = useRef(false)
  const notifyEngage = useCallback(() => {
    if (engagedRef.current) return
    engagedRef.current = true
    onEngageScroll?.()
  }, [onEngageScroll])
  const dragRef = useRef<{ pointerId: number; startX: number; startScroll: number; moved: boolean } | null>(null)
  const overscrollRef = useRef<OverscrollState>(EMPTY_OVERSCROLL)
  const suppressClickRef = useRef(false)
  const pointerInsideRef = useRef(false)
  const edgeUpdateFrameRef = useRef<number | null>(null)
  const wheelPullRef = useRef(0)
  const wheelSideRef = useRef<'left' | 'right' | null>(null)
  const wheelStartedAtEdgeRef = useRef(false)
  const wheelActiveRef = useRef(false)
  const wheelReleaseTimerRef = useRef<number | null>(null)
  const wheelCooldownUntilRef = useRef(0)
  const [edges, setEdges] = useState({ left: false, right: false })
  const [dragging, setDragging] = useState(false)
  const [wheelPulling, setWheelPulling] = useState(false)
  const [overscroll, setOverscroll] = useState<OverscrollState>(EMPTY_OVERSCROLL)

  const updateOverscroll = useCallback((next: OverscrollState) => {
    const prev = overscrollRef.current
    if (
      prev.side === next.side &&
      (prev.progress >= 1) === (next.progress >= 1) &&
      (prev.progress === 0) === (next.progress === 0) &&
      Math.abs(prev.progress - next.progress) < 0.005 &&
      Math.abs(prev.pullPx - next.pullPx) < 0.2 &&
      Math.abs(prev.railShiftPx - next.railShiftPx) < 0.2
    ) {
      return
    }
    overscrollRef.current = next
    setOverscroll(next)
  }, [])

  const updateEdges = useCallback(() => {
    const element = scrollRef.current
    if (!element || !pointerInsideRef.current) {
      setEdges((previous) => previous.left || previous.right ? { left: false, right: false } : previous)
      return
    }
    const maxScroll = element.scrollWidth - element.clientWidth
    const canScroll = maxScroll > 2
    setEdges((previous) => previous.left === canScroll && previous.right === canScroll ? previous : { left: canScroll, right: canScroll })
  }, [])

  useEffect(() => {
    updateEdges()
  }, [children, updateEdges])

  const scheduleEdgeUpdate = useCallback(() => {
    if (edgeUpdateFrameRef.current != null) return
    edgeUpdateFrameRef.current = window.requestAnimationFrame(() => {
      edgeUpdateFrameRef.current = null
      updateEdges()
    })
  }, [updateEdges])

  const scrollByPage = (direction: -1 | 1) => {
    notifyEngage()
    const element = scrollRef.current
    if (!element) return
    const maxScroll = element.scrollWidth - element.clientWidth
    if (direction < 0 && element.scrollLeft <= 2 && maxScroll > 0) {
      element.scrollTo({ left: maxScroll, behavior: 'smooth' })
      return
    }
    if (direction > 0 && element.scrollLeft >= maxScroll - 2 && maxScroll > 0) {
      element.scrollTo({ left: 0, behavior: 'smooth' })
      return
    }
    element.scrollBy({ left: direction * Math.max(260, element.clientWidth * 0.72), behavior: 'smooth' })
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    notifyEngage()
    const element = scrollRef.current
    if (!element) return
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startScroll: element.scrollLeft, moved: false }
  }

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current
      const element = scrollRef.current
      if (drag && element && drag.pointerId === event.pointerId) {
        const delta = event.clientX - drag.startX
        if (!drag.moved && Math.abs(delta) > 5) {
          drag.moved = true
          setDragging(true)
        }
        if (drag.moved) {
          const maxScroll = element.scrollWidth - element.clientWidth
          const targetScroll = drag.startScroll - delta
          const clampedScroll = Math.max(0, Math.min(maxScroll, targetScroll))
          element.scrollLeft = clampedScroll

          if (maxScroll > 2 && (targetScroll > maxScroll || targetScroll < 0)) {
            const side: 'left' | 'right' = targetScroll > maxScroll ? 'right' : 'left'
            const rawOverscroll = side === 'right' ? targetScroll - maxScroll : -targetScroll
            const startedAtEdge = side === 'right' ? drag.startScroll >= maxScroll - 8 : drag.startScroll <= 8
            updateOverscroll(computeOverscrollState(side, rawOverscroll, startedAtEdge ? 10 : 32))
          } else {
            updateOverscroll(EMPTY_OVERSCROLL)
          }

          scheduleEdgeUpdate()
          event.preventDefault()
        }
      }
    }

    const endDrag = (event: PointerEvent) => {
      const drag = dragRef.current
      const element = scrollRef.current
      if (drag && drag.pointerId === event.pointerId) {
        const currentOverscroll = overscrollRef.current
        updateOverscroll(EMPTY_OVERSCROLL)

        if (event.type === 'pointerup' && currentOverscroll.progress >= 1 && currentOverscroll.side && element) {
          wrapScrollToEdge(element, currentOverscroll.side)
        }

        if (drag.moved) {
          suppressClickRef.current = true
          window.setTimeout(() => { suppressClickRef.current = false }, 120)
        }
        dragRef.current = null
        if (drag.moved) setDragging(false)
        scheduleEdgeUpdate()
      }
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      if (edgeUpdateFrameRef.current != null) window.cancelAnimationFrame(edgeUpdateFrameRef.current)
    }
  }, [scheduleEdgeUpdate, updateOverscroll])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const finishWheelGesture = () => {
      wheelReleaseTimerRef.current = null
      const currentOverscroll = overscrollRef.current
      wheelPullRef.current = 0
      wheelSideRef.current = null
      wheelActiveRef.current = false
      setWheelPulling(false)
      updateOverscroll(EMPTY_OVERSCROLL)

      if (currentOverscroll.progress >= 1 && currentOverscroll.side) {
        wheelCooldownUntilRef.current = Date.now() + WHEEL_COOLDOWN_MS
        wrapScrollToEdge(element, currentOverscroll.side)
      }
      scheduleEdgeUpdate()
    }

    const onWheel = (event: WheelEvent) => {
      if (dragRef.current) return
      const scale = event.deltaMode === 1 ? 16 : 1
      const rawDx = (event.deltaX * scale) || (event.shiftKey ? event.deltaY * scale : 0)
      const effectiveDy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY * scale
      if (Math.abs(rawDx) < 0.5 || Math.abs(rawDx) <= Math.abs(effectiveDy)) return
      notifyEngage()

      if (Date.now() < wheelCooldownUntilRef.current) {
        event.preventDefault()
        return
      }

      const maxScroll = element.scrollWidth - element.clientWidth
      if (maxScroll <= 2) return

      if (!wheelActiveRef.current) {
        wheelActiveRef.current = true
        wheelStartedAtEdgeRef.current =
          (rawDx > 0 && element.scrollLeft >= maxScroll - 2) ||
          (rawDx < 0 && element.scrollLeft <= 2)
      }

      const activeSide = wheelSideRef.current
      const deadzone = wheelStartedAtEdgeRef.current ? 8 : 30

      if (activeSide !== null && wheelPullRef.current > 0 && ((activeSide === 'right' && rawDx < 0) || (activeSide === 'left' && rawDx > 0))) {
        event.preventDefault()
        wheelPullRef.current = Math.max(0, wheelPullRef.current - Math.abs(rawDx) * 1.15)
        if (wheelPullRef.current > 0) {
          updateOverscroll(computeOverscrollState(activeSide, wheelPullRef.current, deadzone))
        } else {
          wheelSideRef.current = null
          setWheelPulling(false)
          updateOverscroll(EMPTY_OVERSCROLL)
        }
      } else {
        const atRightEdge = element.scrollLeft >= maxScroll - 2 && rawDx > 0
        const atLeftEdge = element.scrollLeft <= 2 && rawDx < 0
        if (atRightEdge || atLeftEdge) {
          event.preventDefault()
          const side: 'left' | 'right' = atRightEdge ? 'right' : 'left'
          if (wheelSideRef.current !== side) {
            wheelSideRef.current = side
            wheelPullRef.current = 0
          }
          wheelPullRef.current += Math.min(48, Math.abs(rawDx) * 1.15)
          setWheelPulling(true)
          updateOverscroll(computeOverscrollState(side, wheelPullRef.current, deadzone))
        }
      }

      if (wheelReleaseTimerRef.current == null || overscrollRef.current.progress < 1 || Math.abs(rawDx) >= 4) {
        if (wheelReleaseTimerRef.current != null) window.clearTimeout(wheelReleaseTimerRef.current)
        wheelReleaseTimerRef.current = window.setTimeout(finishWheelGesture, WHEEL_RELEASE_MS)
      }
    }

    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      if (wheelReleaseTimerRef.current != null) {
        window.clearTimeout(wheelReleaseTimerRef.current)
        wheelReleaseTimerRef.current = null
      }
    }
  }, [scheduleEdgeUpdate, updateOverscroll, notifyEngage])

  const isRightOverscroll = overscroll.side === 'right'
  const isOverscrollArmed = overscroll.progress >= 1
  const overscrollScale = isOverscrollArmed ? 1.1 : 0.55 + overscroll.progress * 0.45
  const overscrollTranslateX = isRightOverscroll ? -overscroll.pullPx : overscroll.pullPx

  return (
    <div
      className="group/scroll relative"
      onPointerEnter={() => {
        pointerInsideRef.current = true
        updateEdges()
      }}
      onPointerMove={() => {
        if (!pointerInsideRef.current) {
          pointerInsideRef.current = true
          updateEdges()
        }
      }}
      onPointerLeave={() => {
        pointerInsideRef.current = false
        setEdges((previous) => previous.left || previous.right ? { left: false, right: false } : previous)
      }}
    >
      <div
        ref={scrollRef}
        role="region"
        aria-label={label}
        onPointerDown={onPointerDown}
        onDragStartCapture={(event) => event.preventDefault()}
        onClickCapture={(event) => {
          if (suppressClickRef.current) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
        onScroll={(event) => {
          if (event.currentTarget.scrollLeft > 4) notifyEngage()
          scheduleEdgeUpdate()
        }}
        style={{
          transform: overscroll.railShiftPx > 0 ? `translate3d(${isRightOverscroll ? -overscroll.railShiftPx : overscroll.railShiftPx}px, 0, 0)` : undefined,
          transition: dragging || wheelPulling ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        className={`horizontal-rail ${className} ${dragging ? 'cursor-grabbing select-none' : 'cursor-grab'} scrollbar-none touch-pan-x`}
      >
        {children}
      </div>
      {overscroll.side !== null && overscroll.progress > 0.02 && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute top-1/2 z-30 flex h-12 w-12 items-center justify-center rounded-full border transition-[border-color,background-color,box-shadow] duration-150 ${
            isRightOverscroll ? 'right-2' : 'left-2'
          } ${
            isOverscrollArmed
              ? 'border-rose-400/70 bg-rose-500/25 text-rose-200'
              : 'border-white/15 bg-[#0F0B15]/95 text-zinc-200'
          }`}
          style={{
            opacity: Math.min(1, overscroll.progress * 2.2),
            transform: `translate3d(${overscrollTranslateX}px, -50%, 0) scale(${overscrollScale})`,
            boxShadow: isOverscrollArmed
              ? '0 0 26px rgba(255, 30, 109, 0.55)'
              : `0 0 ${Math.round(8 + overscroll.progress * 14)}px rgba(255, 30, 109, ${0.12 + overscroll.progress * 0.25})`,
          }}
        >
          <svg className="absolute inset-0 h-12 w-12 -rotate-90" viewBox="0 0 48 48">
            <circle
              cx="24"
              cy="24"
              r={RING_RADIUS}
              fill="none"
              stroke="rgba(255,255,255,0.12)"
              strokeWidth="2.5"
            />
            <circle
              cx="24"
              cy="24"
              r={RING_RADIUS}
              fill="none"
              stroke={isOverscrollArmed ? '#FF1E6D' : 'rgba(251, 113, 133, 0.85)'}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - overscroll.progress)}
            />
          </svg>
          <RotateCcw
            className="relative h-4 w-4"
            style={{
              transform: `${isRightOverscroll ? '' : 'scaleX(-1) '}rotate(${-overscroll.progress * 220}deg)`,
            }}
          />
        </div>
      )}
      {edges.left && !dragging && (
        <button type="button" aria-label="Scroll left" onPointerDown={(e) => e.stopPropagation()} onClick={() => scrollByPage(-1)} className="absolute left-1 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-[#0F0B15]/95 text-zinc-100 shadow-lg transition hover:border-white/30 hover:bg-[#1D1826]"><ChevronLeft className="h-5 w-5" /></button>
      )}
      {edges.right && !dragging && (
        <button type="button" aria-label="Scroll right" onPointerDown={(e) => e.stopPropagation()} onClick={() => scrollByPage(1)} className="absolute right-1 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-[#0F0B15]/95 text-zinc-100 shadow-lg transition hover:border-white/30 hover:bg-[#1D1826]"><ChevronRight className="h-5 w-5" /></button>
      )}
    </div>
  )
}

export const HorizontalScroller = React.memo(HorizontalScrollerImpl)
