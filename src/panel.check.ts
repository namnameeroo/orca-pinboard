// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Orca fires workspace.changed once as the panel subscribes; each scenario stands in
// for that event, which is what makes the panel ask. Both answer a note before the worker
// reads any file.
import { defineCheck } from 'orca/testing'

const WEB = { workspaceId: 'w1', branch: 'main', displayName: 'web', terminals: [] }

export default defineCheck({
  noWorkspace: {
    results: { 'workspace.readContext': null },
    events: [{ event: 'workspace.changed', payload: { context: null } }]
  },
  remote: {
    results: {
      'workspace.readContext': WEB,
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'web', path: '/srv/web', branch: 'main', hostId: 'ssh:box' }],
        truncated: false
      }
    },
    events: [{ event: 'workspace.changed', payload: { context: WEB } }]
  }
})
