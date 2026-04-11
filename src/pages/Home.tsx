import { useState } from "react";
import { generateCode, getCodeFromURL, setCodeInURL } from "../utils/roomCode";

interface HomeProps {
  onStart: (roomCode: string, isHost: boolean) => void;
}

export function Home({ onStart }: HomeProps) {
  const prefilled = getCodeFromURL() ?? "";
  const [joinCode, setJoinCode] = useState(prefilled);
  const [joinError, setJoinError] = useState("");

  const handleStart = () => {
    const code = generateCode();
    setCodeInURL(code);
    onStart(code, true);
  };

  const handleJoin = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setJoinError("Please enter a session code.");
      return;
    }
    setCodeInURL(code);
    onStart(code, false);
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/* Logo / title */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-violet-600 rounded-2xl mb-4 shadow-lg shadow-violet-900/50">
            <svg
              className="w-8 h-8 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                d="M15 10l4.553-2.069A1 1 0 0121 8.806v6.388a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"
              />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">
            watchtogether
          </h1>
          <p className="text-zinc-400 mt-2 text-sm">
            Video call + sync YouTube. No login required.
          </p>
        </div>

        <div className="space-y-4">
          {/* Start Session */}
          <button
            onClick={handleStart}
            className="w-full bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white font-semibold py-3.5 px-5 rounded-2xl transition-colors shadow-lg shadow-violet-900/40 text-sm"
          >
            Start Session
          </button>

          <div className="flex items-center gap-3 text-zinc-600 text-xs">
            <div className="flex-1 h-px bg-zinc-800" />
            or join an existing one
            <div className="flex-1 h-px bg-zinc-800" />
          </div>

          {/* Join Session */}
          <div className="space-y-2">
            <input
              type="text"
              value={joinCode}
              onChange={(e) => {
                setJoinCode(e.target.value.toUpperCase());
                setJoinError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              placeholder="Enter session code"
              className={`w-full bg-zinc-900 border ${
                joinError
                  ? "border-red-500"
                  : "border-zinc-700 focus:border-violet-500"
              } text-white font-mono placeholder:text-zinc-600 text-sm rounded-xl px-4 py-3 outline-none transition-colors`}
              spellCheck={false}
              autoCapitalize="characters"
            />
            {joinError && (
              <p className="text-red-400 text-xs pl-1">{joinError}</p>
            )}
            <button
              onClick={handleJoin}
              className="w-full bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-200 font-semibold py-3.5 px-5 rounded-2xl transition-colors text-sm"
            >
              Join Session
            </button>
          </div>
        </div>

        <p className="text-zinc-700 text-xs text-center mt-8">
          Sessions are peer-to-peer. No data leaves your browser.
        </p>
      </div>
    </div>
  );
}
