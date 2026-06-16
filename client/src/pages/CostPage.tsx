import { Card, CardContent, CardHeader, CardTitle, Skeleton } from '@databricks/appkit-ui/react';
import { useEffect, useState } from 'react';
import { Cpu, Sparkles, Database, Server, IndianRupee } from 'lucide-react';

interface Line {
  endpoint?: string;
  detail?: string;
  calls?: number;
  tokens?: number;
  ratePerMTok?: number;
  ratePerHour?: number;
  costUsd: number;
}
interface Cost {
  since: string | null;
  measured: { embeddings: Line; llm: Line; totalUsd: number };
  searches: number;
  perSearchUsd: number;
  computeMonthlyEstimate: { lakebase: Line; app: Line; totalUsd: number };
  prices: Record<string, number>;
}

const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const num = (n?: number) => (n ?? 0).toLocaleString();

export function CostPage() {
  const [cost, setCost] = useState<Cost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [perDay, setPerDay] = useState(1000);

  useEffect(() => {
    fetch('/api/cost')
      .then((r) => r.json())
      .then((d: Cost & { error?: string }) => {
        if (d.error) setError(d.error);
        else setCost(d);
      })
      .catch(() => setError('Could not load cost data'));
  }, []);

  if (error) return <div className="max-w-3xl mx-auto text-destructive bg-destructive/10 p-3 rounded-md">{error}</div>;
  if (!cost) return <div className="max-w-3xl mx-auto space-y-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}</div>;

  const projVariable = cost.perSearchUsd * perDay * 30;
  const projMonthly = projVariable + cost.computeMonthlyEstimate.totalUsd;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold text-foreground">Cost dashboard</h2>
        <p className="text-muted-foreground text-sm">
          Token costs are <span className="font-medium text-foreground">measured</span> from real Model Serving usage. Compute is an editable estimate.
        </p>
      </div>

      {/* Headline */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat icon={<IndianRupee className="h-4 w-4" />} label="Spent so far (AI)" value={usd(cost.measured.totalUsd)} sub={cost.since ? `since ${new Date(cost.since).toLocaleDateString()}` : '—'} />
        <Stat icon={<Sparkles className="h-4 w-4" />} label="Searches" value={num(cost.searches)} sub="embedding calls" />
        <Stat icon={<Cpu className="h-4 w-4" />} label="Cost / search" value={usd(cost.perSearchUsd)} sub="AI tokens only" />
        <Stat icon={<Server className="h-4 w-4" />} label="Compute / mo" value={usd(cost.computeMonthlyEstimate.totalUsd)} sub="estimate" />
      </div>

      {/* Measured AI usage */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2"><CardTitle className="text-base">AI usage — measured</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row name="Embeddings" endpoint={cost.measured.embeddings.endpoint} detail={`${num(cost.measured.embeddings.calls)} calls · ${num(cost.measured.embeddings.tokens)} tok · $${cost.measured.embeddings.ratePerMTok}/M`} cost={cost.measured.embeddings.costUsd} icon={<Sparkles className="h-3.5 w-3.5" />} />
          <Row name="Chat LLM (translate/localize)" endpoint={cost.measured.llm.endpoint} detail={`${num(cost.measured.llm.calls)} calls · ${num(cost.measured.llm.tokens)} tok · $${cost.measured.llm.ratePerMTok}/M`} cost={cost.measured.llm.costUsd} icon={<Sparkles className="h-3.5 w-3.5" />} />
          <div className="flex justify-between border-t pt-2 font-medium"><span>Total AI</span><span>{usd(cost.measured.totalUsd)}</span></div>
        </CardContent>
      </Card>

      {/* Compute estimate */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2"><CardTitle className="text-base">Compute — estimated / month</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row name="Lakebase (Postgres + pgvector)" detail={`${cost.computeMonthlyEstimate.lakebase.detail} · $${cost.computeMonthlyEstimate.lakebase.ratePerHour}/hr`} cost={cost.computeMonthlyEstimate.lakebase.costUsd} icon={<Database className="h-3.5 w-3.5" />} />
          <Row name="Databricks App hosting" detail={`${cost.computeMonthlyEstimate.app.detail} · $${cost.computeMonthlyEstimate.app.ratePerHour}/hr`} cost={cost.computeMonthlyEstimate.app.costUsd} icon={<Server className="h-3.5 w-3.5" />} />
          <div className="flex justify-between border-t pt-2 font-medium"><span>Total compute / mo</span><span>{usd(cost.computeMonthlyEstimate.totalUsd)}</span></div>
          <p className="text-xs text-muted-foreground pt-1">Auto-suspend (idle → off) reduces Lakebase/App well below this “always-on” figure.</p>
        </CardContent>
      </Card>

      {/* Projection */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2"><CardTitle className="text-base">Projected monthly cost</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-center gap-3">
            <span className="text-muted-foreground whitespace-nowrap">{num(perDay)} searches/day</span>
            <input type="range" min={100} max={20000} step={100} value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} className="flex-1" />
          </label>
          <div className="flex justify-between"><span className="text-muted-foreground">AI tokens ({num(perDay * 30)} searches/mo)</span><span>{usd(projVariable)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Compute (est.)</span><span>{usd(cost.computeMonthlyEstimate.totalUsd)}</span></div>
          <div className="flex justify-between border-t pt-2 text-base font-bold"><span>≈ Total / month</span><span>{usd(projMonthly)}</span></div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Prices are list-price estimates (USD) and editable via env (PRICE_*). The authoritative billed figure lives in Databricks <code>system.billing.usage</code> (needs a SQL warehouse to query).
      </p>
    </div>
  );
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <Card className="shadow-sm">
      <CardContent className="py-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
        <div className="text-xl font-bold text-foreground mt-1">{value}</div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}

function Row({ name, endpoint, detail, cost, icon }: { name: string; endpoint?: string; detail: string; cost: number; icon: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="inline-flex items-center gap-1.5 font-medium text-foreground">{icon}{name}</div>
        {endpoint && <div className="text-xs text-muted-foreground font-mono">{endpoint}</div>}
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <span className="font-medium whitespace-nowrap">{usd(cost)}</span>
    </div>
  );
}
