/// <reference types="vite/client" />
declare module 'verovio/wasm' { const create: () => Promise<unknown>; export default create; }
declare module 'verovio/esm' { export class VerovioToolkit { constructor(module: unknown); setOptions(options: Record<string, unknown>): void; loadData(data: string): boolean; getPageCount(): number; renderToSVG(page: number): string; getMEI(options?: Record<string, unknown>): string; } }
