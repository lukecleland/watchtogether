import { useEffect, useRef, useState } from "react";

/**
 * SummonButton — pull someone into this room through whatever app you'd
 * normally message them in.
 *
 * ## Why a share sheet rather than our own buttons
 * `navigator.share()` opens the device's own share sheet, which already lists
 * every messaging app the user actually has installed and already knows their
 * contacts. One call covers WhatsApp, Messages, Mail, Signal and the rest,
 * with nothing to keep up to date as people change apps.
 *
 * Where it isn't supported — Firefox, and desktop browsers generally — we fall
 * back to a small menu of explicit links. Those cover the common cases without
 * pretending to be the whole address book.
 *
 * ## No "who's calling" field
 * The invite travels from the sender's own WhatsApp or Messages account, so
 * the channel already says who it's from. A name field here would be asking
 * for something the recipient can already see.
 *
 * ## The room is a doorbell, not a calendar invite
 * A room only exists while someone is in it — the code is a live PeerJS peer
 * id, not a record on a server. So the wording is "join now" rather than
 * anything that implies the link keeps working tomorrow.
 */

interface SummonButtonProps {
  roomCode: string;
  /**
   * `bar` is the permanent button in the session's top bar, showing the room
   * code. `prompt` is the filled one inside the "nobody here yet" card — same
   * behaviour, more weight, and no code (the card is about the person, not
   * the number).
   */
  variant?: "bar" | "prompt";
}

const INVITE_TEXT = "Join my watchtogether room:";

/**
 * iOS and Android disagree on `sms:` parameter syntax — iOS wants `&body=`
 * after the (empty) recipient, Android wants `?body=`. Getting this wrong
 * opens the messaging app with an empty message, which looks like the feature
 * simply doesn't work.
 */
function isIOS(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac, distinguishable only by touch support
  return /iP(hone|ad|od)/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1);
}

export function SummonButton({ roomCode, variant = "bar" }: SummonButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  // Clicking away closes the menu, so it never sits open over the canvas
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Built fresh each time rather than read from window.location, so the room
  // parameter is right even if something else has touched the URL.
  const inviteUrl = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomCode);
    return url.toString();
  };

  const handleSummon = () => {
    const url = inviteUrl();

    // `navigator.share` has to be called synchronously inside the click
    // handler — awaiting anything first loses the user gesture and Safari
    // silently refuses to open the sheet.
    if (typeof navigator.share === "function") {
      navigator
        .share({ title: "watchtogether", text: INVITE_TEXT, url })
        .catch(() => {
          // Cancelling the sheet rejects too; there is nothing to report
        });
      return;
    }
    setMenuOpen((open) => !open);
  };

  const copyLink = () => {
    const url = inviteUrl();
    navigator.clipboard.writeText(url).catch(() => {
      // Clipboard can be blocked; the code stays readable on the button
    });
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  };

  const shareLinks = () => {
    const url = inviteUrl();
    const message = `${INVITE_TEXT} ${url}`;
    return [
      {
        key: "sms",
        label: "Message",
        href: `sms:${isIOS() ? "&" : "?"}body=${encodeURIComponent(message)}`,
      },
      {
        key: "whatsapp",
        label: "WhatsApp",
        // wa.me with no number opens a contact picker in the app or web client
        href: `https://wa.me/?text=${encodeURIComponent(message)}`,
      },
      {
        key: "email",
        label: "Email",
        href: `mailto:?subject=${encodeURIComponent(
          "Join my watchtogether room",
        )}&body=${encodeURIComponent(message)}`,
      },
    ];
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        onClick={handleSummon}
        className={
          variant === "prompt"
            ? "flex items-center gap-1.5 bg-violet-600 hover:bg-violet-500 active:bg-violet-700 border border-violet-400 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
            : "flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-mono px-2 sm:px-3 py-1.5 rounded-lg transition-colors"
        }
        // Both variants can be on screen at once, so they must not read
        // identically to a screen reader.
        title={
          variant === "prompt"
            ? `Summon a friend to room ${roomCode}`
            : `Summon someone to room ${roomCode}`
        }
        aria-label={
          variant === "prompt"
            ? `Summon a friend to room ${roomCode}`
            : `Summon someone to room ${roomCode}`
        }
        aria-haspopup={typeof navigator.share === "function" ? undefined : "menu"}
        aria-expanded={typeof navigator.share === "function" ? undefined : menuOpen}
      >
        {variant === "bar" && <span className="hidden sm:inline">{roomCode}</span>}
        {/* Outward arrow — the same gesture every platform uses for "send this
            somewhere else", so it reads before the label does. */}
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 4v12M12 4L8 8m4-4l4 4M5 14v4a2 2 0 002 2h10a2 2 0 002-2v-4"
          />
        </svg>
        <span className={variant === "prompt" ? undefined : "hidden sm:inline"}>
          Summon
        </span>
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute right-0 top-full mt-1.5 w-44 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-xl p-1 shadow-xl"
          style={{ zIndex: 1000 }}
        >
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] uppercase tracking-wide text-zinc-500">
            Summon by
          </p>
          {shareLinks().map((link) => (
            <a
              key={link.key}
              role="menuitem"
              href={link.href}
              target="_blank"
              rel="noreferrer"
              onClick={() => setMenuOpen(false)}
              className="block px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              {link.label}
            </a>
          ))}
          <button
            role="menuitem"
            onClick={copyLink}
            className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            {copied ? "Link copied" : "Copy link"}
          </button>
        </div>
      )}
    </div>
  );
}
