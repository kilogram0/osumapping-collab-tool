import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createPin,
  deletePin,
  fetchPins,
} from '../api/endpoints';

/** List pin metadata for a difficulty. `enabled` lets callers defer the fetch
 *  until the pin list is actually opened. */
export function usePins(difficultyId: string, enabled = true) {
  return useQuery({
    queryKey: ['pins', difficultyId],
    queryFn: () => fetchPins(difficultyId),
    enabled: !!difficultyId && enabled,
  });
}

export function useCreatePin(difficultyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Parameters<typeof createPin>[1]) =>
      createPin(difficultyId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pins', difficultyId] });
      queryClient.invalidateQueries({ queryKey: ['storage'] });
    },
  });
}

export function useDeletePin(difficultyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pinId: string) => deletePin(difficultyId, pinId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pins', difficultyId] });
      queryClient.invalidateQueries({ queryKey: ['storage'] });
    },
  });
}
