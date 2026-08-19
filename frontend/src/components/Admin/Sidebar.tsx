import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Network,
  Users,
  LogOut,
  ShieldCheck,
  Settings,
  X
} from "lucide-react";
import { adminLogout } from "../../utils/Admin/api/auth";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  setIsAuthenticated: (value: boolean) => void;
}

export default function Sidebar({ isOpen, onClose, setIsAuthenticated }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = async () => {
    try {
      await adminLogout();
    } catch {
      // even if backend fails, force logout locally
    } finally {
      localStorage.removeItem("accessToken");
      setIsAuthenticated(false);
      navigate("/admin/login", { replace: true });
    }
  };

  const navItems = [
    { label: "Dashboard", href: "/admin/dashboard", icon: <LayoutDashboard size={20} /> },
    { label: "Voters", href: "/admin/voters", icon: <Users size={20} /> },
    { label: "Candidates", href: "/admin/candidates", icon: <Network size={20} /> },
    { label: "Settings", href: "/admin/settings", icon: <Settings size={20} /> }
  ];

  return (
    <>
      {/* Overlay for mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed top-0 left-0 h-full bg-white border-r border-slate-200 shadow-xl z-50 transition-transform duration-300 ease-in-out w-64 pt-4
        ${isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        flex flex-col justify-between
        `}
      >
        <div>
          {/* Header in sidebar */}
          <div className="flex items-center justify-between px-6 pb-4 border-b border-slate-100">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white font-bold shadow-sm">
                🗳️
              </div>
              <div>
                <span className="font-bold text-slate-800 text-sm tracking-tight block">VoteChain Admin</span>
                <span className="text-[11px] text-slate-400 font-medium block">Election Commission</span>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-600 md:hidden"
            >
              <X size={20} />
            </button>
          </div>

          {/* Navigation Section */}
          <div className="overflow-y-auto py-4 px-3 space-y-1.5">
            {navItems.map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  onClick={() => {
                    if (window.innerWidth < 768) onClose();
                  }}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200
                    ${
                      isActive
                        ? "bg-blue-600 text-white shadow-md shadow-blue-500/20 font-semibold"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                    }
                  `}
                >
                  <div className={isActive ? "text-white" : "text-slate-400"}>
                    {item.icon}
                  </div>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Profile & Logout Section */}
        <div className="p-4 border-t border-slate-100 space-y-2">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
            <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center text-blue-700 font-semibold text-xs border border-blue-200">
              <ShieldCheck size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-slate-800 truncate">
                Admin (2FA Active)
              </p>
              <p className="text-[11px] text-slate-500 truncate">
                admin@election.in
              </p>
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold text-red-600 hover:bg-red-50 transition-colors border border-transparent hover:border-red-100"
          >
            <LogOut size={16} />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>
    </>
  );
}
