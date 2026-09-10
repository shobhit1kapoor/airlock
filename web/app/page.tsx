"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  ChevronRight,
  ClipboardCheck,
  Cpu,
  Database,
  Eye,
  GitBranch,
  KeyRound,
  LockKeyhole,
  Network,
  RefreshCw,
  Search,
  ShieldAlert,
  Waypoints,
  X,
} from "lucide-react";

type Origin = "LIVE" | "HISTORICAL" | "SIMULATION";
type Counter = { attempts?: number; failures?: number; successful?: number };
type Event = {
  id: string;
  timestamp: string;
  kind: string;
  origin: Origin;
  source?: string;
  destination?: string;
  decision?: string | number | null;
  message?: string;
  status?: number;
  traceId?: string;
  kongRequestId?: string;
  protocol?: string;
  adapters?: { primary?: Counter; fallback?: Counter };
  otelAttributes?: Record<string, string | number | boolean>;
};
type Approval = {
  id: string;
  requester: string;
  tool: string;
  status: string;
  traceId: string;
  createdAt: string;
  expiresAt?: string;
  remainingUses?: number | null;
};
type Policy = {
  drift: boolean;
  severity: string;
  desired: string[];
  actual: string[];
  restoreAvailable?: boolean;
};
type Metric = { label: string; value: string; detail: string };
type RunResult = {
  id: string;
  traceId?: string;
  status?: number;
  primary?: Counter;
  fallback?: Counter;
};
type Sheet =
  | { type: "event"; event: Event }
  | { type: "run"; result: RunResult }
  | { type: "approval"; approval: Approval }
  | null;
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";

const nav = [
  { id: "overview", label: "Overview", icon: Activity, group: "Control plane" },
  { id: "agents", label: "Agent graph", icon: Network, group: "Control plane" },
  { id: "attack", label: "Attack lab", icon: ShieldAlert, group: "Validate" },
  {
    id: "approvals",
    label: "Approvals",
    icon: ClipboardCheck,
    group: "Governance",
  },
  { id: "tools", label: "MCP tools", icon: GitBranch, group: "Governance" },
  { id: "models", label: "Models", icon: Cpu, group: "Governance" },
  {
    id: "traffic",
    label: "Traffic & audit",
    icon: Waypoints,
    group: "Evidence",
  },
] as const;
type View = (typeof nav)[number]["id"];
const agents = [
  {
    id: "planner-agent",
    name: "Planner",
    activity: "Plans work and delegates through Kong",
    access: "May call Research, Security, Coding",
    tone: "blue",
  },
  {
    id: "research-agent",
    name: "Research",
    activity: "Reads and searches repository context",
    access: "May not call Coding or write tools",
    tone: "violet",
  },
  {
    id: "security-agent",
    name: "Security",
    activity: "Reviews change risk before implementation",
    access: "May call Coding",
    tone: "amber",
  },
  {
    id: "coding-agent",
    name: "Coding",
    activity: "Implements bounded, reviewed changes",
    access: "Writes require a human grant",
    tone: "teal",
  },
] as const;
const scenarios = [
  {
    id: "mcp-denial",
    title: "Destructive MCP denial",
    protocol: "MCP tools/call",
    description: "Research calls delete_repository using its own consumer key.",
    expected: "403 from Kong; destructive upstream counter remains 0.",
  },
  {
    id: "a2a-denial",
    title: "A2A destination denial",
    protocol: "A2A message/send",
    description: "Research sends a task to Coding outside Coding’s allow list.",
    expected: "403 from Kong; Coding receives no message.",
  },
  {
    id: "approval",
    title: "Approval-gated branch",
    protocol: "MCP tools/call",
    description:
      "Coding requests create_branch, which is held for an operator.",
    expected: "Backend-only capability; one use or ten-minute grant.",
  },
  {
    id: "failover",
    title: "Kong-owned model recovery",
    protocol: "OpenAI-compatible request",
    description:
      "The primary adapter returns 503 while Kong retries the client request.",
    expected: "Primary fails; fallback succeeds; workflow continues.",
  },
] as const;
const tools = [
  {
    name: "read_repository",
    description: "Read a repository file",
    research: "Allowed",
    coding: "Allowed",
    enforcement: "Listener ACL",
  },
  {
    name: "search_code",
    description: "Search repository contents",
    research: "Allowed",
    coding: "Allowed",
    enforcement: "Listener ACL",
  },
  {
    name: "create_branch",
    description: "Create a repository branch",
    research: "Blocked",
    coding: "Approval required",
    enforcement: "approval-coding-agent",
  },
  {
    name: "delete_repository",
    description: "Delete a repository",
    research: "Blocked",
    coding: "Blocked",
    enforcement: "Per-tool ACL",
  },
];

function compactId(value?: string) {
  return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : "—";
}
function readableTime(value?: string) {
  if (!value) return "—";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 8) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function eventTitle(event: Event) {
  const titles: Record<string, string> = {
    "mcp.denied": "Destructive MCP call blocked",
    "a2a.denied": "Cross-agent request blocked",
    "approval.requested": "Approval requested",
    "approval.decided": "Approval decision recorded",
    "approval.executed": "Approved branch creation completed",
    "approval.execution_failed": "Approved action was rejected",
    "model.failover_observed": "Model request recovered",
    "policy.synced": "Policy restored in Konnect",
    "kong.otel.log": "Native Kong telemetry received",
    "kong.telemetry": "Native Kong telemetry received",
  };
  return titles[event.kind] ?? event.kind.replaceAll(".", " · ");
}
function decisionTone(value?: string | number | null) {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("deny") || text.includes("block") || text === "403")
    return "danger";
  if (
    text.includes("approval") ||
    text.includes("pending") ||
    text.includes("grant")
  )
    return "warning";
  if (text.includes("failover")) return "info";
  return "success";
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
function OriginBadge({ value }: { value: Origin }) {
  return <Badge tone={value.toLowerCase()}>{value}</Badge>;
}
function DecisionBadge({ value }: { value?: string | number | null }) {
  return (
    <Badge tone={decisionTone(value)}>
      {value ? String(value).replaceAll("_", " ") : "OBSERVED"}
    </Badge>
  );
}

