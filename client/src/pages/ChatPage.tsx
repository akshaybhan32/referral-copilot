import { Card, CardContent, Button, Input } from '@databricks/appkit-ui/react';
import { useEffect, useRef, useState } from 'react';
import { Phone, ExternalLink, MapPin, Mic, Volume2, Send, RotateCcw, Sparkles, LocateFixed, Navigation, MessageCircle } from 'lucide-react';
import { listenOnce, speak, sttSupported, ttsSupported } from '../lib/speech';

// Read the device's GPS position (with the user's permission).
function getDeviceLocation(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation not supported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err.message)),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

interface Result {
  facility_id: string;
  name: string;
  distance_km: number;
  score: number;
  similarity: number;
  match_reason: string;
  official_phone: string | null;
  official_website: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
}

// Google Maps directions to the facility (Maps uses the user's live location as origin).
const directionsUrl = (r: Result) =>
  r.lat != null && r.lng != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.name}, ${r.city ?? ''}`)}`;

// Prefilled WhatsApp share — opens WhatsApp so the user picks who to send it to.
const whatsappUrl = (r: Result) => {
  const lines = [
    `*${r.name}*${r.city ? ` — ${r.city}` : ''}`,
    `${r.distance_km} km away`,
    r.official_phone ? `📞 ${r.official_phone}` : '',
    r.match_reason ? `Why: ${r.match_reason}` : '',
    `🗺️ Directions: ${directionsUrl(r)}`,
  ].filter(Boolean);
  return `https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`;
};
interface Origin {
  label: string;
  precision: 'gps' | 'pin' | 'city';
}
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  results?: Result[];
  origin?: Origin;
  lang?: string;
  speechLocale?: string;
  interpretation?: string;
  emergency?: boolean;
}

let msgCounter = 0;
const nextMsgId = () => `m${++msgCounter}`;

const siteUrl = (s: string) => (s.startsWith('http') ? s : `https://${s}`);

const VOICE_LANGS = [
  { code: 'en-IN', label: 'English' },
  { code: 'hi-IN', label: 'हिंदी' },
  { code: 'bn-IN', label: 'বাংলা' },
  { code: 'ta-IN', label: 'தமிழ்' },
  { code: 'te-IN', label: 'తెలుగు' },
  { code: 'mr-IN', label: 'मराठी' },
];

const GREETING: ChatMessage = {
  id: 'greeting',
  role: 'assistant',
  text: 'Namaste 🙏 Tell me a care need and a city — type or speak, in any language. e.g. "dialysis near Patna" or "पटना के पास डायलिसिस".',
};

