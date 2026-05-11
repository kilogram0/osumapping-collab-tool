import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import DifficultyTabs from '../components/DifficultyTabs';
import PassphraseModal from '../components/PassphraseModal';
import SectionList from '../components/SectionList';
import { useEncryption } from '../contexts/EncryptionContext';
import { useDifficulties, useSections } from '../hooks/useDifficulty';
import { useMapset } from '../hooks/useMapset';

export default function MapsetPage() {
  const { id } = useParams<{ id: string }>();
  const mapsetId = id ?? '';
  const { data: mapset, isLoading: mapsetLoading, isError: mapsetError } = useMapset(mapsetId);
  const { data: difficulties, isLoading: difficultiesLoading } = useDifficulties(mapsetId);
  const [selectedDifficultyId, setSelectedDifficultyId] = useState<string | null>(null);
  const { data: sections, isLoading: sectionsLoading } = useSections(selectedDifficultyId);
  const { isUnlocked } = useEncryption();
  const navigate = useNavigate();

  useEffect(() => {
    if (difficulties && difficulties.length > 0 && selectedDifficultyId === null) {
      setSelectedDifficultyId(difficulties[0].id);
    }
  }, [difficulties, selectedDifficultyId]);

  if (!id) return null;
  if (mapsetLoading) return <div className="min-h-screen bg-gray-900 text-white p-8">Loading…</div>;
  if (mapsetError || !mapset) {
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

      {difficultiesLoading && <p className="text-gray-400">Loading difficulties…</p>}

      {difficulties && difficulties.length > 0 && (
        <div className="mb-6">
          <DifficultyTabs
            difficulties={difficulties}
            selectedId={selectedDifficultyId}
            onSelect={setSelectedDifficultyId}
            mapsetId={mapsetId}
          />
        </div>
      )}

      {selectedDifficultyId && (
        <div className="max-w-md">
          <h2 className="text-lg font-semibold text-gray-200 mb-3">Sections</h2>
          {sectionsLoading && <p className="text-gray-400">Loading sections…</p>}
          {sections && <SectionList sections={sections} mapsetId={mapsetId} />}
        </div>
      )}
    </div>
  );
}
