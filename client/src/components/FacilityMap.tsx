import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface MapResult {
  facility_id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  distance_km: number;
}

interface Props {
  origin: { lat: number; lng: number; label: string };
  results: MapResult[];
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

// Numbered marker that matches the card list (#1, #2, …).
const numIcon = (n: number) =>
  L.divIcon({
    className: '',
    html: `<div style="background:#0ea5e9;color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.45)">${n}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

const originIcon = L.divIcon({
  className: '',
  html: `<div style="background:#dc2626;color:#fff;width:14px;height:14px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.45)"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

export function FacilityMap({ origin, results }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const pts = results.filter((r) => r.lat != null && r.lng != null);

    const map = L.map(ref.current, { scrollWheelZoom: false, attributionControl: true }).setView(
      [origin.lat, origin.lng],
      12,
    );
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(map);

    L.marker([origin.lat, origin.lng], { icon: originIcon })
      .addTo(map)
      .bindPopup(`<b>${esc(origin.label)}</b><br/>search origin`);

    const bounds = L.latLngBounds([[origin.lat, origin.lng]]);
    pts.forEach((r, i) => {
      const lat = r.lat as number;
      const lng = r.lng as number;
      const dir = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
      L.marker([lat, lng], { icon: numIcon(i + 1) })
        .addTo(map)
        .bindPopup(
          `<b>#${i + 1} ${esc(r.name)}</b><br/>${r.distance_km} km<br/><a href="${dir}" target="_blank" rel="noopener">Directions ↗</a>`,
        );
      bounds.extend([lat, lng]);
    });
    if (pts.length > 0) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 14 });

    return () => {
      map.remove();
    };
  }, [origin, results]);

  return <div ref={ref} className="h-64 w-full rounded-lg overflow-hidden border z-0" />;
}
