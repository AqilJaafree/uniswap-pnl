/**
 * Weekly swap-volume chart.
 *
 * Two scopes over the same weekly x-axis:
 *   • "Your pools"   — GeckoTerminal per-pool daily volume, summed over the pools the
 *                      analyzed wallet/position actually sits in. One series.
 *   • "All Uniswap"  — DefiLlama chain-wide Uniswap V3 + V4, stacked. Two series.
 *
 * Volume is USD notional as reported by the provider, not a figure our PnL engine
 * derives — see the note in lib/volume.ts. The footer says so rather than letting
 * the number imply it reconciles with the position table below.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fetchChainWeekly, fetchPoolsWeekly, weekLabel, niceCeil,
  type ChainWeek, type PoolRef, type PoolVolume,
} from "../lib/volume";
import { fmtUsdCompact } from "../lib/format";

/** Validated against the app surface #121822 (dark): CVD ΔE 26.8, normal 31.8, both ≥3:1. */
const SERIES = {
  v3: "#3987e5", // categorical slot 1 — blue
  v4: "#d95926", // categorical slot 2 — orange
} as const;

const MAX_WEEKS = 14; // keep the axis readable; older weeks stay in the table view
const PLOT_H = 150; // px, plot area only — the x-axis band is laid out below it

type Scope = "pools" | "chain";
type View = "chart" | "table";

interface Row {
  week: string;
  total: number;
  parts: { key: string; label: string; value: number; color: string }[];
}

