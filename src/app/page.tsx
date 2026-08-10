"use client";

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, BarChart, Bar, Area, AreaChart
} from 'recharts';
import {
  Mail, Send, FileText, AlertTriangle, Trash2, Star, Pin, Paperclip, FolderOpen,
  Clock, Eye, CheckCircle, TrendingUp, TrendingDown, RefreshCw, Calendar, Users,
  Target, Zap, Award, ArrowUp, ArrowDown
} from 'lucide-react';
import { toast } from 'sonner';
import {
  startOfToday, startOfYesterday, endOfYesterday, startOfMonth,
  subDays, isWithinInterval,
} from 'date-fns';
import { ThemeToggle } from '@/components/theme-toggle';

interface Metric {
  value: number;
  prev: number;
  change: number;
  sparkline: number[];
}

interface EmailEvent {
  id: number;
  type: string;
  subject: string;
  from: string;
  timestamp: string;
  label: string;
  read: boolean;
}

interface LabelInfo {
  name: string;
  count: number;
  color: string | null;
}

interface FilterState {
  range: string;
  read: string;
  starred: boolean;
  hasAttachment: boolean;
}

const COLORS = ['var(--pie-1)', 'var(--pie-2)', 'var(--pie-3)'];

const RANGES = ['All-time', 'Today', 'Yesterday', 'Last 7 Days', 'Last 30 Days', 'This Month', 'Last 90 Days'];

// KPI keys that get recomputed from the date-filtered event sample when a
// range other than All-time is selected. The rest (Total Inbox, Important,
// Labels, Read Emails) always show the server's all-time total regardless
// of the date filter — see the spec this was built against.
const DATE_FILTERABLE_METRIC_KEYS = new Set([
  'received', 'sent', 'drafts', 'spam', 'starred', 'unread', 'scheduled', 'attachments',
]);

function isWithinRange(timestamp: string, range: string): boolean {
  if (range === 'All-time') return true;
  const date = new Date(timestamp);
  const now = new Date();
  switch (range) {
    case 'Today':
      return isWithinInterval(date, { start: startOfToday(), end: now });
    case 'Yesterday':
      return isWithinInterval(date, { start: startOfYesterday(), end: endOfYesterday() });
    case 'Last 7 Days':
      return isWithinInterval(date, { start: subDays(now, 7), end: now });
    case 'Last 30 Days':
      return isWithinInterval(date, { start: subDays(now, 30), end: now });
    case 'This Month':
      return isWithinInterval(date, { start: startOfMonth(now), end: now });
    case 'Last 90 Days':
      return isWithinInterval(date, { start: subDays(now, 90), end: now });
    default:
      return true;
  }
}

type DashboardData = {
  metrics: Record<string, Metric>;
  activity: { hour: number; sent: number; received: number; replies: number }[];
  labels: LabelInfo[];
  events: EmailEvent[];
};

const EMPTY_METRIC: Metric = { value: 0, prev: 0, change: 0, sparkline: [0, 0] };
const METRIC_KEYS = [
  'inbox', 'received', 'sent', 'drafts', 'spam', 'trash', 'starred',
  'important', 'attachments', 'labels', 'scheduled', 'unread', 'read',
];
const EMPTY_DATA: DashboardData = {
  metrics: Object.fromEntries(METRIC_KEYS.map(k => [k, EMPTY_METRIC])),
  activity: Array.from({ length: 24 }, (_, hour) => ({ hour, sent: 0, received: 0, replies: 0 })),
  labels: [],
  events: [],
};

