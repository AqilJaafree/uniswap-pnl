/**
 * Swap-volume chart — daily or weekly, as lines.
 *
 * Two scopes over the same time axis:
 *   • "Your pools"   — GeckoTerminal per-pool volume, summed over the pools the
 *                      analyzed wallet/position sits in. One series (+ area wash).
 *   • "All Uniswap"  — DefiLlama chain-wide Uniswap V3 and V4, as two lines.
 *
 * v3 and v4 are drawn as separate lines rather than stacked: the question the two
 * series answer is "how do they compare", and a stack makes the upper series'
 * shape unreadable because its baseline moves. The combined total stays available
 * in the readout and the table.
 *
 * Volume is USD notional as reported by the provider, not a figure our PnL engine
 * derives — see the note in lib/volume.ts. The footer says so rather than letting
 * the number imply it reconciles with the position table below.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fetchChainVolume, fetchPoolsVolume, periodLabel, niceCeil, isWeekend, isPartialPeriod,
  type ChainPoint, type Granularity, type PoolRef, type PoolVolume,
} from "../lib/volume";
import { fmtUsdCompact } from "../lib/format";

/** Validated against the app surface #121822 (dark): CVD ΔE 26.8, normal 31.8, both ≥3:1. */
const SERIES = {
  v3: "#3987e5", // categorical slot 1 — blue
  v4: "#d95926", // categorical slot 2 — orange
} as const;

/** Keep the axis readable; older periods stay reachable in the table view. */
const MAX_POINTS: Record<Granularity, number> = { day: 60, week: 14 };
const PLOT_H = 150; // px, plot area only — the x-axis band is laid out below it
const PAD_R = 54; // room for the end-of-line direct labels
const MAX_XTICKS = 7;

type Scope = "pools" | "chain";
type View = "chart" | "table";

interface Row {
  period: string;
  total: number;
  parts: { key: string; label: string; value: number; color: string }[];
}

interface Line {
  key: string;
  label: string;
  color: string;
  values: number[];
}

