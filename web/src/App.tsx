import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { analyze, fetchEthUsd, poolRefsFor, EXPLORER, type Portfolio, type PositionPnL } from "./lib/chain";
import { resetCaches } from "./lib/chain-cache";
import { clearVolumeMemo } from "./lib/volume";
import { fmtPct, fmtToken, shortId, signUnit, signUsd } from "./lib/format";
import { displayValue, netAfterGas, type NumeraireKind } from "./lib/numeraire";
import { provisionalTotals } from "./lib/provisional";
import SwapVolume from "./components/SwapVolume";
import type { PoolRef } from "./lib/volume";

type Unit = "eth" | "usd";
import { bucketByDay, dayKeyLocal, monthGrid, monthRange } from "./lib/calendar";

export default function App() {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [data, setData] = useState<Portfolio | null>(null);
  const [poolRefs, setPoolRefs] = useState<PoolRef[] | null>(null);
  // Display unit is decoupled from the ETH/USD rate: the rate is always available
  // so mixed WETH+USDG wallets aggregate coherently in either unit. The rate is
  // pulled live from the on-chain WETH/USDG pool, and is user-overridable.
  const [unit, setUnit] = useState<Unit>("eth");
  const [ethUsd, setEthUsd] = useState<number>(3000);
  const [rateLive, setRateLive] = useState(false);

  const loadRate = () =>
    fetchEthUsd()
      .then((v) => { if (v && v > 0) { setEthUsd(Math.round(v)); setRateLive(true); } })
      .catch(() => {});
  useEffect(() => { loadRate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setRateManual = (v: number) => { setEthUsd(v); setRateLive(false); };

  async function run(raw: string) {
    const q = raw.trim();
    if (!q) return;
    setStatus("loading");
    setError("");
    setData(null);
    setPoolRefs(null);
    setProgress(null);
    try {
      const res = await analyze(q, (d, t) => setProgress([d, t]));
      setData(res);
      setStatus("done");
      // Resolve the pools behind these positions after the results are on screen —
      // the volume chart is supplementary and must never delay the PnL render.
      poolRefsFor(res.positions).then(setPoolRefs).catch(() => setPoolRefs([]));
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
        <Header unit={unit} setUnit={setUnit} ethUsd={ethUsd} setEthUsd={setRateManual} rateLive={rateLive} onRefreshRate={loadRate} />

        <div className="mt-8">
          <SwapVolume pools={poolRefs} />
        </div>

        <form onSubmit={onSubmit} className="mt-8">
          <label htmlFor="q" className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted">
            Transaction hash
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
          {/*
            Settled chain history is cached in the browser, so a repeat scan only asks for
            the blocks that did not exist last time. This is the way out of that: if a
            result ever looks wrong, throw the cache away and read everything again. Only
            offered once there is a result to be suspicious of.
          */}
          {status !== "idle" && (
            <button
              type="button"
              disabled={status === "loading" || !input.trim()}
              onClick={async () => { await resetCaches(); clearVolumeMemo(); run(input); }}
              className="mt-3 text-xs text-muted underline-offset-4 hover:text-fg hover:underline disabled:cursor-not-allowed disabled:opacity-40"
            >
              Rescan from chain (ignore cached history)
            </button>
          )}
        </form>

        <div className="mt-8">
          {status === "loading" && <LoadingState progress={progress} />}
          {status === "error" && <ErrorState message={error} onRetry={() => run(input)} />}
          {status === "done" && data && (data.positions.length ? <Results data={data} unit={unit} ethUsd={ethUsd} /> : <EmptyState query={data.query} />)}
          {status === "idle" && <IdleState />}
        </div>
      </div>
    </div>
  );
}

function Header({ unit, setUnit, ethUsd, setEthUsd, rateLive, onRefreshRate }: { unit: Unit; setUnit: (u: Unit) => void; ethUsd: number; setEthUsd: (v: number) => void; rateLive: boolean; onRefreshRate: () => void }) {
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
          Uniswap v3 &amp; v4 liquidity PnL on <span className="text-fg">Robinhood Chain</span> — fees, impermanent loss, and net return per position.
        </p>
      </div>

      <fieldset className="shrink-0 rounded-xl border border-border bg-surface p-1 text-xs" aria-label="Value display unit">
        <div className="flex items-center gap-1">
          <UnitToggle active={unit === "eth"} onClick={() => setUnit("eth")}>Ξ WETH</UnitToggle>
          <UnitToggle active={unit === "usd"} onClick={() => setUnit("usd")}>USD</UnitToggle>
          {/* The rate is always needed to convert between Ξ and $ (mixed wallets),
              so the field stays visible in both views. Pulled live from the on-chain
              WETH/USDG pool; editable to override. */}
          <label className="ml-1 flex items-center gap-1 pl-1 text-muted">
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
          <button
            type="button"
            onClick={onRefreshRate}
            title={rateLive ? "Live from the on-chain WETH/USDG pool — click to refresh" : "Manual override — click to pull the live on-chain price"}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-muted transition-colors hover:text-fg"
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${rateLive ? "bg-pos" : "bg-muted"}`} aria-hidden />
            {rateLive ? "live" : "manual"}
          </button>
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
function Results({ data, unit, ethUsd }: { data: Portfolio; unit: Unit; ethUsd: number }) {
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

      <SummaryBar positions={data.positions} unit={unit} ethUsd={ethUsd} />

      {data.kind === "wallet" && <PnlCalendar positions={data.positions} unit={unit} ethUsd={ethUsd} />}

      {data.skipped.length > 0 && (
        <p className="rounded-xl border border-neg/30 bg-neg/5 px-3 py-2 text-xs text-muted" role="status">
          {data.skipped.length} position{data.skipped.length === 1 ? "" : "s"} {data.skipped.length === 1 ? "was" : "were"} excluded from totals — either unreadable after retries (burned NFT or RPC error), or held by this wallet without it ever adding or removing liquidity: <span className="font-mono text-fg/70">#{data.skipped.join(", #")}</span>
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {data.positions.map((p) => <PositionCard key={String(p.tokenId)} p={p} unit={unit} ethUsd={ethUsd} />)}
      </div>
    </section>
  );
}

// A value in some numeraire (a position's own, or "eth" for native gas) converted
// to the chosen display unit via the shared ETH/USD rate — so WETH and USDG
// figures are expressed in the SAME unit and can be summed. See displayValue.
function money(v: number, kind: NumeraireKind, unit: Unit, ethUsd: number) {
  return displayValue(v, kind, ethUsd, unit);
}
/** Format an already-converted display value with the unit's glyph. */
function fmtMoney(displayVal: number, unit: Unit) {
  return unit === "eth" ? signUnit(displayVal, "WETH") : signUsd(displayVal);
}
/** A position's net after subtracting its native ETH gas, in the display unit. */
function posNet(p: PositionPnL, unit: Unit, ethUsd: number) {
  return netAfterGas(p.result.netPnlUsd, p.numeraireKind, p.gasEth, ethUsd, unit);
}
/** Net %, recomputed post-gas in USD so it matches the displayed net. */
function posPnlPct(p: PositionPnL, ethUsd: number) {
  const depUsd = displayValue(p.result.depositedUsd, p.numeraireKind, ethUsd, "usd");
  return depUsd > 0 ? netAfterGas(p.result.netPnlUsd, p.numeraireKind, p.gasEth, ethUsd, "usd") / depUsd : 0;
}

// ─── Realized-PnL calendar (closed positions, bucketed by close date) ───
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

function PnlCalendar({ positions, unit, ethUsd }: { positions: PositionPnL[]; unit: Unit; ethUsd: number }) {
  const openCount = positions.filter((p) => p.open).length;
  const items = useMemo(() => {
    const closed = positions.filter((p) => !p.open);
    return closed.map((p) => ({
      closedAt: p.result.closedAt,
      net: posNet(p, unit, ethUsd),
      fees: money(p.result.feesUsd, p.numeraireKind, unit, ethUsd),
      price: money(p.result.pricePnlUsd, p.numeraireKind, unit, ethUsd),
      il: money(p.result.ilUsd, p.numeraireKind, unit, ethUsd),
      gas: money(p.gasEth, "eth", unit, ethUsd),
      tokenId: p.tokenId,
    }));
  }, [positions, unit, ethUsd]);
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
  // The calendar is the second headline, and it sums the SAME degraded positions the
  // summary bar does. Marking one and not the other is how the Price / HODL leg came to
  // be missing from both: a fix applied to the bar alone leaves the calendar quietly
  // making the identical over-confident claim.
  const monthProvisional = provisionalTotals(
    positions.filter((p) => !p.open && dayKeyLocal(p.result.closedAt).startsWith(monthPrefix)),
  ).any;

  const todayKey = dayKeyLocal(Math.floor(Date.now() / 1000));
  const selDay = selected ? buckets.get(selected) : undefined;
  const selPositions = selected ? positions.filter((p) => !p.open && dayKeyLocal(p.result.closedAt) === selected) : [];

  const fmtAgg = (v: number) => fmtMoney(v, unit);

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
          <div
            className={`font-mono tnum text-sm font-semibold ${monthNet >= 0 ? "text-pos" : "text-neg"}`}
            title={monthProvisional ? "Includes positions that could not be measured exactly — see the note under the summary" : undefined}
          >
            {monthProvisional ? "~" : ""}{fmtAgg(monthNet)}
          </div>
        </div>
      </div>
      {openCount > 0 && (
        <p className="mt-2 text-[11px] text-muted">
          Realized closes only — {openCount} open position{openCount === 1 ? "" : "s"} {openCount === 1 ? "is" : "are"} counted in the summary above but {openCount === 1 ? "has" : "have"} no close date to sit on.
        </p>
      )}

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
          // Every term, because net = fees + price + il − gas and a tooltip that names
          // only two of them shows a number its own parts cannot add up to.
          const title = b
            ? `${cell.key}: net ${fmtAgg(b.net)} = fees ${fmtAgg(b.fees)} + price/HODL ${fmtAgg(b.price)} + IL ${fmtAgg(b.il)} − gas ${fmtAgg(b.gas)} · ${b.count} closed`
            : undefined;
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
                <span className={`mt-auto truncate font-mono tnum text-[10px] font-semibold ${tone}`}>{fmtAgg(b.net)}</span>
              )}
            </button>
          );
        })}
      </div>

      {selected && selDay && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-fg">{selected} · {selDay.count} closed</span>
            <span className={`font-mono tnum font-semibold ${selDay.net >= 0 ? "text-pos" : "text-neg"}`}>{fmtAgg(selDay.net)}</span>
          </div>
          <ul className="space-y-1">
            {selPositions.map((p) => (
              <li key={String(p.tokenId)} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-muted">
                  <span className="font-mono text-fg/70">#{String(p.tokenId)}</span> · {p.sym0}/{p.sym1} {(p.fee / 1e4).toFixed(2)}%
                </span>
                <span className={`shrink-0 font-mono tnum ${posNet(p, unit, ethUsd) >= 0 ? "text-pos" : "text-neg"}`}>{fmtMoney(posNet(p, unit, ethUsd), unit)}</span>
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

function SummaryBar({ positions, unit, ethUsd }: { positions: PositionPnL[]; unit: Unit; ethUsd: number }) {
  // Every position is converted to the chosen unit via the shared ETH/USD rate, so
  // WETH- and USDG-quoted positions sum coherently in either Ξ or $. Net is after
  // gas; gas is native ETH (kind "eth") so it prices through the rate for USD pairs.
  // Price / HODL belongs here for the same reason it is on the card: net is
  // fees + price + il - gas, and dropping a term leaves a headline the other cells
  // cannot account for. Measured on one live wallet, the missing leg was $534.91
  // against a $754.23 net -- most of what the bar was reporting.
  const acc = { net: 0, fees: 0, price: 0, il: 0, gas: 0 };
  for (const p of positions) {
    acc.net += posNet(p, unit, ethUsd);
    acc.fees += money(p.result.feesUsd, p.numeraireKind, unit, ethUsd);
    acc.price += money(p.result.pricePnlUsd, p.numeraireKind, unit, ethUsd);
    acc.il += money(p.result.ilUsd, p.numeraireKind, unit, ethUsd);
    acc.gas += money(p.gasEth, "eth", unit, ethUsd);
  }
  const fmt = (v: number) => fmtMoney(v, unit);
  // The cards already badge a degraded position; the bar used to sum it in silently and
  // present the result as fact. A fee figure that is a floor and a price that came from a
  // fallback both move between scans, so the headline has to say which of its parts are
  // not measurements — see lib/provisional.ts.
  const prov = provisionalTotals(positions);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Net PnL" value={fmt(acc.net)} tone={acc.net >= 0 ? "pos" : "neg"} big provisional={prov.any} />
        <Stat label="Fees earned" value={fmt(acc.fees)} tone="pos" provisional={prov.fees.length > 0} />
        <Stat label="Price / HODL" value={fmt(acc.price)} tone={acc.price >= 0 ? "pos" : "neg"} provisional={prov.price.length > 0} />
        <Stat label="Impermanent loss" value={fmt(acc.il)} tone={acc.il < 0 ? "neg" : "muted"} provisional={prov.price.length > 0} />
        <Stat label="Gas spent" value={fmt(-acc.gas)} tone={acc.gas > 0 ? "neg" : "muted"} />
      </div>
      {prov.any && (
        <p className="rounded-xl border border-border bg-surface px-3 py-2 text-xs text-muted" role="status">
          <span className="font-semibold text-fg/80">Provisional.</span>{" "}
          {prov.fees.length > 0 && (
            <>
              Fees for {prov.fees.length} position{prov.fees.length === 1 ? "" : "s"} could not be measured in full and are counted as a floor
              (<span className="font-mono text-fg/70">#{prov.fees.join(", #")}</span>).{" "}
            </>
          )}
          {prov.price.length > 0 && (
            <>
              {prov.price.length} position{prov.price.length === 1 ? "" : "s"} {prov.price.length === 1 ? "is" : "are"} priced from a fallback rather than a verified tick
              (<span className="font-mono text-fg/70">#{prov.price.join(", #")}</span>).{" "}
            </>
          )}
          These totals can change on a re-scan. “Rescan from chain” re-reads what failed.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, tone, big, provisional }: { label: string; value: string; tone: "pos" | "neg" | "muted"; big?: boolean; provisional?: boolean }) {
  const color = tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-fg";
  return (
    <div className="bg-surface p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</div>
      {/* One marker, on the figure itself — it reads as part of the number ("~0.21 Ξ"),
          which is what a provisional total is. Marking the LABEL as well said the same
          thing twice. Only the affected cells carry it, so a reader can see which figure
          the note below is about instead of applying the warning to all five. */}
      <div
        className={`mt-1.5 font-mono tnum ${big ? "text-xl sm:text-2xl" : "text-base sm:text-lg"} font-semibold ${color}`}
        title={provisional ? "Includes positions that could not be measured exactly — see the note below" : undefined}
      >
        {provisional ? "~" : ""}{value}
      </div>
    </div>
  );
}

function PositionCard({ p, unit, ethUsd }: { p: PositionPnL; unit: Unit; ethUsd: number }) {
  const r = p.result;
  const net = posNet(p, unit, ethUsd);
  const pct = posPnlPct(p, ethUsd);
  const approx = p.priceBasis === "lower-boundary" || p.priceBasis === "upper-boundary" || p.priceBasis === "live-fallback";
  // Each part carries its own numeraire kind so native gas (always ETH) is priced
  // through the rate; `dv` is the value already converted to the display unit.
  const parts = [
    { label: "Fees", v: r.feesUsd, kind: p.numeraireKind, tone: "pos" as const },
    { label: "Price / HODL", v: r.pricePnlUsd, kind: p.numeraireKind, tone: r.pricePnlUsd >= 0 ? ("pos" as const) : ("neg" as const) },
    { label: "Impermanent loss", v: r.ilUsd, kind: p.numeraireKind, tone: "neg" as const },
    { label: "Gas", v: -p.gasEth, kind: "eth" as NumeraireKind, tone: "neg" as const },
  ].map((x) => ({ ...x, dv: money(x.v, x.kind, unit, ethUsd) }));
  const maxAbs = Math.max(...parts.map((x) => Math.abs(x.dv)), 1e-12);

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
              {p.open ? "OPEN · MTM" : p.soldAt != null ? "transferred out" : "closed"}
            </span>
            {p.soldAt != null && (
              <span
                className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted"
                title={`This wallet transferred the position NFT to another address at block ${p.soldAt}. Figures cover only the span it held the position, and count only what it actually received — any liquidity still in the position at the hand-off is not credited, and whatever the NFT itself sold for is not on-chain here. Later activity by the new owner is excluded.`}
              >
                realized only
              </span>
            )}
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
            {!p.tickComplete && (
              <span
                className="rounded-md bg-neg/15 px-1.5 py-0.5 text-[10px] font-medium text-neg"
                title="The pool price at one of this position's events could not be read from chain state, so a fallback stood in: the pool's last real trade, or this range's own boundary, when a swap had drained the pool to its numerical price limit — which is not a price — (approximate); or the pool's launch price when nothing identified the price at all (possibly badly wrong). Treat this position's PnL as unreliable."
              >
                ! price unverified
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
          <div className={`font-mono tnum text-lg font-semibold ${net >= 0 ? "text-pos" : "text-neg"}`}>{fmtMoney(net, unit)}</div>
          <div className={`text-xs font-medium ${pct >= 0 ? "text-pos" : "text-neg"}`}>{fmtPct(pct)}</div>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {parts.map((x) => (
          <div key={x.label} className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-xs text-muted">{x.label}</span>
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <span
                className={`absolute inset-y-0 ${x.dv >= 0 ? "left-1/2 bg-pos" : "right-1/2 bg-neg"}`}
                style={{ width: `${(Math.abs(x.dv) / maxAbs) * 50}%` }}
              />
              <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
            </div>
            <span className={`w-24 shrink-0 text-right font-mono tnum text-xs ${x.dv >= 0 ? "text-pos" : "text-neg"}`}>{fmtMoney(x.dv, unit)}</span>
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
      <p className="text-sm text-muted">Paste a transaction hash into the search bar to analyze that position.</p>
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
        <span className="font-mono">{shortId(query, 8, 6)}</span> hasn’t held a Uniswap v3 or v4 position on Robinhood Chain.
      </p>
    </div>
  );
}
