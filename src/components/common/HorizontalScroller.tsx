import React, { useCallback, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import { markScrollActivity } from '../../utils/scrollState'

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
const WHEEL_PULL_THRESHOLD = 160
const RING_RADIUS = 20
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const WHEEL_RELEASE_MS = 220
const TOUCHPAD_RELEASE_MS = 420
const WHEEL_COOLDOWN_MS = 450
const SCROLL_IDLE_MS = 150

function computeOverscrollState(
  side: 'left' | 'right',
  rawOverscroll: number,
  deadzone: number,
  threshold: number = PULL_THRESHOLD
): OverscrollState {
  const effectivePull = Math.max(0, rawOverscroll - deadzone)
  const progress = Math.min(1, effectivePull / threshold)
  const scaledPull = effectivePull * (PULL_THRESHOLD / threshold)
  const pullPx = scaledPull > 0 ? Math.min(44, Math.pow(scaledPull, 0.72) * 1.45) : 0
  const railShiftPx = scaledPull > 0 ? Math.min(18, Math.pow(scaledPull, 0.65) * 0.75) : 0
  return { side, progress, pullPx, railShiftPx }
}

function wrapScrollToEdge(element: HTMLDivElement, side: 'left' | 'right', maxScroll: number) {
  if (maxScroll <= 2) return
  element.scrollTo({ left: side === 'right' ? 0 : maxScroll, behavior: 'smooth' })
}

const HorizontalScrollerImpl: React.FC<HorizontalScrollerProps> = ({ children, className = '', label = 'Scrollable items', onEngageScroll }) => {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const overscrollWrapRef = useRef<HTMLDivElement>(null)
  const overscrollRingRef = useRef<SVGCircleElement>(null)
  const overscrollIconRef = useRef<HTMLSpanElement>(null)

  const engagedRef = useRef(false)
  const notifyEngage = useCallback(() => {
    if (engagedRef.current) return
    engagedRef.current = true
    onEngageScroll?.()
  }, [onEngageScroll])

  const maxScrollRef = useRef(0)
  const dragRef = useRef<{ pointerId: number; startX: number; startScroll: number; moved: boolean } | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const overscrollRef = useRef<OverscrollState>(EMPTY_OVERSCROLL)
  const suppressClickRef = useRef(false)
  const wheelPullRef = useRef(0)
  const wheelSideRef = useRef<'left' | 'right' | null>(null)
  const wheelStartedAtEdgeRef = useRef(false)
  const wheelActiveRef = useRef(false)
  const wheelReleaseTimerRef = useRef<number | null>(null)
  const wheelCooldownUntilRef = useRef(0)

  const markRailScrolling = useCallback(() => {
    markScrollActivity(SCROLL_IDLE_MS)
  }, [])

  const syncScrollBounds = useCallback(() => {
    const element = scrollRef.current
    const wrapper = wrapperRef.current
    if (!element || !wrapper) return
    const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth)
    maxScrollRef.current = maxScroll
    const next = maxScroll > 2 ? 'true' : 'false'
    if (wrapper.dataset.scrollable !== next) {
      wrapper.dataset.scrollable = next
    }
  }, [])

  useEffect(() => {
    syncScrollBounds()
  }, [children, syncScrollBounds])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(syncScrollBounds)
    ro.observe(element)
    return () => ro.disconnect()
  }, [syncScrollBounds])

  const applyOverscroll = useCallback((next: OverscrollState, activeGesture: boolean) => {
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

    const railEl = scrollRef.current
    if (railEl) {
      railEl.style.transition = activeGesture ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)'
      if (next.railShiftPx > 0 && next.side) {
        const shift = next.side === 'right' ? -next.railShiftPx : next.railShiftPx
        railEl.style.transform = `translate3d(${shift}px, 0, 0)`
      } else {
        railEl.style.transform = ''
      }
    }

    const pill = overscrollWrapRef.current
    if (!pill) return
    if (next.side === null || next.progress <= 0.02) {
      pill.style.display = 'none'
      return
    }

    const isRight = next.side === 'right'
    const isArmed = next.progress >= 1
    const scale = isArmed ? 1.1 : 0.55 + next.progress * 0.45
    const translateX = isRight ? -next.pullPx : next.pullPx

    pill.style.display = 'flex'
    pill.style.left = isRight ? 'auto' : '0.5rem'
    pill.style.right = isRight ? '0.5rem' : 'auto'
    pill.style.opacity = String(Math.min(1, next.progress * 2.2))
    pill.style.transform = `translate3d(${translateX}px, -50%, 0) scale(${scale})`
    pill.style.borderColor = isArmed ? 'rgba(251, 113, 133, 0.7)' : 'rgba(255, 255, 255, 0.15)'
    pill.style.backgroundColor = isArmed ? 'rgba(255, 30, 109, 0.25)' : 'rgba(15, 11, 21, 0.95)'
    pill.style.color = isArmed ? '#FEC6D9' : '#E6E4EA'
    pill.style.boxShadow = isArmed
      ? '0 0 26px rgba(255, 30, 109, 0.55)'
      : `0 0 ${Math.round(8 + next.progress * 14)}px rgba(255, 30, 109, ${0.12 + next.progress * 0.25})`

    if (overscrollRingRef.current) {
      overscrollRingRef.current.style.stroke = isArmed ? '#FF1E6D' : 'rgba(251, 113, 133, 0.85)'
      overscrollRingRef.current.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - next.progress))
    }
    if (overscrollIconRef.current) {
      overscrollIconRef.current.style.transform = `${isRight ? '' : 'scaleX(-1) '}rotate(${-next.progress * 220}deg)`
    }
  }, [])

  const scrollByPage = (direction: -1 | 1) => {
    notifyEngage()
    const element = scrollRef.current
    if (!element) return
    syncScrollBounds()
    const maxScroll = maxScrollRef.current
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
    syncScrollBounds()
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startScroll: element.scrollLeft, moved: false }

    if (dragCleanupRef.current) {
      dragCleanupRef.current()
      dragCleanupRef.current = null
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current
      const rail = scrollRef.current
      if (!drag || !rail || drag.pointerId !== moveEvent.pointerId) return
      const delta = moveEvent.clientX - drag.startX
      if (!drag.moved && Math.abs(delta) > 5) {
        drag.moved = true
        if (wrapperRef.current) wrapperRef.current.dataset.dragging = 'true'
        markRailScrolling()
      }
      if (drag.moved) {
        const maxScroll = maxScrollRef.current
        const targetScroll = drag.startScroll - delta
        const clampedScroll = Math.max(0, Math.min(maxScroll, targetScroll))
        rail.scrollLeft = clampedScroll
        markRailScrolling()

        if (maxScroll > 2 && (targetScroll > maxScroll || targetScroll < 0)) {
          const side: 'left' | 'right' = targetScroll > maxScroll ? 'right' : 'left'
          const rawOverscroll = side === 'right' ? targetScroll - maxScroll : -targetScroll
          const startedAtEdge = side === 'right' ? drag.startScroll >= maxScroll - 8 : drag.startScroll <= 8
          applyOverscroll(computeOverscrollState(side, rawOverscroll, startedAtEdge ? 10 : 32), true)
        } else {
          applyOverscroll(EMPTY_OVERSCROLL, true)
        }
        moveEvent.preventDefault()
      }
    }

    const endDrag = (endEvent: PointerEvent) => {
      const drag = dragRef.current
      const rail = scrollRef.current
      if (!drag || drag.pointerId !== endEvent.pointerId) return
      const currentOverscroll = overscrollRef.current
      applyOverscroll(EMPTY_OVERSCROLL, false)

      if (endEvent.type === 'pointerup' && currentOverscroll.progress >= 1 && currentOverscroll.side && rail) {
        wrapScrollToEdge(rail, currentOverscroll.side, maxScrollRef.current)
      }

      if (drag.moved) {
        suppressClickRef.current = true
        window.setTimeout(() => { suppressClickRef.current = false }, 120)
      }
      dragRef.current = null
      if (wrapperRef.current) wrapperRef.current.dataset.dragging = 'false'
      if (dragCleanupRef.current) {
        dragCleanupRef.current()
        dragCleanupRef.current = null
      }
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    dragCleanupRef.current = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
    }
  }

  useEffect(() => () => {
    if (dragCleanupRef.current) dragCleanupRef.current()
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const finishWheelGesture = () => {
      wheelReleaseTimerRef.current = null
      const currentOverscroll = overscrollRef.current
      wheelPullRef.current = 0
      wheelSideRef.current = null
      wheelActiveRef.current = false
      applyOverscroll(EMPTY_OVERSCROLL, false)

      if (currentOverscroll.progress >= 1 && currentOverscroll.side) {
        wheelCooldownUntilRef.current = Date.now() + WHEEL_COOLDOWN_MS
        wrapScrollToEdge(element, currentOverscroll.side, maxScrollRef.current)
      }
    }

    const onWheel = (event: WheelEvent) => {
      if (dragRef.current) return
      const scale = event.deltaMode === 1 ? 16 : 1
      const rawDx = (event.deltaX * scale) || (event.shiftKey ? event.deltaY * scale : 0)
      const effectiveDy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY * scale
      if (Math.abs(rawDx) < 0.5 || Math.abs(rawDx) <= Math.abs(effectiveDy)) return
      notifyEngage()
      markRailScrolling()

      if (Date.now() < wheelCooldownUntilRef.current) {
        event.preventDefault()
        return
      }

      const maxScroll = maxScrollRef.current > 0 ? maxScrollRef.current : (element.scrollWidth - element.clientWidth)
      maxScrollRef.current = maxScroll
      if (maxScroll <= 2) return

      const isDiscreteWheel = event.deltaMode !== 0 || (event.shiftKey && event.deltaX === 0)
      const pullThreshold = isDiscreteWheel ? PULL_THRESHOLD : WHEEL_PULL_THRESHOLD
      const releaseMs = isDiscreteWheel ? WHEEL_RELEASE_MS : TOUCHPAD_RELEASE_MS
      const minKeepAliveDx = isDiscreteWheel ? 4 : 1.5

      if (!wheelActiveRef.current) {
        wheelActiveRef.current = true
        wheelStartedAtEdgeRef.current =
          (rawDx > 0 && element.scrollLeft >= maxScroll - 2) ||
          (rawDx < 0 && element.scrollLeft <= 2)
      }

      const activeSide = wheelSideRef.current
      const deadzone = isDiscreteWheel
        ? (wheelStartedAtEdgeRef.current ? 8 : 30)
        : (wheelStartedAtEdgeRef.current ? 32 : 90)

      if (activeSide !== null && wheelPullRef.current > 0 && ((activeSide === 'right' && rawDx < 0) || (activeSide === 'left' && rawDx > 0))) {
        if (wheelPullRef.current <= deadzone) {
          wheelPullRef.current = 0
          wheelSideRef.current = null
          applyOverscroll(EMPTY_OVERSCROLL, false)
        } else {
          event.preventDefault()
          const pullBackGain = isDiscreteWheel ? 1.15 : 0.85
          wheelPullRef.current = Math.max(0, wheelPullRef.current - Math.abs(rawDx) * pullBackGain)
          if (wheelPullRef.current > deadzone) {
            applyOverscroll(computeOverscrollState(activeSide, wheelPullRef.current, deadzone, pullThreshold), true)
          } else {
            wheelPullRef.current = 0
            wheelSideRef.current = null
            applyOverscroll(EMPTY_OVERSCROLL, false)
          }
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
          const pullGain = isDiscreteWheel
            ? 1.15
            : (wheelStartedAtEdgeRef.current ? 0.5 : 0.45)
          const maxStep = isDiscreteWheel
            ? 48
            : (wheelStartedAtEdgeRef.current ? 20 : 18)
          wheelPullRef.current += Math.min(maxStep, Math.abs(rawDx) * pullGain)
          applyOverscroll(computeOverscrollState(side, wheelPullRef.current, deadzone, pullThreshold), true)
        }
      }

      if (wheelReleaseTimerRef.current == null || overscrollRef.current.progress < 1 || Math.abs(rawDx) >= minKeepAliveDx) {
        if (wheelReleaseTimerRef.current != null) window.clearTimeout(wheelReleaseTimerRef.current)
        wheelReleaseTimerRef.current = window.setTimeout(finishWheelGesture, releaseMs)
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
  }, [applyOverscroll, markRailScrolling, notifyEngage])

  return (
    <div ref={wrapperRef} data-scrollable="false" data-dragging="false" className="horizontal-scroller-wrap group/scroll relative">
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
          markRailScrolling()
        }}
        className={`horizontal-rail ${className} cursor-grab scrollbar-none touch-pan-x`}
      >
        {children}
      </div>
      <div
        ref={overscrollWrapRef}
        aria-hidden="true"
        style={{ display: 'none' }}
        className="pointer-events-none absolute top-1/2 z-30 h-12 w-12 items-center justify-center rounded-full border transition-[border-color,background-color,box-shadow] duration-150"
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
            ref={overscrollRingRef}
            cx="24"
            cy="24"
            r={RING_RADIUS}
            fill="none"
            stroke="rgba(251, 113, 133, 0.85)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE}
          />
        </svg>
        <span ref={overscrollIconRef} className="relative inline-flex items-center justify-center">
          <RotateCcw className="h-4 w-4" />
        </span>
      </div>
      <button type="button" aria-label="Scroll left" onPointerDown={(e) => e.stopPropagation()} onClick={() => scrollByPage(-1)} className="horizontal-scroller-btn absolute left-1 top-1/2 z-20 h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-[#0F0B15]/95 text-zinc-100 shadow-lg transition hover:border-white/30 hover:bg-[#1D1826]"><ChevronLeft className="h-5 w-5" /></button>
      <button type="button" aria-label="Scroll right" onPointerDown={(e) => e.stopPropagation()} onClick={() => scrollByPage(1)} className="horizontal-scroller-btn absolute right-1 top-1/2 z-20 h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-[#0F0B15]/95 text-zinc-100 shadow-lg transition hover:border-white/30 hover:bg-[#1D1826]"><ChevronRight className="h-5 w-5" /></button>
    </div>
  )
}

export const HorizontalScroller = React.memo(HorizontalScrollerImpl)
