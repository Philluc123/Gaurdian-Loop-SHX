// Unit tests for the rules classifier (docs/module-contracts.md §3.4).
//
// This suite is intentionally written before `./index.ts` exists, so the first
// run will fail to resolve the import below — that's expected. Implement
// `runRules` (and re-export `RuleHit`) from `./index.ts` until every case here
// passes. See IMPLEMENTATION_PROMPT.md in this folder for the full spec.
//
// This suite doubles as documentation of what the rules catch: add a row to
// the relevant table whenever you add or tighten a rule.

import { describe, expect, it } from "vitest";
import type { Signal, Speaker } from "@guardian-loop/shared-types";
import { runRules, type RuleHit } from "./index";

interface PositiveCase {
  desc: string;
  speaker: Speaker;
  text: string;
  signal: Signal;
  ruleIdPrefix: string; // namespace convention, e.g. "payment." for payment.gift_card
}

interface NegativeCase {
  desc: string;
  speaker: Speaker;
  text: string;
}

// --- Positive cases: one clean phrasing + one with realistic ASR noise per signal ---
const positiveCases: PositiveCase[] = [
  // IMPERSONATION
  {
    desc: "[IMPERSONATION] caller claims to be a government agency",
    speaker: "caller",
    text: "This is Officer Daniels with the Social Security Administration, your number has been suspended.",
    signal: "IMPERSONATION",
    ruleIdPrefix: "impersonation.",
  },
  {
    desc: "[IMPERSONATION] caller claims to be Medicare (ASR noise: 'Medicaire')",
    speaker: "caller",
    text: "This is Medicaire calling to verify your information before we issue your new benefits card.",
    signal: "IMPERSONATION",
    ruleIdPrefix: "impersonation.",
  },

  // URGENCY
  {
    desc: "[URGENCY] caller demands immediate action",
    speaker: "caller",
    text: "You need to act right now or your account will be permanently closed today.",
    signal: "URGENCY",
    ruleIdPrefix: "urgency.",
  },
  {
    desc: "[URGENCY] caller sets an artificial deadline (ASR noise: 'ten minuts')",
    speaker: "caller",
    text: "Act immediately, this offer expires in the next ten minuts, do not wait.",
    signal: "URGENCY",
    ruleIdPrefix: "urgency.",
  },

  // SECRECY
  {
    desc: "[SECRECY] caller asks victim to keep the call secret",
    speaker: "caller",
    text: "Please don't tell your daughter or anyone else about this call, it needs to stay between us.",
    signal: "SECRECY",
    ruleIdPrefix: "secrecy.",
  },
  {
    desc: "[SECRECY] caller asks for confidentiality (ASR noise: 'confidencial')",
    speaker: "caller",
    text: "Keep this confidencial and don't mention it to your family until it's resolved.",
    signal: "SECRECY",
    ruleIdPrefix: "secrecy.",
  },

  // UNTRACEABLE_PAYMENT
  {
    desc: "[UNTRACEABLE_PAYMENT] caller demands gift cards",
    speaker: "caller",
    text: "Go to the nearest pharmacy and buy three $500 Google Play gift cards.",
    signal: "UNTRACEABLE_PAYMENT",
    ruleIdPrefix: "payment.",
  },
  {
    desc: "[UNTRACEABLE_PAYMENT] caller says 'gift cart' (documented ASR error)",
    speaker: "caller",
    text: "You'll need to buy some gift cart, I mean gift card, and read me the numbers on the back.",
    signal: "UNTRACEABLE_PAYMENT",
    ruleIdPrefix: "payment.",
  },
  {
    desc: "[UNTRACEABLE_PAYMENT] caller demands a wire transfer",
    speaker: "caller",
    text: "Wire the funds directly to this account through Western Union within the hour.",
    signal: "UNTRACEABLE_PAYMENT",
    ruleIdPrefix: "payment.",
  },

  // REMOTE_ACCESS
  {
    desc: "[REMOTE_ACCESS] caller asks to install AnyDesk",
    speaker: "caller",
    text: "I'm going to send you a link, please download AnyDesk so I can access your computer remotely.",
    signal: "REMOTE_ACCESS",
    ruleIdPrefix: "remote_access.",
  },
  {
    desc: "[REMOTE_ACCESS] caller asks to install TeamViewer (ASR noise: 'Team Viewer')",
    speaker: "caller",
    text: "Install Team Viewer so I can fix the virus on your computer right now.",
    signal: "REMOTE_ACCESS",
    ruleIdPrefix: "remote_access.",
  },

  // CREDENTIAL_REQUEST
  {
    desc: "[CREDENTIAL_REQUEST] caller asks for a one-time passcode",
    speaker: "caller",
    text: "I need you to read me the one-time passcode that was just texted to your phone.",
    signal: "CREDENTIAL_REQUEST",
    ruleIdPrefix: "credential.",
  },
  {
    desc: "[CREDENTIAL_REQUEST] caller asks for a debit card PIN (ASR noise: 'pin number')",
    speaker: "caller",
    text: "What's the pin number on your debit card?",
    signal: "CREDENTIAL_REQUEST",
    ruleIdPrefix: "credential.",
  },

  // THREAT
  {
    desc: "[THREAT] caller threatens arrest",
    speaker: "caller",
    text: "If you don't pay today, a warrant will be issued for your arrest.",
    signal: "THREAT",
    ruleIdPrefix: "threat.",
  },
  {
    desc: "[THREAT] caller threatens same-day arrest (ASR noise: 'arested')",
    speaker: "caller",
    text: "You'll be arested this afternoon if the payment isn't received.",
    signal: "THREAT",
    ruleIdPrefix: "threat.",
  },

  // VICTIM_COMPLIANCE
  {
    desc: "[VICTIM_COMPLIANCE] victim agrees to get gift cards",
    speaker: "victim",
    text: "Okay, I'm leaving for the store right now to get the gift cards.",
    signal: "VICTIM_COMPLIANCE",
    ruleIdPrefix: "victim_compliance.",
  },
  {
    desc: "[VICTIM_COMPLIANCE] victim confirms purchase (ASR noise: 'gift cart')",
    speaker: "victim",
    text: "Alright, I already bought the gift cart and I'm ready to give you the numbers.",
    signal: "VICTIM_COMPLIANCE",
    ruleIdPrefix: "victim_compliance.",
  },

  // VICTIM_DISCLOSURE
  {
    desc: "[VICTIM_DISCLOSURE] victim reads out their SSN",
    speaker: "victim",
    text: "My social security number is 412-89-2231.",
    signal: "VICTIM_DISCLOSURE",
    ruleIdPrefix: "victim_disclosure.",
  },
  {
    desc: "[VICTIM_DISCLOSURE] victim reads out a one-time code",
    speaker: "victim",
    text: "The one-time code is 482913.",
    signal: "VICTIM_DISCLOSURE",
    ruleIdPrefix: "victim_disclosure.",
  },

  // VICTIM_RESISTANCE
  {
    desc: "[VICTIM_RESISTANCE] victim names it as a scam and hangs up to verify",
    speaker: "victim",
    text: "This sounds like a scam, I'm going to hang up and call my bank directly.",
    signal: "VICTIM_RESISTANCE",
    ruleIdPrefix: "victim_resistance.",
  },
  {
    desc: "[VICTIM_RESISTANCE] victim refuses and says they'll verify independently (ASR noise: 'beleive')",
    speaker: "victim",
    text: "I don't beleive you, I'm calling the police non-emergency line to check.",
    signal: "VICTIM_RESISTANCE",
    ruleIdPrefix: "victim_resistance.",
  },
];

