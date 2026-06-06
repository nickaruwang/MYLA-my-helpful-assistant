export interface InferredToolIntent {
  toolName: string;
  args: Record<string, unknown>;
}

export function inferToolIntent(message: string): InferredToolIntent | undefined {
  if (/\b(calendar|schedule|agenda)\b/i.test(message)) {
    return {
      toolName: "google.calendar.read_schedule",
      args: {
        query: message,
        range: "requested_or_today"
      }
    };
  }

  if (/\b(draft|gmail draft|email draft)\b/i.test(message)) {
    return {
      toolName: "google.gmail.create_draft",
      args: {
        query: message,
        mode: "draft_only"
      }
    };
  }

  if (/\b(drive|google drive|files?)\b/i.test(message)) {
    return {
      toolName: "google.drive.list_files",
      args: {
        query: message,
        metadataOnly: true
      }
    };
  }

  if (/\b(send|text|message)\b/i.test(message) && /\b(imessage|apple|sms|text)\b/i.test(message)) {
    return {
      toolName: "apple.messages.send",
      args: {
        query: message,
        disabledInSkeleton: true
      }
    };
  }

  if (/\b(tesla|vehicle|car)\b/i.test(message)) {
    return {
      toolName: "tesla.vehicle.command",
      args: {
        query: message,
        disabledInSkeleton: true
      }
    };
  }

  return undefined;
}
