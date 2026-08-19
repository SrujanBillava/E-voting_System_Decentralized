import { Link } from "react-router-dom";
import { Menu, Home } from "lucide-react";

interface HeaderProps {
  onMenuClick: () => void;
  isAuthenticated: boolean;
}

export default function Header({ onMenuClick, isAuthenticated }: HeaderProps) {
  return (
    <header className="sticky top-0 z-40 w-full bg-white/80 backdrop-blur-md border-b border-slate-200">
      <div className="h-16 px-4 md:px-6 flex items-center gap-4">
        {/* Hamburger Menu Button */}
        {isAuthenticated && (
          <button
            onClick={onMenuClick}
            className="p-2 -ml-2 rounded-lg hover:bg-slate-100 text-slate-600"
          >
            <Menu size={24} />
          </button>
        )}

        {/* Logo */}
        <Link to="/" className="flex items-center gap-3 group">
          <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-700 to-indigo-600">
            E-Voting System
          </span>
        </Link>

        {/* Home Button (Right Aligned) */}
        {isAuthenticated && (
          <>
            <div className="ml-auto">
              <Link
                to="/admin/dashboard"
                className="p-2 rounded-lg hover:bg-slate-100 text-slate-600 transition-colors flex items-center gap-2"
                title="Go to Dashboard"
              >
                <Home size={22} />
              </Link>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
