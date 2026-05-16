import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import CreateDifficultyModal from '../components/CreateDifficultyModal';
import CreateSectionModal from '../components/CreateSectionModal';
import DifficultyTabs from '../components/DifficultyTabs';
import EditSectionModal from '../components/EditSectionModal';
import PassphraseModal from '../components/PassphraseModal';
import SectionList, { type DecryptedSection } from '../components/SectionList';
import { useAuth } from '../hooks/useAuth';
import { useEncryption } from '../contexts/EncryptionContext';
import { useDifficulties, useSections } from '../hooks/useDifficulty';
import { useMapset, useMyMembership } from '../hooks/useMapset';
import { decrypt, decodeJsonEnvelope, mapsetFieldAad } from '../utils/crypto';
import { logger } from '../utils/logger';

export default function MapsetPage() {
  const { id } = useParams<{ id: string }>();
  const mapsetId = id ?? '';
  const { data: mapset, isLoading: mapsetLoading, isError: mapsetError } = useMapset(mapsetId);
  const { data: myMembership } = useMyMembership(mapsetId);
  const { data: difficulties, isLoading: difficultiesLoading } = useDifficulties(mapsetId);
  const [selectedDifficultyId, setSelectedDifficultyId] = useState<string | null>(null);
  const { data: sections, isLoading: sectionsLoading } = useSections(selectedDifficultyId);
  const { isUnlocked, getKey } = useEncryption();
  const { user } = useAuth();
  const navigate = useNavigate();
  const unlocked = isUnlocked(mapsetId);

  const [showCreateDifficulty, setShowCreateDifficulty] = useState(false);
  const [showCreateSection, setShowCreateSection] = useState(false);
  const [showEditSection, setShowEditSection] = useState(false);
  const [editingSection, setEditingSection] = useState<DecryptedSection | null>(null);
  const [decryptedSections, setDecryptedSections] = useState<DecryptedSection[]>([]);
  const [decryptedDescription, setDecryptedDescription] = useState<string | null>(null);
  const [songLengthMs, setSongLengthMs] = useState<number | null>(null);

  // Role-based gating: owner and mapper can create/edit difficulties and sections.
  // modder can only view.  This matches the backend permission checks.
  const canEditStructure =
    myMembership?.role === 'owner' || myMembership?.role === 'mapper';

  useEffect(() => {
    if (difficulties && difficulties.length > 0 && selectedDifficultyId === null) {
      setSelectedDifficultyId(difficulties[0].id);
    }
  }, [difficulties, selectedDifficultyId]);

  useEffect(() => {
    if (!unlocked || !mapset) {
      setDecryptedDescription(null);
      setSongLengthMs(null);
      return;
    }

    let cancelled = false;

    async function decryptMetadata() {
      try {
        const key = await getKey(mapsetId);
        if (!key || cancelled) return;

        const results = await Promise.allSettled([
          mapset.encrypted_description
            ? decrypt(key, mapset.encrypted_description, mapsetFieldAad(mapsetId))
            : Promise.resolve(null),
          decrypt(key, mapset.encrypted_song_length_ms, mapsetFieldAad(mapsetId)),
        ]);

        if (cancelled) return;

        const descResult = results[0];
        if (descResult.status === 'fulfilled' && descResult.value !== null) {
          setDecryptedDescription(descResult.value);
        }

        const songResult = results[1];
        if (songResult.status === 'fulfilled') {
          setSongLengthMs(decodeJsonEnvelope(songResult.value));
        }
      } catch (err) {
        logger.warn('Failed to decrypt mapset metadata:', err);
      }
    }

    decryptMetadata();
    return () => { cancelled = true; };
  }, [unlocked, mapset, mapsetId, getKey]);

  function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  if (!id) return null;
  if (mapsetLoading) return <div className="min-h-screen bg-gray-900 text-white p-8">Loading…</div>;
  if (mapsetError || !mapset) {
    return <div className="min-h-screen bg-gray-900 text-white p-8 text-red-400">Mapset not found.</div>;
  }

  if (!unlocked) {
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
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-blue-400">{mapset.title}</h1>
          {decryptedDescription && (
            <p className="text-gray-300 mt-2">{decryptedDescription}</p>
          )}
          {songLengthMs !== null && (
            <p className="text-sm text-gray-400 mt-1">{formatDuration(songLengthMs)}</p>
          )}
        </div>

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-200">Difficulties</h2>
          {canEditStructure && (
            <button
              type="button"
              onClick={() => setShowCreateDifficulty(true)}
              className="px-3 py-1.5 bg-pink-600 hover:bg-pink-500 text-white text-sm font-medium rounded transition-colors"
            >
              Add Difficulty
            </button>
          )}
        </div>

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

        {difficulties && difficulties.length === 0 && !difficultiesLoading && (
          <p className="text-gray-400 italic mb-6">No difficulties yet.</p>
        )}

        {selectedDifficultyId && (
          <div className="max-w-md">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-200">Sections</h2>
              {canEditStructure && (
                <button
                  type="button"
                  onClick={() => setShowCreateSection(true)}
                  className="px-3 py-1.5 bg-pink-600 hover:bg-pink-500 text-white text-sm font-medium rounded transition-colors"
                >
                  Add Section
                </button>
              )}
            </div>
            {sectionsLoading && <p className="text-gray-400">Loading sections…</p>}
            {sections && (
              <SectionList
                sections={sections}
                mapsetId={mapsetId}
                difficultyId={selectedDifficultyId}
                onEdit={(s) => {
                  setEditingSection(s);
                  setShowEditSection(true);
                }}
                onDecrypted={setDecryptedSections}
              />
            )}
            {sections && sections.length === 0 && !sectionsLoading && (
              <p className="text-gray-400 italic">No sections yet.</p>
            )}
          </div>
        )}
      </div>

      {showCreateDifficulty && (
        <CreateDifficultyModal
          mapsetId={mapsetId}
          onSuccess={() => setShowCreateDifficulty(false)}
          onCancel={() => setShowCreateDifficulty(false)}
        />
      )}

      {showCreateSection && selectedDifficultyId && (
        <CreateSectionModal
          difficultyId={selectedDifficultyId}
          mapsetId={mapsetId}
          previousSections={decryptedSections}
          onSuccess={() => setShowCreateSection(false)}
          onCancel={() => setShowCreateSection(false)}
        />
      )}

      {showEditSection && editingSection && selectedDifficultyId && (
        <EditSectionModal
          difficultyId={selectedDifficultyId}
          mapsetId={mapsetId}
          sectionId={editingSection.id}
          initialName={editingSection.name}
          initialStartTimeMs={editingSection.startTimeMs}
          initialEndTimeMs={editingSection.endTimeMs}
          onSuccess={() => {
            setShowEditSection(false);
            setEditingSection(null);
          }}
          onCancel={() => {
            setShowEditSection(false);
            setEditingSection(null);
          }}
        />
      )}
    </div>
  );
}
