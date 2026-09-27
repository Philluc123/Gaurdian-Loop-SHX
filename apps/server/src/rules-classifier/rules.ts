// Rule table: pattern list, weights, and speaker scoping for rule-based
// signal detection. Data-driven by design — adding a rule is "add a row",
// not "write new logic" (see matcher.ts for how a row is evaluated).
//
// Weight scale (this module owns it; see IMPLEMENTATION_PROMPT.md):
//   10-15  weak/ambiguous-alone   (URGENCY, SECRECY, VICTIM_RESISTANCE)
//   20-25  strong/unambiguous     (IMPERSONATION, THREAT, VICTIM_COMPLIANCE)
//   30-40  high severity          (UNTRACEABLE_PAYMENT, REMOTE_ACCESS,
//                                  CREDENTIAL_REQUEST, VICTIM_DISCLOSURE)

import type { Signal, Speaker } from "@guardian-loop/shared-types";
import type { Pattern } from "./matcher";

export interface Rule {
  id: string;
  signal: Signal;
  speaker: Speaker;
  weight: number;
  patterns: Pattern[];
}

// `window` defaults to the term count (a tight, near-adjacent match).
// Pass an explicit window to tolerate filler words in between (e.g. a
// brand name between "buy" and "gift card").
function pat(terms: string[], window?: number): Pattern {
  return { terms, window: window ?? terms.length };
}

