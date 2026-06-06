import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalRequest, ChatMessage, ChatResponse, ToolResult } from "@jarvis/shared";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

function App() {
  const [sessionId, setSessionId] = useState<string>();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolResults, setToolResults] = useState<ToolResult[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [auditStatus, setAuditStatus] = useState<string>("not checked");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshApprovals();
    void verifyAudit();
  }, []);

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!input.trim()) {
      return;
    }

    const userDraft = input;
    setInput("");
    setBusy(true);

    try {
      const response = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, message: userDraft })
      });
      const payload = (await response.json()) as ChatResponse;
      setSessionId(payload.sessionId);
      setMessages((current) => [
        ...current,
        {
          id: `${payload.correlationId}-user`,
          sessionId: payload.sessionId,
          actor: "user",
          content: userDraft,
          correlationId: payload.correlationId,
          createdAt: new Date().toISOString()
        },
        payload.message
      ]);
      setToolResults((current) => [...payload.toolResults, ...current]);
      setApprovals((current) => [...payload.approvals, ...current]);
      await verifyAudit();
    } finally {
      setBusy(false);
    }
  }

  async function refreshApprovals() {
    const response = await fetch(`${API_URL}/approvals`);
    const payload = (await response.json()) as { approvals: ApprovalRequest[] };
    setApprovals(payload.approvals);
  }

  async function verifyAudit() {
    const response = await fetch(`${API_URL}/audit/verify`);
    const payload = (await response.json()) as { ok: boolean; checked: number };
    setAuditStatus(payload.ok ? `verified ${payload.checked} events` : "verification failed");
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Local-first assistant skeleton</p>
        <h1>JARVIS Second Brain</h1>
        <p>
          Chat routes through the TypeScript policy gateway, Python ML worker, SQLite state, and
          hash-chained audit log. High-risk actions are queued instead of executed.
        </p>
      </section>

      <section className="grid">
        <div className="panel chat">
          <h2>Chat</h2>
          <div className="messages">
            {messages.length === 0 ? (
              <p className="muted">Try: “check my calendar” or “draft an email about tomorrow”.</p>
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
            <h2>Notifications</h2>
            {toolResults.length === 0 ? (
              <p className="muted">Low-risk tool notifications will appear here.</p>
            ) : (
              toolResults.map((result) => (
                <div key={result.proposalId} className="notice">
                  <strong>{result.toolName}</strong>
                  <p>{result.notification}</p>
                </div>
              ))
            )}
          </section>

          <section className="panel">
            <h2>Approvals</h2>
            {approvals.length === 0 ? (
              <p className="muted">No pending approvals.</p>
            ) : (
              approvals.map((approval) => (
                <div key={approval.id} className="approval">
                  <strong>{approval.status}</strong>
                  <p>{approval.explanation}</p>
                </div>
              ))
            )}
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

createRoot(document.getElementById("root")!).render(<App />);
