import { useState } from "react";
import { Server, Database, Shield } from "lucide-react";
import { CONTRACT_ADDRESS, RPC_URL } from "../../utils/contract";

export default function Settings() {
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="p-6 md:p-10 space-y-8 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-slate-900 tracking-tight">
          System & Security Settings
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Configuration parameters for Blockchain, Backend API, and Security
        </p>
      </div>

      <div className="grid gap-6">
        {/* Blockchain Node Settings */}
        <div className="bg-white rounded-3xl border border-slate-200 p-6 md:p-8 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2.5 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100">
              <Server size={22} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Blockchain Network (Ethereum)</h2>
              <p className="text-xs text-slate-500">Connected smart contract & RPC configuration</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-2xl bg-slate-50 border border-slate-100 gap-2">
              <div>
                <span className="text-xs font-semibold text-slate-500 block">Voting Smart Contract Address</span>
                <span className="text-sm font-mono font-bold text-slate-900 break-all">{CONTRACT_ADDRESS}</span>
              </div>
              <button
                onClick={() => handleCopy(CONTRACT_ADDRESS, "contract")}
                className="px-3 py-1.5 rounded-xl bg-white border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 self-start sm:self-auto shadow-sm"
              >
                {copied === "contract" ? "Copied!" : "Copy"}
              </button>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-2xl bg-slate-50 border border-slate-100 gap-2">
              <div>
                <span className="text-xs font-semibold text-slate-500 block">Local RPC Endpoint</span>
                <span className="text-sm font-mono font-bold text-slate-900">{RPC_URL}</span>
              </div>
              <button
                onClick={() => handleCopy(RPC_URL, "rpc")}
                className="px-3 py-1.5 rounded-xl bg-white border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 self-start sm:self-auto shadow-sm"
              >
                {copied === "rpc" ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        </div>

        {/* Database & API Configuration */}
        <div className="bg-white rounded-3xl border border-slate-200 p-6 md:p-8 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2.5 rounded-2xl bg-emerald-50 text-emerald-600 border border-emerald-100">
              <Database size={22} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Database & Backend API</h2>
              <p className="text-xs text-slate-500">MongoDB voter repository and API service status</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100">
              <span className="text-xs font-semibold text-slate-500 block">Backend API URL</span>
              <span className="text-sm font-semibold text-slate-900 mt-1 block">http://localhost:5000/api</span>
            </div>
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100">
              <span className="text-xs font-semibold text-slate-500 block">MongoDB Database</span>
              <span className="text-sm font-semibold text-slate-900 mt-1 block">mongodb://127.0.0.1:27017/evoting</span>
            </div>
          </div>
        </div>

        {/* 2FA Authenticator Info */}
        <div className="bg-white rounded-3xl border border-slate-200 p-6 md:p-8 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2.5 rounded-2xl bg-blue-50 text-blue-600 border border-blue-100">
              <Shield size={22} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Admin 2FA Security (Speakeasy TOTP)</h2>
              <p className="text-xs text-slate-500">Base32 Secret configured in .env for Time-Based One-Time Passwords</p>
            </div>
          </div>

          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500">Admin TOTP Secret:</span>
              <code className="text-xs font-mono font-bold bg-slate-200 px-2 py-1 rounded">JBSWY3DPEHPK3PXP</code>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              Use any Authenticator app (Google Authenticator, Microsoft Authenticator) with this secret key to generate 6-digit login codes.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}