// --- Negative cases: adjacent vocabulary that must NOT trigger a hit ---
// These guard against naive keyword matching (e.g. matching on "card" or
// "secret" alone) rather than the full scam phrasing.
const legitimateCases: NegativeCase[] = [
  {
    desc: "mentions a library card, not a gift/payment card",
    speaker: "caller",
    text: "I need to renew my library card before it expires.",
  },
  {
    desc: "mentions a gift receipt, not a gift card purchase demand",
    speaker: "caller",
    text: "Can you send me the gift receipt for the sweater I returned?",
  },
  {
    desc: "casual callback with no time pressure",
    speaker: "caller",
    text: "I'll call you back this afternoon, no rush at all.",
  },
  {
    desc: "mentions 'secret' but isn't asking for secrecy about the call",
    speaker: "caller",
    text: "I already told my sister about the trip, it's not a secret.",
  },
  {
    desc: "family video call, not a remote-access request",
    speaker: "caller",
    text: "My grandson is visiting this weekend, he's teaching me how to video call.",
  },
  {
    desc: "ordinary scheduling question, no credential request",
    speaker: "caller",
    text: "Can you remind me what time our reservation is at?",
  },
  {
    desc: "a deadline with a mundane consequence, not a threat",
    speaker: "caller",
    text: "If you don't RSVP by Friday, we'll assume you can't make the party.",
  },
  {
    desc: "victim agrees to a benign errand, not a scam-adjacent action",
    speaker: "victim",
    text: "Sure, I can pick up milk on my way home.",
  },
  {
    desc: "victim shares a mailing address, not a sensitive credential",
    speaker: "victim",
    text: "My address is 42 Ocean Drive if you need it for the invoice.",
  },
  {
    desc: "victim declines a scheduling request, not scam resistance",
    speaker: "victim",
    text: "I don't think I'm free Tuesday, can we reschedule?",
  },
  {
    desc: "empty small talk",
    speaker: "caller",
    text: "Hi, how's the weather over there today?",
  },
];

