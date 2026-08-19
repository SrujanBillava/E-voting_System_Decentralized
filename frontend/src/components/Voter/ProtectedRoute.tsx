// src/components/Voter/ProtectedRoute.tsx
import { Navigate, Outlet } from "react-router-dom";

const ProtectedRoute = () => {
  const token = sessionStorage.getItem("voterObject");
  return token ? <Outlet /> : <Navigate to="/login" replace />;
};

export default ProtectedRoute;