export const RULES: Rule[] = [
  // --- IMPERSONATION (caller) ---
  {
    id: "impersonation.government_agency",
    signal: "IMPERSONATION",
    speaker: "caller",
    weight: 22,
    patterns: [
      pat(["social", "security", "administration"]),
      pat(["medicare"]),
      pat(["irs"]),
      pat(["internal", "revenue", "service"]),
    ],
  },
  {
    id: "impersonation.tech_support",
    signal: "IMPERSONATION",
    speaker: "caller",
    weight: 20,
    patterns: [pat(["tech", "support"]), pat(["microsoft", "support"]), pat(["apple", "support"])],
  },
  {
    id: "impersonation.bank",
    signal: "IMPERSONATION",
    speaker: "caller",
    weight: 22,
    patterns: [pat(["your", "bank", "account"]), pat(["fraud", "department"])],
  },
  {
    id: "impersonation.utility_company",
    signal: "IMPERSONATION",
    speaker: "caller",
    weight: 20,
    patterns: [pat(["power", "company"]), pat(["electric", "company"]), pat(["utility", "company"])],
  },
  {
    id: "impersonation.family_emergency",
    signal: "IMPERSONATION",
    speaker: "caller",
    weight: 25,
    patterns: [pat(["this", "is", "your", "grandson"]), pat(["this", "is", "your", "granddaughter"])],
  },

  // --- URGENCY (caller) ---
  {
    id: "urgency.right_now",
    signal: "URGENCY",
    speaker: "caller",
    weight: 12,
    patterns: [pat(["right", "now", "or"]), pat(["act", "right", "now"])],
  },
  {
    id: "urgency.no_delay",
    signal: "URGENCY",
    speaker: "caller",
    weight: 12,
    patterns: [pat(["do", "not", "wait"]), pat(["dont", "wait"]), pat(["dont", "hang", "up"])],
  },
  {
    id: "urgency.deadline",
    signal: "URGENCY",
    speaker: "caller",
    weight: 15,
    patterns: [pat(["today", "only"]), pat(["ten", "minutes"], 3), pat(["before", "its", "too", "late"])],
  },
  {
    id: "urgency.immediate",
    signal: "URGENCY",
    speaker: "caller",
    weight: 10,
    patterns: [pat(["immediately"])],
  },

  // --- SECRECY (caller) ---
  {
    id: "secrecy.dont_tell",
    signal: "SECRECY",
    speaker: "caller",
    weight: 14,
    patterns: [pat(["dont", "tell"])],
  },
  {
    id: "secrecy.confidential",
    signal: "SECRECY",
    speaker: "caller",
    weight: 12,
    patterns: [pat(["confidential"])],
  },
  {
    id: "secrecy.between_us",
    signal: "SECRECY",
    speaker: "caller",
    weight: 10,
    patterns: [pat(["between", "us"]), pat(["keep", "this", "between"], 4)],
  },

  // --- UNTRACEABLE_PAYMENT (caller) ---
  {
    id: "payment.gift_card",
    signal: "UNTRACEABLE_PAYMENT",
    speaker: "caller",
    weight: 35,
    patterns: [pat(["buy", "gift", "card"], 6), pat(["purchase", "gift", "card"], 6)],
  },
  {
    id: "payment.wire_transfer",
    signal: "UNTRACEABLE_PAYMENT",
    speaker: "caller",
    weight: 32,
    patterns: [
      pat(["wire", "funds"], 4),
      pat(["wire", "transfer"]),
      pat(["western", "union"]),
      pat(["moneygram"]),
    ],
  },
  {
    id: "payment.cryptocurrency",
    signal: "UNTRACEABLE_PAYMENT",
    speaker: "caller",
    weight: 30,
    patterns: [pat(["bitcoin"]), pat(["cryptocurrency"]), pat(["crypto"])],
  },

  // --- REMOTE_ACCESS (caller) ---
  {
    id: "remote_access.remote_desktop_app",
    signal: "REMOTE_ACCESS",
    speaker: "caller",
    weight: 34,
    patterns: [pat(["anydesk"]), pat(["teamviewer"]), pat(["team", "viewer"]), pat(["logmein"])],
  },
  {
    id: "remote_access.access_request",
    signal: "REMOTE_ACCESS",
    speaker: "caller",
    weight: 32,
    patterns: [pat(["access", "your", "computer"]), pat(["control", "your", "computer"])],
  },
  {
    id: "remote_access.download_app",
    signal: "REMOTE_ACCESS",
    speaker: "caller",
    weight: 30,
    patterns: [pat(["download", "app"], 4)],
  },

  // --- CREDENTIAL_REQUEST (caller) ---
  {
    id: "credential.otp",
    signal: "CREDENTIAL_REQUEST",
    speaker: "caller",
    weight: 36,
    patterns: [pat(["one", "time", "passcode"]), pat(["one", "time", "password"]), pat(["verification", "code"])],
  },
  {
    id: "credential.pin",
    signal: "CREDENTIAL_REQUEST",
    speaker: "caller",
    weight: 32,
    patterns: [pat(["pin"])],
  },
  {
    id: "credential.ssn",
    signal: "CREDENTIAL_REQUEST",
    speaker: "caller",
    weight: 38,
    // "your" separates asking for one from a caller stating their own. When speech-to-text
    // splits "…hand me your | Social Security number", runRules' previousText joins it.
    patterns: [pat(["your", "social", "security", "number"]), pat(["ssn"])],
  },
  {
    id: "credential.card",
    signal: "CREDENTIAL_REQUEST",
    speaker: "caller",
    weight: 36,
    patterns: [
      pat(["your", "credit", "card", "number"]),
      pat(["your", "debit", "card", "number"]),
      pat(["your", "card", "number"]),
      pat(["cvv"]),
      pat(["security", "code", "on", "the", "back"], 6),
    ],
  },
  {
    id: "credential.bank",
    signal: "CREDENTIAL_REQUEST",
    speaker: "caller",
    weight: 36,
    patterns: [
      pat(["your", "bank", "account", "number"]),
      pat(["your", "checking", "account", "number"]),
      pat(["your", "routing", "number"]),
      pat(["routing", "and", "account", "number"]),
    ],
  },
  {
    id: "credential.login",
    signal: "CREDENTIAL_REQUEST",
    speaker: "caller",
    weight: 36,
    patterns: [pat(["your", "password"]), pat(["your", "passcode"]), pat(["your", "login"])],
  },
  {
    id: "credential.medicare",
    signal: "CREDENTIAL_REQUEST",
    speaker: "caller",
    weight: 36,
    // "your" keeps a caller merely naming Medicare (impersonation) from counting here.
    patterns: [pat(["your", "medicare", "number"]), pat(["your", "medicare", "card", "number"]), pat(["your", "medicare", "id"])],
  },
  {
    id: "credential.read_out",
    signal: "CREDENTIAL_REQUEST",
    speaker: "caller",
    weight: 20,
    patterns: [pat(["read", "it", "out"]), pat(["read", "me", "the", "numbers"], 5)],
  },

  // --- THREAT (caller) ---
  {
    id: "threat.warrant",
    signal: "THREAT",
    speaker: "caller",
    weight: 22,
    patterns: [pat(["warrant"])],
  },
  {
    id: "threat.arrest",
    signal: "THREAT",
    speaker: "caller",
    weight: 24,
    patterns: [pat(["arrest"]), pat(["arrested"])],
  },
  {
    id: "threat.legal_consequence",
    signal: "THREAT",
    speaker: "caller",
    weight: 20,
    patterns: [pat(["lawsuit"]), pat(["sue", "you"])],
  },
  {
    id: "threat.frozen_account",
    signal: "THREAT",
    speaker: "caller",
    weight: 22,
    patterns: [pat(["account", "frozen"]), pat(["freeze", "your", "account"])],
  },
  {
    id: "threat.detention",
    signal: "THREAT",
    speaker: "caller",
    weight: 20,
    patterns: [pat(["jail"]), pat(["deportation"]), pat(["deported"])],
  },

  // --- VICTIM_COMPLIANCE (victim) ---
  {
    id: "victim_compliance.agree_to_pay",
    signal: "VICTIM_COMPLIANCE",
    speaker: "victim",
    weight: 22,
    patterns: [
      pat(["im", "on", "my", "way"]),
      pat(["im", "leaving", "for", "the", "store"]),
      pat(["im", "heading", "to", "the", "store"]),
    ],
  },
  {
    id: "victim_compliance.confirms_purchase",
    signal: "VICTIM_COMPLIANCE",
    speaker: "victim",
    weight: 24,
    patterns: [pat(["already", "bought", "gift", "card"], 6), pat(["already", "got", "gift", "card"], 6)],
  },
  {
    id: "victim_compliance.reads_numbers",
    signal: "VICTIM_COMPLIANCE",
    speaker: "victim",
    weight: 20,
    patterns: [pat(["im", "ready", "to", "give", "you"])],
  },

  // --- VICTIM_DISCLOSURE (victim) ---
  {
    id: "victim_disclosure.ssn",
    signal: "VICTIM_DISCLOSURE",
    speaker: "victim",
    weight: 38,
    patterns: [pat(["social", "security", "number"])],
  },
  {
    id: "victim_disclosure.otp",
    signal: "VICTIM_DISCLOSURE",
    speaker: "victim",
    weight: 36,
    patterns: [pat(["one", "time", "code"])],
  },
  {
    id: "victim_disclosure.card_number",
    signal: "VICTIM_DISCLOSURE",
    speaker: "victim",
    weight: 32,
    patterns: [pat(["numbers", "on", "the", "back"])],
  },

  // --- VICTIM_RESISTANCE (victim) ---
  {
    id: "victim_resistance.names_scam",
    signal: "VICTIM_RESISTANCE",
    speaker: "victim",
    weight: 14,
    patterns: [pat(["sounds", "like", "a", "scam"])],
  },
  {
    id: "victim_resistance.hangs_up",
    signal: "VICTIM_RESISTANCE",
    speaker: "victim",
    weight: 12,
    patterns: [pat(["hang", "up", "and", "call"])],
  },
  {
    id: "victim_resistance.disbelief",
    signal: "VICTIM_RESISTANCE",
    speaker: "victim",
    weight: 10,
    patterns: [pat(["dont", "believe", "you"])],
  },
];
