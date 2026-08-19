import { useState } from "react";

const Confirm = ({ receipt }: { receipt: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(receipt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = receipt;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border border-slate-200 bg-white p-10 shadow-xl">
        <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-emerald-100 text-4xl text-emerald-700">
          ✅
        </div>
        <div className="mt-8 text-center">
          <h2 className="text-3xl font-semibold text-slate-900">Vote Recorded Successfully</h2>
          <p className="mt-3 text-slate-600">Your vote has been securely stored on the Ethereum blockchain.</p>
        </div>

        <div className="mt-10 rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm" id="receipt-card">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Receipt ID</p>
              <p className="mt-2 break-words text-sm font-medium text-slate-900">{receipt}</p>
            </div>
            <button
              className="inline-flex h-12 items-center justify-center rounded-2xl bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
              onClick={handleCopy}
              title={copied ? "Copied!" : "Copy to clipboard"}
              aria-label="Copy receipt to clipboard"
              id="copy-receipt-btn"
            >
              {copied ? "✓ Copied" : "📋 Copy"}
            </button>
          </div>
        </div>

        <div className="mt-8 rounded-3xl border border-emerald-100 bg-emerald-50 p-6 text-slate-700">
          <div className="flex items-start gap-3">
            <span className="mt-1 text-2xl">💡</span>
            <p className="text-sm leading-6">
              Save this receipt ID. You can use it to verify your vote was counted without revealing your identity. Go to the <strong>Verify</strong> tab to check anytime.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Confirm;
