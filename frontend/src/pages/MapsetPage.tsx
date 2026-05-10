import { useNavigate, useParams } from 'react-router-dom';
import PassphraseModal from '../components/PassphraseModal';
import { useEncryption } from '../contexts/EncryptionContext';
import { useMapset } from '../hooks/useMapset';

export default function MapsetPage() {
  const { id } = useParams<{ id: string }>();
  const { data: mapset, isLoading, isError } = useMapset(id ?? '');
  const { isUnlocked } = useEncryption();
  const navigate = useNavigate();

  if (!id) return null;
  if (isLoading) return <div className="min-h-screen bg-gray-900 text-white p-8">Loading…</div>;
  if (isError || !mapset) {
    return <div className="min-h-screen bg-gray-900 text-white p-8 text-red-400">Mapset not found.</div>;
  }

  if (!isUnlocked(id)) {
    return (
      <div className="min-h-screen bg-gray-900">
        <PassphraseModal
          mapset={mapset}
          onSuccess={() => {}}
          onCancel={() => navigate('/dashboard')}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <h1 className="text-3xl font-bold text-blue-400 mb-4">Mapset View</h1>
      <p className="text-gray-400">Full mapset view coming in Phase 3.</p>
    </div>
  );
}