export default function EmailIntelligenceDashboard() {
  const { data: session, status } = useSession();
  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [filters, setFilters] = useState<FilterState>({ range: 'All-time', read: 'All', starred: false, hasAttachment: false });
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasData, setHasData] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'activity' | 'labels' | 'insights'>('overview');
  const [searchTerm, setSearchTerm] = useState('');

  // Scheduled sync happens server-side via Vercel Cron (see /api/cron/sync-gmail,
  // scheduled for 8:00 AM and 7:00 PM WAT in vercel.json). On load, and whenever
  // "Sync Now" is pressed, we just read whatever's currently in the DB.
  const loadDashboardData = async () => {
    try {
      const res = await fetch('/api/dashboard-data');
      const json = await res.json();
      if (json.ok) {
        setData({ metrics: json.metrics, activity: json.activity, labels: json.labels, events: json.events });
        setHasData(json.hasAnyData);
        setLastSync(new Date());
        setLoadError(false);
      } else {
        // Leave `data`/`hasData` as they were — a failed request must not be
        // indistinguishable from "nothing synced yet". This is what caused
        // the dashboard to appear to reset to 0 on reload when the Supabase
        // pooler connection dropped: the fetch failed, but nothing told the
        // user it failed, so the still-empty initial state read as real data.
        setLoadError(true);
        toast.error('Could not load dashboard data', { description: json.error ?? 'Database request failed' });
      }
    } catch {
      setLoadError(true);
      toast.error('Could not load dashboard data', { description: 'Network request failed' });
    }
  };

  useEffect(() => {
    let ignore = false;
    (async () => {
      await loadDashboardData();
      if (!ignore) setIsLoading(false);
    })();
    return () => { ignore = true; };
  }, []);

  const handleRefresh = async (silent = false) => {
    if (!silent) setIsRefreshing(true);
    try {
      // Triggers a real Gmail sync (same endpoint the 8am/7pm cron calls),
      // then re-reads the freshly written rows.
      const syncRes = await fetch('/api/cron/sync-gmail');
      const syncJson = await syncRes.json();
      await loadDashboardData();

      if (!silent) {
        if (syncJson.ok) {
          toast.success('Gmail synced successfully', { description: `${syncJson.eventsWritten ?? 0} events indexed` });
        } else {
          toast.error(syncJson.error || 'Sync failed');
        }
      }
    } catch {
      if (!silent) toast.error('Sync failed');
    } finally {
      if (!silent) setIsRefreshing(false);
    }
  };

  const applyFilters = (events: EmailEvent[]) => {
    return events
      .filter(e => isWithinRange(e.timestamp, filters.range))
      .filter(e => filters.read === 'All' || (filters.read === 'Read' ? e.read : !e.read))
      .filter(e => !searchTerm || e.subject.toLowerCase().includes(searchTerm.toLowerCase()) || e.from.toLowerCase().includes(searchTerm.toLowerCase()));
  };

  const filteredEvents = useMemo(
    () => applyFilters(data.events),
    [data.events, filters.range, filters.read, searchTerm]
  );

  // Hourly activity, recomputed from the filtered events so the chart
  // actually reflects the active date-range and label filters, instead of
  // always showing the server's unfiltered all-events bucketing.
  const filteredActivity = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, sent: 0, received: 0, replies: 0 }));
    for (const e of filteredEvents) {
      const hour = new Date(e.timestamp).getHours();
      if (e.type === 'sent') buckets[hour].sent += 1;
      else if (e.type === 'received') buckets[hour].received += 1;
    }
    return buckets;
  }, [filteredEvents]);

  // Derived from the real synced events/metrics (not the date-range filter —
  // insights summarize the full synced dataset). Recomputes automatically
  // whenever `data` changes, i.e. after every loadDashboardData() call.
  const insights = useMemo(() => {
    const events = data.events;

    let busiestHour: number | null = null;
    if (events.length > 0) {
      const hourCounts = new Array(24).fill(0);
      for (const e of events) hourCounts[new Date(e.timestamp).getHours()] += 1;
      busiestHour = hourCounts.indexOf(Math.max(...hourCounts));
    }
    const formatHour = (h: number) => {
      const period = h < 12 ? 'AM' : 'PM';
      const display = h % 12 === 0 ? 12 : h % 12;
      return `${display}:00 ${period}`;
    };
    const busiestHourCount = busiestHour !== null
      ? events.filter(e => new Date(e.timestamp).getHours() === busiestHour).length
      : 0;

    // Only RECEIVED messages count toward "who's emailing me" — sent events
    // have `from` set to the signed-in user's own address, which previously
    // made "Top Contact" show the user's own email instead of a real sender.
    // The ownEmail check is a second guard in case a message is ever
    // misclassified as "received" for a self-sent/self-cc'd email.
    const ownEmail = session?.user?.email?.toLowerCase();
    const senderCounts = new Map<string, number>();
    for (const e of events) {
      if (e.type !== 'received' || !e.from) continue;
      if (ownEmail && e.from.toLowerCase().includes(ownEmail)) continue;
      senderCounts.set(e.from, (senderCounts.get(e.from) ?? 0) + 1);
    }
    const topSender = [...senderCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
    const receivedCount = events.filter(e => e.type === 'received').length;

    const unread = data.metrics.unread;
    const inbox = data.metrics.inbox;
    const readCount = data.metrics.read.value;
    const totalForReadRate = readCount + unread.value;
    const readRate = totalForReadRate > 0 ? Math.round((readCount / totalForReadRate) * 100) : 0;

    return [
      {
        title: 'Busiest Hour',
        value: busiestHour !== null ? formatHour(busiestHour) : '—',
        desc: busiestHour !== null
          ? `${busiestHourCount} of ${events.length} synced emails (${Math.round((busiestHourCount / events.length) * 100)}%) landed in this hour`
          : 'No synced events yet — hit Sync Now to populate this.',
      },
      {
        title: 'Unread Trend',
        value: `${unread.value.toLocaleString()} unread`,
        desc: unread.change === 0
          ? 'No change since the last sync'
          : `${unread.change > 0 ? 'Up' : 'Down'} ${Math.abs(unread.change)}% since the last sync (was ${unread.prev.toLocaleString()})`,
      },
      {
        title: 'Top Contact',
        value: topSender ? topSender[0] : '—',
        desc: topSender
          ? `${topSender[1]} of your last ${receivedCount} received emails are from this address`
          : 'No received emails synced yet — hit Sync Now to populate this.',
      },
      {
        title: 'Inbox Growth',
        value: `${inbox.change > 0 ? '+' : ''}${inbox.change}%`,
        desc: `Inbox went from ${inbox.prev.toLocaleString()} to ${inbox.value.toLocaleString()} messages since the last sync • ${readRate}% read rate overall`,
      },
    ];
  }, [data.events, data.metrics]);

  // Only these have a matching per-event field, so only these can be
  // genuinely recomputed from filteredEvents when a date range is active.
  const EVENT_COUNTERS: Partial<Record<string, (e: EmailEvent) => boolean>> = {
    received: (e) => e.type === 'received',
    sent: (e) => e.type === 'sent',
    drafts: (e) => e.type === 'draft',
    spam: (e) => e.label === 'SPAM',
    starred: (e) => e.label === 'STARRED',
    unread: (e) => !e.read,
  };
  const isDateFiltered = filters.range !== 'All-time';

  // For a KPI that both is date-filterable AND has a real per-event
  // predicate, swap in the count from the currently filtered event sample
  // (capped at the last 20 synced messages — see the note under the KPI
  // grid). Everything else — the 4 always-static cards, plus Attachments
  // and Scheduled which have no per-event data — always show the server's
  // all-time total.
  const kpiValue = (metricKey: string, allTimeValue: number) => {
    const counter = EVENT_COUNTERS[metricKey];
    if (isDateFiltered && DATE_FILTERABLE_METRIC_KEYS.has(metricKey) && counter) {
      return filteredEvents.filter(counter).length;
    }
    return allTimeValue;
  };

  const kpis = [
    { key: 'inbox', label: 'Total Inbox', value: data.metrics.inbox.value, change: data.metrics.inbox.change, icon: Mail, spark: data.metrics.inbox.sparkline, filterable: false },
    { key: 'received', label: 'Received', value: kpiValue('received', data.metrics.received.value), change: data.metrics.received.change, icon: Mail, spark: data.metrics.received.sparkline, filterable: true },
    { key: 'sent', label: 'Sent', value: kpiValue('sent', data.metrics.sent.value), change: data.metrics.sent.change, icon: Send, spark: data.metrics.sent.sparkline, filterable: true },
    { key: 'drafts', label: 'Drafts', value: kpiValue('drafts', data.metrics.drafts.value), change: data.metrics.drafts.change, icon: FileText, spark: data.metrics.drafts.sparkline, filterable: true },
    { key: 'spam', label: 'Spam', value: kpiValue('spam', data.metrics.spam.value), change: data.metrics.spam.change, icon: AlertTriangle, spark: data.metrics.spam.sparkline, filterable: true },
    { key: 'starred', label: 'Starred', value: kpiValue('starred', data.metrics.starred.value), change: data.metrics.starred.change, icon: Star, spark: data.metrics.starred.sparkline, filterable: true },
    { key: 'important', label: 'Important', value: data.metrics.important.value, change: data.metrics.important.change, icon: Pin, spark: data.metrics.important.sparkline, filterable: false },
    { key: 'unread', label: 'Unread', value: kpiValue('unread', data.metrics.unread.value), change: data.metrics.unread.change, icon: Eye, spark: data.metrics.unread.sparkline, filterable: true },
    { key: 'scheduled', label: 'Scheduled', value: data.metrics.scheduled.value, change: data.metrics.scheduled.change, icon: Clock, spark: data.metrics.scheduled.sparkline, filterable: true, noEventData: true },
    { key: 'attachments', label: 'Attachments', value: data.metrics.attachments.value, change: data.metrics.attachments.change, icon: Paperclip, spark: data.metrics.attachments.sparkline, filterable: true, noEventData: true },
    { key: 'labels', label: 'Labels', value: data.metrics.labels.value, change: data.metrics.labels.change, icon: FolderOpen, spark: data.metrics.labels.sparkline, filterable: false },
    { key: 'read', label: 'Read Emails', value: data.metrics.read.value, change: data.metrics.read.change, icon: CheckCircle, spark: data.metrics.read.sparkline, filterable: false },
  ];

  const renderSparkline = (points: number[]) => (
    <svg width="72" height="28" className="sparkline">
      <polyline points={points.map((v, i) => `${(i / (points.length - 1)) * 72},${28 - ((v - Math.min(...points)) / (Math.max(...points) - Math.min(...points))) * 22}`).join(' ')} />
    </svg>
  );

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      {/* Top Navigation */}
      <div className="sticky top-0 z-50 glass border-b border-[var(--border)]">
        <div className="max-w-[1600px] mx-auto px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--accent)] flex items-center justify-center">
              <Mail className="w-4.5 h-4.5 text-white" />
            </div>
            <div>
              <div className="font-semibold tracking-[-0.02em] text-xl">InboxMetrics</div>
              <div className="text-[10px] text-[var(--text-muted)] -mt-1">Gmail Analytics Dashboard</div>
            </div>
          </div>

          <div className="flex items-center gap-4 text-sm">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--card)] border border-[var(--border)]">
              <div className={`w-2 h-2 rounded-full ${hasData ? 'bg-[var(--success)] animate-pulse' : status === 'authenticated' ? 'bg-[var(--warning)]' : 'bg-[var(--text-muted)]'}`} />
              <span className="text-[var(--text-muted)]">
                {hasData
                  ? `Connected to Gmail • ${lastSync ? lastSync.toLocaleTimeString() : ''}`
                  : status === 'authenticated'
                    ? 'Signed in • not synced yet'
                    : 'Not connected yet'}
              </span>
            </div>

            <div className="text-[var(--text-muted)] text-xs px-3 py-1.5 rounded-lg bg-[var(--card)] border border-[var(--border)]">
              Auto-syncs 8:00 AM &amp; 7:00 PM
            </div>

            <button onClick={() => handleRefresh()} disabled={isRefreshing} className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 transition text-white">
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} /> Sync Now
            </button>

            <ThemeToggle />
          </div>
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto px-8 pt-8 pb-16">
        {/* Header */}
        <div className="flex justify-between items-end mb-8">
          <div>
            <div className="text-[var(--text-muted)] text-sm tracking-[3px] font-medium">ENTERPRISE DASHBOARD</div>
            <h1 className="text-5xl font-semibold tracking-[-1.6px] mt-1">Email Intelligence</h1>
          </div>
          <div className="text-right text-sm text-[var(--text-muted)]">
            {data.events.length} events • {lastSync ? `Last synced ${lastSync.toLocaleTimeString()}` : 'Not synced yet'}
          </div>
        </div>

        {!isLoading && loadError && (
          <div className="chart-container p-6 rounded-2xl mb-8 flex items-center justify-between border border-[var(--warning)]/40">
            <div>
              <div className="font-semibold text-lg">Couldn&apos;t reach the database</div>
              <div className="text-[var(--text-muted)] text-sm mt-1">
                {hasData
                  ? 'Showing the last data that loaded successfully — this is not necessarily your current inbox state.'
                  : "The last request to load your data failed, so this isn't confirmed to be empty — it may just be a temporary connection issue."}
              </div>
            </div>
            <button onClick={() => loadDashboardData()} className="px-4 py-2 rounded-lg bg-[var(--warning)] text-[var(--bg)] hover:opacity-90 transition text-sm font-medium">
              Retry
            </button>
          </div>
        )}

        {!isLoading && !loadError && !hasData && status === 'unauthenticated' && (
          <div className="chart-container p-6 rounded-2xl mb-8 flex items-center justify-between">
            <div>
              <div className="font-semibold text-lg">Connect your Gmail account</div>
              <div className="text-[var(--text-muted)] text-sm mt-1">Sign in once, then hit Sync Now to pull your first real numbers in.</div>
            </div>
            <Link href="/api/auth/signin" className="px-4 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition text-sm font-medium text-white">
              Sign in with Google
            </Link>
          </div>
        )}

        {!isLoading && !loadError && !hasData && status === 'authenticated' && (
          <div className="chart-container p-6 rounded-2xl mb-8 flex items-center justify-between">
            <div>
              <div className="font-semibold text-lg">You&apos;re signed in — no data synced yet</div>
              <div className="text-[var(--text-muted)] text-sm mt-1">Click Sync Now (top right) to pull your first real Gmail numbers in.</div>
            </div>
            <button onClick={() => handleRefresh()} disabled={isRefreshing} className="px-4 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 transition text-sm font-medium text-white">
              {isRefreshing ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
        )}

        {/* Global Filters — date range only; label pills were removed
            (no real per-custom-label event data existed to filter by). */}
        <div className="flex flex-wrap gap-2 mb-8">
          {RANGES.map(r => (
            <button key={r} onClick={() => setFilters({ ...filters, range: r })} className={`filter-chip px-4 py-1.5 text-sm rounded-full border ${filters.range === r ? 'active border-[var(--accent)]' : 'border-[var(--border)] hover:bg-[var(--card)]'}`}>
              {r}
            </button>
          ))}
        </div>

        {/* KPI Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4 mb-10">
          {kpis.map((kpi, idx) => {
            const Icon = kpi.icon;
            const up = kpi.change > 0;
            return (
              <div key={idx} className="card rounded-2xl p-5 group">
                <div className="flex justify-between items-start">
                  <div className="p-2 rounded-xl bg-[var(--card-hover)]">
                    <Icon className="w-4 h-4 text-[var(--text-muted)]" />
                  </div>
                  <div className={`flex items-center gap-1 text-xs font-medium ${up ? 'metric-up' : 'metric-down'}`}>
                    {up ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                    {Math.abs(kpi.change)}%
                  </div>
                </div>
                <div className="mt-4">
                  <div className="text-[11px] text-[var(--text-muted)] tracking-wider">{kpi.label.toUpperCase()}</div>
                  <div className="kpi-value text-4xl font-semibold tracking-[-1.5px] mt-1 tabular-nums">{kpi.value.toLocaleString()}</div>
                </div>
                <div className="mt-3 flex justify-between items-end">
                  <div className="text-[10px] text-[var(--text-muted)]">
                    {kpi.filterable && isDateFiltered
                      ? ('noEventData' in kpi && kpi.noEventData ? 'all-time (not filterable)' : filters.range.toLowerCase())
                      : 'vs prev period'}
                  </div>
                  {renderSparkline(kpi.spark)}
                </div>
              </div>
            );
          })}
        </div>
        {isDateFiltered && (
          <div className="text-[11px] text-[var(--text-muted)] -mt-8 mb-10">
            Date-filtered KPIs are counted from the last 20 synced messages, not your full inbox history — Attachments and Scheduled always show the all-time total since there&apos;s no per-message data to filter them by.
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-8 border-b border-[var(--border)] mb-8 text-sm">
          {(['overview', 'activity', 'labels', 'insights'] as const).map(t => (
            <button key={t} onClick={() => setActiveTab(t)} className={`pb-3 font-medium transition ${activeTab === t ? 'tab-active' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {/* OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Email Activity Chart */}
              <div className="lg:col-span-8 chart-container p-8 rounded-3xl">
                <div className="flex justify-between mb-6">
                  <div>
                    <div className="font-semibold tracking-tight text-xl">Email Activity</div>
                    <div className="text-[var(--text-muted)] text-sm">Hourly volume • {filters.range}</div>
                  </div>
                  <div className="flex gap-4 text-xs">
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-px bg-[var(--accent)]" /> Sent</div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-px bg-[var(--success)]" /> Received</div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-px bg-[var(--warning)]" /> Replies</div>
                  </div>
                </div>
                <div className="h-80 -mx-2">
                  <ResponsiveContainer>
                    <AreaChart data={filteredActivity}>
                      <CartesianGrid strokeDasharray="2 2" stroke="var(--border)" />
                      <XAxis dataKey="hour" tickFormatter={h => `${h}:00`} stroke="var(--text-muted)" />
                      <YAxis stroke="var(--text-muted)" />
                      <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)' }} />
                      <Area type="natural" dataKey="sent" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.12} />
                      <Area type="natural" dataKey="received" stroke="var(--success)" fill="var(--success)" fillOpacity={0.12} />
                      <Line type="natural" dataKey="replies" stroke="var(--warning)" strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Inbox Health */}
              <div className="lg:col-span-4 chart-container p-8 rounded-3xl flex flex-col">
                <div className="font-semibold tracking-tight text-xl mb-6">Inbox Health</div>
                <div className="flex-1 flex items-center justify-center">
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie dataKey="value" data={[
                        { name: 'Read', value: data.metrics.read.value },
                        { name: 'Unread', value: data.metrics.unread.value },
                        { name: 'Starred', value: data.metrics.starred.value }
                      ]} cx="50%" cy="50%" innerRadius={68} outerRadius={96}>
                        {[0,1,2].map((_, i) => <Cell key={i} fill={COLORS[i]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)' }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="grid grid-cols-1 text-center text-xs mt-auto pt-6 border-t border-[var(--border)]">
                  <div><div className="font-mono text-xl font-semibold">{((data.metrics.read.value / (data.metrics.read.value + data.metrics.unread.value)) * 100).toFixed(0)}%</div><div className="text-[var(--text-muted)]">Read Rate</div></div>
                </div>
              </div>

              {/* Live Activity Feed */}
              <div className="lg:col-span-12 chart-container p-8 rounded-3xl">
                <div className="flex justify-between mb-6">
                  <div className="font-semibold tracking-tight text-xl">Live Activity Feed</div>
                  <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search emails..." className="bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-1 text-sm w-64 placeholder:text-[var(--text-muted)]" />
                </div>
                <div className="max-h-[380px] overflow-auto pr-1 space-y-px text-sm">
                  {filteredEvents.slice(0, 12).map((ev, idx) => (
                    <div key={idx} className="table-row flex items-center justify-between px-4 py-[13px] rounded-xl">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${ev.read ? 'bg-[var(--success)]' : 'bg-[var(--accent)]'}`} />
                        <div className="font-medium truncate pr-4">{ev.subject}</div>
                        <div className="text-[var(--text-muted)] truncate">{ev.from}</div>
                      </div>
                      <div className="flex items-center gap-5 text-[var(--text-muted)] text-xs tabular-nums">
                        <div className="font-mono">{new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                        <div className="px-2.5 py-px rounded bg-[var(--card-hover)]">{ev.label}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ACTIVITY + LABELS + INSIGHTS */}
          {activeTab === 'activity' && (
            <div className="chart-container p-8 rounded-3xl">
              <div className="font-semibold text-2xl tracking-tight mb-8">Detailed Email Activity</div>
              <ResponsiveContainer height={420}>
                <BarChart data={filteredActivity}>
                  <CartesianGrid stroke="var(--border)" />
                  <XAxis dataKey="hour" stroke="var(--text-muted)" />
                  <YAxis stroke="var(--text-muted)" />
                  <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)' }} />
                  <Bar dataKey="sent" fill="var(--accent)" radius={4} />
                  <Bar dataKey="received" fill="var(--success)" radius={4} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {activeTab === 'labels' && (
            <div className="chart-container p-8 rounded-3xl">
              <div className="font-semibold tracking-tight mb-6 text-xl">Label Distribution</div>
              <div className="text-[var(--text-muted)] text-sm mb-6">Real per-label message counts from your last sync.</div>
              {data.labels.length === 0 ? (
                <div className="text-[var(--text-muted)] text-sm">No label data yet — hit Sync Now to pull it in.</div>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {data.labels.map((l, i) => (
                    <div key={i} className="px-6 py-3 rounded-2xl border border-[var(--border)]">
                      {l.name} <span className="font-mono text-[var(--text-muted)] ml-1.5">{l.count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'insights' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {insights.map((insight, i) => (
                <div key={i} className="card rounded-3xl p-8">
                  <div className="uppercase tracking-[1.5px] text-xs text-[var(--text-muted)]">{insight.title}</div>
                  <div className="text-4xl font-semibold tracking-[-1.2px] mt-3">{insight.value}</div>
                  <div className="mt-4 text-[var(--text-muted)] text-[15px]">{insight.desc}</div>
                </div>
              ))}
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
