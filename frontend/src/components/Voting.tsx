import React, { useEffect, useState } from "react";
import { getContract } from "../utils/contract";
import { ethers } from "ethers";
import { MapPin, Building2 } from "lucide-react";

interface Props {
  voter: any;
  booth: string;
  setReceipt: (r: string) => void;
  next: () => void;
}

const Voting: React.FC<Props> = ({ voter, booth, setReceipt, next }) => {
  const [candidates, setCandidates] = useState<any[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const voterConstituency = voter?.constituency || "Bengaluru";

  useEffect(() => {
    const loadCandidates = async () => {
      try {
        setLoading(true);
        console.log("Loading candidates for voter constituency:", voterConstituency, "at physical booth:", booth);
        const contract = await getContract();

        if (!contract) {
          console.error("Contract is undefined");
          return;
        }

        const temp = [];
        const count = Number(await contract.candidateCount());

        for (let i = 1; i <= count; i++) {
          const [name, constituency, votes] = await contract.getCandidate(i);

          if (constituency === voterConstituency) {
            temp.push({
              id: i,
              name,
              constituency,
              votes: Number(votes),
            });
          }
        }

        setCandidates(temp);
      } catch (err) {
        console.error("Failed to load candidates:", err);
      } finally {
        setLoading(false);
      }
    };

    loadCandidates();
  }, [voterConstituency, booth]);

  const handleVote = async () => {
    if (selected === null) return;

    setSubmitting(true);

    try {
      const contract = await getContract();

      if (!contract) {
        alert("Contract is undefined");
        setSubmitting(false);
        return;
      }

      // Generate cryptographically unique receipt hash
      const randomSeed = ethers.hexlify(ethers.randomBytes(32));
      const receipt = ethers.keccak256(
        ethers.toUtf8Bytes(`${Date.now()}-${randomSeed}-${selected}`)
      );

      const tx = await contract.vote(selected, receipt);
      await tx.wait();

      setReceipt(receipt);
      next();
    } catch (err: any) {
      console.error("Vote failed:", err);
      alert("Vote submission failed: " + (err.message || err));
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-r from-blue-600 to-indigo-600 p-8 text-white shadow-lg">
        <div className="flex items-center gap-5">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/20 text-4xl backdrop-blur-sm">
            🗳️
          </div>
          <div>
            <h2 className="text-3xl font-bold">Cast Your Official Ballot</h2>
            <p className="mt-1.5 text-blue-100 text-sm">
              Constituency-mapped on-chain candidate selection
            </p>
          </div>
        </div>
      </div>

      {/* Context Badge Cards */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm flex items-center gap-4">
          <div className="h-12 w-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100">
            <MapPin size={24} />
          </div>
          <div>
            <p className="text-xs uppercase font-semibold tracking-wider text-slate-500">Current Polling Booth</p>
            <h3 className="text-lg font-bold text-slate-900 mt-0.5">{booth} Polling Station</h3>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm flex items-center gap-4">
          <div className="h-12 w-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100">
            <Building2 size={24} />
          </div>
          <div>
            <p className="text-xs uppercase font-semibold tracking-wider text-slate-500">Your Registered Constituency</p>
            <h3 className="text-lg font-bold text-slate-900 mt-0.5">{voterConstituency}</h3>
          </div>
        </div>
      </div>

      {/* Candidate List */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500 px-1">
          Select One Candidate for {voterConstituency}
        </h3>

        {loading &&
          [1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse rounded-3xl border border-slate-200 bg-white p-6 shadow-sm h-24" />
          ))}

        {!loading && candidates.length === 0 && (
          <div className="rounded-3xl border border-slate-200 bg-white p-16 text-center shadow-sm">
            <div className="mb-4 text-5xl">🔍</div>
            <h2 className="text-xl font-bold text-slate-800">No Candidates Found</h2>
            <p className="mt-2 text-slate-500 text-sm">
              No candidates are currently registered for <span className="font-semibold">{voterConstituency}</span>.
            </p>
          </div>
        )}

        {!loading &&
          candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => setSelected(candidate.id)}
              className={`w-full rounded-3xl border p-6 text-left transition-all duration-200 flex items-center justify-between
              ${
                selected === candidate.id
                  ? "border-blue-600 bg-blue-50/70 shadow-lg ring-2 ring-blue-400"
                  : "border-slate-200 bg-white hover:border-blue-300 hover:shadow-md"
              }`}
            >
              <div className="flex items-center gap-4">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-bold transition
                  ${
                    selected === candidate.id
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-slate-300 text-transparent"
                  }`}
                >
                  ✓
                </div>

                <div>
                  <h3 className="text-lg font-bold text-slate-900">{candidate.name}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">{candidate.constituency} Constituency</p>
                </div>
              </div>

              {selected === candidate.id && (
                <span className="rounded-full bg-blue-600 px-3.5 py-1 text-xs font-semibold text-white shadow-sm">
                  Selected
                </span>
              )}
            </button>
          ))}
      </div>

      {/* Bottom Action */}
      {!loading && candidates.length > 0 && (
        <div className="rounded-3xl border border-slate-200 bg-slate-50 p-8 shadow-sm">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs uppercase font-semibold tracking-wider text-slate-500">
                Ballot Choice
              </p>
              {selected === null ? (
                <h4 className="mt-1 text-xl font-semibold text-slate-400">
                  Please tap a candidate above to select
                </h4>
              ) : (
                <div className="mt-1">
                  <h4 className="text-xl font-bold text-slate-900">
                    {candidates.find((c) => c.id === selected)?.name}
                  </h4>
                  <p className="text-xs text-slate-500">
                    {candidates.find((c) => c.id === selected)?.constituency}
                  </p>
                </div>
              )}
            </div>

            <button
              onClick={handleVote}
              disabled={selected === null || submitting}
              className={`flex min-w-[240px] items-center justify-center gap-3 rounded-2xl px-8 py-4 text-base font-bold transition-all duration-200
              ${
                selected === null || submitting
                  ? "cursor-not-allowed bg-slate-200 text-slate-400"
                  : "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-xl shadow-blue-600/25 hover:scale-[1.02]"
              }`}
            >
              {submitting ? "Signing On Blockchain..." : "🗳️ Confirm & Cast Vote"}
            </button>
          </div>
        </div>
      )}

      {/* Security Info */}
      <div className="rounded-3xl border border-emerald-200 bg-emerald-50/70 p-6 flex items-start gap-4">
        <div className="text-2xl mt-0.5">🔒</div>
        <div>
          <h4 className="text-sm font-bold text-emerald-900">Cryptographically Sealed Ballot</h4>
          <p className="text-xs leading-relaxed text-emerald-800 mt-1">
            Once submitted, your vote is recorded as an immutable Ethereum state change. You will receive an anonymous receipt ID to verify that your ballot was counted.
          </p>
        </div>
      </div>
    </div>
  );
};

export default Voting;
