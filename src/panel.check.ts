// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Without a focused workspace the worker answers a note before touching any file.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  noWorkspace: { results: { 'workspace.readContext': null } }
})
