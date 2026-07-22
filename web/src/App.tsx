import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { analyze, EXPLORER, type Portfolio, type PositionPnL } from "./lib/chain";
import { fmtPct, fmtToken, shortId, signUnit, signUsd } from "./lib/format";
import { toUsd } from "./lib/numeraire";
import { bucketByDay, dayKeyLocal, monthGrid, monthRange } from "./lib/calendar";

const DEMO_WALLET = "0x7e995decc404633CF2889968537D723c55ffEA2C";

export default function App() {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [data, setData] = useState<Portfolio | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null); // null = WETH-only view

  async function run(raw: string) {
    const q = raw.trim();
    if (!q) return;
    setStatus("loading");
    setError("");
    setData(null);
    setProgress(null);
    try {
      const res = await analyze(q, (d, t) => setProgress([d, t]));
      setData(res);
      setStatus("done");
    } catch (e) {
      setError((e as Error).message || "Something went wrong.");
      setStatus("error");
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    run(input);
  };

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-5xl px-4 pb-24 pt-8 sm:pt-12">
        <Header ethUsd={ethUsd} setEthUsd={setEthUsd} />

        <form onSubmit={onSubmit} className="mt-8">
          <label htmlFor="q" className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted">
            Wallet address or transaction hash
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="q"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-4 py-3 font-mono text-sm text-fg placeholder:text-muted/60"
            />
            <button
              type="submit"
              disabled={status === "loading" || !input.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-base transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "loading" ? "Analyzing…" : "Analyze PnL"}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Try:</span>
            <button
              type="button"
              onClick={() => { setInput(DEMO_WALLET); run(DEMO_WALLET); }}
              className="rounded-lg border border-border bg-surface px-2.5 py-1 font-mono text-[11px] text-fg/80 transition-colors hover:border-accent/60 hover:text-fg"
            >
              {shortId(DEMO_WALLET, 8, 6)} · wallet
            </button>
          </div>
        </form>

        <div className="mt-8">
          {status === "loading" && <LoadingState progress={progress} />}
          {status === "error" && <ErrorState message={error} onRetry={() => run(input)} />}
          {status === "done" && data && (data.positions.length ? <Results data={data} ethUsd={ethUsd} /> : <EmptyState query={data.query} />)}
          {status === "idle" && <IdleState />}
        </div>
      </div>
    </div>
  );
}

function Header({ ethUsd, setEthUsd }: { ethUsd: number | null; setEthUsd: (v: number | null) => void }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/15 text-accent" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
            </svg>
          </span>
          <h1 className="text-lg font-semibold tracking-tight">LP PnL Tracker</h1>
        </div>
        <p className="mt-1.5 text-sm text-muted">
          Uniswap v3 liquidity PnL on <span className="text-fg">Robinhood Chain</span> — fees, impermanent loss, and net return per position.
        </p>
      </div>

      <fieldset className="shrink-0 rounded-xl border border-border bg-surface p-1 text-xs" aria-label="Value display unit">
        <div className="flex items-center gap-1">
          <UnitToggle active={ethUsd === null} onClick={() => setEthUsd(null)}>Ξ WETH</UnitToggle>
          <UnitToggle active={ethUsd !== null} onClick={() => setEthUsd(ethUsd ?? 3000)}>USD</UnitToggle>
          {ethUsd !== null && (
            <label className="ml-1 flex items-center gap-1 pl-1 pr-1.5 text-muted">
              <span className="sr-only">ETH price in USD</span>
              <span aria-hidden>ETH $</span>
              <input
                type="number"
                min={0}
                value={ethUsd}
                onChange={(e) => setEthUsd(Math.max(0, Number(e.target.value) || 0))}
                className="w-16 rounded-md border border-border bg-surface-2 px-1.5 py-1 font-mono text-fg tnum"
              />
            </label>
          )}
        </div>
      </fieldset>
    </header>
  );
}

function UnitToggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg px-2.5 py-1.5 font-medium transition-colors ${active ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

// ─── Results ───
function Results({ data, ethUsd }: { data: Portfolio; ethUsd: number | null }) {
  const t = data.totals;
  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted">
          {data.kind === "wallet" ? `${t.count} position${t.count === 1 ? "" : "s"}` : "Position"}
          <span className="mx-1.5 text-border">·</span>
          <a href={`${EXPLORER}/address/${data.query}`} target="_blank" rel="noreferrer" className="font-mono text-fg/70 underline decoration-border underline-offset-2 hover:text-accent">
            {shortId(data.query, 8, 6)}
          </a>
        </h2>
      </div>

      <SummaryBar positions={data.positions} ethUsd={ethUsd} />

      {data.kind === "wallet" && <PnlCalendar positions={data.positions} ethUsd={ethUsd} />}

      {data.skipped.length > 0 && (
        <p className="rounded-xl border border-neg/30 bg-neg/5 px-3 py-2 text-xs text-muted" role="status">
          {data.skipped.length} position{data.skipped.length === 1 ? "" : "s"} couldn’t be read after retries (burned NFT or RPC error) and {data.skipped.length === 1 ? "is" : "are"} excluded from totals: <span className="font-mono text-fg/70">#{data.skipped.join(", #")}</span>
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {data.positions.map((p) => <PositionCard key={String(p.tokenId)} p={p} ethUsd={ethUsd} />)}
      </div>
    </section>
  );
}

// A position's value converted for display. USD-numeraire positions are always
// dollars; ETH-numeraire positions honour the Ξ/USD toggle (ethUsd null = Ξ).
function convPos(valueInNumeraire: number, p: PositionPnL, ethUsd: number | null) {
  if (p.numeraireKind === "usd") return valueInNumeraire; // already USD
  return ethUsd === null ? valueInNumeraire : valueInNumeraire * ethUsd;
}
function signMoneyPos(valueInNumeraire: number, p: PositionPnL, ethUsd: number | null) {
  if (p.numeraireKind === "usd") return signUsd(valueInNumeraire);
  return ethUsd === null ? signUnit(valueInNumeraire, "WETH") : signUsd(valueInNumeraire * ethUsd);
}
// Portfolio/calendar aggregates are always USD-normalised (a mix of ETH- and USD-pairs
// can't share a Ξ unit).
function signMoneyUsd(usdValue: number) { return signUsd(usdValue); }

// ─── Realized-PnL calendar (closed positions, bucketed by close date) ───
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

function PnlCalendar({ positions, ethUsd }: { positions: PositionPnL[]; ethUsd: number | null }) {
  const items = useMemo(
    () =>
      positions
        .filter((p) => !p.open)
        .map((p) => ({
          closedAt: p.result.closedAt,
          net: toUsd(p.result.netPnlUsd, p.numeraireKind, ethUsd),
          fees: toUsd(p.result.feesUsd, p.numeraireKind, ethUsd),
          il: toUsd(p.result.ilUsd, p.numeraireKind, ethUsd),
          tokenId: p.tokenId,
        })),
    [positions, ethUsd],
  );
  const buckets = useMemo(() => bucketByDay(items, dayKeyLocal), [items]);
  const range = useMemo(() => monthRange(items, dayKeyLocal), [items]);

  const [ym, setYm] = useState(() => range?.max ?? { year: new Date().getFullYear(), month: new Date().getMonth() });
  const [selected, setSelected] = useState<string | null>(null);

  if (!range) return null; // no closed positions

  const idx = ym.year * 12 + ym.month;
  const minIdx = range.min.year * 12 + range.min.month;
  const maxIdx = range.max.year * 12 + range.max.month;
  const go = (delta: number) => {
    const n = idx + delta;
    if (n < minIdx || n > maxIdx) return;
    setYm({ year: Math.floor(n / 12), month: n % 12 });
    setSelected(null);
  };

  const grid = monthGrid(ym.year, ym.month);
  const monthPrefix = `${ym.year}-${pad2(ym.month + 1)}`;
  let monthNet = 0;
  buckets.forEach((b, k) => { if (k.startsWith(monthPrefix)) monthNet += b.net; });

  const todayKey = dayKeyLocal(Math.floor(Date.now() / 1000));
  const selDay = selected ? buckets.get(selected) : undefined;
  const selPositions = selected ? positions.filter((p) => !p.open && dayKeyLocal(p.result.closedAt) === selected) : [];

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <NavBtn disabled={idx <= minIdx} onClick={() => go(-1)} label="Previous month">‹</NavBtn>
          <h3 className="min-w-[9.5rem] text-center text-sm font-semibold">{MONTH_NAMES[ym.month]} {ym.year}</h3>
          <NavBtn disabled={idx >= maxIdx} onClick={() => go(1)} label="Next month">›</NavBtn>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted">Realized this month</div>
          <div className={`font-mono tnum text-sm font-semibold ${monthNet >= 0 ? "text-pos" : "text-neg"}`}>{signMoneyUsd(monthNet)}</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-7 gap-1">
        {WEEKDAYS.map((d) => (
          <div key={d} className="pb-1 text-center text-[10px] font-medium uppercase tracking-wider text-muted">{d}</div>
        ))}
        {grid.flat().map((cell) => {
          const b = cell.inMonth ? buckets.get(cell.key) : undefined;
          const isToday = cell.key === todayKey;
          const isSel = cell.key === selected;
          const tone = b ? (b.net >= 0 ? "text-pos" : "text-neg") : "text-fg/40";
          const tint = b ? (b.net >= 0 ? "bg-pos/10" : "bg-neg/10") : "";
          const title = b ? `${cell.key}: net ${signMoneyUsd(b.net)} · fees ${signMoneyUsd(b.fees)} · IL ${signMoneyUsd(b.il)} · ${b.count} closed` : undefined;
          return (
            <button
              key={cell.key}
              type="button"
              title={title}
              disabled={!b}
              onClick={() => b && setSelected(isSel ? null : cell.key)}
              className={`flex min-h-[3.25rem] flex-col rounded-lg border p-1.5 text-left transition-colors ${cell.inMonth ? "border-border" : "border-transparent"} ${tint} ${b ? "cursor-pointer hover:border-accent/60" : "cursor-default"} ${isSel ? "ring-1 ring-accent" : ""} ${isToday ? "outline outline-1 outline-accent/50" : ""}`}
            >
              <span className={`text-[11px] ${cell.inMonth ? "text-muted" : "text-fg/25"}`}>{cell.day}</span>
              {b && (
                <span className={`mt-auto truncate font-mono tnum text-[10px] font-semibold ${tone}`}>{signMoneyUsd(b.net)}</span>
              )}
            </button>
          );
        })}
      </div>

      {selected && selDay && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-fg">{selected} · {selDay.count} closed</span>
            <span className={`font-mono tnum font-semibold ${selDay.net >= 0 ? "text-pos" : "text-neg"}`}>{signMoneyUsd(selDay.net)}</span>
          </div>
          <ul className="space-y-1">
            {selPositions.map((p) => (
              <li key={String(p.tokenId)} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-muted">
                  <span className="font-mono text-fg/70">#{String(p.tokenId)}</span> · {p.sym0}/{p.sym1} {(p.fee / 1e4).toFixed(2)}%
                </span>
                <span className={`shrink-0 font-mono tnum ${p.result.netPnlUsd >= 0 ? "text-pos" : "text-neg"}`}>{signMoneyUsd(toUsd(p.result.netPnlUsd, p.numeraireKind, ethUsd))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function NavBtn({ disabled, onClick, label, children }: { disabled: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid h-7 w-7 place-items-center rounded-lg border border-border bg-surface text-muted transition-colors hover:border-accent/60 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function SummaryBar({ positions, ethUsd }: { positions: PositionPnL[]; ethUsd: number | null }) {
  const acc = { net: 0, fees: 0, il: 0, gas: 0 };
  for (const p of positions) {
    acc.net += toUsd(p.result.netPnlUsd, p.numeraireKind, ethUsd);
    acc.fees += toUsd(p.result.feesUsd, p.numeraireKind, ethUsd);
    acc.il += toUsd(p.result.ilUsd, p.numeraireKind, ethUsd);
    acc.gas += toUsd(p.result.gasUsd, p.numeraireKind, ethUsd);
  }
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-4">
      <Stat label="Net PnL" value={signMoneyUsd(acc.net)} tone={acc.net >= 0 ? "pos" : "neg"} big />
      <Stat label="Fees earned" value={signMoneyUsd(acc.fees)} tone="pos" />
      <Stat label="Impermanent loss" value={signMoneyUsd(acc.il)} tone={acc.il < 0 ? "neg" : "muted"} />
      <Stat label="Gas spent" value={signMoneyUsd(-acc.gas)} tone={acc.gas > 0 ? "neg" : "muted"} />
    </div>
  );
}

function Stat({ label, value, tone, big }: { label: string; value: string; tone: "pos" | "neg" | "muted"; big?: boolean }) {
  const color = tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-fg";
  return (
    <div className="bg-surface p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-1.5 font-mono tnum ${big ? "text-xl sm:text-2xl" : "text-base sm:text-lg"} font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function PositionCard({ p, ethUsd }: { p: PositionPnL; ethUsd: number | null }) {
  const r = p.result;
  const net = convPos(r.netPnlUsd, p, ethUsd);
  const approx = p.priceBasis === "lower-boundary" || p.priceBasis === "upper-boundary" || p.priceBasis === "live-fallback";
  const parts = [
    { label: "Fees", v: r.feesUsd, tone: "pos" as const },
    { label: "Price / HODL", v: r.pricePnlUsd, tone: r.pricePnlUsd >= 0 ? ("pos" as const) : ("neg" as const) },
    { label: "Impermanent loss", v: r.ilUsd, tone: "neg" as const },
    { label: "Gas", v: -r.gasUsd, tone: "neg" as const },
  ];
  const maxAbs = Math.max(...parts.map((x) => Math.abs(x.v)), 1e-12);

  return (
    <article className="flex flex-col rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{p.sym0} / {p.sym1}</h3>
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">{(p.fee / 1e4).toFixed(2)}%</span>
            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${p.version === "v4" ? "bg-accent/15 text-accent" : "bg-surface-2 text-muted"}`}>
              {p.version}
            </span>
            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${p.open ? "bg-accent/15 text-accent" : "bg-surface-2 text-muted"}`}>
              {p.open ? "OPEN · MTM" : "closed"}
            </span>
            {approx && (
              <span
                className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted"
                title="Position exited fully out of range. The exact exit price can't be recovered without an archive node, so impermanent loss is priced at the range boundary it crossed — treat it as approximate."
              >
                ≈ out-of-range
              </span>
            )}
            {!p.feesComplete && (
              <span
                className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted"
                title="Some of this position's fee history is older than the RPC's ~14-day state retention, so accrued fees for that period could not be measured and are understated. Principal, price PnL and IL are exact."
              >
                ~ fees partial
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px]">
            {p.txHashes[0] ? (
              <a href={`${EXPLORER}/tx/${p.txHashes[0]}`} target="_blank" rel="noreferrer" title="Entry transaction"
                 className="font-mono text-muted underline decoration-border underline-offset-2 hover:text-accent">
                #{String(p.tokenId)}
              </a>
            ) : (
              <span className="font-mono text-muted">#{String(p.tokenId)}</span>
            )}
            {!p.open && p.exitTx && (
              <a href={`${EXPLORER}/tx/${p.exitTx}`} target="_blank" rel="noreferrer" title="Exit (close) transaction"
                 className="text-muted underline decoration-border underline-offset-2 hover:text-accent">
                exit ↗
              </a>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className={`font-mono tnum text-lg font-semibold ${net >= 0 ? "text-pos" : "text-neg"}`}>{signMoneyPos(r.netPnlUsd, p, ethUsd)}</div>
          <div className={`text-xs font-medium ${r.pnlPct >= 0 ? "text-pos" : "text-neg"}`}>{fmtPct(r.pnlPct)}</div>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {parts.map((x) => (
          <div key={x.label} className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-xs text-muted">{x.label}</span>
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <span
                className={`absolute inset-y-0 ${x.v >= 0 ? "left-1/2 bg-pos" : "right-1/2 bg-neg"}`}
                style={{ width: `${(Math.abs(x.v) / maxAbs) * 50}%` }}
              />
              <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
            </div>
            <span className={`w-24 shrink-0 text-right font-mono tnum text-xs ${x.v >= 0 ? "text-pos" : "text-neg"}`}>{signMoneyPos(x.v, p, ethUsd)}</span>
          </div>
        ))}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-4 text-xs">
        <Row label="Deposited">{fmtToken(r.deposited0, p.sym0)}{r.deposited1 > 0 ? ` + ${fmtToken(r.deposited1, p.sym1)}` : ""}</Row>
        <Row label="Withdrawn">{fmtToken(r.withdrawn0, p.sym0)}{r.withdrawn1 > 0 ? ` + ${fmtToken(r.withdrawn1, p.sym1)}` : ""}</Row>
        <Row label="Fees">{fmtToken(r.fees0, p.sym0)}{r.fees1 > 0 ? ` + ${fmtToken(r.fees1, p.sym1)}` : ""}</Row>
        <Row label="Duration">{r.durationDays < 1 ? `${(r.durationDays * 24).toFixed(1)}h` : `${r.durationDays.toFixed(1)}d`}</Row>
      </dl>
    </article>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate font-mono tnum text-fg/90">{children}</dd>
    </div>
  );
}

// ─── States ───
function IdleState() {
  return (
    <div className="rounded-2xl border border-dashed border-border p-8 text-center">
      <p className="text-sm text-muted">Paste a wallet to sweep every position, or a transaction hash for a single one.</p>
      <p className="mx-auto mt-2 max-w-md text-xs text-muted/70">
        Values default to WETH (Ξ). Impermanent loss is measured against holding your deposit — fees have to beat it to profit.
      </p>
    </div>
  );
}

function LoadingState({ progress }: { progress: [number, number] | null }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <div className="text-xs text-muted">
        {progress ? `Reconstructing positions… ${progress[0]}/${progress[1]}` : "Reading on-chain history…"}
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-surface p-4">
            <div className="skeleton h-3 w-20 rounded" />
            <div className="skeleton mt-3 h-6 w-24 rounded" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-border bg-surface p-5">
            <div className="skeleton h-5 w-32 rounded" />
            <div className="skeleton mt-4 h-1.5 w-full rounded-full" />
            <div className="skeleton mt-2 h-1.5 w-full rounded-full" />
            <div className="skeleton mt-2 h-1.5 w-2/3 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-neg/40 bg-neg/5 p-6" role="alert">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-neg" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 8v4" /><path d="M12 16h.01" /><circle cx="12" cy="12" r="9" /></svg>
        </span>
        <div className="flex-1">
          <p className="text-sm font-medium text-fg">Couldn’t analyze that</p>
          <p className="mt-1 text-sm text-muted">{message}</p>
          <button onClick={onRetry} className="mt-3 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:border-accent/60">
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border p-8 text-center">
      <p className="text-sm font-medium text-fg">No LP positions found</p>
      <p className="mt-1 text-sm text-muted">
        <span className="font-mono">{shortId(query, 8, 6)}</span> hasn’t held a Uniswap v3 position on Robinhood Chain.
      </p>
    </div>
  );
}
