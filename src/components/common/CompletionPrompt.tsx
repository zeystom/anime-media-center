import React from 'react'
import { motion } from 'framer-motion'
import { CheckCircle, Trash2, X } from 'lucide-react'
import { formatFileSize } from '../../utils/format'

export interface CompletionPromptData {
  title: string
  sizeBytes: number
}

interface CompletionPromptProps {
  data: CompletionPromptData
  onDelete: () => void
  onKeep: () => void
}

/**
 * Bottom-center glass suggestion shown right after a season finishes playing:
 * offers to free the downloaded files while making clear the title stays in
 * watch history. Dismissing (X) counts as "Keep".
 */
export const CompletionPrompt: React.FC<CompletionPromptProps> = ({ data, onDelete, onKeep }) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="fixed bottom-6 left-1/2 z-[60] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2"
    >
      <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-zinc-900/95 px-4 py-3.5 shadow-2xl shadow-black/50 backdrop-blur-md">
        <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-100">
            &ldquo;{data.title}&rdquo; completed!
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
            Delete the downloaded files (frees {formatFileSize(data.sizeBytes)})? The title stays
            in your watch history.
          </p>

          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={onDelete}
              className="flex select-none items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-red-500 active:scale-[0.98]"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Delete files</span>
            </button>
            <button
              type="button"
              onClick={onKeep}
              className="rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-700/80 hover:text-white active:scale-[0.98]"
            >
              Keep
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={onKeep}
          title="Dismiss"
          className="shrink-0 rounded-lg p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </motion.div>
  )
}
