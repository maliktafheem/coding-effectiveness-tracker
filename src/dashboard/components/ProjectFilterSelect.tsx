import { useFetch } from './useFetch';
import type { ProjectInfo } from './types';

export default function ProjectFilterSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useFetch<{ projects: ProjectInfo[] }>('/api/projects');
  return (
    <select value={value} onChange={e => onChange(e.target.value)}>
      <option value="">All projects</option>
      {(data?.projects || []).map(p => (
        <option key={p.projectId} value={p.projectId}>{p.projectId} ({p.sessionCount})</option>
      ))}
    </select>
  );
}
