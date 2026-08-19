import React, { useState } from 'react';
import { useLogin } from '../../hooks/useLogin';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff, Vote, ArrowLeft } from 'lucide-react';

const VoterLogin = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { loginUser } = useLogin();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await loginUser({ email, password });
      navigate('/home');
    } catch (err: any) {
      setError(err.message || 'Login failed. Check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const fillDemoAccount = (demoEmail: string) => {
    setEmail(demoEmail);
    setPassword('password123');
    setError(null);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 via-slate-50 to-blue-50/40 px-4 py-12">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl border border-slate-200/80 p-8 sm:p-10">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-800 transition mb-6"
        >
          <ArrowLeft size={14} /> Back to Home
        </Link>

        {/* Header */}
        <div className="text-center mb-8">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 mb-4 border border-blue-100 shadow-sm">
            <Vote size={32} />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Voter Sign In
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Access your secure voting ballot
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-2">
              Registered Voter Email
            </label>
            <input
              type="email"
              placeholder="e.g. aarav@bengaluru.in"
              className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-2">
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter password"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-900 pr-11 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
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
            className="w-full mt-2 rounded-2xl bg-blue-600 py-3.5 text-white text-sm font-semibold hover:bg-blue-700 shadow-lg shadow-blue-600/30 active:scale-[0.98] transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? 'Authenticating...' : 'Sign In to Vote →'}
          </button>
        </form>

        {/* Demo Fast-Fill Accounts */}
        <div className="mt-8 pt-6 border-t border-slate-100">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3 text-center">
            ⚡ Quick-Fill Demo Voters
          </p>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => fillDemoAccount('aarav@bengaluru.in')}
              className="px-2.5 py-2 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] font-semibold transition text-center border border-blue-200/60"
            >
              Bengaluru
            </button>
            <button
              type="button"
              onClick={() => fillDemoAccount('pooja@delhi.in')}
              className="px-2.5 py-2 rounded-xl bg-purple-50 hover:bg-purple-100 text-purple-700 text-[11px] font-semibold transition text-center border border-purple-200/60"
            >
              Delhi
            </button>
            <button
              type="button"
              onClick={() => fillDemoAccount('rahul@mumbai.in')}
              className="px-2.5 py-2 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-700 text-[11px] font-semibold transition text-center border border-amber-200/60"
            >
              Mumbai
            </button>
          </div>
          <p className="text-[11px] text-slate-400 text-center mt-2">
            Default password: <code className="font-mono font-semibold text-slate-600">password123</code>
          </p>
        </div>
      </div>
    </div>
  );
};

export default VoterLogin;