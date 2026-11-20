import React, { useEffect, useRef, useState } from 'react'
import { Check, MoreHorizontal } from 'lucide-react'
import type { FolderDiskSpace } from '../../types'
import { extractDriveLabelFromPath, formatDiskSize, getDiskHealthStyle, getFolderDisplayName } from '../../utils/format'
import { DiskSpaceRing } from './DiskSpaceRing'

interface DownloadFolderMenuProps {
  roots: string[]
  selectedRoot: string | null | undefined
  onSelect: (root: string) => void
  triggerVariant: 'split' | 'standalone'
  resetKey?: string | number | null
}

export const DownloadFolderMenu: React.FC<DownloadFolderMenuProps> = ({
  roots,
  selectedRoot,
  onSelect,
  triggerVariant,
  resetKey,
}) => {
  const [open, setOpen] = useState(false)
  const [diskSpaces, setDiskSpaces] = useState<Record<string, FolderDiskSpace>>({})
  const [loadingSpace, setLoadingSpace] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setOpen(false)
  }, [resetKey])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (containerRef.current && target && !containerRef.current.contains(target)) {
        setOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || roots.length === 0) return
    const api = window.electronAPI
    if (!api?.getFoldersDiskSpace) return

    let cancelled = false
    setLoadingSpace(true)
    api.getFoldersDiskSpace(roots)
      .then((entries) => {
        if (cancelled || !Array.isArray(entries)) return
        const next: Record<string, FolderDiskSpace> = {}
        for (const entry of entries) {
          next[entry.folderPath] = entry
          next[entry.folderPath.toLowerCase()] = entry
        }
        setDiskSpaces(next)
      })
      .catch(() => {
        // Ignore transient IPC/statfs failures; fallback text renders cleanly.
      })
      .finally(() => {
        if (!cancelled) setLoadingSpace(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, roots])

  if (roots.length <= 1) return null

  const activeRoot = selectedRoot || roots[0]
  const triggerClass =
    triggerVariant === 'split'
      ? `btn-glass -ml-px flex h-full w-11 items-center justify-center rounded-r-xl transition-colors ${
          open ? 'border-rose-400/40 bg-rose-500/15 text-rose-200' : 'text-zinc-300 hover:text-white'
        }`
      : `flex h-11 w-11 items-center justify-center rounded-xl border transition-colors ${
          open
            ? 'border-rose-400/40 bg-rose-500/15 text-rose-200'
            : 'border-white/10 text-zinc-300 hover:bg-white/5 hover:text-white'
        }`

  return (
    <div ref={containerRef} className={triggerVariant === 'split' ? 'relative flex' : 'relative'}>
      <button
        type="button"
        aria-label="Choose download folder"
        aria-expanded={open}
        aria-haspopup="menu"
        title={`Download to: ${activeRoot}`}
        onClick={() => setOpen((prev) => !prev)}
        className={triggerClass}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="menu"
          className="glass-dropdown animate-pop-in absolute bottom-full right-0 z-50 mb-2 w-80 overflow-hidden rounded-2xl p-2 shadow-2xl shadow-black/60"
        >
          <div className="mb-1.5 flex items-center justify-between border-b border-white/[0.06] px-2.5 pb-1.5 pt-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-400">
              Download destination
            </span>
            <span className="tabular-nums text-[10px] font-medium text-zinc-500">
              {roots.length} folders
            </span>
          </div>

          <div className="max-h-64 space-y-1 overflow-y-auto pr-0.5">
            {roots.map((root) => {
              const isSelected = activeRoot === root
              const info = diskSpaces[root] ?? diskSpaces[root.toLowerCase()]
              const driveLabel = info?.driveLabel || extractDriveLabelFromPath(root)
              const freeBytes = info?.freeBytes ?? null
              const totalBytes = info?.totalBytes ?? null
              const { textClass } = getDiskHealthStyle(freeBytes)

              return (
                <button
                  key={root}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  title={root}
                  onClick={() => {
                    onSelect(root)
                    setOpen(false)
                  }}
                  className={`group/item flex w-full items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition-colors ${
                    isSelected
                      ? 'border-rose-500/35 bg-rose-500/[0.14] text-white'
                      : 'border-transparent text-zinc-200 hover:border-white/[0.08] hover:bg-white/[0.05]'
                  }`}
                >
                  <DiskSpaceRing
                    driveLabel={driveLabel}
                    freeBytes={freeBytes}
                    totalBytes={totalBytes}
                    size={34}
                    active={isSelected}
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-semibold">{getFolderDisplayName(root)}</span>
                      {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-rose-400" />}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">{root}</p>
                  </div>

                  <div className="shrink-0 text-right tabular-nums leading-tight">
                    <p className={`text-[11px] font-medium ${textClass}`}>
                      {freeBytes != null
                        ? `${formatDiskSize(freeBytes)} free`
                        : loadingSpace && !info
                        ? 'Checking…'
                        : '—'}
                    </p>
                    {totalBytes != null && totalBytes > 0 && (
                      <p className="mt-0.5 text-[10px] text-zinc-500">of {formatDiskSize(totalBytes)}</p>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
