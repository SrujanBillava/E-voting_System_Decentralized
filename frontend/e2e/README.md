# Browser tests (Playwright, system Chrome)

Real stack: Hardhat node + MongoDB (db name contains `e2e`) + V2 backend; the specs create their own admin/voters through
`backend-api/test/helpers/e2e-fixture.js` (see `helpers.ts`). Set `E2E_BACKEND_DIR` to the backend-api directory if it is not `../backend-api`.

| Spec | Needs |
|---|---|
| `lifecycle.spec.ts` | pristine Setup election (fresh chain). One-way: Setup -> Open -> Closed. Re-run only after a reset. |
| `a11y-responsive.spec.ts` | Setup election; does not change the phase. |
| `kiosk-mocked.spec.ts` | nothing (all `/api/v1` calls are stubbed). |

Both the dev server (React StrictMode) and a production build (`vite build` + `vite preview`, with `E2E_PORT`) are supported; the
backend CORS allow-list must name the origin you use (the default dev port 5173 is allowed). `E2E_SHOTS_DIR` sets where screenshots go.
