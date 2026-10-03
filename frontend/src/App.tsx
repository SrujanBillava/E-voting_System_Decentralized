import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { LoadingState } from "./components/States";

/**
 * Three visually and structurally separate contexts, each with its own layout and its own code-split bundle:
 *   PUBLIC  (/, /election, /verify, /results, /trust, /accessibility)
 *   VOTER   (/vote)           - the supervised-terminal kiosk, no public or admin navigation
 *   ADMIN   (/admin/...)      - the operator console
 * Route guards here are a UX convenience only. The backend is the security boundary for every request.
 */
const PublicLayout = lazy(() => import("./layouts/PublicLayout"));
const Landing = lazy(() => import("./features/public/LandingPage"));
const ElectionPage = lazy(() => import("./features/public/ElectionPage"));
const VerifyPage = lazy(() => import("./features/public/VerifyPage"));
const ResultsPage = lazy(() => import("./features/public/ResultsPage"));
const TrustPage = lazy(() => import("./features/public/TrustPage"));
const AccessibilityPage = lazy(() => import("./features/public/AccessibilityPage"));
const NotFoundPage = lazy(() => import("./features/public/NotFoundPage"));

const VoterKioskLayout = lazy(() => import("./layouts/VoterKioskLayout"));
const Kiosk = lazy(() => import("./features/voter/Kiosk"));

const AdminLayout = lazy(() => import("./layouts/AdminLayout"));
const AdminLogin = lazy(() => import("./features/admin/LoginPage"));
const AdminElection = lazy(() => import("./features/admin/ElectionPage"));
const AdminVoters = lazy(() => import("./features/admin/VotersPage"));
const AdminConstituencies = lazy(() => import("./features/admin/ConstituenciesPage"));
const AdminCandidates = lazy(() => import("./features/admin/CandidatesPage"));
const AdminBiometrics = lazy(() => import("./features/admin/BiometricsPage"));
const AdminSystem = lazy(() => import("./features/admin/SystemPage"));

export default function App() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" />}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<Landing />} />
          <Route path="election" element={<ElectionPage />} />
          <Route path="verify" element={<VerifyPage />} />
          <Route path="verify/:txHash" element={<VerifyPage />} />
          <Route path="results" element={<ResultsPage />} />
          <Route path="trust" element={<TrustPage />} />
          <Route path="accessibility" element={<AccessibilityPage />} />
        </Route>

        <Route path="vote" element={<VoterKioskLayout />}>
          <Route index element={<Kiosk />} />
        </Route>

        <Route path="admin/login" element={<AdminLogin />} />
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="election" replace />} />
          <Route path="election" element={<AdminElection />} />
          <Route path="voters" element={<AdminVoters />} />
          <Route path="constituencies" element={<AdminConstituencies />} />
          <Route path="candidates" element={<AdminCandidates />} />
          <Route path="biometrics" element={<AdminBiometrics />} />
          <Route path="system" element={<AdminSystem />} />
        </Route>

        <Route element={<PublicLayout />}>
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
