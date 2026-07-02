import React, { useEffect, useRef, useState } from "react";
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

interface BrowserSpeechRecognitionResult {
  0: { transcript: string };
  isFinal: boolean;
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  abort: () => void;
  start: () => void;
  stop: () => void;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<BrowserSpeechRecognitionResult> }) => void) | null;
  onend: (() => void) | null;
}

function App() {
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const voiceBaseInputRef = useRef("");
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
  const [clarificationInputs, setClarificationInputs] = useState<Record<string, string>>({});
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

  useEffect(
    () => () => {
      if (recognitionRef.current) {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.abort();
      }
    },
    []
  );

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

  async function sendClarification(event: React.FormEvent, task: ToolTask) {
    event.preventDefault();
    const answer = clarificationInputs[task.id]?.trim();
    if (!answer) {
      return;
    }

    setClarificationInputs((current) => {
      const next = { ...current };
      delete next[task.id];
      return next;
    });
    setTasks((current) => current.filter((currentTask) => currentTask.id !== task.id));
    await submitMessage(`For the pending ${task.toolName ?? "task"}: ${answer}`, "chat");
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
      if (inputMode === "voice") {
        speak(payload.message.content);
      }
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
    const payload = await requestJson<{ sessions: Session[] }>(`${API_URL}/sessions`);
    setSessions(payload.sessions ?? []);
  }

  async function loadMessages(nextSessionId: string) {
    const payload = await requestJson<{ messages: ChatMessage[] }>(`${API_URL}/sessions/${nextSessionId}/messages`);
    setMessages(payload.messages ?? []);
  }

  async function refreshApprovals() {
    const payload = await requestJson<{ approvals: ApprovalRequest[] }>(`${API_URL}/approvals`);
    setApprovals((payload.approvals ?? []).filter((approval) => approval.status === "pending" && !isApprovalExpired(approval)));
  }

  async function decideApproval(approval: ApprovalRequest, decision: "approved" | "rejected") {
    setApprovals((current) => current.filter((currentApproval) => currentApproval.id !== approval.id));
    setLastError(undefined);
    try {
      const response = await fetch(`${API_URL}/approvals/${approval.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision })
      });
      const payload = (await response.json()) as { toolResult?: ToolResult; error?: string };
      if (!response.ok) {
        if (typeof payload.error === "string" && /^Approval is already (approved|rejected|expired)\./i.test(payload.error)) {
          setRunStatus(payload.error);
          await refreshApprovals();
          await refreshTasks();
          return;
        }
        throw new Error(payload.error ?? `Approval request failed with ${response.status}`);
      }

      setApprovals((current) => current.filter((currentApproval) => currentApproval.id !== approval.id));
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
    const payload = await requestJson<{ facts: MemoryFact[] }>(`${API_URL}/memory`);
    setMemories(payload.facts ?? []);
  }

  async function refreshTasks(nextSessionId = sessionId) {
    const url = nextSessionId ? `${API_URL}/sessions/${nextSessionId}/tasks` : `${API_URL}/tasks`;
    const payload = await requestJson<{ tasks: ToolTask[] }>(url);
    setTasks(payload.tasks ?? []);
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
    const payload = await requestJson<{ tools: PublicTool[] }>(`${API_URL}/tools`);
    setTools(payload.tools ?? []);
  }

  async function refreshProviders() {
    const payload = await requestJson<{ providers: ProviderStatus[] }>(`${API_URL}/providers`);
    setProviders(payload.providers ?? []);
  }

  async function refreshVoiceStatus() {
    setVoiceStatus(await requestJson<VoiceStatus>(`${API_URL}/voice/status`));
  }

  function startVoiceInput() {
    if (listening || busy) {
      return;
    }

    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      const message = "Voice input is not supported by this browser. Try Chrome or Edge for dictation.";
      setLastError(message);
      setRunStatus("Voice input unavailable.");
      return;
    }

    const recognition = new Recognition();
    let submittedTranscript = false;
    let heardTranscript = false;
    let recognitionFailed = false;
    voiceBaseInputRef.current = input.trim();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const results = Array.from(event.results);
      const transcript = results.map((result) => result[0]?.transcript ?? "").join(" ").trim();
      const finalTranscript = results
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();

      if (transcript) {
        heardTranscript = true;
        setInput(combineVoiceInput(voiceBaseInputRef.current, transcript));
      }

      if (finalTranscript && !submittedTranscript) {
        submittedTranscript = true;
        recognition.stop();
        void submitMessage(combineVoiceInput(voiceBaseInputRef.current, finalTranscript), "voice");
      }
    };
    recognition.onerror = (event) => {
      recognitionFailed = true;
      const message = speechRecognitionErrorMessage(event.error);
      setLastError(message);
      setRunStatus("Voice input failed.");
      setListening(false);
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
      voiceBaseInputRef.current = "";
      setListening(false);
      if (!recognitionFailed && !submittedTranscript && !heardTranscript) {
        setRunStatus("Voice input ended without a transcript.");
      }
    };

    try {
      setListening(true);
      setLastError(undefined);
      setRunStatus("Listening...");
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      voiceBaseInputRef.current = "";
      setListening(false);
      const message = error instanceof Error ? error.message : "Voice input could not start.";
      setLastError(message);
      setRunStatus("Voice input failed.");
    }
  }

  function stopVoiceInput() {
    if (!recognitionRef.current) {
      return;
    }

    setRunStatus("Finishing voice input...");
    recognitionRef.current.stop();
  }

  function cancelVoiceInput() {
    if (!recognitionRef.current) {
      return;
    }

    const baseInput = voiceBaseInputRef.current;
    recognitionRef.current.onresult = null;
    recognitionRef.current.onerror = null;
    recognitionRef.current.onend = null;
    recognitionRef.current.abort();
    recognitionRef.current = null;
    voiceBaseInputRef.current = "";
    setInput(baseInput);
    setListening(false);
    setRunStatus("Voice input cancelled.");
  }

  async function verifyAudit() {
    const payload = await requestJson<{ ok: boolean; checked: number }>(`${API_URL}/audit/verify`);
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

  const visibleTasks = tasks.filter(shouldDisplayTask);
  const voiceInputSupported = Boolean(getSpeechRecognition());

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
                  <span className="session-title">{session.title ?? "Untitled conversation"}</span>
                  <small>{formatSessionDate(session.updatedAt)}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <p className="eyebrow">Hands free</p>
            <h2>Voice</h2>
            <p className="muted">Worker mode: {voiceStatus.mode} ({voiceStatus.ready ? "ready" : "not ready"})</p>
            <p className="muted">Use Dictate in the chat box for browser voice-to-text.</p>
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
          <form className="chat-composer" onSubmit={sendMessage}>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={busy}
              placeholder="Ask MYLA to plan, remember, search, or take an approved action..."
            />
            <div className="composer-actions">
              <button
                type="button"
                className={[
                  "voice-button",
                  listening ? "listening" : "",
                  voiceInputSupported ? "" : "unsupported"
                ].filter(Boolean).join(" ")}
                aria-pressed={listening}
                onClick={listening ? stopVoiceInput : startVoiceInput}
                disabled={busy}
              >
                {listening ? "Stop" : "Dictate"}
              </button>
              {listening ? (
                <button type="button" className="secondary voice-cancel" onClick={cancelVoiceInput}>
                  Cancel
                </button>
              ) : null}
              <button disabled={busy || listening}>{busy ? "Thinking..." : "Send"}</button>
            </div>
          </form>
          {listening ? (
            <p className="composer-hint active">Listening now. Speak naturally, then pause or press Stop.</p>
          ) : !voiceInputSupported ? (
            <p className="composer-hint">Voice dictation works best in Chrome or Edge through the Web Speech API.</p>
          ) : null}
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
            {visibleTasks.length === 0 ? (
              <p className="muted">Tool activity will appear here when MYLA takes action.</p>
            ) : (
              visibleTasks.slice(0, 8).map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  clarificationValue={clarificationInputs[task.id] ?? ""}
                  busy={busy}
                  onClarificationChange={(value) =>
                    setClarificationInputs((current) => ({
                      ...current,
                      [task.id]: value
                    }))
                  }
                  onClarificationSubmit={(event) => void sendClarification(event, task)}
                />
              ))
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

function combineVoiceInput(baseInput: string, transcript: string) {
  return [baseInput.trim(), transcript.trim()].filter(Boolean).join(" ");
}

function speechRecognitionErrorMessage(error?: string) {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was blocked. Allow microphone access to dictate to MYLA.";
    case "no-speech":
      return "MYLA did not hear anything. Try dictating again.";
    case "audio-capture":
      return "No microphone was found for voice input.";
    case "network":
      return "Voice recognition could not reach the browser speech service.";
    default:
      return "Voice input failed. Try again or type your message.";
  }
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

function formatSessionDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function clarificationPlaceholder(task: ToolTask): string {
  if (task.missingFields.length === 0) {
    return "Type your answer...";
  }

  return `Type ${humanReadableList(task.missingFields.map(humanizeKey).map((field) => field.toLowerCase()))}...`;
}

function shouldDisplayTask(task: ToolTask): boolean {
  if (task.status === "cancelled" || task.status === "expired") {
    return false;
  }

  return true;
}

function taskClarificationQuestion(task: ToolTask): string {
  const storedQuestion = [task.resultNotification, ...task.validationErrors].find((value) => isUsefulClarificationQuestion(value));
  if (storedQuestion) {
    return storedQuestion;
  }

  if (task.missingFields.length > 0) {
    return `What ${humanReadableList(task.missingFields.map(humanizeKey).map((field) => field.toLowerCase()))} should MYLA use?`;
  }

  if (Object.keys(task.draftArgs).length > 0) {
    return "What detail should MYLA add or change before continuing?";
  }

  return "What information should MYLA use to continue?";
}

function isUsefulClarificationQuestion(value: string | null | undefined): value is string {
  if (!value?.trim()) {
    return false;
  }

  return !/^request failed/i.test(value);
}

function humanReadableList(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? "detail";
  }

  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }

  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function TaskCard({
  task,
  clarificationValue,
  busy,
  onClarificationChange,
  onClarificationSubmit
}: {
  task: ToolTask;
  clarificationValue: string;
  busy: boolean;
  onClarificationChange: (value: string) => void;
  onClarificationSubmit: (event: React.FormEvent) => void;
}) {
  const needsClarification = task.status === "needs_clarification";
  const clarificationQuestion = taskClarificationQuestion(task);

  return (
    <div className={needsClarification ? "notice clarification-task" : "notice"}>
      <strong>{task.toolName ?? "External action"} · {humanizeKey(task.status)}</strong>
      {needsClarification ? (
        <div className="clarification-question">
          <span>MYLA is asking</span>
          <p>{clarificationQuestion}</p>
        </div>
      ) : task.resultNotification ? (
        <p>{task.resultNotification}</p>
      ) : null}
      {task.missingFields.length > 0 ? <p className="muted">Missing: {task.missingFields.join(", ")}</p> : null}
      {task.assumptions.length > 0 ? <p className="muted">Assumptions: {task.assumptions.join("; ")}</p> : null}
      {needsClarification ? (
        <form className="clarification-form" onSubmit={onClarificationSubmit}>
          <label>
            <span>Answer MYLA here</span>
            <input
              value={clarificationValue}
              onChange={(event) => onClarificationChange(event.target.value)}
              disabled={busy}
              placeholder={clarificationPlaceholder(task)}
            />
          </label>
          <button type="submit" disabled={busy || !clarificationValue.trim()}>
            Continue
          </button>
        </form>
      ) : null}
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

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(async () => ({
    error: await response.text()
  }))) as unknown;

  if (!response.ok) {
    throw new Error(formatApiError(payload, response.status));
  }

  return payload as T;
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
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (first) => first.toUpperCase());
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
