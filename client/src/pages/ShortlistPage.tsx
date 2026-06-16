import { Card, CardContent, CardHeader, CardTitle, Button, Skeleton } from '@databricks/appkit-ui/react';
import { useEffect, useState, useCallback } from 'react';
import { Phone } from 'lucide-react';

interface Item {
  facility_id: string;
  name: string;
  city: string | null;
  state: string | null;
  official_phone: string | null;
  rank: number | null;
  distance_km: number | null;
  match_reason: string | null;
  status: string;
}

const STATUSES = ['candidate', 'contacted', 'referred', 'rejected'] as const;

export function ShortlistPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [loading, setLoading] = useState(true);
  const id = sessionStorage.getItem('shortlist_id');

  const load = useCallback(async () => {
    if (!id) { setItems([]); setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/referral/shortlists/${id}/items`);
      setItems(res.ok ? ((await res.json()) as Item[]) : []);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const setStatus = async (facilityId: string, status: string) => {
    if (!id) return;
    await fetch(`/api/referral/shortlists/${id}/items/${facilityId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    void load();
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold text-foreground">My referrals</h2>
        <p className="text-muted-foreground text-sm">Facilities you shortlisted, with referral status.</p>
      </div>

      {loading && Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}

      {!loading && (!items || items.length === 0) && (
        <p className="text-muted-foreground text-center py-10">
          Nothing shortlisted yet. Run a search and tap “Shortlist” on a facility.
        </p>
      )}

      {!loading && items && items.length > 0 && (
        <div className="space-y-3">
          {items.map((it) => (
            <Card key={it.facility_id} className="shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{it.name}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {it.city}, {it.state}{it.distance_km != null ? ` · ${it.distance_km} km` : ''}
                </p>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                {it.match_reason && <p className="text-sm text-muted-foreground">{it.match_reason}</p>}
                {it.official_phone && (
                  <a href={`tel:${it.official_phone}`} className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4">
                    <Phone className="h-3.5 w-3.5" />{it.official_phone}
                  </a>
                )}
                <div className="flex flex-wrap gap-2">
                  {STATUSES.map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant={it.status === s ? 'default' : 'outline'}
                      onClick={() => void setStatus(it.facility_id, s)}
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
