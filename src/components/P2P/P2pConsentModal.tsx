/**
 * P2pConsentModal: explicit opt-in dialog for the P2P / BitTorrent engine.
 * Purely presentational — the parent performs acceptP2pConsent/enableP2p via
 * onAccept and owns toasts and state refresh. Escape and backdrop clicks call
 * onCancel; the capture-phase Escape listener stops propagation so parent
 * modals (e.g. SettingsModal) stay open.
 */
import React, { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Eye, Power, Scale, ShieldAlert, ShieldCheck } from 'lucide-react'

export interface P2pConsentModalProps {
  onAccept: () => void
  onCancel: () => void
}

const WARNING_ROWS: Array<{ icon: React.ElementType; text: string }> = [
  { icon: Eye, text: 'Your IP address is visible to peers and your ISP while torrenting.' },
  { icon: ShieldCheck, text: 'Use a VPN tunnel — the app can block downloads when no VPN is detected.' },
  { icon: Scale, text: 'You are responsible for what you download and share in your country.' },
  { icon: Power, text: 'P2P stays OFF until you explicitly enable it here.' },
]

export const P2pConsentModal: React.FC<P2pConsentModalProps> = ({ onAccept, onCancel }) => {
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return (
    <motion.div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      onClick={(e) => {
        e.stopPropagation()
        onCancel()
      }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        data-modal="true"
        aria-labelledby="p2p-consent-title"
        className="w-full max-w-md flex flex-col rounded-2xl border border-white/10 bg-[#141418] text-zinc-100 shadow-2xl"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start space-x-3 px-5 pt-5 pb-4">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5 text-amber-400" />
          </div>
          <div className="min-w-0">
            <h2 id="p2p-consent-title" className="text-sm font-bold text-white tracking-tight">
              Enable P2P / BitTorrent?
            </h2>
            <p className="mt-0.5 text-[11px] text-zinc-400 leading-relaxed">
              The torrent engine connects your computer directly to other computers.
            </p>
          </div>
        </div>

        {/* Warning rows */}
        <div className="px-5 space-y-2">
          {WARNING_ROWS.map(({ icon: RowIcon, text }) => (
            <div
              key={text}
              className="flex items-start space-x-2.5 rounded-lg bg-zinc-900/80 border border-white/5 px-3 py-2"
            >
              <RowIcon className="w-3.5 h-3.5 text-amber-400/90 shrink-0 mt-0.5" />
              <span className="text-[11px] leading-relaxed text-zinc-300">{text}</span>
            </div>
          ))}
        </div>

        {/* Footer: consent checkbox + actions */}
        <div className="px-5 py-4 mt-4 border-t border-white/10 space-y-3">
          <label className="flex items-center space-x-2.5 text-xs text-zinc-300 hover:text-zinc-100 cursor-pointer select-none transition-colors">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-red-600 focus:ring-0 focus:ring-offset-0 cursor-pointer accent-red-600"
            />
            <span className="font-medium">I understand and accept</span>
          </label>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={onAccept}
              disabled={!accepted}
              className="flex-1 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Enable P2P
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800 text-xs font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
