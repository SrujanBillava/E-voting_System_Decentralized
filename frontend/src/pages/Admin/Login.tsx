import { useState } from "react";
import { adminLogin } from "../../utils/Admin/api/auth";
import { useNavigate, Navigate, Link } from "react-router-dom";
import { Shield, KeyRound, ArrowLeft } from "lucide-react";

export default function AdminLogin({ setIsAuthenticated }: { setIsAuthenticated: (value: boolean) => void }) {
  if (localStorage.getItem("accessToken")) {
    return <Navigate to="/admin/dashboard" replace />;
  }

  const [username, setUsername] = useState("admin");
  const [totp, setTotp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!username || !totp) {
      setError("Please fill in both username and 6-digit TOTP code.");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const res = await adminLogin({
        username,
        password: totp,
      });

      localStorage.setItem("accessToken", res.data.accessToken);
      setIsAuthenticated(true);
      navigate("/admin/dashboard", { replace: true });
    } catch (err: any) {
      setError(err.response?.data?.message || "Invalid credentials or TOTP expired.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 px-4 py-12">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-100 p-8 sm:p-10 relative">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-800 transition mb-6"
        >
          <ArrowLeft size={14} /> Back to Portal
        </Link>

        {/* Header */}
        <div className="text-center mb-8">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 mb-4 border border-blue-100 shadow-sm">
            <Shield size={32} />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Admin Portal Login
          </h1>
          <p className="text-sm text-slate-500 mt-1.5">
            Two-Factor Authentication Protected
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-2">
              Admin Username
            </label>
            <input
              type="text"
              placeholder="e.g. admin"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-900
                         focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500
                         focus:border-transparent transition"
              required
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600">
                Authenticator 6-Digit TOTP Code
              </label>
            </div>
            <div className="relative">
              <input
                type="text"
                maxLength={6}
                placeholder="••••••"
                value={totp}
                onChange={(e) => setTotp(e.target.value.trim())}
                className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-900
                           tracking-[0.4em] text-center font-mono font-bold
                           focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500
                           focus:border-transparent transition"
                required
              />
              <KeyRound size={18} className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>
          </div>

          {error && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
              ⚠️ {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 rounded-2xl bg-blue-600 py-3.5 text-white text-sm
                       font-semibold hover:bg-blue-700 shadow-lg shadow-blue-600/30
                       active:scale-[0.98] transition
                       disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? "Verifying Credentials..." : "Authenticate & Enter →"}
          </button>
        </form>

        {/* Demo Helper Info */}
        <div className="mt-8 pt-6 border-t border-slate-100">
          <div className="rounded-2xl bg-slate-50 border border-slate-200/70 p-3.5 text-xs text-slate-600 space-y-1">
            <p className="font-semibold text-slate-800">🔐 Demo Admin Credentials:</p>
            <p>• Username: <code className="bg-slate-200/80 px-1.5 py-0.5 rounded text-slate-800">admin</code></p>
            <p>• Authenticator Secret: <code className="bg-slate-200/80 px-1.5 py-0.5 rounded text-slate-800 font-mono">JBSWY3DPEHPK3PXP</code></p>
          </div>
        </div>
      </div>
    </div>
  );
}
