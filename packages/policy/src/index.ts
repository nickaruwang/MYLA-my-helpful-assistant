import type { ApprovalMode, ModelRoute, PrivacyClass, RiskLevel } from "@myla/shared";

export interface IntentPolicyInput {
  text: string;
  toolName?: string;
  operation?: string;
}

export interface IntentPolicyDecision {
  riskLevel: RiskLevel;
  approvalMode: ApprovalMode;
  privacyClass: PrivacyClass;
  modelRoute: ModelRoute;
  reasons: string[];
}

const HIGH_RISK_PATTERNS = [
  /\bsend\b/i,
  /\btext\b/i,
  /\bmessage\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bunlock\b/i,
  /\bstart\b/i,
  /\bcharge\b/i,
  /\btransfer\b/i,
  /\bbuy\b/i,
  /\bsell\b/i,
  /\bpay\b/i
];

const SENSITIVE_PATTERNS = [
  /\btesla\b/i,
  /\bcar\b/i,
  /\bvehicle\b/i,
  /\bchase\b/i,
  /\brobinhood\b/i,
  /\bbank\b/i,
  /\bfinance\b/i,
  /\bportfolio\b/i,
  /\bimessage\b/i,
  /\bnotes?\b/i
];

const LOW_RISK_PATTERNS = [
  /\bdraft\b/i,
  /\bcalendar\b/i,
  /\bschedule\b/i,
  /\bdrive\b/i,
  /\blist\b/i,
  /\bread\b/i,
  /\bsummarize\b/i
];

export function classifyIntent(input: IntentPolicyInput): IntentPolicyDecision {
  const haystack = [input.text, input.toolName, input.operation].filter(Boolean).join(" ");
  const reasons: string[] = [];

  const privacyClass = classifyPrivacy(haystack);
  let riskLevel: RiskLevel = "read";

  if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(haystack))) {
    riskLevel = "high";
    reasons.push("Matched a high-impact action keyword.");
  } else if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(haystack))) {
    riskLevel = "sensitive";
    reasons.push("Matched a sensitive domain keyword.");
  } else if (LOW_RISK_PATTERNS.some((pattern) => pattern.test(haystack))) {
    riskLevel = "low";
    reasons.push("Matched a low-risk read or draft keyword.");
  } else {
    reasons.push("No tool or sensitive-domain trigger matched.");
  }

  const approvalMode: ApprovalMode =
    riskLevel === "high" || riskLevel === "sensitive" ? "manual" : riskLevel === "low" ? "notify" : "auto";

  const modelRoute: ModelRoute =
    privacyClass === "financial" || privacyClass === "vehicle" || privacyClass === "sensitive"
      ? "local"
      : "local";

  return {
    riskLevel,
    approvalMode,
    privacyClass,
    modelRoute,
    reasons
  };
}

export function classifyTool(toolName: string, operation: string, args: Record<string, unknown>): IntentPolicyDecision {
  return classifyIntent({
    text: JSON.stringify(args),
    toolName,
    operation
  });
}

function classifyPrivacy(text: string): PrivacyClass {
  if (/\b(chase|robinhood|bank|finance|portfolio|transaction|balance)\b/i.test(text)) {
    return "financial";
  }

  if (/\b(tesla|vehicle|car|charging|vin)\b/i.test(text)) {
    return "vehicle";
  }

  if (/\b(imessage|message|notes?|gmail|email|drive|calendar)\b/i.test(text)) {
    return "personal";
  }

  return "public";
}
