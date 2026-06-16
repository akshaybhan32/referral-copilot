import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Skeleton,
} from '@databricks/appkit-ui/react';
import { useState } from 'react';
import { Phone, ExternalLink, MapPin, BedDouble, Stethoscope, Plus, Check, Sparkles } from 'lucide-react';

interface Result {
  facility_id: string;
  name: string;
  facility_type: string | null;
  operator_type: string | null;
  distance_km: number;
  score: number;
  match_reason: string;
  beds: number | null;
  num_doctors: number | null;
  official_phone: string | null;
  official_website: string | null;
  city: string | null;
  state: string | null;
}

const siteUrl = (s: string) => (s.startsWith('http') ? s : `https://${s}`);

const EXAMPLES = [
  'dialysis near Patna',
  'open heart surgery near New Delhi',
  'newborn intensive care near Mumbai',
  'cataract surgery near Jaipur',
];

export function ReferralSearchPage() {
  const [query, setQuery] = useState('dialysis near Patna');
  const [radius, setRadius] = useState(50);
  const [results, setResults] = useState<Result[] | null>(null);
  const [parsed, setParsed] = useState<{ need: string; place: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, boolean>>({});

  const search = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ q: q.trim(), radius: String(radius) });
      const res = await fetch(`/api/referral/ask?${qs}`);
      const data = (await res.json()) as {
        need?: string;
        place?: string;
        results?: Result[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `Search failed: ${res.statusText}`);
      setParsed({ need: data.need ?? '', place: data.place ?? '' });
      setResults(data.results ?? []);
    } catch (err) {
      setResults(null);
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const runSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void search(query);
  };

  const addToShortlist = async (r: Result, rank: number) => {
    try {
      // lazy-create one shortlist per browser session
      let id = sessionStorage.getItem('shortlist_id');
      if (!id) {
        const created = (await fetch('/api/referral/shortlists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'My referrals' }),
        }).then((x) => x.json())) as { shortlist_id: string };
        id = created.shortlist_id;
        sessionStorage.setItem('shortlist_id', id);
      }
      await fetch(`/api/referral/shortlists/${id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facility_id: r.facility_id,
          rank,
          distance_km: r.distance_km,
          score: r.score,
          match_reason: r.match_reason,
        }),
      });
      setAdded((p) => ({ ...p, [r.facility_id]: true }));
    } catch {
      /* best-effort */
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold text-foreground">Where should this patient go?</h2>
        <p className="text-muted-foreground text-sm">
          Enter a care need and a location — get an evidence-attached shortlist of candidate facilities.
        </p>
      </div>

      <Card className="shadow-sm">
        <CardContent className="pt-6 space-y-3">
          <form onSubmit={runSearch} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 items-end">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Ask in plain language</label>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="dialysis near Patna"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Radius</label>
              <select
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value))}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {[25, 50, 100, 200].map((r) => (
                  <option key={r} value={r}>{r} km</option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={loading}>{loading ? 'Searching…' : 'Find facilities'}</Button>
          </form>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => { setQuery(ex); void search(ex); }}
                className="text-xs rounded-full border border-input px-2.5 py-1 text-muted-foreground hover:bg-muted"
              >
                {ex}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {parsed && !error && (
        <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          semantic match for <span className="font-medium text-foreground">“{parsed.need}”</span> near{' '}
          <span className="font-medium text-foreground">{parsed.place}</span>
        </p>
      )}

      {error && <div className="text-destructive bg-destructive/10 p-3 rounded-md">{error}</div>}

      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={`sk-${i}`} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      )}

      {!loading && results && results.length === 0 && (
        <p className="text-muted-foreground text-center py-10">
          No facilities matched {parsed ? `“${parsed.need}” near ${parsed.place}` : 'your search'} within {radius} km.
          Try a wider radius or a different need.
        </p>
      )}

      {!loading && results && results.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{results.length} candidate facilities, ranked</p>
          {results.map((r, i) => (
            <Card key={r.facility_id} className="shadow-sm">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <CardTitle className="text-base leading-tight">
                    <span className="text-muted-foreground mr-2">#{i + 1}</span>
                    {r.name}
                  </CardTitle>
                  <Button
                    variant={added[r.facility_id] ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => void addToShortlist(r, i + 1)}
                    disabled={added[r.facility_id]}
                  >
                    {added[r.facility_id] ? <><Check className="h-3.5 w-3.5 mr-1" />Added</> : <><Plus className="h-3.5 w-3.5 mr-1" />Shortlist</>}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 text-xs pt-1">
                  {r.facility_type && <Badge>{r.facility_type}</Badge>}
                  {r.operator_type && <Badge tone={r.operator_type === 'public' || r.operator_type === 'government' ? 'success' : 'muted'}>{r.operator_type}</Badge>}
                  <span className="inline-flex items-center gap-1 text-muted-foreground"><MapPin className="h-3 w-3" />{r.distance_km} km · {r.city}, {r.state}</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                <p className="text-sm">
                  <span className="font-medium text-foreground">Why: </span>
                  <span className="text-muted-foreground">{r.match_reason}</span>
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {r.beds != null && <span className="inline-flex items-center gap-1"><BedDouble className="h-3 w-3" />{r.beds} beds</span>}
                  {r.num_doctors != null && <span className="inline-flex items-center gap-1"><Stethoscope className="h-3 w-3" />{r.num_doctors} doctors</span>}
                  <span>match score {r.score}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {r.official_phone && (
                    <a href={`tel:${r.official_phone}`} className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4">
                      <Phone className="h-3.5 w-3.5" />{r.official_phone}
                    </a>
                  )}
                  {r.official_website && (
                    <a href={siteUrl(r.official_website)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4">
                      <ExternalLink className="h-3.5 w-3.5" />website
                    </a>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Badge({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'success' | 'muted' }) {
  const cls =
    tone === 'success'
      ? 'bg-success/15 text-success'
      : tone === 'muted'
        ? 'bg-muted text-muted-foreground'
        : 'bg-primary/10 text-primary';
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${cls}`}>{children}</span>;
}
