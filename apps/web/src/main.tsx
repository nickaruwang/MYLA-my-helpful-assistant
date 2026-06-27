import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ApprovalRequest,
  ChatMessage,
  ChatResponse,
  MemoryFact,
  ProviderStatus,
  Session,
  ToolCallProposal,
  ToolTask,
  ToolResult
} from "@myla/shared";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const SESSION_STORAGE_KEY = "myla-session-id";

interface PublicTool {
  name: string;
  provider: string;
  description: string;
  riskLevel: string;
  approvalMode: string;
}

interface VoiceStatus {
  mode: string;
  ready: boolean;
  notes: string[];
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(() => localStorage.getItem(SESSION_STORAGE_KEY) ?? undefined);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolResults, setToolResults] = useState<ToolResult[]>([]);
  const [tasks, setTasks] = useState<ToolTask[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [memories, setMemories] = useState<MemoryFact[]>([]);
  const [memoryInput, setMemoryInput] = useState("");
  const [tools, setTools] = useState<PublicTool[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({ mode: "disabled", ready: false, notes: [] });
  const [auditStatus, setAuditStatus] = useState<string>("not checked");
  const [runStatus, setRunStatus] = useState<string>("idle");
  const [lastError, setLastError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);

  useEffect(() => {
    void refreshSessions();
    void refreshApprovals();
    void refreshTasks();
    void refreshMemory();
    void refreshTools();
    void refreshProviders();
    void refreshVoiceStatus();
    void verifyAudit();
  }, []);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    void loadMessages(sessionId);
    void refreshTasks(sessionId);
  }, [sessionId]);

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    await submitMessage(input, "chat");
  }

  async function submitMessage(message: string, inputMode: "chat" | "voice") {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    const optimisticSessionId = sessionId ?? "pending";
    const userMessage: ChatMessage = {
      id: `${crypto.randomUUID()}-user`,
      sessionId: optimisticSessionId,
      actor: "user",
      content: trimmed,
      correlationId: "pending",
      createdAt: new Date().toISOString()
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setBusy(true);
    setLastError(undefined);
    setRunStatus("Sending request to API...");

    const statusTimer = window.setInterval(() => {
      setRunStatus("Still working...");
    }, 10_000);

    try {
      const startedAt = performance.now();
      const payload = await requestChat({ sessionId, message: trimmed, inputMode });
      const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
      setSessionId(payload.sessionId);
      setMessages((current) => [
        ...current.filter((message) => message.id !== userMessage.id),
        {
          ...userMessage,
          sessionId: payload.sessionId,
          correlationId: payload.correlationId
        },
        payload.message
      ]);
      setToolResults((current) => [...payload.toolResults, ...current]);
      setTasks((current) => dedupeTasks([...payload.tasks, ...current]));
      setApprovals((current) => dedupeApprovals([...payload.approvals, ...current]));
      setProviders(payload.providerStatuses);
      setMemories((current) => dedupeMemories([...payload.storedMemories, ...current]));
      setRunStatus(
        `Completed in ${elapsedSeconds}s. Tools: ${payload.toolResults.length}. Approvals: ${payload.approvals.length}.`
      );
      speak(payload.message.content);
      void (async () => {
        try {
          await Promise.all([verifyAudit(), refreshSessions(), refreshMemory(), refreshTasks(payload.sessionId), refreshProviders()]);
        } catch (error) {
          console.warn("Post-response refresh failed", error);
        }
      })();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed.";
      setLastError(message);
      setRunStatus("Request failed.");
      setMessages((current) => [
        ...current,
        {
          id: `${crypto.randomUUID()}-error`,
          sessionId: sessionId ?? "pending",
          actor: "system",
          content: `Request failed: ${message}`,
          correlationId: "error",
          createdAt: new Date().toISOString()
        }
      ]);
    } finally {
      window.clearInterval(statusTimer);
      setBusy(false);
    }
  }

  async function requestChat(body: { sessionId?: string; message: string; inputMode: "chat" | "voice" }) {
    const response = await fetch(`${API_URL}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    const payload = (await response.json().catch(async () => ({
      error: await response.text()
    }))) as unknown;

    if (!response.ok) {
      throw new Error(formatApiError(payload, response.status));
    }

    return payload as ChatResponse;
  }

  async function refreshSessions() {
    const response = await fetch(`${API_URL}/sessions`);
    const payload = (await response.json()) as { sessions: Session[] };
    setSessions(payload.sessions);
  }

  async function loadMessages(nextSessionId: string) {
    const response = await fetch(`${API_URL}/sessions/${nextSessionId}/messages`);
    const payload = (await response.json()) as { messages: ChatMessage[] };
    setMessages(payload.messages);
  }

  async function refreshApprovals() {
    const response = await fetch(`${API_URL}/approvals`);
    const payload = (await response.json()) as { approvals: ApprovalRequest[] };
    setApprovals(payload.approvals);
  }

  async function decideApproval(approval: ApprovalRequest, decision: "approved" | "rejected") {
    try {
      const response = await fetch(`${API_URL}/approvals/${approval.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision })
      });
      const payload = (await response.json()) as { toolResult?: ToolResult; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `Approval request failed with ${response.status}`);
      }

      const toolResult = payload.toolResult;
      if (toolResult) {
        setToolResults((current) => [toolResult, ...current]);
        setMessages((current) => [
          ...current,
          {
            id: `${crypto.randomUUID()}-approval-result`,
            sessionId: approval.sessionId,
            actor: "assistant",
            content: approvalResultMessage(decision, toolResult),
            correlationId: "approval",
            createdAt: new Date().toISOString()
          }
        ]);
      }
      setRunStatus(decision === "approved" ? "Approval executed." : "Approval rejected.");
      await refreshApprovals();
      await refreshTasks();
      await verifyAudit();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Approval failed.";
      setLastError(message);
      setRunStatus("Approval failed.");
      await refreshApprovals().catch((refreshError) => {
        console.warn("Failed to refresh approvals after approval error", refreshError);
      });
    }
  }

  async function refreshMemory() {
    const response = await fetch(`${API_URL}/memory`);
    const payload = (await response.json()) as { facts: MemoryFact[] };
    setMemories(payload.facts);
  }

  async function refreshTasks(nextSessionId = sessionId) {
    const url = nextSessionId ? `${API_URL}/sessions/${nextSessionId}/tasks` : `${API_URL}/tasks`;
    const response = await fetch(url);
    const payload = (await response.json()) as { tasks: ToolTask[] };
    setTasks(payload.tasks);
  }

  async function saveMemory(event: React.FormEvent) {
    event.preventDefault();
    if (!memoryInput.trim()) {
      return;
    }

    await fetch(`${API_URL}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object: memoryInput })
    });
    setMemoryInput("");
    await refreshMemory();
  }

  async function deleteMemory(factId: string) {
    await fetch(`${API_URL}/memory/${factId}`, { method: "DELETE" });
    await refreshMemory();
  }

  async function refreshTools() {
    const response = await fetch(`${API_URL}/tools`);
    const payload = (await response.json()) as { tools: PublicTool[] };
    setTools(payload.tools);
  }

  async function refreshProviders() {
    const response = await fetch(`${API_URL}/providers`);
    const payload = (await response.json()) as { providers: ProviderStatus[] };
    setProviders(payload.providers);
  }

  async function refreshVoiceStatus() {
    const response = await fetch(`${API_URL}/voice/status`);
    setVoiceStatus((await response.json()) as VoiceStatus);
  }

  function startVoiceInput() {
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      setInput("Voice input is not supported by this browser.");
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      void submitMessage(transcript, "voice");
    };
    recognition.onend = () => setListening(false);
    setListening(true);
    recognition.start();
  }

  async function verifyAudit() {
    const response = await fetch(`${API_URL}/audit/verify`);
    const payload = (await response.json()) as { ok: boolean; checked: number };
    setAuditStatus(payload.ok ? `verified ${payload.checked} events` : "verification failed");
  }

  function newSession() {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSessionId(undefined);
    setMessages([]);
    setLastError(undefined);
    setRunStatus("idle");
    setToolResults([]);
    setTasks([]);
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">MYLA / local-first copilot</p>
          <h1>Meet MYLA, your calm command center.</h1>
          <p>
            A thoughtful personal assistant for chat, voice, memory, approvals, and tools, with every action routed through
            policy checks and a verifiable audit trail.
          </p>
          <div className="prompt-row" aria-label="Starter prompts">
            <button type="button" className="prompt-chip" onClick={() => setInput("What should I focus on this morning?")}>
              Plan my morning
            </button>
            <button type="button" className="prompt-chip" onClick={() => setInput("Remember that I prefer morning meetings.")}>
              Remember a preference
            </button>
            <button type="button" className="prompt-chip" onClick={() => setInput("Check my calendar and flag anything important.")}>
              Scan my day
            </button>
          </div>
        </div>
        <aside className="persona-card" aria-label="MYLA personality">
          <div className="assistant-orb">MYLA</div>
          <p className="eyebrow">Assistant style</p>
          <h2>Warm, precise, and quietly proactive.</h2>
          <p className="muted">
            MYLA keeps the room uncluttered: she asks before acting, remembers what matters, and surfaces the next useful step.
          </p>
        </aside>
      </section>

      <section className="workspace-grid">
        <aside className="stack side-rail">
          <section className="panel">
            <div className="panel-heading">
              <span>
                <p className="eyebrow">Threads</p>
                <h2>Sessions</h2>
              </span>
              <button type="button" className="secondary compact-button" onClick={newSession}>New</button>
            </div>
            <div className="list">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={session.id === sessionId ? "secondary selected" : "secondary"}
                  onClick={() => setSessionId(session.id)}
                >
                  {session.title ?? session.id.slice(0, 8)}
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <p className="eyebrow">Hands free</p>
            <h2>Voice</h2>
            <p className="muted">Worker mode: {voiceStatus.mode} ({voiceStatus.ready ? "ready" : "not ready"})</p>
            <button type="button" onClick={startVoiceInput} disabled={busy || listening}>
              {listening ? "MYLA is listening..." : "Push to talk"}
            </button>
            {voiceStatus.notes.slice(0, 2).map((note) => <p key={note} className="muted">{note}</p>)}
          </section>
        </aside>

        <div className="panel chat">
          <div className="chat-heading">
            <span>
              <p className="eyebrow">Conversation</p>
              <h2>Ask MYLA anything</h2>
            </span>
            <div className={lastError ? "run-status error" : "run-status"}>
              <strong>Status:</strong> {runStatus}
              {lastError ? <p>{lastError}</p> : null}
            </div>
          </div>
          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty-state">
                <p className="eyebrow">A clear place to start</p>
                <h3>Tell MYLA what you want handled.</h3>
                <p className="muted">
                  Try a calendar check, a quick search, or a memory you want MYLA to keep close for next time.
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`message ${message.actor}`}>
                  <strong>{actorLabel(message.actor)}</strong>
                  <p>{message.content}</p>
                </article>
              ))
            )}
          </div>
          <form onSubmit={sendMessage}>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={busy}
              placeholder="Ask MYLA to plan, remember, search, or take an approved action..."
            />
            <button disabled={busy}>{busy ? "Thinking..." : "Send"}</button>
          </form>
        </div>

        <aside className="stack context-rail">
          <section className="panel">
            <p className="eyebrow">Human in the loop</p>
            <h2>Approvals</h2>
            {approvals.length === 0 ? (
              <p className="muted">Nothing needs your sign-off right now.</p>
            ) : (
              approvals.map((approval) => (
                <div key={approval.id} className="approval">
                  <strong>{approvalStatusLabel(approval)}</strong>
                  <p>{approval.explanation}</p>
                  {approval.proposal ? <ApprovalPreview proposal={approval.proposal} /> : null}
                  <div className="actions">
                    <button
                      type="button"
                      disabled={isApprovalExpired(approval)}
                      onClick={() => void decideApproval(approval, "approved")}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={isApprovalExpired(approval)}
                      onClick={() => void decideApproval(approval, "rejected")}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="panel">
            <p className="eyebrow">What MYLA is doing</p>
            <h2>Activity</h2>
            {tasks.length === 0 ? (
              <p className="muted">Tool activity will appear here when MYLA takes action.</p>
            ) : (
              tasks.slice(0, 8).map((task) => <TaskCard key={task.id} task={task} />)
            )}
            {toolResults.length > 0 ? (
              <details className="approval-preview">
                <summary>Recent Tool Notifications</summary>
                {toolResults.slice(0, 5).map((result) => (
                  <div key={`${result.proposalId}-${result.status}`} className="notice">
                    <strong>{result.toolName}</strong>
                    <p>{result.notification}</p>
                    {toolResultDetails(result).length > 0 ? (
                      <dl className="tool-details">
                        {toolResultDetails(result).map(([label, value]) => (
                          <React.Fragment key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </React.Fragment>
                        ))}
                      </dl>
                    ) : null}
                  </div>
                ))}
              </details>
            ) : null}
          </section>

          <section className="panel">
            <p className="eyebrow">Connections</p>
            <h2>Providers</h2>
            {providers.length === 0 ? (
              <p className="muted">Provider readiness is unavailable.</p>
            ) : (
              <div className="list">
                {providers.map((provider) => (
                  <ProviderCard key={provider.provider} provider={provider} />
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <p className="eyebrow">Personal context</p>
            <h2>Memory</h2>
            <form onSubmit={saveMemory} className="compact-form">
              <input value={memoryInput} onChange={(event) => setMemoryInput(event.target.value)} placeholder="Give MYLA something to remember" />
              <button>Save</button>
            </form>
            <div className="list">
              {memories.slice(0, 6).map((memory) => (
                <div key={memory.id} className="memory">
                  <span>{memory.object}</span>
                  <small>{[memory.category, memory.sensitivity].filter(Boolean).join(" / ") || "general"}</small>
                  <button type="button" className="secondary" onClick={() => void deleteMemory(memory.id)}>Forget</button>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <p className="eyebrow">Capabilities</p>
            <h2>Tools</h2>
            <div className="list">
              {tools.map((tool) => (
                <div key={tool.name} className="tool">
                  <strong>{tool.name}</strong>
                  <p>{tool.provider} / {tool.riskLevel} / {tool.approvalMode}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <p className="eyebrow">Trust layer</p>
            <h2>Audit</h2>
            <p>{auditStatus}</p>
            <button type="button" onClick={verifyAudit}>
              Verify chain
            </button>
          </section>
        </aside>
      </section>
    </main>
  );
}

function getSpeechRecognition(): (new () => BrowserSpeechRecognition) | undefined {
  const browserWindow = window as Window & {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition;
}

function speak(text: string) {
  if (!("speechSynthesis" in window)) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function dedupeApprovals(approvals: ApprovalRequest[]): ApprovalRequest[] {
  return [...new Map(approvals.map((approval) => [approval.id, approval])).values()];
}

function dedupeTasks(tasks: ToolTask[]): ToolTask[] {
  return [...new Map(tasks.map((task) => [task.id, task])).values()].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

function dedupeMemories(memories: MemoryFact[]): MemoryFact[] {
  return [...new Map(memories.map((memory) => [memory.id, memory])).values()];
}

function TaskCard({ task }: { task: ToolTask }) {
  return (
    <div className="notice">
      <strong>{task.toolName ?? "External action"} · {humanizeKey(task.status)}</strong>
      {task.resultNotification ? <p>{task.resultNotification}</p> : null}
      {task.missingFields.length > 0 ? <p className="muted">Missing: {task.missingFields.join(", ")}</p> : null}
      {task.assumptions.length > 0 ? <p className="muted">Assumptions: {task.assumptions.join("; ")}</p> : null}
      <details className="approval-preview">
        <summary>Task Details</summary>
        <dl className="tool-details">
          <dt>Correlation</dt>
          <dd>{task.correlationId}</dd>
          {task.proposalId ? (
            <>
              <dt>Proposal</dt>
              <dd>{task.proposalId}</dd>
            </>
          ) : null}
          {task.approvalId ? (
            <>
              <dt>Approval</dt>
              <dd>{task.approvalId}</dd>
            </>
          ) : null}
        </dl>
        {Object.keys(task.draftArgs).length > 0 ? <pre>{JSON.stringify(task.draftArgs, null, 2)}</pre> : null}
      </details>
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderStatus }) {
  return (
    <div className={`tool provider ${provider.status}`}>
      <strong>{provider.provider} · {humanizeKey(provider.status)}</strong>
      <p>{provider.message}</p>
      {provider.missingConfig.length > 0 ? <p className="muted">Missing: {provider.missingConfig.join(", ")}</p> : null}
      <small>{provider.tools.length} tools</small>
    </div>
  );
}

function approvalResultMessage(decision: "approved" | "rejected", result: ToolResult): string {
  if (decision === "rejected") {
    return `Rejected ${result.toolName}. No action was taken.`;
  }

  if (result.status === "executed") {
    return `${result.toolName} completed: ${result.notification}`;
  }

  return `${result.toolName} returned ${result.status}: ${result.notification}`;
}

function isApprovalExpired(approval: ApprovalRequest): boolean {
  return new Date(approval.expiresAt).getTime() < Date.now();
}

function approvalStatusLabel(approval: ApprovalRequest): string {
  return isApprovalExpired(approval) ? "expired" : approval.status;
}

function ApprovalPreview({ proposal }: { proposal: ToolCallProposal }) {
  const preview = approvalPreview(proposal);

  return (
    <details className="approval-preview" open>
      <summary>Preview {preview.title}</summary>
      {preview.fields.length > 0 ? (
        <dl className="tool-details">
          {preview.fields.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
      {preview.body ? <pre>{preview.body}</pre> : null}
    </details>
  );
}

function approvalPreview(proposal: ToolCallProposal): {
  title: string;
  fields: Array<[string, string]>;
  body?: string;
} {
  const args = proposal.args;
  if (proposal.toolName === "google.gmail.send_draft" || proposal.toolName === "google.gmail.create_draft") {
    return {
      title: "Email",
      fields: compactFields([
        ["To", stringValue(args.to)],
        ["Subject", stringValue(args.subject)],
        ["Draft ID", stringValue(args.draftId)]
      ]),
      body: stringValue(args.body) ?? stringValue(args.bodyPreview)
    };
  }

  if (proposal.toolName === "google.calendar.create_event") {
    return {
      title: "Calendar Event",
      fields: compactFields([
        ["Title", stringValue(args.summary)],
        ["Starts", stringValue(args.startIso)],
        ["Ends", stringValue(args.endIso)],
        ["Location", stringValue(args.location)],
        ["Time zone", stringValue(args.timeZone)],
        ["Calendar", stringValue(args.calendarId)]
      ]),
      body: stringValue(args.description)
    };
  }

  return {
    title: proposal.operation,
    fields: compactFields([
      ["Tool", proposal.toolName],
      ["Risk", proposal.riskLevel],
      ["Summary", proposal.dryRunSummary]
    ]),
    body: JSON.stringify(args, null, 2)
  };
}

function compactFields(fields: Array<[string, string | undefined]>): Array<[string, string]> {
  return fields.filter((field): field is [string, string] => Boolean(field[1]));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toolResultDetails(result: ToolResult): Array<[string, string]> {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return [];
  }

  const data = result.data as Record<string, unknown>;
  const details: Array<[string, string]> = [];

  for (const key of ["to", "subject", "bodyPreview", "draftId", "messageId", "eventId", "htmlLink"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      details.push([humanizeKey(key), value]);
    }
  }

  if (Array.isArray(data.events)) {
    details.push(["Events", `${data.events.length}`]);
  }

  return details;
}

function actorLabel(actor: ChatMessage["actor"]): string {
  if (actor === "assistant") {
    return "MYLA";
  }
  if (actor === "user") {
    return "You";
  }
  return humanizeKey(actor);
}

function humanizeKey(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (first) => first.toUpperCase());
}

function formatApiError(payload: unknown, status: number): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return `API returned ${status}`;
  }

  const record = payload as Record<string, unknown>;
  const error =
    typeof record.error === "string"
      ? record.error
      : typeof record.message === "string"
        ? record.message
        : `API returned ${status}`;
  return [error, typeof record.requestId === "string" ? `requestId=${record.requestId}` : undefined]
    .filter(Boolean)
    .join(" ");
}

createRoot(document.getElementById("root")!).render(<App />);
