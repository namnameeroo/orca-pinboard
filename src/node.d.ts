// Node's typings for what src/worker.ts uses: Orca's tsconfig loads no @types/node.
// ponytail: hand-written; switch to @types/node when the worker uses more of Node
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: string[],
    options: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> },
    callback: (error: Error | null, stdout: string) => void
  ): { stdin: { end(data: string): void } | null }
}
declare module 'node:fs/promises' {
  export function readdir(path: string): Promise<string[]>
  export function realpath(path: string): Promise<string>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function stat(path: string): Promise<{ mtimeMs: number }>
}
declare module 'node:os' {
  export function homedir(): string
}
declare module 'node:path' {
  export function join(...parts: string[]): string
}
declare const process: { env: Record<string, string | undefined> }
