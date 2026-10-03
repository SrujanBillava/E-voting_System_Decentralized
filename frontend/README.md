# VoteChain frontend

React + TypeScript + Vite. Three separate contexts, each with its own layout and code-split bundle:

| Context | Routes | Layout |
|---|---|---|
| Public | `/`, `/election`, `/verify`, `/results`, `/trust`, `/accessibility` | `layouts/PublicLayout.tsx` |
| Voter kiosk | `/vote` | `layouts/VoterKioskLayout.tsx` |
| Admin console | `/admin/login`, `/admin/*` | `layouts/AdminLayout.tsx` |

The browser talks **only** to the VoteChain HTTP API (`/api/v1`). There is no ethers, MetaMask or direct RPC. Route guards are a UX
convenience; the backend is the security boundary.

```bash
npm install
npm run dev        # proxies /api to VITE_PROXY_TARGET (default http://localhost:5000)
npm run build      # tsc -b && vite build
npm run lint
npm run e2e        # Playwright against a real local stack, see e2e/README.md
```

Design: `docs/FRONTEND_DESIGN.md` (tokens in `src/styles/tokens.css`, class vocabulary in `src/styles/components.css`).

## Server is the authority

* Voter: the stage always comes from `GET /voter/status`. Nothing about the journey is stored in `localStorage` / `sessionStorage`.
* Admin: the access token lives in memory only (`src/api/adminSession.ts`); the rotating refresh token is an HttpOnly cookie.
* Face verification is a **shell only** (`src/features/voter/screens/FaceScreen.tsx`). The biometric client plugs in through
  `src/features/voter/face/registry.ts`; it can never report success from the browser, the server moves the stage.