export function ChatPage() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState('');
  const [voiceLang, setVoiceLang] = useState('hi-IN');
  const [listening, setListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [operator, setOperator] = useState<'' | 'public' | 'private'>('');
  const startedRef = useRef(false);
  const threadRef = useRef<HTMLDivElement>(null);

  const startConversation = async (): Promise<string | null> => {
    try {
      const res = await fetch('/api/conversation', { method: 'POST' });
      const data = (await res.json()) as { conversation_id?: string };
      const id = data.conversation_id ?? null;
      setConversationId(id);
      return id;
    } catch {
      return null;
    }
  };

  // Open one conversation when the page mounts.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startConversation();
  }, []);

  // Keep the thread scrolled to the latest message.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const send = async (text: string) => {
    const msg = text.trim();
    if (!msg || loading) return;
    let id = conversationId;
    id ??= await startConversation();
    if (!id) return;
    setInput('');
    setMessages((m) => [...m, { id: nextMsgId(), role: 'user', text: msg }]);
    setLoading(true);
    try {
      const res = await fetch(`/api/conversation/${id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: msg, limit: 5, ...(coords ?? {}), ...(operator ? { operator } : {}) }),
      });
      const data = (await res.json()) as {
        summary?: string; results?: Result[]; origin?: Origin; lang?: string; speechLocale?: string; interpretation?: string; emergency?: boolean; error?: string;
      };
      if (!res.ok) {
        // Keep the emergency banner even when the search itself failed.
        setMessages((m) => [...m, { id: nextMsgId(), role: 'assistant', text: data.error ?? 'Please try again.', emergency: data.emergency }]);
        return;
      }
      setMessages((m) => [
        ...m,
        {
          id: nextMsgId(),
          role: 'assistant',
          text: data.summary ?? '',
          results: data.results ?? [],
          origin: data.origin,
          lang: data.lang,
          speechLocale: data.speechLocale,
          interpretation: data.interpretation,
          emergency: data.emergency,
        },
      ]);
    } catch (err) {
      setMessages((m) => [...m, { id: nextMsgId(), role: 'assistant', text: err instanceof Error ? `Sorry — ${err.message}` : 'Sorry, something went wrong.' }]);
    } finally {
      setLoading(false);
    }
  };

  const shareLocation = async () => {
    setLocating(true);
    try {
      setCoords(await getDeviceLocation());
    } catch {
      /* permission denied / unavailable — silently keep city-level search */
    } finally {
      setLocating(false);
    }
  };

  const startListening = async () => {
    setListening(true);
    try {
      const transcript = await listenOnce(voiceLang);
      await send(transcript);
    } catch {
      /* mic unavailable / denied */
    } finally {
      setListening(false);
    }
  };

  // End this conversation (archives it server-side) and open a fresh one.
  const newChat = async () => {
    if (conversationId) {
      void fetch(`/api/conversation/${conversationId}/close`, { method: 'POST' }).catch(() => undefined);
    }
    setMessages([GREETING]);
    setConversationId(null);
    await startConversation();
  };

  return (
    <div className="max-w-3xl mx-auto flex flex-col h-[calc(100vh-9rem)]">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Referral assistant</h2>
          <p className="text-muted-foreground text-sm">Multi-turn — ask follow-ups like “what about Jaipur?”. Saved to the lakehouse when you finish.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void newChat()}>
          <RotateCcw className="h-3.5 w-3.5 mr-1" /> End & new
        </Button>
      </div>

      <div ref={threadRef} className="flex-1 overflow-y-auto space-y-4 pr-1">
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] ${m.role === 'user' ? 'order-2' : ''}`}>
              {m.emergency && (
                <div className="mb-2 rounded-xl border-2 border-destructive bg-destructive/10 p-3">
                  <p className="font-semibold text-destructive">🚨 This looks like an emergency</p>
                  <p className="text-sm text-foreground mb-2">If it’s life-threatening, call now — don’t wait for a search.</p>
                  <div className="flex gap-2">
                    <a href="tel:112" className="rounded-md bg-destructive text-destructive-foreground px-3 py-1.5 text-sm font-semibold">Call 112</a>
                    <a href="tel:108" className="rounded-md border border-destructive text-destructive px-3 py-1.5 text-sm font-semibold">Ambulance 108</a>
                  </div>
                </div>
              )}
              <div
                className={`rounded-2xl px-4 py-2 text-sm ${
                  m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
                }`}
              >
                {m.role === 'assistant' && m.interpretation && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                    <Sparkles className="h-3 w-3 text-primary" /> {m.interpretation}
                    {m.lang && m.lang !== 'en' && <span className="rounded-full bg-primary/10 text-primary px-1.5">{m.lang}</span>}
                  </span>
                )}
                <span className="inline-flex items-start gap-2">
                  <span>{m.text}</span>
                  {m.role === 'assistant' && m.text && ttsSupported() && (
                    <button
                      type="button"
                      title="Read aloud"
                      onClick={() => speak(m.text, m.speechLocale ?? 'en-IN')}
                      className="text-muted-foreground hover:text-primary shrink-0 mt-0.5"
                    >
                      <Volume2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </div>

              {m.results && m.results.length > 0 && (
                <div className="mt-2 space-y-2">
                  {m.origin && (
                    <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      distances measured from <span className="font-medium text-foreground">{m.origin.label}</span>
                      {m.origin.precision === 'city' && (
                        <span className="text-amber-600"> · tap 📍 Near me (or give a PIN) for distance from you</span>
                      )}
                    </p>
                  )}
                  {m.results.map((r, idx) => (
                    <Card key={r.facility_id} className="shadow-sm">
                      <CardContent className="py-3 space-y-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium text-sm">
                            <span className="text-muted-foreground mr-1.5">#{idx + 1}</span>{r.name}
                          </span>
                          <span className="text-xs text-muted-foreground inline-flex items-center gap-1 shrink-0">
                            <MapPin className="h-3 w-3" />{r.distance_km} km
                          </span>
                        </div>
                        {/* Why this result: semantic relevance + the matched evidence */}
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className={`rounded-full px-1.5 py-0.5 font-medium ${
                            (r.similarity ?? 0) < 0.55 ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'
                          }`}>
                            {Math.round((r.similarity ?? 0) * 100)}% {(r.similarity ?? 0) < 0.55 ? 'related' : 'match'}
                          </span>
                          {m.origin && <span className="text-muted-foreground">{r.distance_km} km from {m.origin.label}</span>}
                        </div>
                        <p className="text-xs">
                          <span className="font-medium text-foreground">Why: </span>
                          <span className="text-muted-foreground">{r.match_reason}</span>
                        </p>
                        <div className="flex flex-wrap gap-3 text-xs">
                          <a href={directionsUrl(r)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline underline-offset-4">
                            <Navigation className="h-3 w-3" />Directions
                          </a>
                          <a href={whatsappUrl(r)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-green-600 underline underline-offset-4">
                            <MessageCircle className="h-3 w-3" />WhatsApp
                          </a>
                          {r.official_phone && (
                            <a href={`tel:${r.official_phone}`} className="inline-flex items-center gap-1 text-primary underline underline-offset-4">
                              <Phone className="h-3 w-3" />{r.official_phone}
                            </a>
                          )}
                          {r.official_website && (
                            <a href={siteUrl(r.official_website)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline underline-offset-4">
                              <ExternalLink className="h-3 w-3" />website
                            </a>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && <div className="text-sm text-muted-foreground px-4">…searching</div>}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); void send(input); }}
        className="mt-3 flex items-end gap-2 border-t pt-3"
      >
        <select
          value={operator}
          onChange={(e) => setOperator(e.target.value as '' | 'public' | 'private')}
          className="h-9 rounded-md border border-input bg-background px-2 text-xs"
          title="Public / private filter"
        >
          <option value="">All</option>
          <option value="public">Public</option>
          <option value="private">Private</option>
        </select>
        <button
          type="button"
          title={coords ? 'Using your location — click to turn off' : 'Use my location for closest facilities'}
          onClick={() => (coords ? setCoords(null) : void shareLocation())}
          disabled={locating}
          className={`h-9 rounded-md border px-2.5 text-xs inline-flex items-center gap-1 ${
            coords ? 'border-primary text-primary bg-primary/10' : 'border-input text-muted-foreground hover:bg-muted'
          }`}
        >
          <LocateFixed className={`h-3.5 w-3.5 ${locating ? 'animate-pulse' : ''}`} />
          {coords ? 'Near me' : locating ? '…' : 'Near me'}
        </button>
        <select
          value={voiceLang}
          onChange={(e) => setVoiceLang(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-xs"
          title="Voice language"
        >
          {VOICE_LANGS.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
        <div className="relative flex-1">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type or tap the mic… (any language)"
            className="pr-10"
          />
          {sttSupported() && (
            <button
              type="button"
              title="Speak"
              onClick={() => void startListening()}
              disabled={listening || loading}
              className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 ${
                listening ? 'text-destructive animate-pulse' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              <Mic className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button type="submit" disabled={loading || !input.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
      <p className="text-[11px] text-muted-foreground text-center mt-2">
        Informational only — not medical advice. Listings aren’t verified for availability or quality. In an emergency, call <a href="tel:112" className="underline">112</a>.
        <br />
        Searches are stored without your identity (pseudonymised) to improve the service and auto-deleted after 90 days.
      </p>
    </div>
  );
}