export default function SwapVolume({ pools }: { pools: PoolRef[] | null }) {
  // `null` = follow the data (pools once a portfolio is loaded, chain-wide before);
  // an explicit click pins the scope so it survives the next analysis.
  const [pinned, setPinned] = useState<Scope | null>(null);
  const [gran, setGran] = useState<Granularity>("week");
  const [view, setView] = useState<View>("chart");
  const scope: Scope = pinned ?? (pools?.length ? "pools" : "chain");

  const [chain, setChain] = useState<ChainPoint[] | null>(null);
  const [chainStart, setChainStart] = useState<string | null>(null);
  const [poolVol, setPoolVol] = useState<PoolVolume | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Switching granularity re-reads the same cached provider payload and re-buckets
  // it — no extra network call, so it is safe to key the effect on `gran`.
  useEffect(() => {
    let live = true;
    setBusy(true);
    fetchChainVolume(gran)
      .then((r) => { if (live) { setChain(r.points); setChainStart(r.coverageStart); } })
      .catch((e) => { if (live) setError((e as Error).message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [gran]);

  const key = pools?.map((p) => p.id).sort().join(",") ?? "";
  useEffect(() => {
    if (scope !== "pools" || !pools?.length) return;
    let live = true;
    setBusy(true);
    setError("");
    fetchPoolsVolume(pools, gran)
      .then((r) => { if (live) setPoolVol(r); })
      .catch((e) => { if (live) setError((e as Error).message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [key, scope, gran]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows: Row[] = useMemo(() => {
    if (scope === "chain") {
      return (chain ?? []).map((p) => ({
        period: p.period,
        total: p.v3 + p.v4,
        parts: [
          { key: "v3", label: "Uniswap v3", value: p.v3, color: SERIES.v3 },
          { key: "v4", label: "Uniswap v4", value: p.v4, color: SERIES.v4 },
        ],
      }));
    }
    const byId = new Map((poolVol?.covered ?? []).map((p) => [p.id, p.label]));
    return (poolVol?.points ?? []).map((p) => ({
      period: p.period,
      total: p.total,
      // One line: every pool feeds the same total, and the per-pool split lives in
      // the readout. Eight lines would spend the identity channel on something the
      // reader can't hold in their head anyway.
      parts: Object.entries(p.byPool)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([id, value]) => ({ key: id, label: byId.get(id) ?? id, value, color: SERIES.v3 })),
    }));
  }, [scope, chain, poolVol]);

  // Drop leading/trailing empty periods: a provider's coverage starts mid-period, so
  // the span otherwise opens on a flat zero run that costs axis width and says
  // nothing. Interior zeros stay — those are real quiet days, and the axis must
  // remain a continuous time axis.
  const trimmed = useMemo(() => {
    let lo = 0, hi = rows.length - 1;
    while (lo <= hi && rows[lo].total <= 0) lo++;
    while (hi >= lo && rows[hi].total <= 0) hi--;
    return rows.slice(lo, hi + 1);
  }, [rows]);
  const shown = trimmed.slice(-MAX_POINTS[gran]);
  const hasData = shown.some((r) => r.total > 0);
  const multi = scope === "chain";

  const lines: Line[] = useMemo(() => {
    if (!multi) {
      return [{ key: "total", label: "Volume", color: SERIES.v3, values: shown.map((r) => r.total) }];
    }
    return [
      { key: "v3", label: "Uniswap v3", color: SERIES.v3, values: shown.map((r) => r.parts[0]?.value ?? 0) },
      { key: "v4", label: "Uniswap v4", color: SERIES.v4, values: shown.map((r) => r.parts[1]?.value ?? 0) },
    ];
  }, [shown, multi]);

  const coverage = scope === "chain" ? chainStart : poolVol?.coverageStart ?? null;
  const missing = scope === "pools" ? poolVol?.missing ?? [] : [];
  const failed = scope === "pools" ? poolVol?.failed ?? [] : [];
  const poolCount = poolVol?.covered.length ?? pools?.length ?? 0;
  const lastPartial = shown.length > 0 && isPartialPeriod(shown[shown.length - 1].period, gran);

  return (
    <section className="rounded-2xl border border-border bg-surface p-5" aria-labelledby="vol-h">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="vol-h" className="text-sm font-semibold">
            {gran === "day" ? "Daily" : "Weekly"} swap volume
            <span className="ml-1.5 font-normal text-muted">· {scope === "pools" ? "your pools" : "all Uniswap"}</span>
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {scope === "pools"
              ? `Traded volume in the ${poolCount} pool${poolCount === 1 ? "" : "s"} this ${pools && pools.length > 1 ? "wallet" : "position"} provides liquidity to.`
              : "Uniswap v3 and v4 traded volume across all of Robinhood Chain."}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <fieldset className="rounded-xl border border-border bg-surface p-1 text-xs" aria-label="Bucket size">
            <div className="flex items-center gap-1">
              <Toggle active={gran === "day"} onClick={() => setGran("day")}>Daily</Toggle>
              <Toggle active={gran === "week"} onClick={() => setGran("week")}>Weekly</Toggle>
            </div>
          </fieldset>
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
          <VolumeTable rows={shown} gran={gran} multi={multi} />
        ) : shown.length === 1 ? (
          // A single period is a number, not a chart — one point has nothing to be
          // compared against and just draws an axis around a lone value.
          <SinglePeriod row={shown[0]} gran={gran} />
        ) : (
          <Plot rows={shown} lines={lines} gran={gran} multi={multi} />
        )}
      </div>

      {hasData && shown.length > 1 && multi && (
        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted">
          <LegendKey color={SERIES.v3}>Uniswap v3</LegendKey>
          <LegendKey color={SERIES.v4}>Uniswap v4</LegendKey>
        </div>
      )}

      <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted/80">
        USD notional priced by {scope === "chain" ? "DefiLlama" : "GeckoTerminal"} — an independent
        source, so it won’t tie out exactly against the PnL figures below.
        {coverage && <> Coverage starts {coverage}; earlier {gran === "day" ? "days" : "weeks"} aren’t reported and are not drawn as zero.</>}
        {lastPartial && <> The final {gran === "day" ? "day" : "week"} is still in progress — its segment is dashed and its total will keep rising.</>}
        {missing.length > 0 && (
          <> {missing.length} pool{missing.length === 1 ? " is" : "s are"} not indexed by the provider and{" "}
            {missing.length === 1 ? "is" : "are"} excluded: <span className="text-fg/70">{missing.map((m) => m.label).join(", ")}</span>.</>
        )}
        {/* A rate-limited pool is NOT an unindexed one — saying so would be a
            false statement about the user's position. */}
        {failed.length > 0 && (
          <> {failed.length} pool{failed.length === 1 ? "" : "s"} couldn’t be read (rate limit or network) and{" "}
            {failed.length === 1 ? "is" : "are"} missing from these totals:{" "}
            <span className="text-fg/70">{failed.map((m) => m.label).join(", ")}</span>. Reload to retry.</>
        )}
      </p>
    </section>
  );
}

/** Measure the plot's own width so line geometry is in real pixels — an SVG scaled
 *  by preserveAspectRatio="none" would stretch strokes and turn markers into ovals. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Evenly spaced label positions, always including the first and last. */
function tickIndices(n: number, max = MAX_XTICKS): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => Math.round(i * step));
}

// ─── Plot ───
function Plot({ rows, lines, gran, multi }: { rows: Row[]; lines: Line[]; gran: Granularity; multi: boolean }) {
  const [wrapRef, W] = useWidth<HTMLDivElement>();
  const [sel, setSel] = useState<number | null>(null);

  const top = niceCeil(Math.max(...lines.flatMap((l) => l.values), 0));
  const innerW = Math.max(W - PAD_R, 1);
  const n = rows.length;
  const x = (i: number) => (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PLOT_H - (v / top) * PLOT_H;
  const ticks = [top, top / 2, 0];
  // Tick count follows the measured width: a "MM/DD" label needs ~56px of room, and
  // a fixed count collides into "07/1807/22" on a phone.
  const xTicks = tickIndices(n, Math.max(2, Math.min(MAX_XTICKS, Math.floor(innerW / 56))));

  const path = (vals: number[], from = 0, to = n - 1) =>
    vals.slice(from, to + 1).map((v, k) => `${k ? "L" : "M"}${x(from + k).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const area = (vals: number[]) => `${path(vals)} L${x(n - 1).toFixed(2)},${PLOT_H} L${x(0).toFixed(2)},${PLOT_H} Z`;

  // The final period is usually still accruing. Draw its segment dashed and hollow
  // its end dot so the closing slope isn't read as a finished trend.
  const partial = isPartialPeriod(rows[n - 1].period, gran);
  const solidTo = partial ? n - 2 : n - 1;

  return (
    <div className="mt-4">
      <div className="flex gap-2">
        <div className="flex shrink-0 flex-col justify-between text-right" style={{ height: PLOT_H }}>
          {ticks.map((t) => (
            <span key={t} className="font-mono tnum text-[10px] leading-none text-muted/70">{fmtTick(t)}</span>
          ))}
        </div>

        <div ref={wrapRef} className="relative min-w-0 flex-1">
          <svg width="100%" height={PLOT_H} className="block overflow-visible" role="presentation">
            {/* gridlines: solid hairlines, one step off the surface */}
            {ticks.map((t) => (
              <line key={t} x1={0} x2={innerW} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} shapeRendering="crispEdges" />
            ))}

            {/* Weekends are shaded in the day view — the weekly dip is the whole
                reason to look at daily data, and banding shows it without a series. */}
            {gran === "day" && W > 0 && rows.map((r, i) =>
              isWeekend(r.period) ? (
                <rect key={r.period} x={x(i) - innerW / (n - 1) / 2} y={0}
                      width={innerW / (n - 1)} height={PLOT_H} fill="var(--surface-2)" opacity={0.45} />
              ) : null,
            )}

            {W > 0 && (
              <>
                {/* Single series gets an area wash at ~10%; two lines would muddy each other. */}
                {!multi && <path d={area(lines[0].values)} fill={lines[0].color} opacity={0.1} />}

                {sel != null && (
                  <line x1={x(sel)} x2={x(sel)} y1={0} y2={PLOT_H} stroke="var(--border)" strokeWidth={1} shapeRendering="crispEdges" />
                )}

                {lines.map((l) => (
                  <g key={l.key}>
                    <path d={path(l.values, 0, solidTo)} fill="none" stroke={l.color}
                          strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                    {partial && n >= 2 && (
                      <path d={path(l.values, n - 2, n - 1)} fill="none" stroke={l.color}
                            strokeWidth={2} strokeLinecap="round" strokeDasharray="3 3" />
                    )}
                  </g>
                ))}

                {/* Markers: the selected point on every series, plus each line's end
                    dot. A dot on every point at 60 daily samples is noise. */}
                {lines.map((l) => (
                  <g key={`m-${l.key}`}>
                    <circle cx={x(n - 1)} cy={y(l.values[n - 1])} r={4}
                            fill={partial ? "var(--surface)" : l.color}
                            stroke={partial ? l.color : "var(--surface)"} strokeWidth={2} />
                    {sel != null && sel !== n - 1 && (
                      <circle cx={x(sel)} cy={y(l.values[sel])} r={4} fill={l.color}
                              stroke="var(--surface)" strokeWidth={2} />
                    )}
                  </g>
                ))}

                {/* Direct labels ride the line ends, where series separate. */}
                {lines.map((l) => (
                  <text key={`t-${l.key}`} x={x(n - 1) + 8} y={y(l.values[n - 1])}
                        dominantBaseline="middle" className="font-mono fill-fg text-[10px] font-semibold">
                    {fmtUsdCompact(l.values[n - 1])}
                  </text>
                ))}

                {/* The crosshair finds the X: one full-height band per point, so the
                    pointer only has to be nearest — never on the 2px line itself. */}
                {rows.map((r, i) => {
                  const half = n > 1 ? innerW / (n - 1) / 2 : innerW / 2;
                  return (
                    <rect
                      key={r.period}
                      x={Math.max(x(i) - half, 0)}
                      y={0}
                      width={Math.min(half * 2, innerW)}
                      height={PLOT_H}
                      fill="transparent"
                      tabIndex={0}
                      role="button"
                      aria-label={`${periodLabel(r.period, gran)}: ${fmtUsdCompact(r.total)} total. ${r.parts.map((p) => `${p.label} ${fmtUsdCompact(p.value)}`).join(", ")}`}
                      onPointerEnter={() => setSel(i)}
                      onFocus={() => setSel(i)}
                      onPointerLeave={() => setSel(null)}
                      className="cursor-crosshair outline-none"
                    />
                  );
                })}
              </>
            )}
          </svg>

          {/* x-axis band, inside the flow so it can never be clipped by a fixed height */}
          <div className="relative mt-2 h-3" style={{ width: innerW }}>
            {xTicks.map((i) => (
              <span
                key={rows[i].period}
                className="absolute -translate-x-1/2 whitespace-nowrap font-mono tnum text-[10px] text-muted/70"
                style={{ left: x(i) }}
              >
                {rows[i].period.slice(5).replace("-", "/")}
              </span>
            ))}
          </div>
        </div>
      </div>

      <Readout row={sel == null ? null : rows[sel]} gran={gran} multi={multi} />
    </div>
  );
}

/**
 * The hovered/focused period's detail. Rendered in the card's flow rather than as a
 * floating tooltip so it can't be clipped by the card or land off-screen on touch,
 * and so keyboard focus shows exactly what hover shows.
 */
function Readout({ row, gran, multi }: { row: Row | null; gran: Granularity; multi: boolean }) {
  if (!row) {
    return (
      <p className="mt-3 text-[11px] text-muted/60" aria-hidden>
        Hover or focus the chart for a {gran === "day" ? "day" : "week"}’s breakdown.
      </p>
    );
  }
  const parts = multi ? row.parts : row.parts.slice(0, 6);
  const rest = multi ? 0 : row.parts.length - parts.length;
  return (
    <div className="mt-3 rounded-xl border border-border bg-surface-2 px-3 py-2" role="status" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-fg">
          {periodLabel(row.period, gran)}
          {isPartialPeriod(row.period, gran) && <span className="ml-1.5 font-normal text-muted">· in progress</span>}
        </span>
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

/** Stat tile for the single-period case: the value, its span, and the split. */
function SinglePeriod({ row, gran }: { row: Row; gran: Granularity }) {
  return (
    <div className="mt-4 rounded-xl border border-border bg-surface-2 px-4 py-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{periodLabel(row.period, gran)}</div>
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

function VolumeTable({ rows, gran, multi }: { rows: Row[]; gran: Granularity; multi: boolean }) {
  const cols = multi ? ["Uniswap v3", "Uniswap v4"] : [];
  return (
    <div className="mt-4 max-h-80 overflow-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">{gran === "day" ? "Daily" : "Weekly"} swap volume in US dollars</caption>
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted">
            <th scope="col" className="py-1.5 pr-3 font-medium">{gran === "day" ? "Day" : "Week"}</th>
            {cols.map((c) => <th key={c} scope="col" className="py-1.5 pr-3 text-right font-medium">{c}</th>)}
            <th scope="col" className="py-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.period} className="border-b border-border/60 last:border-0">
              <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted">
                {periodLabel(r.period, gran)}
                {isPartialPeriod(r.period, gran) && <span className="ml-1.5 text-muted/60">· in progress</span>}
              </th>
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

/**
 * Axis ticks are round by construction (see `niceCeil`), so they never want cents —
 * "$200.00" next to "$0" reads as a measurement rather than a scale.
 */
function fmtTick(v: number): string {
  if (v === 0) return "$0";
  if (v < 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 })}`;
  return fmtUsdCompact(v);
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
      <span className="h-0.5 w-3 rounded-full" style={{ background: color }} aria-hidden />
      {children}
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-4 rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted">{children}</p>;
}
