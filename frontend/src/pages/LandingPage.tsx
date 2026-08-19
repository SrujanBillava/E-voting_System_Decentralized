import { Link } from "react-router-dom";
import { ShieldCheck, Vote, Lock, Sparkles, Globe, Key } from "lucide-react";

export const LandingPage = () => {
  return (
    <div className="min-h-screen bg-[#0d1117] text-white flex flex-col justify-between selection:bg-blue-600 selection:text-white">
      {/* Top Navbar */}
      <nav className="border-b border-slate-800 bg-[#0d1117]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-500 text-xl font-bold shadow-lg shadow-blue-500/20">
              🗳️
            </div>
            <div>
              <span className="text-lg font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-300">
                VoteChain
              </span>
              <span className="hidden sm:inline-block ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                Ethereum Layer
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Link
              to="/admin/login"
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-800/60 transition border border-slate-700/60"
            >
              Admin Portal
            </Link>
            <Link
              to="/login"
              className="px-5 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition shadow-md shadow-blue-600/30"
            >
              Voter Login →
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="max-w-7xl mx-auto px-6 py-16 md:py-24 flex-1 flex flex-col items-center justify-center text-center">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold mb-8 backdrop-blur-sm">
          <Sparkles size={14} /> Next-Gen Blockchain E-Voting System
        </div>

        <h1 className="text-4xl sm:text-6xl md:text-7xl font-extrabold tracking-tight max-w-4xl text-transparent bg-clip-text bg-gradient-to-b from-white via-slate-100 to-slate-400 leading-[1.15]">
          Vote from Anywhere. Counted on Blockchain.
        </h1>

        <p className="mt-6 text-base sm:text-lg md:text-xl text-slate-400 max-w-2xl font-normal leading-relaxed">
          A decentralized voting architecture guaranteeing <strong>one person one vote</strong>, verifiable anonymous receipts, and location-independent constituency mapping.
        </p>

        {/* CTA Buttons */}
        <div className="mt-10 flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto">
          <Link
            to="/login"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-4 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-sm shadow-xl shadow-blue-600/25 transition active:scale-95"
          >
            <Vote size={18} /> Launch Voter Portal
          </Link>

          <Link
            to="/admin/login"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-4 rounded-2xl bg-slate-800/80 hover:bg-slate-800 text-slate-200 hover:text-white font-bold text-sm border border-slate-700 transition active:scale-95"
          >
            <Key size={18} /> Admin & Results Center
          </Link>
        </div>

        {/* Feature Cards Grid */}
        <div className="mt-20 grid grid-cols-1 md:grid-cols-3 gap-6 text-left w-full">
          <div className="p-8 rounded-3xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition">
            <div className="h-12 w-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 mb-5">
              <Globe size={24} />
            </div>
            <h2 className="text-lg font-bold text-white mb-2">Vote From Any Booth</h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              Cast your ballot from any polling booth across the country. Candidates automatically adapt to your registered constituency.
            </p>
          </div>

          <div className="p-8 rounded-3xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition">
            <div className="h-12 w-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-5">
              <Lock size={24} />
            </div>
            <h2 className="text-lg font-bold text-white mb-2">Zero-Knowledge Verification</h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              Each voter receives a cryptographic hash receipt. Verify anytime on-chain that your vote was counted without revealing candidate choice.
            </p>
          </div>

          <div className="p-8 rounded-3xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition">
            <div className="h-12 w-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mb-5">
              <ShieldCheck size={24} />
            </div>
            <h2 className="text-lg font-bold text-white mb-2">Immutable Smart Contracts</h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              Ballots and vote tallies reside directly on the Ethereum virtual machine. Immune to central server tampering and double voting.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-[#0b0e14] py-8 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© 2026 E-Voting System • Powered by Ethereum & Smart Contracts</p>
          <div className="flex items-center gap-4">
            <Link to="/login" className="hover:text-slate-300">Voter Login</Link>
            <span>•</span>
            <Link to="/admin/login" className="hover:text-slate-300">Admin Login</Link>
          </div>
        </div>
      </footer>
    </div>
  );
};