// --- Speaker-gating cases: same trigger phrasing, wrong speaker for that signal ---
// Per module design, each rule is scoped to the speaker who would plausibly say
// it (caller for scammer-side signals, victim for victim-side signals); a match
// from the "wrong" speaker must not produce a hit for that rule.
const speakerGatedCases: NegativeCase[] = [
  {
    desc: "victim echoing a government-agency phrase isn't the caller impersonating",
    speaker: "victim",
    text: "Wait, this is the Social Security Administration, right?",
  },
  {
    desc: "victim asking about buying a gift card isn't the caller demanding payment",
    speaker: "victim",
    text: "Should I just buy a gift card for him?",
  },
  {
    desc: "victim asking whether to install AnyDesk isn't the caller requesting remote access",
    speaker: "victim",
    text: "Should I download AnyDesk like he asked?",
  },
  {
    desc: "caller reading out a one-time code isn't a victim disclosure",
    speaker: "caller",
    text: "The one-time code is 482913.",
  },
  {
    desc: "caller stating an SSN isn't a victim disclosure",
    speaker: "caller",
    text: "My social security number is 412-89-2231.",
  },
  {
    desc: "caller getting gift cards isn't victim compliance",
    speaker: "caller",
    text: "Okay, I'm leaving for the store right now to get the gift cards.",
  },
  {
    desc: "caller asking if this sounds like a scam isn't victim resistance",
    speaker: "caller",
    text: "This sounds like a scam, doesn't it?",
  },
];

describe("runRules", () => {
  it("is exported as a function", () => {
    expect(typeof runRules).toBe("function");
  });

  it("returns no hits for text with no matching patterns", () => {
    expect(runRules({ speaker: "caller", text: "Hi, how's the weather over there today?" })).toEqual([]);
  });

  describe("positive cases (one per signal, plus a realistic ASR-noise variant)", () => {
    it.each(positiveCases)("$desc", ({ speaker, text, signal, ruleIdPrefix }) => {
      const hits = runRules({ speaker, text });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.signal === signal)).toBe(true);
      expect(hits.some((h) => h.signal === signal && h.ruleId.startsWith(ruleIdPrefix))).toBe(true);
    });
  });

  describe("legitimate sentences (must not produce any hit)", () => {
    it.each(legitimateCases)("$desc", ({ speaker, text }) => {
      expect(runRules({ speaker, text })).toEqual([]);
    });
  });

  describe("speaker scoping (matching phrase from the wrong speaker produces no hit)", () => {
    it.each(speakerGatedCases)("$desc", ({ speaker, text }) => {
      expect(runRules({ speaker, text })).toEqual([]);
    });
  });

  describe("combos", () => {
    it("detects multiple distinct signals within a single segment", () => {
      const hits = runRules({
        speaker: "caller",
        text: "Don't tell your daughter, just go buy the gift cards and read me the numbers on the back.",
      });
      const signals = new Set(hits.map((h) => h.signal));
      expect(signals.has("SECRECY")).toBe(true);
      expect(signals.has("UNTRACEABLE_PAYMENT")).toBe(true);
      expect(hits.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("matching mechanics", () => {
    it("is case-insensitive", () => {
      const hits = runRules({
        speaker: "caller",
        text: "BUY A GIFT CARD RIGHT NOW OR YOUR ACCOUNT WILL BE CLOSED",
      });
      const signals = new Set(hits.map((h) => h.signal));
      expect(signals.has("UNTRACEABLE_PAYMENT")).toBe(true);
      expect(signals.has("URGENCY")).toBe(true);
    });

    it("reports start/end offsets that select `match` out of the original text", () => {
      const text = "Please buy a gift card today, don't wait.";
      const hits = runRules({ speaker: "caller", text });
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(hit.start).toBeGreaterThanOrEqual(0);
        expect(hit.end).toBeLessThanOrEqual(text.length);
        expect(hit.start).toBeLessThan(hit.end);
        expect(text.slice(hit.start, hit.end).toLowerCase()).toBe(hit.match.toLowerCase());
      }
    });

    it("every hit has a well-formed shape", () => {
      const allCases = [...positiveCases, ...legitimateCases, ...speakerGatedCases];
      for (const c of allCases) {
        const hits: RuleHit[] = runRules({ speaker: c.speaker, text: c.text });
        for (const hit of hits) {
          expect(typeof hit.ruleId).toBe("string");
          expect(hit.ruleId.length).toBeGreaterThan(0);
          expect(typeof hit.weight).toBe("number");
          expect(hit.weight).toBeGreaterThan(0);
          expect(typeof hit.match).toBe("string");
          expect(hit.match.length).toBeGreaterThan(0);
        }
      }
    });
  });
});
