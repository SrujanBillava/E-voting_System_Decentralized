import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Voting from "../components/Voting";
import Confirm from "../components/Confirm";
import Verify from "../components/Verify";
import Results from "../components/Results";
import { useAuth } from "../context/AuthContext";
import { LogOut, Vote, Search, BarChart3, MapPin } from "lucide-react";

export default function Home() {
  const [step, setStep] = useState(0);
  const [receipt, setReceipt] = useState("");
  const [activeTab, setActiveTab] = useState<"vote" | "verify" | "results">("vote");
  const [selectedBooth, setSelectedBooth] = useState("Bengaluru Booth 01");
  const { logout } = useAuth();
  const navigate = useNavigate();

  const voter = sessionStorage.getItem("voterObject")
    ? JSON.parse(sessionStorage.getItem("voterObject")!)
    : null;

  const handleSignOut = () => {
    logout();
    navigate("/login");
  };

  const handleTabChange = (tab: "vote" | "verify" | "results") => {
    setActiveTab(tab);
    if (tab === "vote") setStep(1);
    else if (tab === "verify") setStep(3);
    else setStep(4);
  };

  const tabClass = (isActive: boolean) =>
    `inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-xs font-bold transition duration-200 ${
      isActive
        ? "bg-blue-600 text-white shadow-lg shadow-blue-600/25"
        : "bg-white text-slate-700 shadow-sm hover:bg-slate-50 border border-slate-200/80"
    }`;

  return (
    <div className="min-h-screen bg-slate-100/70 text-slate-900 pb-16">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <header className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white px-6 py-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-2xl text-white shadow-md shadow-blue-500/20">
              🗳️
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-blue-600">VoteChain Protocol</p>
              <h1 className="text-xl font-extrabold text-slate-900 tracking-tight">Decentralized E-Voting Portal</h1>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-slate-50 border border-slate-200/80 px-4 py-2.5 text-xs text-slate-700 shadow-sm">
              {voter ? (
                <span className="inline-flex items-center gap-2 font-medium">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <strong>{voter.name}</strong> • {voter.constituency}
                </span>
              ) : (
                <span>Guest Voter</span>
              )}
            </div>

            <button
              onClick={handleSignOut}
              className="p-2.5 rounded-2xl border border-slate-200 bg-white hover:bg-red-50 hover:text-red-600 hover:border-red-200 text-slate-500 transition shadow-sm"
              title="Sign Out"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {/* Navigation Tabs & Booth Selector */}
        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex flex-wrap gap-2">
            <button
              className={tabClass(activeTab === "vote")}
              onClick={() => handleTabChange("vote")}
              id="nav-vote"
            >
              <Vote size={16} /> Ballot Voting
            </button>
            <button
              className={tabClass(activeTab === "verify")}
              onClick={() => handleTabChange("verify")}
              id="nav-verify"
            >
              <Search size={16} /> Verify Receipt
            </button>
            <button
              className={tabClass(activeTab === "results")}
              onClick={() => handleTabChange("results")}
              id="nav-results"
            >
              <BarChart3 size={16} /> Live On-Chain Results
            </button>
          </div>

          {/* Location / Booth Switcher */}
          {activeTab === "vote" && (
            <div className="flex items-center gap-2">
              <MapPin size={16} className="text-slate-400" />
              <span className="text-xs font-semibold text-slate-500">Polling Booth:</span>
              <select
                value={selectedBooth}
                onChange={(e) => setSelectedBooth(e.target.value)}
                className="text-xs font-bold text-slate-800 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                <option value="Bengaluru Booth 01">Bengaluru Booth 01</option>
                <option value="Delhi Booth 04">Delhi Booth 04</option>
                <option value="Mumbai Booth 02">Mumbai Booth 02</option>
              </select>
            </div>
          )}
        </div>

        {/* Main Content Area */}
        <main className="space-y-6">
          {step === 0 && (
            <section className="rounded-3xl border border-slate-200 bg-gradient-to-br from-blue-600 via-indigo-600 to-indigo-800 p-8 sm:p-12 text-white shadow-xl">
              <div className="max-w-2xl space-y-6">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur-md text-xs font-semibold text-blue-100">
                  ✨ Location-Independent Smart Balloting
                </div>
                <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
                  Welcome to Official Voting
                </h2>
                <p className="text-sm sm:text-base leading-relaxed text-blue-100">
                  You are registered under <strong>{voter?.constituency || "Bengaluru"}</strong> constituency.
                  Even if you are currently at <strong>{selectedBooth}</strong>, you will seamlessly vote for candidates in your home constituency.
                </p>

                <button
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white px-8 py-4 text-sm font-bold text-blue-700 shadow-lg transition hover:scale-105 active:scale-95"
                  onClick={() => {
                    setActiveTab("vote");
                    setStep(1);
                  }}
                  id="start-voting-btn"
                >
                  <Vote size={18} /> Proceed to Ballot →
                </button>
              </div>
            </section>
          )}

          {step === 1 && (
            <div className="animate-fade-in-up">
              <Voting
                voter={voter || { name: "Demo Voter", constituency: "Bengaluru" }}
                booth={selectedBooth}
                setReceipt={setReceipt}
                next={() => setStep(2)}
              />
            </div>
          )}

          {step === 2 && (
            <div className="animate-fade-in-up">
              <Confirm receipt={receipt} />
            </div>
          )}

          {step === 3 && (
            <div className="animate-fade-in-up">
              <Verify />
            </div>
          )}

          {step === 4 && (
            <div className="animate-fade-in-up">
              <Results />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
