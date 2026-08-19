import { useState } from "react";
import { getContract } from "../utils/contract";

const Verify = () => {
  const [receipt, setReceipt] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const handleVerify = async () => {
    if (!receipt.trim()) return;

    setLoading(true);
    setResult(null);
    setVerified(null);

    try {
      const contract = await getContract();
      const exists = await contract.verifyVote(receipt);

      if (exists) {
        setResult("Your vote has been recorded and verified on the blockchain.");
        setVerified(true);
      } else {
        setResult("No vote found with this receipt. Please check and try again.");
        setVerified(false);
      }
    } catch (err) {
      setResult("Verification failed. Please check your receipt ID.");
      setVerified(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-8 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-white text-3xl shadow">
            🔍
          </div>
          <div>
            <h2 className="text-3xl font-semibold text-slate-900">Verify Your Vote</h2>
            <p className="mt-2 text-slate-600">Enter your receipt ID to confirm your vote was counted.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:grid-cols-[1fr_auto]" id="verify-form">
        <input
          type="text"
          placeholder="Paste your receipt ID here (0x...)"
          className="min-w-0 rounded-3xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          value={receipt}
          onChange={(e) => setReceipt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleVerify();
          }}
          aria-label="Receipt ID"
          id="verify-input"
        />
        <button
          onClick={handleVerify}
          className="inline-flex min-w-[140px] items-center justify-center rounded-3xl bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-4 text-sm font-semibold text-white transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
          disabled={loading || !receipt.trim()}
          id="verify-btn"
        >
          {loading ? "Verifying…" : "🛡️ Verify"}
        </button>
      </div>

      {result && (
        <div
          className={`rounded-3xl border px-6 py-5 shadow-sm ${verified ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900"}`}
          id="verify-result"
          role="alert"
        >
          <div className="flex items-start gap-4">
            <span className="mt-1 text-2xl" aria-hidden="true">
              {verified ? "✅" : "❌"}
            </span>
            <div>
              <p className="font-semibold">{verified ? "Vote Verified" : "Not Found"}</p>
              <p className="mt-1 text-sm leading-6 opacity-90">{result}</p>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="mt-1 text-2xl">🔒</span>
          <p>
            <span className="font-semibold">Privacy preserved.</span> Verification only confirms that your vote exists — it does not reveal which candidate you voted for.
          </p>
        </div>
      </div>
    </div>
  );
};

export default Verify;
