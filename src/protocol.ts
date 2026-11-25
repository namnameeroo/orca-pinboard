// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both import it.
import type { JsonValue } from 'orca'
import type { Snap } from './scan'

// what crosses panel and worker is JSON: Json<T> refuses a Date, a Map or a RegExp in T
// (Snap stays a `type`: an interface has no index signature and would fail here)
type Json<T extends JsonValue> = T

declare module 'orca' {
  interface PluginRequests {
    /** The focused workspace's newest Claude session; or a note why there is none to show;
     *  or an error why it could not be read (the panel then keeps what it showed). */
    'snap.get': { output: Json<{ snap: Snap } | { snap: null; note: string } | { snap: null; error: string }> }
    /** Puts text on the clipboard (the panel itself has none). */
    'clip.copy': { input: { text: string }; output: Json<{ ok: true } | { ok: false; error: string }> }
    /** Opens a doc in its app, or shows anything else in Finder. */
    'doc.open': {
      input: { path: string }
      output: Json<{ ok: true; how: 'opened' | 'revealed' } | { ok: false; error: string }>
    }
  }
}