export default function Airlock() {
  const [showLanding, setShowLanding] = useState(true);
  const [view, setView] = useState<View>("overview");
  const [events, setEvents] = useState<Event[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [trafficFilter, setTrafficFilter] = useState<"all" | "live" | "denied">(
    "all",
  );
  const [query, setQuery] = useState("");
  const refresh = async () => {
    const [overview, nextApprovals, nextPolicy] = await Promise.all([
      fetch(`${API}/api/overview`).then((r) =>
        r.ok ? r.json() : Promise.reject(r),
      ),
      fetch(`${API}/api/approvals`).then((r) =>
        r.ok ? r.json() : Promise.reject(r),
      ),
      fetch(`${API}/api/policy/drift`).then((r) =>
        r.ok ? r.json() : Promise.reject(r),
      ),
    ]);
    setEvents(overview.events ?? []);
    setMetrics(overview.metrics ?? []);
    setApprovals(nextApprovals ?? []);
    setPolicy(nextPolicy);
  };
  useEffect(() => {
    refresh().catch(() =>
      setNotice("Control API is unavailable. Check the local Docker stack."),
    );
    const stream = new EventSource(`${API}/api/events`);
    stream.addEventListener("airlock", (message) => {
      const event = JSON.parse((message as MessageEvent).data) as Event;
      setEvents((current) =>
        [event, ...current.filter((item) => item.id !== event.id)].slice(
          0,
          100,
        ),
      );
    });
    stream.onerror = () =>
      setNotice("Live stream paused. Use Refresh to reconnect.");
    return () => stream.close();
  }, []);
  const runScenario = async (id: string) => {
    setRunning(id);
    setNotice(null);
    try {
      const response = await fetch(`${API}/api/attacks/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: id }),
      });
      if (!response.ok) throw new Error(await response.text());
      const result = { id, ...(await response.json()) } as RunResult;
      await refresh();
      if (id === "approval") {
        const approval = (
          (await fetch(`${API}/api/approvals`).then((r) =>
            r.json(),
          )) as Approval[]
        ).find((item) => item.traceId === result.traceId);
        if (approval) setSheet({ type: "approval", approval });
        setView("approvals");
        setNotice(
          "Approval request created. It remains paused until an operator decides.",
        );
      } else {
        setSheet({ type: "run", result });
        setNotice("Live test completed through the local Kong data plane.");
      }
    } catch {
      setNotice(
        "The requested test did not return the expected gateway response.",
      );
    } finally {
      setRunning(null);
    }
  };
  const decide = async (
    approval: Approval,
    decision: "approve-once" | "approve-10m" | "deny",
  ) => {
    setRunning(approval.id);
    setNotice(null);
    try {
      const response = await fetch(`${API}/api/approvals/${approval.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) throw new Error(await response.text());
      const next = (await response.json()) as Approval;
      await refresh();
      setSheet({ type: "approval", approval: next });
      setNotice(
        decision === "deny"
          ? "Request denied. Airlock made no privileged MCP call."
          : "Grant applied. The backend used its server-only identity through Kong.",
      );
    } catch {
      setNotice("The approval decision could not be recorded.");
    } finally {
      setRunning(null);
    }
  };
  const syncPolicy = async () => {
    setRunning("policy-sync");
    setNotice(null);
    try {
      const response = await fetch(`${API}/api/policy/sync`, {
        method: "POST",
      });
      if (!response.ok) throw new Error();
      await refresh();
      setNotice(
        "The desired Coding destination allow list is now active in Konnect.",
      );
    } catch {
      setNotice("Policy sync failed. Konnect did not accept the change.");
    } finally {
      setRunning(null);
    }
  };
  const pending = approvals.filter((item) => item.status === "PENDING");
  const latestFailover = events.find(
    (event) => event.kind === "model.failover_observed",
  );
  const filteredEvents = useMemo(
    () =>
      events.filter((event) => {
        const sourceMatch =
          `${eventTitle(event)} ${event.source ?? ""} ${event.destination ?? ""} ${event.message ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase());
        if (!sourceMatch) return false;
        if (trafficFilter === "live") return event.origin === "LIVE";
        if (trafficFilter === "denied")
          return decisionTone(event.decision) === "danger";
        return true;
      }),
    [events, query, trafficFilter],
  );
  const headers: Record<View, [string, string, string]> = {
    overview: [
      "Overview",
      "A precise view of the access boundaries enforcing work today.",
      "OPERATIONS",
    ],
    agents: [
      "Agent graph",
      "Authenticated agent identities and the paths Kong permits.",
      "ACCESS CONTROL",
    ],
    attack: [
      "Attack lab",
      "Run the four live proofs against the local data plane.",
      "VALIDATION",
    ],
    approvals: [
      "Approvals",
      "Review narrowly scoped requests without exposing privileged credentials.",
      "JUST-IN-TIME ACCESS",
    ],
    tools: [
      "MCP tools",
      "Listener-mode tool policy, enforced before the Git MCP server.",
      "TOOL AUTHORIZATION",
    ],
    models: [
      "Models",
      "Kong selects targets and recovers model requests without app fallback logic.",
      "MODEL ROUTING",
    ],
    traffic: [
      "Traffic & audit",
      "Native Kong telemetry and Airlock audit projections, joined by trace ID.",
      "EVIDENCE",
    ],
  };
  const current = headers[view];
  if (showLanding) {
    return (
      <Landing
        onEnter={(nextView) => {
          setView(nextView);
          setShowLanding(false);
        }}
      />
    );
  }
  return (
    <main className="app-shell">
      <aside className="app-sidebar">
        <div className="brand">
          <span className="brand-symbol">
            <LockKeyhole size={16} />
          </span>
          <strong>Airlock</strong>
        </div>
        <p className="brand-subtitle">Agent access control</p>
        <nav aria-label="Airlock views">
          {["Control plane", "Validate", "Governance", "Evidence"].map(
            (group) => (
              <div className="nav-group" key={group}>
                <span className="nav-caption">{group}</span>
                {nav
                  .filter((item) => item.group === group)
                  .map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      className={view === id ? "nav-link active" : "nav-link"}
                      onClick={() => setView(id)}
                    >
                      <Icon size={16} />
                      <span>{label}</span>
                      {id === "approvals" && pending.length > 0 && (
                        <Badge tone="warning">{pending.length}</Badge>
                      )}
                    </button>
                  ))}
              </div>
            ),
          )}
        </nav>
        <div className="sidebar-status">
          <span className="dot dot-success" />
          <div>
            <b>Local data plane</b>
            <small>Konnect-controlled policy</small>
          </div>
        </div>
      </aside>
      <section className="app-content">
        <header className="topbar">
          <div>
            <p className="section-kicker">{current[2]}</p>
            <h1>{current[0]}</h1>
            <p>{current[1]}</p>
          </div>
          <div className="topbar-actions">
            <button
              className="button button-secondary"
              onClick={() =>
                refresh().catch(() =>
                  setNotice("Unable to refresh live state."),
                )
              }
            >
              <RefreshCw size={14} /> Refresh
            </button>
            <span className="connection-state">
              <span className="dot dot-success" /> Connected
            </span>
          </div>
        </header>
        {notice && (
          <div className="notice" role="status">
            <Check size={15} />
            <span>{notice}</span>
            <button
              onClick={() => setNotice(null)}
              aria-label="Dismiss notification"
            >
              <X size={15} />
            </button>
          </div>
        )}
        {view === "overview" && (
          <Overview
            metrics={metrics}
            events={events}
            policy={policy}
            pending={pending.length}
            onNavigate={setView}
            onEvent={(event) => setSheet({ type: "event", event })}
          />
        )}
        {view === "agents" && (
          <AgentsView
            onRun={() => runScenario("a2a-denial")}
            running={running}
          />
        )}
        {view === "attack" && (
          <AttackLab
            onRun={runScenario}
            running={running}
            latest={latestFailover}
          />
        )}
        {view === "approvals" && (
          <ApprovalsView
            approvals={approvals}
            onOpen={(approval) => setSheet({ type: "approval", approval })}
            onRun={() => runScenario("approval")}
            running={running}
          />
        )}
        {view === "tools" && (
          <ToolsView
            onRun={() => runScenario("mcp-denial")}
            running={running}
          />
        )}
        {view === "models" && (
          <ModelsView
            latest={latestFailover}
            onRun={() => runScenario("failover")}
            running={running}
          />
        )}
        {view === "traffic" && (
          <TrafficView
            events={filteredEvents}
            filter={trafficFilter}
            query={query}
            setFilter={setTrafficFilter}
            setQuery={setQuery}
            policy={policy}
            running={running}
            onSync={syncPolicy}
            onOpen={(event) => setSheet({ type: "event", event })}
          />
        )}
      </section>
      {sheet && (
        <SideSheet
          sheet={sheet}
          onClose={() => setSheet(null)}
          onDecide={decide}
          running={running}
        />
      )}
    </main>
  );
}

function Landing({ onEnter }: { onEnter: (view: View) => void }) {
  return (
    <main className="landing-shell landing-prompt">
      <div className="landing-video" aria-hidden="true">
        <video autoPlay loop muted playsInline>
          <source
            src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4"
            type="video/mp4"
          />
        </video>
      </div>
      <div className="landing-scrim" aria-hidden="true" />
      <div className="landing-grid" aria-hidden="true" />

      <header className="landing-header">
        <div className="landing-mark" aria-label="Airlock">
          <LockKeyhole size={20} />
        </div>
        <nav className="landing-nav" aria-label="Airlock overview">
          <span className="landing-nav-active">Home</span>
          <span>Product</span>
          <span>Architecture</span>
          <span>Evidence</span>
        </nav>
        <span className="landing-header-space" aria-hidden="true" />
      </header>

      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-proof-row">
          <span className="proof-orbit"><LockKeyhole size={14} /></span>
          <span className="proof-orbit"><KeyRound size={14} /></span>
          <span className="proof-orbit"><Network size={14} /></span>
          <span className="landing-proof-copy">Kong AI Gateway + Agent Gateway</span>
        </div>
        <p className="landing-eyebrow">ZERO-TRUST AGENT OPERATIONS</p>
        <h1 id="landing-title">
          <span>Autonomy needs</span>
          <span>an airlock.</span>
        </h1>
        <p className="landing-subhead">
          Airlock gives every agent a real identity, a narrow boundary, and a
          traceable record of what Kong allowed, denied, or recovered.
        </p>
        <div className="landing-actions">
          <button className="landing-primary" onClick={() => onEnter("overview")}>
            Open control panel <ArrowRight size={16} />
          </button>
        </div>
      </section>

      <footer className="landing-stats" aria-label="Airlock capabilities">
        <div><span>5</span><strong>Agent identities</strong><small>separate Kong AI Consumers</small></div>
        <div><span>4</span><strong>Live proofs</strong><small>enforced end to end</small></div>
        <div><span>403</span><strong>Gateway denials</strong><small>before an upstream is reached</small></div>
        <div><span>1</span><strong>Trace per decision</strong><small>native Kong telemetry</small></div>
      </footer>
    </main>
  );
}

function Overview({
  metrics,
  events,
  policy,
  pending,
  onNavigate,
  onEvent,
}: {
  metrics: Metric[];
  events: Event[];
  policy: Policy | null;
  pending: number;
  onNavigate: (view: View) => void;
  onEvent: (event: Event) => void;
}) {
  const denials = events.filter(
    (event) =>
      event.origin === "LIVE" && decisionTone(event.decision) === "danger",
  ).length;
  return (
    <div className="page-stack">
      <section className="summary-strip">
        <div>
          <span className="summary-label">Enforcement state</span>
          <strong>
            {policy?.drift
              ? "Policy drift needs review"
              : "Policy matches Konnect"}
          </strong>
          <p>
            {policy?.drift
              ? "The live Coding allow list differs from its desired policy."
              : "Kong resolves every caller to an AI Consumer before it evaluates access."}
          </p>
        </div>
        <div className="summary-actions">
          <button
            className="button button-secondary"
            onClick={() => onNavigate(policy?.drift ? "traffic" : "agents")}
          >
            {policy?.drift ? "Review drift" : "Review agent access"}
            <ArrowRight size={14} />
          </button>
        </div>
      </section>
      <section className="metric-grid">
        {metrics.map((metric) => (
          <article className="metric-card" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <p>{metric.detail}</p>
          </article>
        ))}
        <article className="metric-card">
          <span>Live denials</span>
          <strong>{denials}</strong>
          <p>gateway decisions retained in this session</p>
        </article>
        <article className="metric-card">
          <span>Pending approvals</span>
          <strong>{pending}</strong>
          <p>requests waiting for an operator</p>
        </article>
      </section>
      <section className="content-grid overview-grid">
        <article className="surface">
          <SurfaceHeader
            label="A2A policy"
            title="Coding accepts two callers"
            action="Open agent graph"
            onAction={() => onNavigate("agents")}
          />
          <div className="access-table">
            <div className="access-row">
              <AgentMark tone="blue" initials="PL" />
              <span>planner-agent</span>
              <span className="route-line success">
                <ArrowRight size={14} /> Coding
              </span>
              <DecisionBadge value="Allowed" />
            </div>
            <div className="access-row">
              <AgentMark tone="amber" initials="SE" />
              <span>security-agent</span>
              <span className="route-line success">
                <ArrowRight size={14} /> Coding
              </span>
              <DecisionBadge value="Allowed" />
            </div>
            <div className="access-row">
              <AgentMark tone="violet" initials="RE" />
              <span>research-agent</span>
              <span className="route-line danger">
                <ArrowRight size={14} /> Coding
              </span>
              <DecisionBadge value="Denied" />
            </div>
          </div>
          <p className="surface-note">
            Coding’s destination allow list is evaluated at Kong before its
            upstream A2A agent receives <code>message/send</code>.
          </p>
        </article>
        <article className="surface">
          <SurfaceHeader
            label="Recent evidence"
            title="Gateway activity"
            action="Open audit"
            onAction={() => onNavigate("traffic")}
          />
          <div className="mini-event-list">
            {events.slice(0, 5).map((event) => (
              <EventRow
                key={event.id}
                event={event}
                onClick={() => onEvent(event)}
                compact
              />
            ))}
          </div>
        </article>
      </section>
      <section className="surface guidance">
        <div className="guidance-icon">
          <Eye size={18} />
        </div>
        <div>
          <p className="section-kicker">TRACE-CORRELATED EVIDENCE</p>
          <h2>Every operator decision has proof behind it.</h2>
          <p>
            Airlock preserves native Kong OpenTelemetry records alongside its
            audit projections. The trace ID is the link between the gateway
            decision, the upstream result, and the human action.
          </p>
        </div>
        <button
          className="button button-secondary"
          onClick={() => onNavigate("attack")}
        >
          Run live proofs <ArrowRight size={14} />
        </button>
      </section>
    </div>
  );
}
function AgentsView({
  onRun,
  running,
}: {
  onRun: () => void;
  running: string | null;
}) {
  return (
    <div className="page-stack">
      <section className="surface">
        <SurfaceHeader
          label="Machine identities"
          title="One consumer identity per agent"
          right={<Badge tone="success">Kong key-auth</Badge>}
        />
        <p className="intro-copy">
          Each agent authenticates independently. Kong evaluates the caller
          identity first, then applies the destination allow list for that
          agent.
        </p>
        <AgentRelationshipGraph />
        <div className="data-table agent-table">
          <div className="table-head">
            <span>Identity</span>
            <span>Operational role</span>
            <span>Permitted access</span>
            <span>Credential</span>
          </div>
          {agents.map((agent) => (
            <div className="table-row" key={agent.id}>
              <div className="identity-cell">
                <AgentMark
                  tone={agent.tone}
                  initials={agent.name.slice(0, 2).toUpperCase()}
                />
                <div>
                  <b>{agent.name}</b>
                  <code>{agent.id}</code>
                </div>
              </div>
              <span>{agent.activity}</span>
              <span>{agent.access}</span>
              <span>
                <Badge tone="neutral">
                  <KeyRound size={11} /> own consumer
                </Badge>
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="content-grid agent-detail-grid">
        <article className="surface">
          <SurfaceHeader
            label="Destination control"
            title="Coding’s inbound allow list"
          />
          <div className="allow-list">
            <div>
              <DecisionBadge value="Allowed" />
              <code>planner-agent</code>
            </div>
            <div>
              <DecisionBadge value="Allowed" />
              <code>security-agent</code>
            </div>
            <div>
              <DecisionBadge value="Denied" />
              <code>research-agent</code>
              <span>not present in allow list</span>
            </div>
          </div>
        </article>
        <article className="surface danger-surface">
          <SurfaceHeader
            label="Live validation"
            title="Prove the rejected route"
          />
          <p>
            Send a protocol-valid A2A <code>message/send</code> request from
            Research to Coding. Kong should return 403 before Coding’s upstream
            receives anything.
          </p>
          <button
            className="button button-danger"
            disabled={running !== null}
            onClick={onRun}
          >
            {running === "a2a-denial" ? (
              <>
                <RefreshCw size={14} className="spin" /> Running test
              </>
            ) : (
              <>
                Run A2A denial <ArrowRight size={14} />
              </>
            )}
          </button>
        </article>
      </section>
    </div>
  );
}

function AgentRelationshipGraph() {
  return (
    <section className="relationship-graph" aria-label="A2A relationship graph">
      <div className="graph-heading">
        <div>
          <p className="section-kicker">A2A RELATIONSHIP GRAPH</p>
          <h2>Coding inbound policy</h2>
        </div>
        <div className="graph-legend" aria-label="Graph legend">
          <span><i className="legend-line allowed" /> Allowed route</span>
          <span><i className="legend-line denied" /> Denied route</span>
        </div>
      </div>
      <div className="graph-canvas">
        <svg viewBox="0 0 720 310" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <marker id="airlock-arrow-allow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="arrow-allow" /></marker>
            <marker id="airlock-arrow-deny" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="arrow-deny" /></marker>
          </defs>
          <path className="graph-path graph-path-allow" d="M 214 63 C 355 63, 395 145, 504 155" markerEnd="url(#airlock-arrow-allow)" />
          <path className="graph-path graph-path-deny" d="M 214 155 C 337 155, 405 155, 504 155" markerEnd="url(#airlock-arrow-deny)" />
          <path className="graph-path graph-path-allow" d="M 214 247 C 355 247, 395 166, 504 155" markerEnd="url(#airlock-arrow-allow)" />
          <text className="graph-label graph-label-allow" x="371" y="90">ALLOW</text>
          <text className="graph-label graph-label-deny" x="365" y="145">DENY</text>
          <text className="graph-label graph-label-allow" x="371" y="226">ALLOW</text>
        </svg>
        <div className="graph-node planner"><AgentMark tone="blue" initials="PL" /><div><b>Planner</b><code>planner-agent</code></div></div>
        <div className="graph-node research"><AgentMark tone="violet" initials="RE" /><div><b>Research</b><code>research-agent</code></div></div>
        <div className="graph-node security"><AgentMark tone="amber" initials="SE" /><div><b>Security</b><code>security-agent</code></div></div>
        <div className="graph-node coding"><AgentMark tone="teal" initials="CO" /><div><b>Coding</b><code>coding-agent</code></div><Badge tone="success">allow list</Badge></div>
      </div>
      <p className="graph-footnote">Kong evaluates each caller’s authenticated AI Consumer identity before it forwards A2A <code>message/send</code> traffic to Coding.</p>
    </section>
  );
}

function AttackLab({
  onRun,
  running,
  latest,
}: {
  onRun: (id: string) => void;
  running: string | null;
  latest?: Event;
}) {
  return (
    <div className="page-stack">
      <section className="surface validation-intro">
        <div>
          <p className="section-kicker">LIVE TEST HARNESS</p>
          <h2>Validate the boundary, not the interface.</h2>
          <p>
            Every test reaches the local Kong data plane. Airlock retains the
            trace, gateway response, and upstream proof so it can be inspected
            afterwards.
          </p>
        </div>
        <div className="proof-keys">
          <span>
            <Check size={13} /> protocol request
          </span>
          <span>
            <Check size={13} /> Kong evidence
          </span>
          <span>
            <Check size={13} /> upstream assertion
          </span>
        </div>
      </section>
      <section className="scenario-table surface">
        <div className="scenario-head">
          <span>Test</span>
          <span>Path</span>
          <span>Expected proof</span>
          <span />
        </div>
        {scenarios.map((scenario) => (
          <div className="scenario-row" key={scenario.id}>
            <div>
              <b>{scenario.title}</b>
              <p>{scenario.description}</p>
            </div>
            <code>{scenario.protocol}</code>
            <span>{scenario.expected}</span>
            <button
              className="button button-secondary button-small"
              disabled={running !== null}
              onClick={() => onRun(scenario.id)}
            >
              {running === scenario.id ? (
                <RefreshCw className="spin" size={13} />
              ) : (
                "Run test"
              )}
            </button>
          </div>
        ))}
      </section>
      {latest && (
        <section className="inline-evidence">
          <Cpu size={17} />
          <div>
            <b>Most recent model recovery</b>
            <span>
              Primary adapter failed; Kong continued the same request on the
              fallback target.
            </span>
          </div>
          <DecisionBadge value={latest.decision} />
          <code>{compactId(latest.traceId)}</code>
        </section>
      )}
    </div>
  );
}
function ApprovalsView({
  approvals,
  onOpen,
  onRun,
  running,
}: {
  approvals: Approval[];
  onOpen: (approval: Approval) => void;
  onRun: () => void;
  running: string | null;
}) {
  const ordered = [...approvals].sort(
    (a, b) => Number(b.status === "PENDING") - Number(a.status === "PENDING"),
  );
  return (
    <div className="page-stack">
      <section className="surface approval-brief">
        <div>
          <p className="section-kicker">JUST-IN-TIME ACCESS</p>
          <h2>Approval creates a limited capability.</h2>
          <p>
            Normal Coding credentials cannot call <code>create_branch</code>.
            After approval, Airlock’s backend uses its server-only approval
            identity only for the stored grant.
          </p>
        </div>
        <button className="button" disabled={running !== null} onClick={onRun}>
          <ClipboardCheck size={14} /> New request
        </button>
      </section>
      <section className="surface">
        <div className="table-toolbar">
          <div>
            <h2>Request queue</h2>
            <p>Open a request to review scope, trace, and grant options.</p>
          </div>
          <Badge tone="neutral">{ordered.length} records</Badge>
        </div>
        {ordered.length ? (
          <div className="data-table approval-table">
            <div className="table-head">
              <span>Status</span>
              <span>Requested operation</span>
              <span>Identity</span>
              <span>Scope</span>
              <span>Created</span>
              <span />
            </div>
            {ordered.map((approval) => (
              <button
                className="table-row table-button"
                key={approval.id}
                onClick={() => onOpen(approval)}
              >
                <span>
                  <DecisionBadge value={approval.status} />
                </span>
                <span>
                  <code>{approval.tool}</code>
                  <small>payments-api</small>
                </span>
                <code>{approval.requester}</code>
                <span>
                  {approval.remainingUses === 1
                    ? "One invocation"
                    : approval.expiresAt
                      ? "Timed grant"
                      : "Awaiting review"}
                </span>
                <span>{readableTime(approval.createdAt)}</span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={ClipboardCheck}
            title="No approval requests"
            text="Create a branch request to demonstrate the just-in-time path."
            action="New request"
            onAction={onRun}
          />
        )}
      </section>
    </div>
  );
}
function ToolsView({
  onRun,
  running,
}: {
  onRun: () => void;
  running: string | null;
}) {
  return (
    <div className="page-stack">
      <section className="surface">
        <SurfaceHeader
          label="MCP listener"
          title="Tool access is evaluated by exact name"
          right={<Badge tone="info">Listener mode</Badge>}
        />
        <p className="intro-copy">
          These are real MCP <code>tools/call</code> operations. Kong resolves
          the AI Consumer, applies the default policy, then checks the
          listener’s per-tool allow list before forwarding a request.
        </p>
        <div className="data-table tool-table">
          <div className="table-head">
            <span>Tool</span>
            <span>Operation</span>
            <span>Research</span>
            <span>Coding</span>
            <span>Enforced by</span>
          </div>
          {tools.map((tool) => (
            <div className="table-row" key={tool.name}>
              <code>{tool.name}</code>
              <span>{tool.description}</span>
              <AccessText value={tool.research} />
              <AccessText value={tool.coding} />
              <span>{tool.enforcement}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="surface danger-surface action-panel">
        <div>
          <div>
            <p className="section-kicker">DESTRUCTIVE ACTION CHECK</p>
            <h2>
              Prove <code>delete_repository</code> never reached the MCP server.
            </h2>
            <p>
              Research calls the real tool through Kong. A valid result is HTTP
              403, native telemetry, a matching audit projection, and a
              destructive invocation counter of zero.
            </p>
          </div>
          <button
            className="button button-danger"
            disabled={running !== null}
            onClick={onRun}
          >
            {running === "mcp-denial" ? (
              <>
                <RefreshCw className="spin" size={14} /> Testing
              </>
            ) : (
              <>
                Run destructive-call test <ArrowRight size={14} />
              </>
            )}
          </button>
        </div>
      </section>
    </div>
  );
}
function ModelsView({
  latest,
  onRun,
  running,
}: {
  latest?: Event;
  onRun: () => void;
  running: string | null;
}) {
  const primary = latest?.adapters?.primary;
  const fallback = latest?.adapters?.fallback;
  return (
    <div className="page-stack">
      <section className="surface model-brief">
        <div>
          <p className="section-kicker">KONG AI MODEL</p>
          <h2>One client request. Kong owns target selection.</h2>
          <p>
            FastAPI does not choose a fallback. Kong applies priority, retries,
            and failure criteria across the two Ollama adapter targets.
          </p>
        </div>
        <button className="button" disabled={running !== null} onClick={onRun}>
          {running === "failover" ? (
            <>
              <RefreshCw className="spin" size={14} /> Running test
            </>
          ) : (
            <>
              <Cpu size={14} /> Force primary failure
            </>
          )}
        </button>
      </section>
      <section className="model-layout">
        <article className="surface model-target">
          <div className="target-header">
            <Badge tone="success">Priority 100</Badge>
            <span>Primary</span>
          </div>
          <h2>qwen3:8b</h2>
          <code>ollama-primary-adapter</code>
          <CounterGrid
            values={[
              "Attempts",
              primary?.attempts,
              "Failures",
              primary?.failures,
            ]}
          />
        </article>
        <div className="model-connector">
          <span>Kong retry</span>
          <ArrowRight size={20} />
        </div>
        <article className="surface model-target">
          <div className="target-header">
            <Badge tone="info">Priority 10</Badge>
            <span>Fallback</span>
          </div>
          <h2>qwen2.5-coder:1.5b</h2>
          <code>ollama-fallback-adapter</code>
          <CounterGrid
            values={[
              "Attempts",
              fallback?.attempts,
              "Succeeded",
              fallback?.successful,
            ]}
          />
        </article>
      </section>
      <section className="inline-evidence">
        <Database size={17} />
        <div>
          <b>Adapter counters are the proof</b>
          <span>
            The primary adapter is forced to return 5xx. A fallback attempt only
            occurs after Kong retries the same request.
          </span>
        </div>
        {latest ? (
          <>
            <DecisionBadge value={latest.decision} />
            <code>{compactId(latest.traceId)}</code>
          </>
        ) : (
          <span className="muted">
            Run the resilience test to collect live counters.
          </span>
        )}
      </section>
    </div>
  );
}
function TrafficView({
  events,
  filter,
  query,
  setFilter,
  setQuery,
  policy,
  running,
  onSync,
  onOpen,
}: {
  events: Event[];
  filter: "all" | "live" | "denied";
  query: string;
  setFilter: (filter: "all" | "live" | "denied") => void;
  setQuery: (query: string) => void;
  policy: Policy | null;
  running: string | null;
  onSync: () => void;
  onOpen: (event: Event) => void;
}) {
  return (
    <div className="page-stack">
      <section className={`policy-banner ${policy?.drift ? "is-drift" : ""}`}>
        <div>
          <p className="section-kicker">KONNECT POLICY</p>
          <h2>
            {policy?.drift ? "Policy drift detected" : "Desired policy is live"}
          </h2>
          <p>
            Coding caller allow list:{" "}
            <code>{policy?.actual?.join(", ") || "loading"}</code>
          </p>
        </div>
        {policy?.drift ? (
          <button
            className="button button-danger"
            disabled={running !== null}
            onClick={onSync}
          >
            {running === "policy-sync" ? "Restoring…" : "Restore policy"}
          </button>
        ) : (
          <Badge tone="success">
            <Check size={12} /> Verified
          </Badge>
        )}
      </section>
      <section className="surface audit-surface">
        <div className="audit-toolbar">
          <div>
            <h2>Request evidence</h2>
            <p>
              Click any record to inspect its trace context and native
              attributes.
            </p>
          </div>
          <label className="search-field">
            <Search size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter events"
            />
          </label>
          <div className="filter-tabs">
            {(["all", "live", "denied"] as const).map((item) => (
              <button
                key={item}
                className={filter === item ? "selected" : ""}
                onClick={() => setFilter(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="data-table audit-table">
          <div className="table-head">
            <span>Time</span>
            <span>Event</span>
            <span>Path</span>
            <span>Decision</span>
            <span>Evidence</span>
            <span />
          </div>
          {events.map((event) => (
            <button
              className="table-row table-button"
              key={event.id}
              onClick={() => onOpen(event)}
            >
              <time>{readableTime(event.timestamp)}</time>
              <span className="event-name">
                <b>{eventTitle(event)}</b>
                <small>
                  {event.message ?? "Trace-correlated gateway record"}
                </small>
              </span>
              <span>
                <code>{event.source ?? "kong"}</code> <ArrowRight size={11} />{" "}
                <code>{event.destination ?? "Airlock"}</code>
              </span>
              <DecisionBadge value={event.decision} />
              <OriginBadge value={event.origin} />
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
        {events.length === 0 && (
          <EmptyState
            icon={Waypoints}
            title="No matching evidence"
            text="Try a broader filter or run a live proof from Attack lab."
          />
        )}
      </section>
    </div>
  );
}
function SideSheet({
  sheet,
  onClose,
  onDecide,
  running,
}: {
  sheet: Exclude<Sheet, null>;
  onClose: () => void;
  onDecide: (
    approval: Approval,
    decision: "approve-once" | "approve-10m" | "deny",
  ) => void;
  running: string | null;
}) {
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="side-sheet"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <p className="section-kicker">
              {sheet.type === "event"
                ? "TRACE INSPECTOR"
                : sheet.type === "approval"
                  ? "APPROVAL REQUEST"
                  : "TEST RESULT"}
            </p>
            <h2>
              {sheet.type === "event"
                ? eventTitle(sheet.event)
                : sheet.type === "approval"
                  ? sheet.approval.tool
                  : scenarios.find((item) => item.id === sheet.result.id)
                      ?.title}
            </h2>
          </div>
          <button
            className="icon-close"
            onClick={onClose}
            aria-label="Close details"
          >
            <X size={18} />
          </button>
        </header>
        {sheet.type === "event" && <EventInspector event={sheet.event} />}
        {sheet.type === "run" && <RunInspector result={sheet.result} />}
        {sheet.type === "approval" && (
          <ApprovalInspector
            approval={sheet.approval}
            running={running}
            onDecide={onDecide}
          />
        )}
      </aside>
    </div>
  );
}
function EventInspector({ event }: { event: Event }) {
  const attributes = event.otelAttributes ?? {};
  const keys = Object.keys(attributes);
  return (
    <div className="sheet-body">
      <div className="sheet-badges">
        <OriginBadge value={event.origin} />
        <DecisionBadge value={event.decision} />
      </div>
      <p className="sheet-copy">
        {event.message ??
          "Airlock received a trace-correlated record from the gateway."}
      </p>
      <DetailList
        entries={[
          ["Trace ID", compactId(event.traceId)],
          ["Kong request", compactId(event.kongRequestId)],
          [
            "Protocol",
            event.protocol ??
              (event.kind.includes("otel")
                ? "OpenTelemetry"
                : "Airlock projection"),
          ],
          ["Observed", readableTime(event.timestamp)],
          ["HTTP status", event.status ? String(event.status) : "—"],
        ]}
      />
      {keys.length > 0 && (
        <section className="attribute-section">
          <p className="section-kicker">NATIVE KONG ATTRIBUTES</p>
          {keys.slice(0, 12).map((key) => (
            <div key={key}>
              <code>{key}</code>
              <span>{String(attributes[key])}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
function RunInspector({ result }: { result: RunResult }) {
  const scenario = scenarios.find((item) => item.id === result.id);
  const failover = result.id === "failover";
  return (
    <div className="sheet-body">
      <div className="sheet-badges">
        <Badge tone="success">
          <Check size={12} /> Test completed
        </Badge>
        {result.status && (
          <Badge tone={result.status >= 400 ? "danger" : "success"}>
            HTTP {result.status}
          </Badge>
        )}
      </div>
      <p className="sheet-copy">
        {failover
          ? "The primary adapter failed and Kong retried the same client request on its lower-priority model target."
          : scenario?.expected}
      </p>
      <DetailList
        entries={[
          ["Trace ID", compactId(result.traceId)],
          [
            "Gateway response",
            result.status ? `HTTP ${result.status}` : "Recorded",
          ],
          ["Evidence", "Available in Traffic & audit"],
        ]}
      />
      {failover && (
        <section className="counter-panel">
          <p className="section-kicker">ADAPTER COUNTERS</p>
          <CounterGrid
            values={[
              "Primary attempts",
              result.primary?.attempts,
              "Primary failures",
              result.primary?.failures,
              "Fallback attempts",
              result.fallback?.attempts,
              "Fallback succeeded",
              result.fallback?.successful,
            ]}
          />
        </section>
      )}
      <p className="sheet-footnote">
        Open Traffic & audit and locate this trace to inspect the native Kong
        record.
      </p>
    </div>
  );
}
function ApprovalInspector({
  approval,
  running,
  onDecide,
}: {
  approval: Approval;
  running: string | null;
  onDecide: (
    approval: Approval,
    decision: "approve-once" | "approve-10m" | "deny",
  ) => void;
}) {
  const pending = approval.status === "PENDING";
  return (
    <div className="sheet-body">
      <div className="sheet-badges">
        <DecisionBadge value={approval.status} />
        <Badge tone="neutral">
          <LockKeyhole size={12} /> backend only
        </Badge>
      </div>
      <p className="sheet-copy">
        The browser and normal Coding agent cannot access the approval
        credential. If approved, the backend invokes <code>create_branch</code>{" "}
        through Kong with the narrowly scoped <code>approval-coding-agent</code>{" "}
        identity.
      </p>
      <DetailList
        entries={[
          ["Requester", approval.requester],
          ["Tool", approval.tool],
          ["Trace ID", compactId(approval.traceId)],
          ["Requested", readableTime(approval.createdAt)],
          [
            "Grant scope",
            approval.remainingUses === 1
              ? "One invocation"
              : approval.expiresAt
                ? `Expires ${readableTime(approval.expiresAt)}`
                : "Awaiting decision",
          ],
        ]}
      />
      {pending ? (
        <div className="decision-actions">
          <p className="section-kicker">OPERATOR DECISION</p>
          <button
            className="button button-danger button-full"
            disabled={running !== null}
            onClick={() => onDecide(approval, "deny")}
          >
            Deny request
          </button>
          <button
            className="button button-secondary button-full"
            disabled={running !== null}
            onClick={() => onDecide(approval, "approve-10m")}
          >
            Approve for 10 minutes
          </button>
          <button
            className="button button-full"
            disabled={running !== null}
            onClick={() => onDecide(approval, "approve-once")}
          >
            {running === approval.id ? "Calling through Kong…" : "Approve once"}
          </button>
        </div>
      ) : (
        <div className="outcome">
          <Check size={17} />
          <span>
            {approval.status === "CONSUMED"
              ? "Grant consumed after successful branch creation."
              : approval.status === "DENIED"
                ? "Request closed; no privileged call was made."
                : `Request is ${approval.status.toLowerCase()}.`}
          </span>
        </div>
      )}
    </div>
  );
}
function SurfaceHeader({
  label,
  title,
  action,
  onAction,
  right,
}: {
  label: string;
  title: string;
  action?: string;
  onAction?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="surface-header">
      <div>
        <p className="section-kicker">{label}</p>
        <h2>{title}</h2>
      </div>
      {right ??
        (action && onAction ? (
          <button className="link-button" onClick={onAction}>
            {action}
            <ChevronRight size={14} />
          </button>
        ) : null)}
    </div>
  );
}
function AgentMark({ initials, tone }: { initials: string; tone: string }) {
  return <span className={`agent-mark ${tone}`}>{initials}</span>;
}
function AccessText({ value }: { value: string }) {
  return (
    <span
      className={
        value === "Blocked"
          ? "access-danger"
          : value.includes("Approval")
            ? "access-warning"
            : "access-success"
      }
    >
      {value}
    </span>
  );
}
function CounterGrid({ values }: { values: (string | number | undefined)[] }) {
  const pairs: [string, string | number | undefined][] = [];
  for (let i = 0; i < values.length; i += 2)
    pairs.push([String(values[i]), values[i + 1]]);
  return (
    <div className="counter-grid">
      {pairs.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <b>{value ?? "—"}</b>
        </div>
      ))}
    </div>
  );
}
function DetailList({ entries }: { entries: [string, string][] }) {
  return (
    <dl className="detail-list">
      {entries.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function EventRow({
  event,
  onClick,
  compact = false,
}: {
  event: Event;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      className={compact ? "mini-event compact" : "mini-event"}
      onClick={onClick}
    >
      <OriginBadge value={event.origin} />
      <div>
        <b>{eventTitle(event)}</b>
        <span>
          {event.message ??
            `${event.source ?? "kong"} → ${event.destination ?? "Airlock"}`}
        </span>
      </div>
      <DecisionBadge value={event.decision} />
      <time>{readableTime(event.timestamp)}</time>
      <ChevronRight size={15} />
    </button>
  );
}
function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  onAction,
}: {
  icon: typeof Activity;
  title: string;
  text: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <Icon size={21} />
      <b>{title}</b>
      <p>{text}</p>
      {action && onAction && (
        <button className="button button-small" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}
