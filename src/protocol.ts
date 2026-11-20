// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Snap } from './scan'

declare module 'orca' {
  interface PluginRequests {
    /** The focused workspace's newest Claude session, or why there is none to show. */
    'snap.get': { output: { snap: Snap | null; note?: string } }
    /** Puts text on the clipboard (the panel itself has none). */
    'clip.copy': { input: { text: string }; output: { ok: boolean; error?: string } }
    /** Opens a doc in its app, or shows anything else in Finder. */
    'doc.open': { input: { path: string }; output: { ok: boolean; error?: string; how?: 'opened' | 'revealed' } }
  }
}
