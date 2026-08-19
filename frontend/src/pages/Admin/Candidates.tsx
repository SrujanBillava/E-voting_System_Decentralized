import { useEffect, useState } from "react";
import { Award, Plus, Search, Filter, CheckCircle2 } from "lucide-react";
import { getContract } from "../../utils/contract";

interface Candidate {
  id: number;
  name: string;
  constituency: string;
  votes: number;
}

export default function Candidates() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedConstituency, setSelectedConstituency] = useState("All");
  const [showAddModal, setShowAddModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newConstituency, setNewConstituency] = useState("Bengaluru");
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const fetchCandidates = async () => {
    try {
      setLoading(true);
      const contract = await getContract();
      if (!contract) return;

      const count = Number(await contract.candidateCount());
      const temp: Candidate[] = [];

      for (let i = 1; i <= count; i++) {
        const [name, constituency, votes] = await contract.getCandidate(i);
        temp.push({
          id: i,
          name,
          constituency,
          votes: Number(votes),
        });
      }

      setCandidates(temp);
    } catch (err) {
      console.error("Error fetching candidates:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCandidates();
  }, []);

  const handleAddCandidate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    try {
      setSubmitting(true);
      setStatusMessage(null);
      const contract = await getContract();
      if (!contract) throw new Error("Contract not connected");

      const tx = await contract.addCandidate(newName.trim(), newConstituency);
      await tx.wait();

      setStatusMessage(`Candidate "${newName}" successfully registered on-chain!`);
      setNewName("");
      setShowAddModal(false);
      await fetchCandidates();
    } catch (err: any) {
      alert("Transaction failed: " + (err.message || err));
    } finally {
      setSubmitting(false);
    }
  };

  const filteredCandidates = candidates.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase());
    const matchesConstituency =
      selectedConstituency === "All" || c.constituency === selectedConstituency;
    return matchesSearch && matchesConstituency;
  });

  return (
    <div className="p-6 md:p-10 space-y-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-900 tracking-tight">
            On-Chain Candidates
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Smart contract candidate registry ({candidates.length} total)
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-5 py-3 rounded-2xl shadow-lg shadow-blue-600/20 transition active:scale-95"
        >
          <Plus size={18} /> Register Candidate
        </button>
      </div>

      {statusMessage && (
        <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-medium flex items-center gap-2">
          <CheckCircle2 size={18} className="text-emerald-600" />
          {statusMessage}
        </div>
      )}

      {/* Filters & Search */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search candidate name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition shadow-sm"
          />
        </div>

        <div className="flex items-center gap-2">
          <Filter size={18} className="text-slate-400 hidden sm:block" />
          <select
            value={selectedConstituency}
            onChange={(e) => setSelectedConstituency(e.target.value)}
            className="bg-white border border-slate-200 px-4 py-3 rounded-2xl text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
          >
            <option value="All">All Constituencies</option>
            <option value="Bengaluru">Bengaluru</option>
            <option value="Delhi">Delhi</option>
            <option value="Mumbai">Mumbai</option>
          </select>
        </div>
      </div>

      {/* Candidates Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {loading ? (
          [1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-40 bg-white rounded-3xl border border-slate-200 animate-pulse p-6" />
          ))
        ) : filteredCandidates.length === 0 ? (
          <div className="col-span-full bg-white rounded-3xl border border-slate-200 p-12 text-center">
            <Award size={48} className="mx-auto text-slate-300 mb-3" />
            <p className="font-semibold text-slate-700">No candidates match the criteria</p>
            <p className="text-xs text-slate-400 mt-1">Try resetting the filter or add a candidate.</p>
          </div>
        ) : (
          filteredCandidates.map((c) => (
            <div
              key={c.id}
              className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm hover:shadow-md transition flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-4">
                  <span className="h-8 w-8 rounded-xl bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-700">
                    #{c.id}
                  </span>
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-semibold ${
                      c.constituency === "Bengaluru"
                        ? "bg-blue-50 text-blue-700 border border-blue-200"
                        : c.constituency === "Delhi"
                        ? "bg-purple-50 text-purple-700 border border-purple-200"
                        : "bg-amber-50 text-amber-700 border border-amber-200"
                    }`}
                  >
                    🏛️ {c.constituency}
                  </span>
                </div>
                <h3 className="text-lg font-bold text-slate-900">{c.name}</h3>
              </div>

              <div className="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between text-xs">
                <span className="text-slate-500 font-medium">Votes Cast:</span>
                <span className="font-bold text-slate-900 bg-slate-100 px-2.5 py-1 rounded-lg">
                  {c.votes} votes
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add Candidate Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 sm:p-8 border border-slate-100">
            <h2 className="text-xl font-bold text-slate-900 mb-1">Register New Candidate</h2>
            <p className="text-xs text-slate-500 mb-6">This will execute an on-chain transaction (`addCandidate`)</p>

            <form onSubmit={handleAddCandidate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 uppercase mb-2">Candidate Full Name</label>
                <input
                  type="text"
                  placeholder="e.g. Ramesh Reddy"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 uppercase mb-2">Constituency</label>
                <select
                  value={newConstituency}
                  onChange={(e) => setNewConstituency(e.target.value)}
                  className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="Bengaluru">Bengaluru</option>
                  <option value="Delhi">Delhi</option>
                  <option value="Mumbai">Mumbai</option>
                </select>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-5 py-2.5 rounded-xl bg-slate-100 text-slate-700 text-sm font-semibold hover:bg-slate-200 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition disabled:opacity-50"
                >
                  {submitting ? "Confirming on-chain..." : "Submit to Blockchain"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}