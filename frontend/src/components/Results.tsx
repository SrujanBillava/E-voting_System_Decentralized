import { useEffect, useState } from "react";
import { getContract } from "../utils/contract";

const Results = () => {
  const [candidates, setCandidates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadResults = async () => {
      const contract = await getContract();

      if (!contract) {
        setLoading(false);
        return;
      }

      let temp = [];
      const count = await contract.candidateCount();

      for (let i = 1; i <= Number(count); i++) {
        try {
          const c = await contract.getCandidate(i);

          temp.push({
            id: i,
            name: c[0],
            constituency: c[1],
            votes: Number(c[2]),
          });
        } catch {
          break;
        }
      }

      temp.sort((a, b) => b.votes - a.votes);
      setCandidates(temp);
      setLoading(false);
    };

    loadResults();
  }, []);

  const maxVotes = Math.max(...candidates.map((c) => c.votes), 1);
  const totalVotes = candidates.reduce((sum, c) => sum + c.votes, 0);

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-8 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-white text-3xl shadow">
            📊
          </div>
          <div>
            <h2 className="text-3xl font-semibold text-slate-900">Election Results</h2>
            <p className="mt-2 text-slate-600">
              Live results from the blockchain
              {!loading && totalVotes > 0 && (
                <span className="ml-2 text-sm font-semibold text-slate-900">• {totalVotes} total votes</span>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2" id="results-grid">
        {loading ? (
          [1, 2, 3].map((i) => (
            <div key={i} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-4">
                <div className="h-10 w-10 rounded-2xl bg-slate-200" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 rounded-full bg-slate-200" />
                  <div className="h-3 w-20 rounded-full bg-slate-200" />
                </div>
              </div>
              <div className="mt-4 h-2 rounded-full bg-slate-200" />
            </div>
          ))
        ) : candidates.length === 0 ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-12 text-center shadow-sm">
            <div className="text-5xl">📭</div>
            <p className="mt-4 text-lg font-semibold text-slate-900">No results available yet.</p>
            <p className="mt-2 text-sm text-slate-500">Check back after voting.</p>
          </div>
        ) : (
          candidates.map((c, i) => (
            <div
              key={c.id}
              className={`rounded-3xl border p-6 shadow-sm transition ${i === 0 && c.votes > 0 ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`}
              id={`result-${c.id}`}
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-3xl bg-slate-100 text-lg font-semibold text-slate-900">
                    {i === 0 && c.votes > 0 ? "👑" : i + 1}
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-slate-900">{c.name}</p>
                    <p className="text-sm text-slate-500">{c.constituency}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-semibold text-slate-900">{c.votes}</p>
                  <p className="text-sm text-slate-500">
                    {totalVotes > 0 ? `${((c.votes / totalVotes) * 100).toFixed(1)}%` : "0%"}
                  </p>
                </div>
              </div>
              <div className="mt-5 h-3 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500"
                  style={{ width: `${maxVotes > 0 ? (c.votes / maxVotes) * 100 : 0}%` }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default Results;
