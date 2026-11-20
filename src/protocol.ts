// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both import it.
import type { Snap } from './scan'

declare module 'orca' {
  interface PluginRequests {
    /** The focused workspace's newest Claude session; `note` why there is none to show,
     *  `error` why it could not be read (the panel then keeps what it showed). */
    'snap.get': { output: { snap: Snap | null; note?: string; error?: string } }
    /** Puts text on the clipboard (the panel itself has none). */
    'clip.copy': { input: { text: string }; output: { ok: boolean; error?: string } }
    /** Opens a doc in its app, or shows anything else in Finder. */
    'doc.open': { input: { path: string }; output: { ok: boolean; error?: string; how?: 'opened' | 'revealed' } }
  }
}
