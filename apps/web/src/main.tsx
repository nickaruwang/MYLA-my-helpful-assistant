import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalRequest, ChatMessage, ChatResponse, MemoryFact, Session, ToolResult } from "@jarvis/shared";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const SESSION_STORAGE_KEY = "jarvis-session-id";

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
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [memories, setMemories] = useState<MemoryFact[]>([]);
  const [memoryInput, setMemoryInput] = useState("");
  const [tools, setTools] = useState<PublicTool[]>([]);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({ mode: "disabled", ready: false, notes: [] });
  const [auditStatus, setAuditStatus] = useState<string>("not checked");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);

  useEffect(() => {
    void refreshSessions();
    void refreshApprovals();
    void refreshMemory();
    void refreshTools();
    void refreshVoiceStatus();
    void verifyAudit();
  }, []);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    void loadMessages(sessionId);
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

    try {
      const payload = await requestChatStream({ sessionId, message: trimmed, inputMode });
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
      setApprovals((current) => dedupeApprovals([...payload.approvals, ...current]));
      setMemories((current) => dedupeMemories([...payload.storedMemories, ...current]));
      speak(payload.message.content);
      await Promise.all([verifyAudit(), refreshSessions(), refreshMemory()]);
    } finally {
      setBusy(false);
    }
  }

  async function requestChatStream(body: { sessionId?: string; message: string; inputMode: "chat" | "voice" }) {
    const response = await fetch(`${API_URL}/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.body) {
      return (await response.json()) as ChatResponse;
    }

    const text = await response.text();
    const dataLine = text
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.replace("data: ", "");

    if (!dataLine) {
      throw new Error("Stream did not return chat data.");
    }

    return JSON.parse(dataLine) as ChatResponse;
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
    const response = await fetch(`${API_URL}/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision })
    });
    const payload = (await response.json()) as { toolResult?: ToolResult };
    if (payload.toolResult) {
      setToolResults((current) => [payload.toolResult!, ...current]);
    }
    await refreshApprovals();
    await verifyAudit();
  }

  async function refreshMemory() {
    const response = await fetch(`${API_URL}/memory`);
    const payload = (await response.json()) as { facts: MemoryFact[] };
    setMemories(payload.facts);
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
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Local-first assistant</p>
        <h1>JARVIS Second Brain</h1>
        <p>
          Chat and voice requests route through Ollama, MongoDB memory, policy checks, tool approvals, and a hash-chained audit log.
        </p>
      </section>

      <section className="grid">
        <aside className="stack">
          <section className="panel">
            <h2>Sessions</h2>
            <button type="button" onClick={newSession}>New session</button>
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
            <h2>Voice</h2>
            <p className="muted">Worker mode: {voiceStatus.mode} ({voiceStatus.ready ? "ready" : "not ready"})</p>
            <button type="button" onClick={startVoiceInput} disabled={busy || listening}>
              {listening ? "Listening..." : "Push to talk"}
            </button>
            {voiceStatus.notes.slice(0, 2).map((note) => <p key={note} className="muted">{note}</p>)}
          </section>
        </aside>

        <div className="panel chat">
          <h2>Chat</h2>
          <div className="messages">
            {messages.length === 0 ? (
              <p className="muted">Try: "check my calendar", "search the latest AI news", or "remember that I prefer morning meetings".</p>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`message ${message.actor}`}>
                  <strong>{message.actor}</strong>
                  <p>{message.content}</p>
                </article>
              ))
            )}
          </div>
          <form onSubmit={sendMessage}>
            <input value={input} onChange={(event) => setInput(event.target.value)} disabled={busy} />
            <button disabled={busy}>{busy ? "Thinking..." : "Send"}</button>
          </form>
        </div>

        <aside className="stack">
          <section className="panel">
            <h2>Approvals</h2>
            {approvals.length === 0 ? (
              <p className="muted">No pending approvals.</p>
            ) : (
              approvals.map((approval) => (
                <div key={approval.id} className="approval">
                  <strong>{approval.status}</strong>
                  <p>{approval.explanation}</p>
                  <div className="actions">
                    <button type="button" onClick={() => void decideApproval(approval, "approved")}>Approve</button>
                    <button type="button" className="danger" onClick={() => void decideApproval(approval, "rejected")}>Reject</button>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="panel">
            <h2>Notifications</h2>
            {toolResults.length === 0 ? (
              <p className="muted">Tool notifications will appear here.</p>
            ) : (
              toolResults.map((result) => (
                <div key={`${result.proposalId}-${result.status}`} className="notice">
                  <strong>{result.toolName}</strong>
                  <p>{result.notification}</p>
                </div>
              ))
            )}
          </section>

          <section className="panel">
            <h2>Memory</h2>
            <form onSubmit={saveMemory} className="compact-form">
              <input value={memoryInput} onChange={(event) => setMemoryInput(event.target.value)} placeholder="Add a memory" />
              <button>Save</button>
            </form>
            <div className="list">
              {memories.slice(0, 6).map((memory) => (
                <div key={memory.id} className="memory">
                  <span>{memory.object}</span>
                  <button type="button" className="secondary" onClick={() => void deleteMemory(memory.id)}>Forget</button>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
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

function dedupeMemories(memories: MemoryFact[]): MemoryFact[] {
  return [...new Map(memories.map((memory) => [memory.id, memory])).values()];
}

createRoot(document.getElementById("root")!).render(<App />);
