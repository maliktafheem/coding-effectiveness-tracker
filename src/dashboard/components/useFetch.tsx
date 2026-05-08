import { useState, useEffect, useCallback } from 'react';

const API_BASE = window.location.origin;

export function useFetch<T>(url: string, deps: unknown[] = []): { data: T | null; loading: boolean; error: string | null; refetch: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(API_BASE + url)
      .then(res => {
        if (!res.ok) throw new Error('API error: ' + res.status);
        return res.json();
      })
      .then((json: T) => { if (!cancelled) setData(json); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url, tick, ...deps]);

  return { data, loading, error, refetch };
}