export default function WeeklyVolume({ pools }: { pools: PoolRef[] | null }) {
  // `null` = follow the data (pools once a portfolio is loaded, chain-wide before);
  // an explicit click pins the scope so it survives the next analysis.
  const [pinned, setPinned] = useState<Scope | null>(null);
  const [view, setView] = useState<View>("chart");
  const scope: Scope = pinned ?? (pools?.length ? "pools" : "chain");

  const [chain, setChain] = useState<ChainWeek[] | null>(null);
  const [chainStart, setChainStart] = useState<string | null>(null);
  const [poolVol, setPoolVol] = useState<PoolVolume | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setBusy(true);
    fetchChainWeekly()
      .then((r) => { if (live) { setChain(r.weeks); setChainStart(r.coverageStart); } })
      .catch((e) => { if (live) setError((e as Error).message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, []);

  // Pool volume is fetched per analyzed portfolio, and only once the reader is
  // actually looking at that scope — the provider's free tier is ~30 calls/minute.
  const key = pools?.map((p) => p.id).sort().join(",") ?? "";
  useEffect(() => {
    if (scope !== "pools" || !pools?.length) return;
    let live = true;
    setBusy(true);
    setError("");
    fetchPoolsWeekly(pools)
      .then((r) => { if (live) setPoolVol(r); })
      .catch((e) => { if (live) setError((e as Error).message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [key, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows: Row[] = useMemo(() => {
    if (scope === "chain") {
      return (chain ?? []).map((w) => ({
        week: w.week,
        total: w.v3 + w.v4,
        parts: [
          { key: "v3", label: "Uniswap v3", value: w.v3, color: SERIES.v3 },
          { key: "v4", label: "Uniswap v4", value: w.v4, color: SERIES.v4 },
        ],
      }));
    }
    const byId = new Map((poolVol?.covered ?? []).map((p) => [p.id, p.label]));
    return (poolVol?.weeks ?? []).map((w) => ({
      week: w.week,
      total: w.total,
      // One series: every pool wears slot 1, and the per-pool split lives in the
      // tooltip. Colouring 8 pools would spend the identity channel on something
      // the reader can't hold in their head anyway.
      parts: Object.entries(w.byPool)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([id, value]) => ({ key: id, label: byId.get(id) ?? id, value, color: SERIES.v3 })),
    }));
  }, [scope, chain, poolVol]);

  // Drop leading/trailing empty weeks: a provider's coverage starts mid-week, so the
  // span always opens with a zero column that costs axis width and says nothing.
  // Interior zeros stay — those are real quiet weeks, and the axis must stay a
  // continuous time axis.
  const trimmed = useMemo(() => {
    let lo = 0, hi = rows.length - 1;
    while (lo <= hi && rows[lo].total <= 0) lo++;
    while (hi >= lo && rows[hi].total <= 0) hi--;
    return rows.slice(lo, hi + 1);
  }, [rows]);
  const shown = trimmed.slice(-MAX_WEEKS);
  const hasData = shown.some((r) => r.total > 0);
  const stacked = scope === "chain";

  const coverage = scope === "chain" ? chainStart : poolVol?.coverageStart ?? null;
  const missing = scope === "pools" ? poolVol?.missing ?? [] : [];

  return (
    <section className="rounded-2xl border border-border bg-surface p-5" aria-labelledby="vol-h">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="vol-h" className="text-sm font-semibold">
            Weekly swap volume
            {scope === "pools" && <span className="ml-1.5 font-normal text-muted">· your pools</span>}
            {scope === "chain" && <span className="ml-1.5 font-normal text-muted">· all Uniswap</span>}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {scope === "pools"
              ? `Traded volume in the ${poolVol?.covered.length ?? pools?.length ?? 0} pool${(poolVol?.covered.length ?? pools?.length ?? 0) === 1 ? "" : "s"} this ${pools && pools.length > 1 ? "wallet" : "position"} provides liquidity to.`
              : "Uniswap v3 and v4 traded volume across all of Robinhood Chain."}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <fieldset className="rounded-xl border border-border bg-surface p-1 text-xs" aria-label="Volume scope">
            <div className="flex items-center gap-1">
              <Toggle active={scope === "pools"} disabled={!pools?.length} onClick={() => setPinned("pools")}
                      title={pools?.length ? undefined : "Analyze a wallet or position first"}>
                Your pools
              </Toggle>
              <Toggle active={scope === "chain"} onClick={() => setPinned("chain")}>All Uniswap</Toggle>
            </div>
          </fieldset>
          <button
            type="button"
            onClick={() => setView(view === "chart" ? "table" : "chart")}
            aria-pressed={view === "table"}
            className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent/60 hover:text-fg"
          >
            {view === "chart" ? "Table" : "Chart"}
          </button>
        </div>
      </div>

      {/* Refetch holds the previous render rather than flashing a skeleton. */}
      <div className={busy && hasData ? "opacity-50 transition-opacity" : "transition-opacity"}>
        {error && !hasData ? (
          <Note>Couldn’t reach the volume provider — {error}.</Note>
        ) : !hasData ? (
          <Note>{busy ? "Loading volume…" : "No volume reported for this scope yet."}</Note>
        ) : view === "table" ? (
          <VolumeTable rows={shown} stacked={stacked} />
        ) : shown.length === 1 ? (
          // One week is a number, not a chart — a lone column has nothing to be
          // compared against and just draws an axis around a single value.
          <SingleWeek row={shown[0]} />
        ) : (
          <Plot rows={shown} stacked={stacked} />
        )}
      </div>

      {hasData && stacked && (
        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted">
          <LegendKey color={SERIES.v3}>Uniswap v3</LegendKey>
          <LegendKey color={SERIES.v4}>Uniswap v4</LegendKey>
        </div>
      )}

      <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted/80">
        USD notional priced by {scope === "chain" ? "DefiLlama" : "GeckoTerminal"} — an independent
        source, so it won’t tie out exactly against the PnL figures below.
        {coverage && <> Coverage starts {coverage}; earlier weeks aren’t reported and are not drawn as zero.</>}
        {missing.length > 0 && (
          <> {missing.length} pool{missing.length === 1 ? " is" : "s are"} not indexed by the provider and{" "}
            {missing.length === 1 ? "is" : "are"} excluded: <span className="text-fg/70">{missing.map((m) => m.label).join(", ")}</span>.</>
        )}
      </p>
    </section>
  );
}

/** Stat tile for the one-week case: the value, its period, and the split. */
function SingleWeek({ row }: { row: Row }) {
  return (
    <div className="mt-4 rounded-xl border border-border bg-surface-2 px-4 py-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{weekLabel(row.week)}</div>
      {/* Proportional figures, not tabular — nothing below this aligns to it. */}
      <div className="mt-1 text-2xl font-semibold text-fg">{fmtUsdCompact(row.total)}</div>
      <ul className="mt-3 space-y-1 border-t border-border pt-3">
        {row.parts.map((p) => (
          <li key={p.key} className="flex items-center justify-between gap-3 text-[11px]">
            <span className="flex min-w-0 items-center gap-1.5 text-muted">
              <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
              <span className="truncate">{p.label}</span>
            </span>
            <span className="shrink-0 font-mono tnum text-fg/90">{fmtUsdCompact(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Axis ticks are round by construction (see `niceCeil`), so they never want cents —
 * "$200.00" next to "$0" reads as a measurement rather than a scale.
 */
function fmtTick(v: number): string {
  if (v === 0) return "$0";
  if (v < 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 })}`;
  return fmtUsdCompact(v);
}

// ─── Plot ───
function Plot({ rows, stacked }: { rows: Row[]; stacked: boolean }) {
  const [sel, setSel] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const max = Math.max(...rows.map((r) => r.total), 0);
  const top = niceCeil(max);
  const peak = rows.reduce((a, r) => (r.total > a.total ? r : a), rows[0]);

  // Three recessive gridlines carry the values that aren't directly labelled.
  const ticks = [top, top / 2, 0];

  return (
    <div className="mt-4">
      <div className="flex gap-2">
        {/* y-axis ticks */}
        <div className="flex shrink-0 flex-col justify-between text-right" style={{ height: PLOT_H }}>
          {ticks.map((t) => (
            <span key={t} className="font-mono tnum text-[10px] leading-none text-muted/70">{fmtTick(t)}</span>
          ))}
        </div>

        <div ref={wrap} className="relative min-w-0 flex-1">
          {/* gridlines: solid hairlines, one step off the surface */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col justify-between" style={{ height: PLOT_H }}>
            {ticks.map((t) => <div key={t} className="h-px w-full bg-border" />)}
          </div>

          <div className="relative flex items-end gap-1" style={{ height: PLOT_H }}>
            {rows.map((r) => {
              const isSel = sel === r.week;
              const isPeak = r.week === peak?.week && r.total > 0;
              return (
                <button
                  key={r.week}
                  type="button"
                  onClick={() => setSel(isSel ? null : r.week)}
                  onPointerEnter={() => setSel(r.week)}
                  onFocus={() => setSel(r.week)}
                  aria-label={`Week of ${weekLabel(r.week)}: ${fmtUsdCompact(r.total)} total. ${r.parts.map((p) => `${p.label} ${fmtUsdCompact(p.value)}`).join(", ")}`}
                  // The hit target is the whole column, not the 24px bar inside it,
                  // and the band behind it is what visibly responds — the bar's own
                  // ink stays constant so hovering never looks like a value change.
                  className={`group relative flex h-full flex-1 cursor-pointer flex-col justify-end rounded-md transition-colors ${isSel ? "bg-surface-2" : ""}`}
                  style={{ minWidth: 0 }}
                >
                  {isPeak && (
                    // Direct-label the extreme only — a value on every column goes unread.
                    <span className="mb-1 block truncate text-center font-mono tnum text-[10px] font-semibold text-fg">
                      {fmtUsdCompact(r.total)}
                    </span>
                  )}
                  <span
                    className="mx-auto flex w-full max-w-[24px] flex-col justify-end"
                    style={{
                      height: `${(r.total / top) * 100}%`,
                      // A real but tiny week ($22.8M against a $5B axis) is a
                      // sub-pixel bar, which reads as "no data" rather than "almost
                      // none". Floor it so absent and near-zero stay distinguishable.
                      minHeight: r.total > 0 ? 2 : 0,
                    }}
                  >
                    {/* Rendered top-to-bottom, so the series list is reversed: slot 1
                        (v3) sits at the stack base, matching the legend read upward. */}
                    {(stacked ? [...r.parts].reverse() : [{ key: "all", label: "", value: r.total, color: SERIES.v3 }])
                      .filter((p) => p.value > 0)
                      .map((p, i, arr) => (
                        <span
                          key={p.key}
                          className="w-full"
                          style={{
                            height: `${(p.value / Math.max(r.total, 1e-9)) * 100}%`,
                            background: p.color,
                            // Focus+context: the hovered column keeps the exact
                            // validated hue and the others recede. Never the reverse
                            // — brightening the hovered mark would move it off the
                            // contrast/CVD steps the palette was checked at.
                            opacity: sel == null || isSel ? 1 : 0.45,
                            // 4px rounded data-end on top, square at the baseline.
                            borderTopLeftRadius: i === 0 ? 4 : 0,
                            borderTopRightRadius: i === 0 ? 4 : 0,
                            // 2px surface gap does the separating — never a border.
                            marginBottom: i < arr.length - 1 ? 2 : 0,
                          }}
                        />
                      ))}
                  </span>
                </button>
              );
            })}
          </div>

          {/* x-axis band, inside the flow so it can never be clipped by a fixed height */}
          <div className="mt-2 flex gap-1">
            {rows.map((r) => (
              <span key={r.week} className="min-w-0 flex-1 truncate text-center font-mono tnum text-[10px] text-muted/70">
                {r.week.slice(5).replace("-", "/")}
              </span>
            ))}
          </div>
        </div>
      </div>

      <Readout row={rows.find((r) => r.week === sel) ?? null} stacked={stacked} />
    </div>
  );
}

/**
 * The hovered/focused week's detail. Rendered in the card's flow rather than as a
 * floating tooltip so it can't be clipped by the card or land off-screen on touch,
 * and so keyboard focus shows exactly what hover shows.
 */
function Readout({ row, stacked }: { row: Row | null; stacked: boolean }) {
  if (!row) {
    return (
      <p className="mt-3 text-[11px] text-muted/60" aria-hidden>
        Hover or focus a column for the week’s breakdown.
      </p>
    );
  }
  const parts = stacked ? row.parts : row.parts.slice(0, 6);
  const rest = stacked ? 0 : row.parts.length - parts.length;
  return (
    <div className="mt-3 rounded-xl border border-border bg-surface-2 px-3 py-2" role="status" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-fg">{weekLabel(row.week)}</span>
        <span className="font-mono text-sm font-semibold text-fg">{fmtUsdCompact(row.total)}</span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center justify-between gap-3 text-[11px]">
            <span className="flex min-w-0 items-center gap-1.5 text-muted">
              <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
              <span className="truncate">{p.label}</span>
            </span>
            <span className="shrink-0 font-mono tnum text-fg/90">{fmtUsdCompact(p.value)}</span>
          </li>
        ))}
        {rest > 0 && <li className="text-[11px] text-muted/70">+{rest} more in the table view</li>}
      </ul>
    </div>
  );
}

function VolumeTable({ rows, stacked }: { rows: Row[]; stacked: boolean }) {
  const cols = stacked ? ["Uniswap v3", "Uniswap v4"] : [];
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">Weekly swap volume in US dollars</caption>
        <thead>
          <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted">
            <th scope="col" className="py-1.5 pr-3 font-medium">Week</th>
            {cols.map((c) => <th key={c} scope="col" className="py-1.5 pr-3 text-right font-medium">{c}</th>)}
            <th scope="col" className="py-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.week} className="border-b border-border/60 last:border-0">
              <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted">{weekLabel(r.week)}</th>
              {cols.map((c) => (
                <td key={c} className="py-1.5 pr-3 text-right font-mono tnum text-fg/80">
                  {fmtUsdCompact(r.parts.find((p) => p.label === c)?.value ?? 0)}
                </td>
              ))}
              <td className="py-1.5 text-right font-mono tnum font-semibold text-fg">{fmtUsdCompact(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── bits ───
function Toggle({ active, disabled, title, onClick, children }: { active: boolean; disabled?: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={`rounded-lg px-2.5 py-1.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${active ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

function LegendKey({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} aria-hidden />
      {children}
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-4 rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted">{children}</p>;
}
