import { useState } from 'react';

export default function AnnotationForm({ onSubmit }: { onSubmit: (form: { outcome: string; score: string; note: string }) => void }) {
  const [outcome, setOutcome] = useState('good');
  const [score, setScore] = useState('');
  const [note, setNote] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = () => {
    // Validate score range
    if (score) {
      const num = parseFloat(score);
      if (isNaN(num) || num < 0 || num > 1) {
        setValidationError('Score must be a number between 0 and 1.');
        return;
      }
    }
    setValidationError(null);
    onSubmit({ outcome, score, note });
  };

  return (
    <div className="annotation-form" style={{ marginTop: 12 }}>
      {validationError && <div className="error" style={{ marginBottom: 8, padding: '8px 12px', fontSize: '0.8rem' }}>{validationError}</div>}
      <div>
        <label style={{ display: 'block', marginBottom: 4, color: '#94a3b8', fontSize: '0.8rem' }}>Outcome</label>
        <select value={outcome} onChange={e => setOutcome(e.target.value)}>
          {['good','accepted','merged','shipped','ok','neutral','partial','poor','rejected','reverted','abandoned','unknown'].map(o => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: 4, color: '#94a3b8', fontSize: '0.8rem' }}>Score (0-1, optional)</label>
        <input type="number" min="0" max="1" step="0.1" value={score} onChange={e => setScore(e.target.value)} placeholder="0.8" />
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: 4, color: '#94a3b8', fontSize: '0.8rem' }}>Note (optional)</label>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Add a note..." />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" onClick={handleSubmit}>Save Annotation</button>
        <button className="btn btn-secondary" onClick={() => { setScore(''); setNote(''); setValidationError(null); }}>Reset</button>
      </div>
    </div>
  );
}
