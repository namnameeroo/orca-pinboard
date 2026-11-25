// Node's typings for what src/worker.ts and the worker tests use: Orca's tsconfig loads
// no @types/node. Ambient, so a panel file would type-check against them too: panels run
// without Node, so import none of these there and use no `process`.
// ponytail: hand-written; switch to @types/node when the worker uses more of Node
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: string[],
    options: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> },
    callback: (error: (Error & { killed?: boolean }) | null, stdout: string) => void
  ): { stdin: { end(data: string): void; on(event: 'error', listener: (e: Error) => void): void } | null }
}
declare module 'node:fs/promises' {
  export function readdir(path: string): Promise<string[]>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function realpath(path: string): Promise<string>
  export function stat(path: string): Promise<{ mtimeMs: number; size: number; isFile(): boolean }>
  export function open(
    path: string,
    flags: 'r'
  ): Promise<{
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
    close(): Promise<void>
  }>
  // the worker tests' fixtures
  export function mkdtemp(prefix: string): Promise<string>
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>
  export function writeFile(path: string, data: string): Promise<void>
  export function symlink(target: string, path: string): Promise<void>
  export function utimes(path: string, atimeSec: number, mtimeSec: number): Promise<void>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
}
declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}
declare module 'node:path' {
  export function join(...parts: string[]): string
}
declare const process: { env: Record<string, string | undefined> }
