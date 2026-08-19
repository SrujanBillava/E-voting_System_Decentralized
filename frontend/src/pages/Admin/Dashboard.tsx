import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Users, Award, Vote, Activity, ArrowUpRight, CheckCircle2, Shield } from "lucide-react";
import { api } from "../../utils/Admin/api/api";
import { getContract, CONTRACT_ADDRESS } from "../../utils/contract";

export default function AdminDashboard() {
  const [voterCount, setVoterCount] = useState<number>(0);
  const [candidateCount, setCandidateCount] = useState<number>(0);
  const [totalVotes, setTotalVotes] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        // Fetch voter count from backend API
        const votersRes = await api.get("/admin/voters", { params: { limit: 1 } });
        setVoterCount(votersRes.data.pagination?.total || 0);

        // Fetch candidates and votes from smart contract
        const contract = await getContract();
        if (contract) {
          const count = Number(await contract.candidateCount());
          setCandidateCount(count);

          let sumVotes = 0;
          for (let i = 1; i <= count; i++) {
            const [, , votes] = await contract.getCandidate(i);
            sumVotes += Number(votes);
          }
          setTotalVotes(sumVotes);
        }
      } catch (err) {
        console.error("Failed to load dashboard data:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  return (
    <div className="p-6 md:p-10 space-y-8 max-w-7xl mx-auto">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-900 tracking-tight">
            Election Admin Overview
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Real-time monitoring and blockchain status
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-semibold border border-emerald-200">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            Hardhat Node Active
          </span>
          <Link
            to="/home"
            target="_blank"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 shadow-sm transition"
          >
            Live Voter App <ArrowUpRight size={14} />
          </Link>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Registered Voters</p>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <Users size={20} />
            </div>
          </div>
          <p className="text-3xl font-bold text-slate-900 mt-3">{loading ? "..." : voterCount}</p>
          <p className="text-xs text-slate-500 mt-1">Managed via MongoDB</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Candidates on Chain</p>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
              <Award size={20} />
            </div>
          </div>
          <p className="text-3xl font-bold text-slate-900 mt-3">{loading ? "..." : candidateCount}</p>
          <p className="text-xs text-slate-500 mt-1">Bengaluru, Delhi, Mumbai</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Total Votes Cast</p>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
              <Vote size={20} />
            </div>
          </div>
          <p className="text-3xl font-bold text-slate-900 mt-3">{loading ? "..." : totalVotes}</p>
          <p className="text-xs text-slate-500 mt-1">Cryptographically verified</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Active Constituencies</p>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-50 text-purple-600">
              <Activity size={20} />
            </div>
          </div>
          <p className="text-3xl font-bold text-slate-900 mt-3">3</p>
          <p className="text-xs text-slate-500 mt-1">Bengaluru, Delhi, Mumbai</p>
        </div>
      </div>

      {/* Contract Information & Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-3xl border border-slate-200 bg-white p-6 md:p-8 shadow-sm">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-blue-100 flex items-center justify-center text-blue-700 font-bold">
                <Shield size={20} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900">Blockchain Smart Contract Info</h2>
                <p className="text-xs text-slate-500">Ethereum Hardhat Local Node (Chain ID: 31337)</p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
              <CheckCircle2 size={16} /> Verified
            </span>
          </div>

          <div className="space-y-4">
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100 space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Deployed Contract Address</span>
              <p className="text-sm font-mono text-slate-800 break-all font-semibold">{CONTRACT_ADDRESS}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100">
                <span className="text-xs font-semibold text-slate-500 block">RPC Provider URL</span>
                <span className="text-sm font-semibold text-slate-800 mt-1 block">http://127.0.0.1:8545</span>
              </div>
              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100">
                <span className="text-xs font-semibold text-slate-500 block">Solidity Version</span>
                <span className="text-sm font-semibold text-slate-800 mt-1 block">v0.8.28 (Cancun EVM)</span>
              </div>
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="rounded-3xl border border-slate-200 bg-white p-6 md:p-8 shadow-sm flex flex-col justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900 mb-2">Admin Shortcuts</h2>
            <p className="text-xs text-slate-500 mb-6">Manage system components quickly</p>

            <div className="space-y-3">
              <Link
                to="/admin/voters"
                className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50 hover:bg-blue-50 hover:text-blue-700 text-slate-700 font-semibold text-sm transition"
              >
                <span>👥 Manage Voters</span>
                <ArrowUpRight size={16} />
              </Link>
              <Link
                to="/admin/candidates"
                className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50 hover:bg-indigo-50 hover:text-indigo-700 text-slate-700 font-semibold text-sm transition"
              >
                <span>🏛️ View On-Chain Candidates</span>
                <ArrowUpRight size={16} />
              </Link>
              <Link
                to="/admin/settings"
                className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold text-sm transition"
              >
                <span>⚙️ System Settings</span>
                <ArrowUpRight size={16} />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
