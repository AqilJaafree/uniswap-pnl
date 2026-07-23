/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** RPC endpoint the browser talks to. Defaults to the same-origin proxy at /rpc. */
  readonly VITE_RPC_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
