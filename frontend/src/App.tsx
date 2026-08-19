import "./App.css";
import { useState } from "react";
import { Routes, Route } from "react-router-dom";

// Admin Imports
import Sidebar from "./components/Admin/Sidebar";
import AdminRoute from "./components/Admin/AdminRoute";
import AdminLogin from "./pages/Admin/Login";
import AdminDashboard from "./pages/Admin/Dashboard";
import Header from "./components/Admin/Header";
import Voters from "./pages/Admin/Voters";
import Candidates from "./pages/Admin/Candidates";
import Settings from "./pages/Admin/Settings";

// Voter Imports
import { LandingPage } from "./pages/LandingPage";
import Home from "./pages/Home";
import VoterLogin from "./pages/Voter/Login";
import ProtectedRoute from "./components/Voter/ProtectedRoute";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(
    !!localStorage.getItem("accessToken"),
  );
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const showSidebar = isAuthenticated;

  return (
    <div className="flex flex-col min-h-screen bg-[#F8F9FC]">
      <Header
        isAuthenticated={showSidebar}
        onMenuClick={() => setIsSidebarOpen(!isSidebarOpen)}
      />
      <div className="flex flex-1 relative">
        {showSidebar && (
          <Sidebar
            isOpen={isSidebarOpen}
            onClose={() => setIsSidebarOpen(false)}
            setIsAuthenticated={setIsAuthenticated}
          />
        )}
        <main className={`flex-1 w-full p-0 transition-all duration-300 ${showSidebar && isSidebarOpen ? "md:pl-64" : ""}`}>
          <Routes>
            {/* Voter Routes */}
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<VoterLogin />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/home" element={<Home />} />
            </Route>

            {/* Admin Routes */}
            <Route
              path="/admin/login"
              element={<AdminLogin setIsAuthenticated={setIsAuthenticated} />}
            />
            {/* PROTECTED ADMIN ROUTES */}
            <Route path="/admin" element={<AdminRoute />}>
              <Route path="dashboard" element={<AdminDashboard />} />
              <Route path="voters" element={<Voters />} />
              <Route path="candidates" element={<Candidates />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default App;
