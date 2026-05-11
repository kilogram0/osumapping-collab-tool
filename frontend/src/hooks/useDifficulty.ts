import { useQuery } from '@tanstack/react-query';
import { fetchDifficulties, fetchSections } from '../api/endpoints';

export function useDifficulties(mapsetId: string) {
  return useQuery({
    queryKey: ['difficulties', mapsetId],
    queryFn: () => fetchDifficulties(mapsetId),
    enabled: !!mapsetId,
  });
}

export function useSections(difficultyId: string | null) {
  return useQuery({
    queryKey: ['sections', difficultyId],
    queryFn: () => fetchSections(difficultyId!),
    enabled: !!difficultyId,
  });
}
