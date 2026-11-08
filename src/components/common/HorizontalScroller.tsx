import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface HorizontalScrollerProps {
  children: React.ReactNode
  className?: string
  label?: string
}

export const HorizontalScroller: React.FC<HorizontalScrollerProps> = ({ children, className = '', label = 'Scrollable items' }) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startScroll: number; moved: boolean } | null>(null)
  const suppressClickRef = useRef(false)
  const pointerInsideRef = useRef(false)
  const pointerPositionRef = useRef({ x: 0, y: 0 })
  const edgeUpdateFrameRef = useRef<number | null>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const [dragging, setDragging] = useState(false)

  const updateEdges = useCallback((clientX?: number, clientY?: number) => {
    const element = scrollRef.current
    if (!element || clientX === undefined || clientY === undefined || !pointerInsideRef.current) {
      setEdges((previous) => previous.left || previous.right ? { left: false, right: false } : previous)
      return
    }
    const rect = element.getBoundingClientRect()
    const maxScroll = element.scrollWidth - element.clientWidth
    const canScroll = maxScroll > 2
    const withinRail = clientY >= rect.top && clientY <= rect.bottom
    const next = {
      left: canScroll && withinRail && clientX >= rect.left && clientX - rect.left < 56,
      right: canScroll && withinRail && clientX <= rect.right && rect.right - clientX < 56,
    }
    setEdges((previous) => previous.left === next.left && previous.right === next.right ? previous : next)
  }, [])

  const scheduleEdgeUpdate = useCallback(() => {
    if (edgeUpdateFrameRef.current != null) return
    edgeUpdateFrameRef.current = window.requestAnimationFrame(() => {
      edgeUpdateFrameRef.current = null
      updateEdges(pointerPositionRef.current.x, pointerPositionRef.current.y)
    })
  }, [updateEdges])

  const scrollByPage = (direction: -1 | 1) => {
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
          element.scrollLeft = drag.startScroll - delta
          scheduleEdgeUpdate()
          event.preventDefault()
        }
      }
    }

    const endDrag = (event: PointerEvent) => {
      const drag = dragRef.current
      if (drag && drag.pointerId === event.pointerId) {
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
  }, [scheduleEdgeUpdate])

  return (
    <div
      className="group/scroll relative"
      onPointerEnter={(event) => {
        pointerInsideRef.current = true
        pointerPositionRef.current = { x: event.clientX, y: event.clientY }
        updateEdges(event.clientX, event.clientY)
      }}
      onPointerMove={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY }
        updateEdges(event.clientX, event.clientY)
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
        onScroll={scheduleEdgeUpdate}
        className={`horizontal-rail ${className} ${dragging ? 'cursor-grabbing select-none' : 'cursor-grab'} scrollbar-none touch-pan-x`}
      >
        {children}
      </div>
      <button type="button" aria-label="Scroll left" onPointerDown={(e) => e.stopPropagation()} onClick={() => scrollByPage(-1)} className={`absolute left-1 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-[#101116]/90 text-zinc-100 shadow-lg backdrop-blur transition-all hover:border-white/30 hover:bg-[#20222b] ${edges.left ? 'scale-100 opacity-100' : 'pointer-events-none scale-90 opacity-0'}`}><ChevronLeft className="h-5 w-5" /></button>
      <button type="button" aria-label="Scroll right" onPointerDown={(e) => e.stopPropagation()} onClick={() => scrollByPage(1)} className={`absolute right-1 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-[#101116]/90 text-zinc-100 shadow-lg backdrop-blur transition-all hover:border-white/30 hover:bg-[#20222b] ${edges.right ? 'scale-100 opacity-100' : 'pointer-events-none scale-90 opacity-0'}`}><ChevronRight className="h-5 w-5" /></button>
    </div>
  )
}
