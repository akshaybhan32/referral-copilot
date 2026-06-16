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
import {
  Phone, ExternalLink, MapPin, BedDouble, Stethoscope, Sparkles, Mic, Volume2,
} from 'lucide-react';
import { listenOnce, speak, sttSupported, ttsSupported } from '../lib/speech';

interface Result {
  facility_id: string;
  name: string;
  facility_type: string | null;
  operator_type: string | null;
  distance_km: number;
  score: number;
  match_reason: string;
  match_reason_en?: string;
  beds: number | null;
  num_doctors: number | null;
  official_phone: string | null;
  official_website: string | null;
  city: string | null;
  state: string | null;
}

interface Parsed {
  need: string;
  place: string;
  lang: string;
  interpretation: string;
  summary: string;
  speechLocale: string;
}

const siteUrl = (s: string) => (s.startsWith('http') ? s : `https://${s}`);

const EXAMPLES = [
  'dialysis near Patna',
  'पटना के पास डायलिसिस',
  'open heart surgery near New Delhi',
  'जयपुर में मोतियाबिंद का ऑपरेशन',
];

// Languages offered for the mic (BCP-47 for the Web Speech API).
const VOICE_LANGS: { code: string; label: string }[] = [
  { code: 'en-IN', label: 'English' },
  { code: 'hi-IN', label: 'हिंदी' },
  { code: 'bn-IN', label: 'বাংলা' },
  { code: 'ta-IN', label: 'தமிழ்' },
  { code: 'te-IN', label: 'తెలుగు' },
  { code: 'mr-IN', label: 'मराठी' },
];

export function ReferralSearchPage() {
  const [query, setQuery] = useState('dialysis near Patna');
  const [radius, setRadius] = useState(50);
  const [voiceLang, setVoiceLang] = useState('hi-IN');
  const [listening, setListening] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ q: q.trim(), radius: String(radius) });
      const res = await fetch(`/api/referral/ask?${qs}`);
      const data = (await res.json()) as Partial<Parsed> & { results?: Result[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Search failed: ${res.statusText}`);
      setParsed({
        need: data.need ?? '',
        place: data.place ?? '',
        lang: data.lang ?? 'en',
        interpretation: data.interpretation ?? '',
        summary: data.summary ?? '',
        speechLocale: data.speechLocale ?? 'en-IN',
      });
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

  const startListening = async () => {
    setError(null);
    setListening(true);
    try {
      const transcript = await listenOnce(voiceLang);
      setQuery(transcript);
      await search(transcript);
    } catch (err) {
      setError(err instanceof Error ? `Mic error: ${err.message}` : 'Mic error');
    } finally {
      setListening(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold text-foreground">Where should this patient go?</h2>
        <p className="text-muted-foreground text-sm">
          Ask in any language — type or speak. We find facilities and answer back in your language.
        </p>
      </div>

      <Card className="shadow-sm">
        <CardContent className="pt-6 space-y-3">
          <form onSubmit={runSearch} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 items-end">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Ask in plain language</label>
              <div className="relative">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="dialysis near Patna · पटना के पास डायलिसिस"
                  className="pr-10"
                />
                {sttSupported() && (
                  <button
                    type="button"
                    title="Speak"
                    onClick={() => void startListening()}
                    disabled={listening}
                    className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 ${
                      listening ? 'text-destructive animate-pulse' : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <Mic className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Voice</label>
              <select
                value={voiceLang}
                onChange={(e) => setVoiceLang(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {VOICE_LANGS.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={loading}>{loading ? 'Searching…' : 'Find facilities'}</Button>
          </form>
          <div className="flex flex-wrap items-center gap-1.5">
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
            <span className="text-xs text-muted-foreground ml-auto">Radius
              <select
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value))}
                className="ml-1 rounded-md border border-input bg-background px-2 py-0.5 text-xs"
              >
                {[25, 50, 100, 200].map((r) => (
                  <option key={r} value={r}>{r} km</option>
                ))}
              </select>
            </span>
          </div>
        </CardContent>
      </Card>

      {parsed && !error && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            understood as <span className="font-medium text-foreground">“{parsed.interpretation}”</span>
            {parsed.lang !== 'en' && <span className="rounded-full bg-primary/10 text-primary px-1.5 py-0.5">{parsed.lang}</span>}
          </p>
          {parsed.summary && (
            <p className="text-sm text-foreground inline-flex items-center gap-2">
              {parsed.summary}
              {ttsSupported() && (
                <button
                  type="button"
                  title="Read aloud"
                  onClick={() => speak(parsed.summary, parsed.speechLocale)}
                  className="text-muted-foreground hover:text-primary"
                >
                  <Volume2 className="h-4 w-4" />
                </button>
              )}
            </p>
          )}
        </div>
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
                <CardTitle className="text-base leading-tight">
                  <span className="text-muted-foreground mr-2">#{i + 1}</span>
                  {r.name}
                </CardTitle>
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
