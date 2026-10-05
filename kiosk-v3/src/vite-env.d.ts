/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_IDENTITY_BASE: string;
  readonly VITE_RELAY_BASE: string;
  readonly VITE_RPC_URL: string;
  readonly VITE_CHAIN_ID: string;
  readonly VITE_VOTECHAIN_ADDRESS: string;
  readonly VITE_ELECTION_ID?: string;
  readonly VITE_DEFAULT_CONSTITUENCY?: string;
  /** "1" ONLY in the test build (npm run build:e2e): compiles the test face engine in. A production build never has it. */
  readonly VITE_E2E_FACE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
