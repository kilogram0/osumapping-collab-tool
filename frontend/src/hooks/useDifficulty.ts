import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createDifficulty,
  createSection,
  fetchDifficulties,
  fetchSections,
  updateSection,
} from '../api/endpoints';

export function useDifficulties(mapsetId: string) {
  return useQuery({
    queryKey: ['difficulties', mapsetId],
    queryFn: () => fetchDifficulties(mapsetId),
    enabled: !!mapsetId,
  });
}

export function useCreateDifficulty(mapsetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Parameters<typeof createDifficulty>[1]) =>
      createDifficulty(mapsetId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['difficulties', mapsetId] });
    },
  });
}

export function useSections(difficultyId: string | null) {
  return useQuery({
    queryKey: ['sections', difficultyId],
    queryFn: () => fetchSections(difficultyId!),
    enabled: !!difficultyId,
  });
}

export function useCreateSection(difficultyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Parameters<typeof createSection>[1]) =>
      createSection(difficultyId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sections', difficultyId] });
    },
  });
}

export function useUpdateSection(difficultyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      sectionId,
      payload,
    }: {
      sectionId: string;
      payload: Parameters<typeof updateSection>[2];
    }) => updateSection(difficultyId, sectionId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sections', difficultyId] });
    },
  });
}
